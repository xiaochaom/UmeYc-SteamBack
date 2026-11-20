"""Offline retry must recheck cloud against the original synchronization base."""
import asyncio
import unittest
from unittest.mock import patch

import test_cloud
from steamback.cloud import CloudService
from steamback.quark import QuarkError
from steamback.custom import write_json


class RetryUploadTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_cloud.CloudSync.setUp

    async def run_auto(self, service, item=None):
        async def immediate(_):
            pass
        with patch('steamback.cloud.asyncio.sleep', immediate):
            job = service.start_job(123, self.game, 'upload', automatic=True, retry_item=item)
            await asyncio.gather(*service.tasks)
        return service.jobs[job['id']]

    async def fail_offline(self):
        self.service.set_auto_sync(123, self.game, True)
        self.service.upload(123, self.game)
        base = self.service.latest(123, self.game)
        self.slot.write_bytes(b'offline progress')
        with patch.object(self.client, 'account', side_effect=QuarkError('offline')):
            result = await self.run_auto(self.service)
        self.assertEqual(result['state'], 'error')
        item = next(iter(self.service.retry_queue.pending.values()))
        self.assertEqual(item['base_hash'], base['content_hash'])
        return base

    async def test_restart_retry_rechecks_cloud_and_blocks_other_device_updates(self):
        await self.fail_offline()
        self.slot.write_bytes(b'other device progress')
        other = CloudService(self.engine, self.client)
        with patch.object(other.retry_queue, "clear"):
            other.upload(123, self.game)
        remote = other.latest(123, self.game)
        self.slot.write_bytes(b'offline progress')
        # Even if the mutable settings now remember the new version, the
        # persisted retry must keep its original baseline and reject overwrite.
        resumed = CloudService(self.engine, self.client)
        result = await self.run_auto(resumed, next(iter(resumed.retry_queue.pending.values())))
        self.assertEqual(result['state'], 'conflict')
        self.assertEqual(resumed.latest(123, self.game)['revision'], remote['revision'])
        self.assertEqual(self.slot.read_bytes(), b'offline progress')
        item = next(iter(resumed.retry_queue.pending.values()))
        self.assertTrue(item['blocked'])
        self.assertIsNone(resumed.retry_queue.next(self.client.user_id, 123, set(), now=10**12))
        before = len(resumed.jobs)
        await resumed.retry_uploads(123)
        self.assertEqual(len(resumed.jobs), before)

    async def test_unchanged_cloud_retries_automatically_after_restart(self):
        await self.fail_offline()
        resumed = CloudService(self.engine, self.client)
        item = next(iter(resumed.retry_queue.pending.values()))
        item['due'] = 0
        write_json(resumed.retry_queue.path, resumed.retry_queue.pending)
        async def immediate(_):
            pass
        with patch('steamback.cloud.asyncio.sleep', immediate):
            await resumed.retry_uploads(123)
            await asyncio.gather(*resumed.tasks)
        self.assertEqual(list(resumed.jobs.values())[-1]['state'], 'done')
        self.assertFalse(resumed.retry_queue.pending)
        self.assertFalse(CloudService(self.engine, self.client).retry_queue.pending)

    async def test_same_content_clears_task_without_duplicate_archive(self):
        await self.fail_offline()
        other = CloudService(self.engine, self.client)
        with patch.object(other.retry_queue, "clear"):
            other.upload(123, self.game)
        remote = other.latest(123, self.game)
        count = len(self.client.items)
        resumed = CloudService(self.engine, self.client)
        result = await self.run_auto(resumed, next(iter(resumed.retry_queue.pending.values())))
        self.assertEqual(result['state'], 'done')
        self.assertEqual(resumed.latest(123, self.game)['revision'], remote['revision'])
        self.assertEqual(len(self.client.items), count)
        self.assertFalse(resumed.retry_queue.pending)

    async def test_deleted_cloud_is_a_change_and_manual_download_clears_conflict(self):
        base = await self.fail_offline()
        self.client.delete_files([base['revision'], base['archive_fid']])
        resumed = CloudService(self.engine, self.client)
        result = await self.run_auto(resumed, next(iter(resumed.retry_queue.pending.values())))
        self.assertEqual(result['state'], 'conflict')
        self.assertIsNone(resumed.latest(123, self.game))
        # A new remote is restored by another device. Explicit manual download
        # resolves the task; no stale upload gets resurrected after restart.
        self.slot.write_bytes(b'remote selected')
        other = CloudService(self.engine, self.client)
        with patch.object(other.retry_queue, "clear"):
            other.upload(123, self.game)
        remote = other.latest(123, self.game)
        self.slot.write_bytes(b'offline progress')
        await resumed.download(123, self.game, remote['revision'])
        self.assertFalse(resumed.retry_queue.pending)
        self.assertEqual(self.slot.read_bytes(), b'remote selected')

    async def test_running_game_and_account_switch_never_start_retry(self):
        await self.fail_offline()
        item = next(iter(self.service.retry_queue.pending.values()))
        item['due'] = 0
        before = len(self.service.jobs)
        self.service.running.add((123, 42))
        await self.service.retry_uploads(123)
        self.assertEqual(len(self.service.jobs), before)
        self.service.running.clear()
        self.service.active_account = 124
        await self.service.retry_uploads(123)
        self.assertEqual(len(self.service.jobs), before)
        self.service.active_account = 123
        self.service.set_auto_sync(123, self.game, False)
        await self.service.retry_uploads(123)
        self.assertFalse(self.service.retry_queue.pending)


    async def test_retry_detects_cloud_change_during_archive_upload(self):
        base = await self.fail_offline()
        item = next(iter(self.service.retry_queue.pending.values()))
        original = self.service.latest
        calls = []
        def concurrent(*args):
            calls.append(1)
            remote = original(*args)
            return {**remote, 'revision': 'another-commit'} if len(calls) > 1 else remote
        with patch.object(self.service, 'latest', side_effect=concurrent):
            result = await self.run_auto(self.service, item)
        self.assertEqual(result['state'], 'conflict')
        self.assertEqual(original(123, self.game)['revision'], base['revision'])

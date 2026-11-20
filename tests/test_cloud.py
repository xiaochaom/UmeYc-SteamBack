"""隔离目录中的云存档完整往返；网盘使用内存文件服务，不访问真实账号。"""
import asyncio
import copy
import hashlib
import json
import logging
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile, ZipInfo

from steamback import Config, Engine
from steamback.cloud import CloudService, CloudConflict, pack_current, unpack_verified, digest
from steamback.quark import QuarkError, LoginExpired


class MemoryQuark:
    def __init__(self):
        self.user_id = "quark-user"
        self.items = {}
        self.payloads = {}
        self.fail_commit = False
        self.expired = False
        self.sequence = 0
        self.deleted = []
        self.fail_delete = False

    def next_id(self):
        self.sequence += 1
        return str(self.sequence)

    def account(self):
        if self.expired:
            raise LoginExpired("夸克登录已失效，请重新扫码")
        return {"logged_in": True, "user_id": self.user_id}

    def list_files(self, folder):
        return [copy.deepcopy(v) for v in self.items.values() if v["parent"] == folder]

    def folder(self, parent, name, create=False):
        match = next((f for f in self.list_files(parent) if f["file_name"] == name), None)
        if match:
            return match["fid"]
        if create:
            fid = self.next_id()
            self.items[fid] = {"fid": fid, "parent": parent, "file_name": name, "dir": True}
            return fid
        return None

    def upload(self, source, folder, name):
        if self.fail_commit and name.endswith('.json'):
            raise QuarkError("模拟网络失败")
        fid = self.next_id()
        data = Path(source).read_bytes()
        self.items[fid] = {"fid": fid, "parent": folder, "file_name": name, "size": len(data), "created_at": self.sequence}
        self.payloads[fid] = data
        return self.items[fid]

    def delete_files(self, file_ids):
        if self.fail_delete:
            raise QuarkError("模拟删除失败")
        self.deleted.extend(file_ids)
        for fid in file_ids:
            self.items.pop(fid, None)
            self.payloads.pop(fid, None)

    def download(self, fid, destination, limit=None):
        data = self.payloads[fid]
        if limit and len(data) > limit:
            raise ValueError("超过限制")
        Path(destination).write_bytes(data)


class CloudSync(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / '游戏存档'; self.source.mkdir()
        self.slot = self.source / 'slot.sav'; self.slot.write_bytes(b'chapter one')
        os.utime(self.slot, (1700000000, 1700000000))
        self.engine = Engine(Config(logging.getLogger('test'), str(self.root / 'data'), str(self.root / 'Steam')))
        self.engine.account_ids = {123}
        self.game = {"game_id": 42, "game_name": "测试游戏", "install_root": self.engine.get_steam_root()}
        self.engine.set_custom_game(self.game, [str(self.source)])
        self.client = MemoryQuark()
        self.service = CloudService(self.engine, self.client)

    async def upload(self):
        return self.service.upload(123, self.game)

    async def test_upload_download_roundtrip_times_and_reversible_restore(self):
        await self.upload()
        status = self.service.status(123, self.game)
        self.assertEqual(status['cloud_time'], 1700000000000)
        self.assertFalse(status['auto_upload'])
        self.assertNotEqual(status['uploaded_at'], status['cloud_time'])
        top = [f['file_name'] for f in self.client.list_files('0')]
        self.assertEqual(top, ['UmeYc-SteamBack'])
        self.slot.write_bytes(b'chapter two')
        unrelated = self.source / 'extra.sav'; unrelated.write_bytes(b'extra slot')
        await self.service.download(123, self.game, status['revision'])
        self.assertEqual(self.slot.read_bytes(), b'chapter one')
        self.assertEqual(self.slot.stat().st_mtime_ns, 1700000000000000000)
        self.assertEqual(unrelated.read_bytes(), b'extra slot')
        saves = await self.engine.get_saveinfos()
        self.assertEqual(len(saves), 2)
        downloaded = next(s for s in saves if s.get('source') == 'cloud_download')
        self.assertFalse(downloaded['is_undo'])
        undo = next(s for s in saves if s['is_undo'])
        self.assertEqual(undo['source'], 'before_cloud_sync')
        await self.engine.do_restore(undo)
        self.assertEqual(self.slot.read_bytes(), b'chapter two')
        self.assertEqual(unrelated.read_bytes(), b'extra slot')
        await self.engine.do_restore(downloaded)
        self.assertEqual(self.slot.read_bytes(), b'chapter one')
        self.assertTrue(any(s.get('source') == 'cloud_download' for s in await self.engine.get_saveinfos()))

    async def test_directory_upload_download_overwrites_nested_files_and_preserves_unselected_files(self):
        nested = self.source / 'profiles' / 'slot-1.sav'
        nested.parent.mkdir()
        nested.write_bytes(b'cloud nested')
        await self.upload()
        remote = self.service.latest(123, self.game)

        self.slot.write_bytes(b'local changed')
        nested.unlink()
        unrelated = self.source / 'local-only.sav'
        unrelated.write_bytes(b'keep local')
        await self.service.download(123, self.game, remote['revision'])

        self.assertEqual(self.slot.read_bytes(), b'chapter one')
        self.assertEqual(nested.read_bytes(), b'cloud nested')
        self.assertEqual(unrelated.read_bytes(), b'keep local')

        saves = await self.engine.get_saveinfos()
        self.assertEqual(len(saves), 2)
        self.assertTrue(any(s.get('source') == 'cloud_download' for s in saves))
        undo = next(s for s in saves if s['is_undo'])
        await self.engine.do_restore(undo)
        self.assertEqual(self.slot.read_bytes(), b'local changed')
        self.assertFalse(nested.exists())
        self.assertEqual(unrelated.read_bytes(), b'keep local')

    async def test_download_maps_to_current_device_and_keeps_remote_paths_out(self):
        await self.upload()
        remote = self.service.latest(123, self.game)
        destination = self.root / 'other device'; destination.mkdir()
        self.engine.set_custom_game(self.game, [str(destination)])
        await self.service.download(123, self.game, remote['revision'])
        self.assertEqual((destination/'slot.sav').read_bytes(), b'chapter one')
        self.assertEqual(self.slot.read_bytes(), b'chapter one')
        with tempfile.TemporaryDirectory() as t:
            archive = Path(t)/'cloud.zip'; self.client.download(remote['archive_fid'], archive)
            with ZipFile(archive) as z:
                self.assertNotIn(str(self.source), z.read('manifest.json').decode())

    async def test_unchanged_upload_is_idempotent_and_changed_saves_keep_only_latest(self):
        await self.upload(); count = len(self.client.items)
        old = self.service.latest(123, self.game)
        result = await self.upload()
        self.assertIn('一致', result['message']); self.assertEqual(len(self.client.items), count)
        self.slot.write_bytes(b'next')
        await self.upload()
        commits = [i for i in self.client.items.values() if i['file_name'].endswith('.json')]
        self.assertEqual(len(commits), 1)
        self.assertEqual(len([i for i in self.client.items.values() if i['file_name'].endswith('.zip')]), 1)
        self.assertNotIn(old['revision'], self.client.items)
        self.assertNotIn(old['archive_fid'], self.client.items)
        self.assertLess(self.client.deleted.index(old['revision']), self.client.deleted.index(old['archive_fid']))
        self.assertIn('最新一份', (await self.upload())['message'])
        current = self.service.latest(123, self.game)
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp)/'latest.zip'
            self.client.download(current['archive_fid'], archive)
            manifest = unpack_verified(archive, Path(tmp)/'files', self.game, 123, current['content_hash'])
            self.assertEqual((Path(tmp)/'files/0/slot.sav').read_bytes(), b'next')

    async def test_other_device_changes_require_explicit_revision_confirmation(self):
        await self.upload()
        other = CloudService(self.engine, self.client)
        other.state_path = self.root / 'other-settings.json'
        self.slot.write_bytes(b'other device')
        with self.assertRaises(CloudConflict):
            other.upload(123, self.game)
        old = self.service.latest(123, self.game)
        other.upload(123, self.game, old['revision'])
        self.slot.write_bytes(b'my device')
        with self.assertRaises(CloudConflict) as conflict:
            await self.upload()
        current = conflict.exception.remote
        with self.assertRaises(CloudConflict):
            self.service.upload(123, self.game, old['revision'])
        self.service.upload(123, self.game, current['revision'])

    async def test_failed_publish_keeps_previous_latest(self):
        await self.upload(); old = self.service.latest(123, self.game)
        self.slot.write_bytes(b'new data'); self.client.fail_commit = True
        with self.assertRaises(QuarkError):
            await self.upload()
        self.assertEqual(self.service.latest(123, self.game)['revision'], old['revision'])
        self.assertEqual(self.slot.read_bytes(), b'new data')
        self.assertEqual(self.client.deleted, [])

    async def test_bad_archive_cannot_write_live_files(self):
        await self.upload(); remote = self.service.latest(123, self.game)
        self.client.payloads[remote['archive_fid']] += b'corruption'
        self.slot.write_bytes(b'current')
        with self.assertRaisesRegex(ValueError, '校验'):
            await self.service.download(123, self.game, remote['revision'])
        self.assertEqual(self.slot.read_bytes(), b'current')
        self.assertEqual(await self.engine.get_saveinfos(), [])

    async def test_running_game_or_stale_revision_blocks_restore_and_upload(self):
        await self.upload(); remote = self.service.latest(123, self.game)
        with self.assertRaisesRegex(ValueError, '版本已变化'):
            await self.service.download(123, self.game, 'stale')
        self.service.running.add((123, 42))
        with self.assertRaisesRegex(ValueError, '退出游戏'):
            await self.upload()
        with self.assertRaisesRegex(ValueError, '退出游戏'):
            await self.service.download(123, self.game, remote['revision'])

    async def test_settings_and_files_are_isolated_by_accounts_and_games(self):
        self.service.set_auto(123, self.game, True)
        self.assertIsNotNone(self.service.auto_game(123, 42))
        self.assertIsNone(self.service.auto_game(124, 42))
        self.assertIsNone(self.service.auto_game(123, 43))
        self.service.uid = self.client.user_id = 'other-quark'
        self.assertIsNone(self.service.auto_game(123, 42))
        self.assertFalse(self.service.status(123, self.game)['auto_upload'])
        self.service.uid = self.client.user_id = 'quark-user'
        await self.upload()
        self.assertIsNone(self.service.latest(124, self.game))
        self.assertIsNone(self.service.latest(123, dict(self.game, game_id=43)))

    async def test_async_jobs_survive_view_close_and_report_conflict_or_expiry(self):
        job = self.service.start_job(123, self.game, 'upload')
        await asyncio.gather(*self.service.tasks)
        self.assertEqual(self.service.jobs[job['id']]['state'], 'done')
        self.client.expired = True
        job = self.service.start_job(123, self.game, 'upload')
        await asyncio.gather(*self.service.tasks)
        self.assertEqual(self.service.jobs[job['id']]['state'], 'error')
        self.assertIn('登录', self.service.jobs[job['id']]['message'])

    async def test_automatic_upload_waits_for_stable_files_and_rejects_restart(self):
        async def immediate(_):
            pass
        with patch('steamback.cloud.asyncio.sleep', immediate):
            job = self.service.start_job(123, self.game, 'upload', automatic=True)
            await asyncio.gather(*self.service.tasks)
            self.assertEqual(self.service.jobs[job['id']]['state'], 'done')
            self.service.running.add((123, 42))
            job = self.service.start_job(123, self.game, 'upload', automatic=True)
            await asyncio.gather(*self.service.tasks)
            self.assertEqual(self.service.jobs[job['id']]['state'], 'error')
            self.assertIn('重新启动', self.service.jobs[job['id']]['message'])

    async def test_pack_detects_mutation_and_rejects_empty_sources(self):
        target = self.root/'save.zip'
        manifest = pack_current(self.engine, self.game, target)
        self.assertEqual(manifest['save_time'], 1700000000000)
        original = ZipFile.open
        def mutate(archive, name, mode='r', *args, **kwargs):
            if mode == 'w' and isinstance(name, str) and name.startswith('files/'):
                self.slot.write_bytes(b'game is writing while the archive is built')
            return original(archive, name, mode, *args, **kwargs)
        with patch.object(ZipFile, 'open', mutate), self.assertRaisesRegex(ValueError, '发生变化'):
            pack_current(self.engine, self.game, target)
        self.slot.unlink()
        with self.assertRaisesRegex(ValueError, '没有可同步'):
            pack_current(self.engine, self.game, target)

    async def test_zip_traversal_symlinks_and_wrong_identity_rejected(self):
        for bad in ['../escape', '/absolute', 'files/0/../../escape', 'files\\0\\escape']:
            archive = self.root/'bad.zip'
            with ZipFile(archive, 'w') as z:
                z.writestr(bad, b'invalid')
            with self.assertRaises(ValueError):
                unpack_verified(archive, self.root/'unpack', self.game, 123, 'none')
        archive = self.root/'bad.zip'
        with ZipFile(archive, 'w') as z:
            entry = ZipInfo('files/0/link'); entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            z.writestr(entry, '/somewhere')
        with self.assertRaises(ValueError):
            unpack_verified(archive, self.root/'unpack', self.game, 123, 'none')
        archive = self.root/'good.zip'
        manifest = pack_current(self.engine, self.game, archive)
        with self.assertRaisesRegex(ValueError, '不属于'):
            unpack_verified(archive, self.root/'unpack', self.game, 124, manifest['content_hash'])

    async def test_exact_file_selection_cannot_restore_unselected_sibling_files(self):
        extra = self.source/'extra.sav'; extra.write_bytes(b'cloud extra')
        await self.upload(); remote = self.service.latest(123, self.game)
        self.engine.set_custom_game(self.game, [str(self.slot)])
        extra.write_bytes(b'current extra')
        with self.assertRaisesRegex(ValueError, '所选存档范围'):
            await self.service.download(123, self.game, remote['revision'])
        self.assertEqual(extra.read_bytes(), b'current extra')
        self.assertEqual(await self.engine.get_saveinfos(), [])

    async def test_job_does_not_switch_quark_account_while_queued(self):
        job = self.service.start_job(123, self.game, 'upload')
        self.client.user_id = 'changed-account'
        await asyncio.gather(*self.service.tasks)
        self.assertEqual(self.service.jobs[job['id']]['state'], 'error')
        self.assertIn('账号已变化', self.service.jobs[job['id']]['message'])
        self.assertEqual(self.client.items, {})
        activity = self.service.read_state(self.service.activity_path)
        self.assertIn('quark-user:123:42', activity)
        self.assertNotIn('changed-account:123:42', activity)

    async def test_running_job_status_does_not_wait_for_network_lock(self):
        job = self.service.start_job(123, self.game, 'upload')
        status = self.service.status(123, self.game)
        self.assertEqual(status['activity']['id'], job['id'])
        self.assertEqual(status['activity']['state'], 'running')
        await asyncio.gather(*self.service.tasks)

    async def test_same_content_upload_cleans_legacy_history_and_is_scoped(self):
        # Build history using the old retention behavior, then exercise migration.
        with patch.object(self.service, '_prune_versions', return_value=None):
            await self.upload()
            self.slot.write_bytes(b'newest'); await self.upload()
        folder = self.service.directory(123, self.game)
        tmp = self.root/'unrelated'; tmp.write_bytes(b'keep')
        unrelated = self.client.upload(tmp, folder, 'my-notes.zip')['fid']
        other_folder = self.service.directory(124, self.game, create=True)
        other = self.client.upload(tmp, other_folder, 'version-1700000000000-' + 'a'*32 + '.zip')['fid']
        same_name_dir = self.client.folder(folder, 'version-1700000000000-' + 'b'*32 + '.zip', create=True)
        await self.upload()
        names = [f['file_name'] for f in self.client.list_files(folder) if not f.get('dir')]
        self.assertEqual(sum(n.endswith('.json') for n in names), 1)
        self.assertEqual(sum(n.startswith('version-') and n.endswith('.zip') for n in names), 1)
        self.assertTrue(all(fid in self.client.items for fid in [unrelated, other, same_name_dir]))

    async def test_cleanup_failure_keeps_latest_downloadable_and_retries_on_next_upload(self):
        await self.upload()
        self.slot.write_bytes(b'new data')
        self.client.fail_delete = True
        result = await self.upload()
        self.assertIn('清理', result['message'])
        remote = self.service.latest(123, self.game)
        self.assertIn(remote['archive_fid'], self.client.payloads)
        self.client.fail_delete = False
        await self.upload()
        self.assertEqual(len([f for f in self.client.items.values() if f['file_name'].endswith('.json')]), 1)
        self.assertEqual(len([f for f in self.client.items.values() if f['file_name'].endswith('.zip')]), 1)
        self.assertIn(remote['archive_fid'], self.client.items)

    async def test_missing_new_archive_or_concurrent_new_revision_prevents_cleanup(self):
        with patch.object(self.service, '_prune_versions', return_value=None):
            await self.upload()
            self.slot.write_bytes(b'new data'); await self.upload()
        current = self.service.latest(123, self.game)
        folder = self.service.directory(123, self.game)
        before = self.client.list_files(folder)
        broken = dict(current, archive_fid='missing')
        self.assertIsNotNone(self.service._prune_versions(123, self.game, folder, before, broken))
        self.assertEqual(self.client.deleted, [])
        old = next(f for f in before if f['file_name'].endswith('.json') and f['fid'] != current['revision'])
        stale = dict(current, revision=old['fid'])
        self.assertIsNotNone(self.service._prune_versions(123, self.game, folder, before, stale))
        self.assertEqual(self.client.deleted, [])

    async def test_unconfirmed_index_deletion_never_deletes_its_archive(self):
        await self.upload()
        old = self.service.latest(123, self.game)
        self.slot.write_bytes(b'new data')
        # Quark may accept a delete request before its background task completes.
        with patch.object(self.client, 'delete_files', return_value=None) as delete, \
             patch('steamback.cloud.time.sleep'):
            result = await self.upload()
        self.assertIn('清理', result['message'])
        delete.assert_called_once_with([old['revision']])
        self.assertIn(old['archive_fid'], self.client.payloads)
        current = self.service.latest(123, self.game)
        self.assertNotEqual(current['revision'], old['revision'])
        await self.upload()
        self.assertNotIn(old['archive_fid'], self.client.items)
        self.assertIn(current['archive_fid'], self.client.items)

    async def test_recent_inflight_archives_protected_but_stale_orphans_reaped(self):
        import time
        await self.upload()
        folder = self.service.directory(123, self.game)
        src = self.root/'orphan.zip'; src.write_bytes(b'inflight')
        recent = self.client.upload(src, folder, 'version-1700000000000-'+'a'*32+'.zip')
        recent['created_at'] = int(time.time()*1000)
        stale = self.client.upload(src, folder, 'version-1700000000000-'+'b'*32+'.zip')
        stale['created_at'] = int(time.time()) - 2*24*3600
        await self.upload()
        self.assertIn(recent['fid'], self.client.items)
        self.assertNotIn(stale['fid'], self.client.items)

    async def test_files_created_after_upload_snapshot_are_not_pruned(self):
        await self.upload()
        folder = self.service.directory(123, self.game)
        before = self.client.list_files(folder)
        current = self.service.latest(123, self.game)
        src = self.root/'pending'; src.write_bytes(b'pending')
        newer = self.client.upload(src, folder, 'version-1700000000000-'+'c'*32+'.zip')
        self.service._prune_versions(123, self.game, folder, before, current)
        self.assertIn(newer['fid'], self.client.items)

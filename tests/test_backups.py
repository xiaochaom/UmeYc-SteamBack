"""使用临时目录验证真实文件备份、恢复和保留策略，不接触玩家存档。"""
import json
import logging
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from steamback import Config, Engine


class Backups(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data = self.root / "data"
        self.source = self.root / "游戏存档"
        self.source.mkdir()
        self.file = self.source / "进度.sav"
        self.file.write_text("第一章", encoding="utf-8")
        self.config = Config(logging.getLogger("test"), str(self.data), str(self.root / "Steam"))
        self.engine = Engine(self.config)
        self.game = {"game_id": 42, "game_name": "测试游戏", "install_root": self.config.steam_dir}
        self.engine.set_custom_game(self.game, [str(self.source)])

    async def test_snapshot_name_preserves_identity_timestamp_and_pin(self):
        save = await self.snapshot("chapter")
        updated = await self.engine.update_snapshot(save["filename"], True, "中文备注", "首领前")
        self.assertEqual(updated["name"], "首领前")
        self.assertEqual(updated["timestamp"], save["timestamp"])
        self.assertEqual(updated["filename"], save["filename"])
        self.assertTrue(updated["pinned"])
        updated = await self.engine.update_snapshot(save["filename"], False, "中文备注")
        self.assertEqual(updated["name"], "首领前")
        self.assertEqual((await Engine(self.config).get_saveinfos())[0]["name"], "首领前")
        with self.assertRaises(ValueError):
            await self.engine.update_snapshot(save["filename"], False, "", "x" * 101)
        await self.engine.do_restore({"filename": save["filename"]})

    async def snapshot(self, text):
        self.file.write_text(text, encoding="utf-8")
        result = await self.engine.do_backup(self.game)
        self.assertIsNotNone(result)
        return result

    async def test_old_auto_setting_has_no_effect_and_manual_clicks_always_save(self):
        self.data.mkdir(exist_ok=True)
        (self.data / "enabled_games.json").write_text("[42]")
        self.assertFalse(hasattr(self.engine, "set_game_enabled"))
        first = await self.engine.do_backup(self.game)
        second = await self.engine.do_backup(self.game)
        self.assertNotEqual(first["filename"], second["filename"])
        self.assertEqual(len(await self.engine.get_saveinfos()), 2)

    async def test_detected_aliases_share_one_backup_without_rewriting_old_mappings(self):
        self.engine.set_custom_game(self.game, [])
        alias = self.root / "Windows 兼容目录"
        alias.symlink_to(self.source, target_is_directory=True)
        other = self.root / "另一个存档目录"
        other.mkdir()
        (other / self.file.name).write_text("第二处存档", encoding="utf-8")
        cache = self.root / "cloud-cache"
        cache.mkdir()
        (cache / "remotecache.vdf").write_text(
            f'"42"\n{{\n"{self.file.name}"\n{{\n"size" "9"\n}}\n}}\n', encoding="utf-8")
        old_game = dict(self.game, save_games_roots={str(alias): "", str(self.source): "_1"})
        old_roots = dict(old_game["save_games_roots"])
        with patch.object(self.engine, "_get_gamedir", return_value=[str(cache)]), \
                patch.object(self.engine, "_parse_installdir", return_value=True), \
                patch.object(self.engine, "_search_likely_locations", return_value=[str(alias), str(self.source), str(other)]), \
                patch.object(self.engine, "_find_autoclouds", return_value=[]):
            supported = await self.engine.find_supported([old_game])
            roots = supported[0]["save_games_roots"]
            self.assertEqual(roots, {str(self.source.resolve()): "", str(other.resolve()): "_1"})
            self.assertEqual(old_game["save_games_roots"], old_roots)
            save = await self.engine.do_backup(old_game)
            self.assertEqual(save["game_info"]["save_games_roots"], roots)
            # One backup copy per real source; different sources remain separate.
            base = self.data / "saves2" / save["filename"]
            self.assertEqual((base / self.file.name).read_text(encoding="utf-8"), "第一章")
            self.assertEqual((Path(str(base) + "_1") / self.file.name).read_text(encoding="utf-8"), "第二处存档")
            self.assertFalse(Path(str(base) + "_2").exists())
            self.file.write_text("修改后", encoding="utf-8")
            await self.engine.do_restore(save)
            self.assertEqual(self.file.read_text(encoding="utf-8"), "第一章")

    async def test_noncloud_multi_directory_and_same_parent_files(self):
        second = self.root / "另一个目录"
        second.mkdir()
        (second / "config.dat").write_bytes(b"settings")
        one, two = self.root / "one.sav", self.root / "two.sav"
        one.write_bytes(b"one")
        two.write_bytes(b"two")
        self.engine.set_custom_game(self.game, [str(self.source), str(second), str(one), str(two)])
        save = await self.engine.do_backup(self.game)
        self.assertEqual(len(save["game_info"]["save_games_roots"]), 3)
        self.file.write_text("changed")
        one.write_bytes(b"new one")
        await self.engine.do_restore({"filename": save["filename"]})
        self.assertEqual(self.file.read_text(encoding="utf-8"), "第一章")
        self.assertEqual(one.read_bytes(), b"one")
        self.assertEqual(two.read_bytes(), b"two")
        undo = next(s for s in await self.engine.get_saveinfos() if s["is_undo"])
        await self.engine.do_restore(undo)
        self.assertEqual(self.file.read_text(), "changed")
        self.assertEqual(one.read_bytes(), b"new one")

    async def test_unchanged_and_backdated_content(self):
        await self.snapshot("aaaa")
        old_stat = self.file.stat()
        self.assertIsNotNone(await self.engine.do_backup(self.game))
        self.file.write_text("bbbb")
        os.utime(self.file, ns=(old_stat.st_atime_ns, old_stat.st_mtime_ns))
        self.assertIsNotNone(await self.engine.do_backup(self.game))

    async def test_all_backups_kept_and_pin_survives_restart(self):
        pinned = await self.snapshot("fixed")
        await self.engine.update_snapshot(pinned["filename"], True, "击败首领之前")
        for index in range(15):
            await self.snapshot(str(index))
        saves = await self.engine.get_saveinfos()
        self.assertEqual(len(saves), 16)
        self.assertEqual(sum(not s["pinned"] for s in saves), 15)
        restarted = Engine(self.config)
        fixed = next(s for s in await restarted.get_saveinfos() if s["pinned"])
        self.assertEqual(fixed["note"], "击败首领之前")
        self.assertEqual(fixed["timestamp"], pinned["timestamp"])

    async def test_unpin_never_deletes_even_after_new_backup(self):
        pinned = await self.snapshot("fixed")
        await self.engine.update_snapshot(pinned["filename"], True, "备注")
        await self.snapshot("new 1")
        await self.snapshot("new 2")
        await self.engine.update_snapshot(pinned["filename"], False, "备注")
        self.assertEqual(len(await self.engine.get_saveinfos()), 3)
        await self.snapshot("new 3")
        saves = await self.engine.get_saveinfos()
        self.assertEqual(len(saves), 4)
        self.assertIn(pinned["filename"], [s["filename"] for s in saves])

    async def test_restores_preserve_every_undo_and_existing_snapshot(self):
        original = await self.snapshot("original")
        for index in range(12):
            self.file.write_text(f"before restore {index}")
            await self.engine.do_restore({"filename": original["filename"]})
        saves = await self.engine.get_saveinfos()
        self.assertEqual(len(saves), 13)
        self.assertEqual(sum(s["is_undo"] for s in saves), 12)
        self.assertIn(original["filename"], [s["filename"] for s in saves])
        undo = next(s for s in saves if s["is_undo"])
        updated = await self.engine.update_snapshot(undo["filename"], True, "restore safety", "恢复前")
        self.assertTrue(updated["pinned"])
        self.assertEqual(updated["name"], "恢复前")

    async def test_manual_deletion_including_pinned_leaves_live_files(self):
        save = await self.snapshot("kept live")
        await self.engine.update_snapshot(save["filename"], True, "固定")
        with self.assertRaises(ValueError):
            self.engine._delete_savedir(save["filename"])
        self.assertTrue(await self.engine.delete_snapshot(save["filename"]))
        self.assertEqual(await self.engine.get_saveinfos(), [])
        self.assertEqual(self.file.read_text(), "kept live")
        self.assertEqual(list((self.data / "saves2").iterdir()), [])

    async def test_backing_up_other_game_keeps_existing_backups(self):
        first = await self.snapshot("first")
        other = dict(self.game, game_id=43)
        self.engine.set_custom_game(other, [str(self.source)])
        await self.engine.do_backup(other)
        self.assertIn(first["filename"], [s["filename"] for s in await self.engine.get_saveinfos()])

    async def test_restore_undo_when_live_file_was_deleted(self):
        save = await self.snapshot("restore me")
        self.file.unlink()
        await self.engine.do_restore(save)
        self.assertEqual(self.file.read_text(), "restore me")
        undo = next(s for s in await self.engine.get_saveinfos() if s["is_undo"])
        await self.engine.do_restore(undo)
        self.assertFalse(self.file.exists())

    async def test_restores_stored_paths_after_configuration_removed(self):
        save = await self.snapshot("original")
        self.engine.set_custom_game(self.game, [])
        self.file.write_text("new")
        await self.engine.do_restore(save)
        self.assertEqual(self.file.read_text(), "original")

    async def test_overlay_preserves_unrelated_new_files(self):
        save = await self.snapshot("original")
        extra = self.source / "new-slot.sav"
        extra.write_text("additional slot")
        await self.engine.do_restore(save)
        self.assertEqual(extra.read_text(), "additional slot")

    async def test_missing_backup_fails_before_live_write(self):
        save = await self.snapshot("old")
        (Path(self.engine._saveinfo_to_dir(save)) / self.file.name).unlink()
        self.file.write_text("current")
        with self.assertRaises(ValueError):
            await self.engine.do_restore(save)
        self.assertEqual(self.file.read_text(), "current")

    async def test_missing_mount_fails_without_empty_backup(self):
        self.source.rename(self.root / "unmounted")
        with self.assertRaises(ValueError):
            await self.engine.do_backup(self.game)
        self.assertEqual(await self.engine.get_saveinfos(), [])

    async def test_failed_copy_does_not_publish_metadata_or_partial_files(self):
        with patch("steamback.shutil.copy2", side_effect=OSError("磁盘已满")):
            with self.assertRaises(OSError):
                await self.engine.do_backup(self.game)
        self.assertEqual(await self.engine.get_saveinfos(), [])
        self.assertEqual(list((self.data / "saves2").iterdir()), [])

    async def test_legacy_snapshot_defaults(self):
        save = await self.snapshot("old")
        path = Path(self.engine._saveinfo_to_dir(save) + ".json")
        metadata = json.loads(path.read_text())
        metadata.pop("pinned")
        metadata.pop("note")
        metadata["game_info"]["save_games_root"] = str(self.source)
        metadata["game_info"].pop("save_games_roots")
        path.write_text(json.dumps(metadata))
        old = (await self.engine.get_saveinfos())[0]
        self.assertFalse(old["pinned"])
        self.assertEqual(old["note"], "")
        self.assertEqual(old["game_info"]["save_games_roots"], {str(self.source): ""})

    async def test_bad_paths_and_backup_ids_rejected(self):
        for path in [str(self.root), str(self.data), "/", "relative/path"]:
            with self.assertRaises(ValueError):
                self.engine.set_custom_game(self.game, [path])
        with self.assertRaises(ValueError):
            self.engine.set_custom_game(self.game, [str(self.source), str(self.file)])
        for bad in ["../outside", "/tmp/outside", "save_1_1/../../outside", "save_1_1*"]:
            with self.assertRaises(ValueError):
                await self.engine.delete_snapshot(bad)

    async def test_symlinks_not_followed_and_traversal_rejected(self):
        outside = self.root / "outside"
        outside.write_text("outside")
        (self.source / "link").symlink_to(outside)
        save = await self.snapshot("data")
        self.assertNotIn("link", save["files"][""])
        from steamback.custom import safe_file
        with self.assertRaises(ValueError):
            safe_file(self.source, "../outside")
        with self.assertRaises(ValueError):
            safe_file(self.source, "link")

    async def test_note_validation_and_timestamp_unchanged(self):
        save = await self.snapshot("data")
        with self.assertRaises(ValueError):
            await self.engine.update_snapshot(save["filename"], True, "长" * 501)
        updated = await self.engine.update_snapshot(save["filename"], True, "中文备注")
        self.assertEqual(updated["timestamp"], save["timestamp"])

    async def test_cloud_backup_without_custom_paths_and_restore_without_rcf(self):
        self.engine.set_custom_game(self.game, [])
        self.engine.add_account_id(123)
        remote = Path(self.config.steam_dir) / "userdata/123/42/remote"
        remote.mkdir(parents=True)
        (remote / "slot.sav").write_text("cloud old")
        rcf = remote.parent / "remotecache.vdf"
        rcf.write_text('"42"\n{\n"slot.sav"\n{\n"size" "9"\n}\n}\n')
        save = await self.engine.do_backup(self.game)
        self.assertIsNotNone(save)
        (remote / "slot.sav").write_text("cloud current")
        rcf.unlink()
        await self.engine.do_restore(save)
        self.assertEqual((remote / "slot.sav").read_text(), "cloud old")
        undo = next(s for s in await self.engine.get_saveinfos() if s["is_undo"])
        await self.engine.do_restore(undo)
        self.assertEqual((remote / "slot.sav").read_text(), "cloud current")

    async def test_empty_directory_and_dry_run_do_not_publish_snapshot(self):
        self.file.unlink()
        self.assertIsNone(await self.engine.do_backup(self.game))
        self.file.write_text("new")
        self.assertEqual(await self.engine.do_backup(self.game, dry_run=True), {})
        self.assertEqual(await self.engine.get_saveinfos(), [])


if __name__ == "__main__":
    unittest.main()

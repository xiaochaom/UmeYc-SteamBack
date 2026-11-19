import logging
import os
from pathlib import Path
import tempfile
import unittest
from steamback import Engine, Config
from steamback.sniff import SaveSniffer


class SniffTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.home = self.root/'home'; self.home.mkdir()
        self.engine = Engine(Config(logging.getLogger('test'), str(self.home/'homebrew/data'), str(self.home/'.local/share/Steam')))
        self.game = {'game_id': 42, 'game_name': 'test', 'install_root': self.engine.get_steam_root()}
        self.sniffer = SaveSniffer(self.engine, home=self.home)
        self.source = self.home/'.local/share/Game/Saved'; self.source.mkdir(parents=True)
        self.slot = self.source/'slot.sav'; self.slot.write_bytes(b'old')
        self.original = self.slot.stat().st_mtime_ns

    def test_diff_finds_new_and_modified_files_but_not_unchanged_logs_or_backups(self):
        self.sniffer.begin(self.game, 123)
        self.slot.write_bytes(b'new progress')
        new = self.source/'second.sav'; new.write_bytes(b'new slot')
        (self.source/'game.log').write_text('noise')
        cache = self.source/'Cache'; cache.mkdir(); (cache/'data.bin').write_bytes(b'noise')
        result = self.sniffer.finish(self.game, 123)
        self.assertEqual({c['path'] for c in result['candidates']}, {str(self.slot), str(new)})
        self.assertEqual(self.slot.read_bytes(), b'new progress')
        self.assertEqual(self.engine.get_custom_games(), [])
        self.assertEqual(self.sniffer.status(self.game, 123)['state'], 'ready')
        self.assertEqual(self.sniffer.status(self.game, 124)['state'], 'idle')
        self.assertEqual(self.sniffer.cancel(self.game, 123)['state'], 'idle')

    def test_prefix_created_after_baseline_is_discovered_and_other_steam_games_excluded(self):
        self.sniffer.begin(self.game, 123)
        prefix = Path(self.engine.get_steam_root())/'steamapps/compatdata/42/pfx/drive_c/users/steamuser/AppData/Local/Game'
        prefix.mkdir(parents=True); (prefix/'slot.sav').write_bytes(b'new')
        other = Path(self.engine.get_steam_root())/'steamapps/compatdata/99/pfx/drive_c/users/steamuser/AppData/Local/Game'
        other.mkdir(parents=True); (other/'slot.sav').write_bytes(b'other')
        result = self.sniffer.finish(self.game, 123)
        self.assertEqual([c['path'] for c in result['candidates']], [str(prefix/'slot.sav')])

    def test_no_baseline_and_bounded_scans_are_explicit(self):
        with self.assertRaisesRegex(ValueError, '先开始'):
            self.sniffer.finish(self.game, 123)
        self.sniffer.MAX_FILES = 1
        self.assertTrue(self.sniffer.begin(self.game, 123)['truncated'])
        self.sniffer.cancel(self.game, 123)
        self.assertEqual(self.sniffer.status(self.game, 123)['state'], 'idle')

    def test_symlinks_are_not_followed(self):
        outside = self.root/'outside'; outside.mkdir()
        (self.source/'alias').symlink_to(outside, target_is_directory=True)
        self.sniffer.begin(self.game, 123)
        (outside/'secret.sav').write_bytes(b'not a save')
        self.assertEqual(self.sniffer.finish(self.game, 123)['candidates'], [])

import tempfile
import unittest
from pathlib import Path
from steamback.browser import list_save_files


class SaveBrowser(unittest.TestCase):
    def test_directory_file_hidden_and_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '槽位').mkdir()
            (root / 'slot.sav').write_text('progress')
            (root / '.hidden').write_text('hidden progress')
            (root / 'link').symlink_to(root / 'slot.sav')
            result = list_save_files(str(root))
            self.assertEqual(result['directory'], str(root.resolve()))
            self.assertEqual(result['entries'][0]['name'], '槽位')
            self.assertEqual({e['name'] for e in result['entries']}, {'槽位', '.hidden', 'slot.sav'})
            self.assertEqual(list_save_files(str(root / 'slot.sav'))['directory'], str(root.resolve()))
            with self.assertRaises(ValueError):
                list_save_files('relative')
            with self.assertRaises(FileNotFoundError):
                list_save_files(str(root / 'missing'))

    def test_large_directory_is_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            for i in range(501):
                (Path(tmp) / str(i)).touch()
            result = list_save_files(tmp)
            self.assertEqual(len(result['entries']), 500)
            self.assertTrue(result['truncated'])

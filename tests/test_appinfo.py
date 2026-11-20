import struct
import tempfile
import unittest
from pathlib import Path
from steamback.appinfo import cloud_support

def fixture(version, apps=None):
    strings = []
    def string(value):
        return value.encode() + b"\0"
    def key(value):
        if version != 0x29:
            return string(value)
        if value not in strings:
            strings.append(value)
        return struct.pack("<I", strings.index(value))
    def encode(data):
        result = b""
        for name, value in data.items():
            result += (b"\0" if isinstance(value, dict) else b"\1") + key(name)
            result += encode(value) if isinstance(value, dict) else string(str(value))
        return result + b"\x08"
    payload = b""
    if apps is None:
        apps = {42: {"common": {"name": "Cloud", "category": {"category_23": "1"}}},
                43: {"common": {"name": "Local", "category": {"category_2": "1"}}}}
    for aid, app in apps.items():
        body = encode({"appinfo": app})
        header = bytes(60 if version >= 0x28 else 40)
        payload += struct.pack("<II", aid, len(header)+len(body)) + header + body
    payload += bytes(4)
    prefix = struct.pack("<II", 0x07564400 + version, 1)
    if version == 0x29:
        prefix += struct.pack("<Q", 16 + len(payload))
        return prefix + payload + struct.pack("<I", len(strings)) + b"".join(string(s) for s in strings)
    return prefix + payload



class SteamCloudMetadata(unittest.TestCase):
    def test_metadata_versions_and_missing_entries(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'appcache').mkdir()
            path = root/'appcache/appinfo.vdf'
            for version in [0x27, 0x28, 0x29]:
                with self.subTest(version=version):
                    path.write_bytes(fixture(version))
                    self.assertEqual(cloud_support(root, [42,43,44]), {'42':True,'43':False})
            path.write_bytes(b'invalid')
            self.assertEqual(cloud_support(root, [42]), {})

    def test_unused_ufs_configuration_does_not_advertise_steam_cloud(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'appcache').mkdir()
            for version in (0x27, 0x28, 0x29):
                with self.subTest(version=version):
                    (root / 'appcache/appinfo.vdf').write_bytes(fixture(version, regression_apps()))
                    self.assertEqual(cloud_support(root, [374320, 570940, 814380, 99]),
                                     {'374320': False, '570940': False, '814380': True})


def regression_apps():
    return {
        374320: {"common": {"name": "DARK SOULS III", "category": {"category_2": 1}},
                 "ufs": {"quota": "100000000000", "maxnumfiles": 10000, "hidecloudui": 1,
                         "ignoreexternalfiles": 1, "savefiles": {"0": {
                             "root": "WinAppDataRoaming", "path": "DarkSoulsIII", "pattern": "*.sl2"}}}},
        570940: {"common": {"name": "DARK SOULS REMASTERED", "category": {"category_2": 1}},
                 "ufs": {"quota": 167772160, "savefiles": {"0": {"pattern": "*.sl2"}}}},
        814380: {"common": {"name": "Sekiro", "category": {"category_23": 1}}},
    }

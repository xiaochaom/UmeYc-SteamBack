import struct
import tempfile
import unittest
from pathlib import Path
from steamback.appinfo import cloud_support

def fixture(version):
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
    for aid, category in [(42, {"category_23": "1"}), (43, {"category_2": "1"})]:
        body = encode({"appinfo": {"common": {"name": str(aid), "category": category}}})
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

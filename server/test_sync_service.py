"""Offline checks for Drive sync storage; Drive calls are replaced in memory."""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import sync_service
from sync_service import DriveSync, MANIFEST_NAME, preset_file_name


class FakeFiles:
    def __init__(self, store):
        self.store = store

    def delete(self, fileId):
        class Call:
            def execute(inner):
                for name, (fid, _) in list(self.store.items()):
                    if fid == fileId:
                        del self.store[name]
        return Call()


class FakeDrive:
    def __init__(self):
        self.store = {}  # name -> (id, data)

    def files(self):
        return FakeFiles(self.store)


class SyncServiceTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.session_path = os.path.join(directory.name, ".loy_user.json")
        self.drive = FakeDrive()
        store = self.drive.store
        self.sync = DriveSync(calendar_service=None, loy_session_path=self.session_path)
        patches = [
            patch.object(DriveSync, "_drive", lambda s: self.drive),
            patch.object(DriveSync, "_file_ids", lambda s, d: {name: fid for name, (fid, _) in store.items()}),
            patch.object(DriveSync, "_read_json", staticmethod(lambda d, fid: next(data for (i, data) in store.values() if i == fid))),
            patch.object(DriveSync, "_write_json", staticmethod(lambda d, ids, name, data: store.__setitem__(name, (ids.setdefault(name, name), json.loads(json.dumps(data)))))),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def write_session(self, value, stamp):
        with open(self.session_path, "w", encoding="utf-8") as f:
            json.dump(value, f)
        os.utime(self.session_path, (stamp, stamp))

    def test_presets_round_trip_and_deletions_remove_files(self):
        self.sync.push({"presets": {"a": {"hash": "1", "updatedAt": 5}}}, {"a": {"id": "a", "name": "A"}})
        self.assertEqual(self.sync.get_presets(["a", "missing"]), {"a": {"id": "a", "name": "A"}})
        self.sync.push({"presets": {"a": {"deleted": True, "updatedAt": 9}}}, {})
        self.assertNotIn(preset_file_name("a"), self.drive.store)

    def test_loy_session_moves_between_machines_but_not_to_the_browser(self):
        session = {"userid": "42", "key": "secret-key", "user": "me"}
        self.write_session(session, 1000)
        manifest = self.sync.get_manifest()
        self.assertTrue(manifest["needsPush"])
        self.assertNotIn("value", manifest["secrets"]["loySession"])
        self.sync.push({"presets": {}, "secrets": manifest["secrets"]}, {})
        stored = self.drive.store[MANIFEST_NAME][1]
        self.assertEqual(stored["secrets"]["loySession"]["value"], session)

        # A second machine with no LOY session receives it on its next sync.
        os.remove(self.session_path)
        manifest = self.sync.get_manifest()
        with open(self.session_path, encoding="utf-8") as f:
            self.assertEqual(json.load(f), session)
        self.assertFalse(manifest["needsPush"])

    def test_older_remote_session_does_not_replace_newer_local_sign_in(self):
        self.write_session({"userid": "1", "key": "old"}, 1000)
        self.sync.push({"presets": {}, "secrets": {}}, {})
        self.write_session({"userid": "2", "key": "new"}, 2000)
        self.sync.get_manifest()
        with open(self.session_path, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["key"], "new")


if __name__ == "__main__":
    unittest.main()

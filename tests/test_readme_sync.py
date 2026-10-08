"""Offline safety tests for the cross-repository README table updater."""

import runpy
from pathlib import Path
import unittest

SCRIPT = runpy.run_path(
    str(Path(__file__).resolve().parents[1] / "scripts" / "sync-es-repo-readmes.py")
)
TABLE = SCRIPT["TABLE"]
rewrite = SCRIPT["rewrite"]


class ReadmeSyncTests(unittest.TestCase):
    def test_replacement_preserves_other_sections_and_is_idempotent(self):
        original = "# Heading\n\nIntro\n\n## Part Of The Same Toolkit\n<table>\nOLD\n</table>\n\n## Footer\nDo not edit.\n"
        updated = rewrite(original)
        self.assertIn(TABLE, updated)
        self.assertEqual(updated[:updated.index("## Part Of The Same Toolkit")],
                         original[:original.index("## Part Of The Same Toolkit")])
        self.assertTrue(updated.endswith("\n\n## Footer\nDo not edit.\n"))
        self.assertEqual(rewrite(updated), updated)

    def test_crlf_existing_readme_stays_crlf(self):
        original = "intro\r\n## Part Of The Same Toolkit\r\n<table>\r\nold\r\n</table>\r\nfooter\r\n"
        updated = rewrite(original)
        self.assertEqual(updated.count("\n"), updated.count("\r\n"))
        self.assertEqual(rewrite(updated), updated)

    def test_missing_or_duplicate_table_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Expected exactly one"):
            rewrite("plain readme")
        with self.assertRaisesRegex(ValueError, "Expected exactly one"):
            rewrite("## Part Of The Same Toolkit\n<table></table>\n" * 2)
        with self.assertRaisesRegex(ValueError, "No closing"):
            rewrite("## Part Of The Same Toolkit\n<table>\n")

    def test_canonical_table_links_all_repositories_and_not_unpublished_previews(self):
        names = SCRIPT["ALL_REPOSITORIES"]
        self.assertEqual(len(names), len(set(names)))
        self.assertIn("essemble", names)
        self.assertNotIn("esobf", names)
        for name in names:
            self.assertIn(f"https://github.com/thelabcorner/{name}", TABLE)


if __name__ == "__main__":
    unittest.main()
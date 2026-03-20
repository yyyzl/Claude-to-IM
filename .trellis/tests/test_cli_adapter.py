import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str((REPO_ROOT / ".trellis" / "scripts").resolve()))

from common.cli_adapter import detect_platform  # noqa: E402


class DetectPlatformTests(unittest.TestCase):
    def test_prefers_claude_when_claude_and_gemini_configs_both_exist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            project_root = Path(tmp_dir)
            (project_root / ".claude").mkdir()
            (project_root / ".gemini").mkdir()

            self.assertEqual(detect_platform(project_root), "claude")


if __name__ == "__main__":
    unittest.main()

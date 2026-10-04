"""Fusion 会话隔离回归：只访问临时夹具，不读取真实会话或启动子进程。"""
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / ".trellis" / "scripts"))
from common.paths import set_current_task
from fusion import recovery_io


class FusionContextTests(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix="trellis-fusion-test-")
        self.addCleanup(self.fixture.cleanup)
        self.repo = Path(self.fixture.name).resolve()
        self.alpha = self.repo / ".trellis/tasks/alpha"
        self.beta = self.repo / ".trellis/tasks/beta"
        for task in [self.alpha, self.beta]:
            task.mkdir(parents=True)
        (self.repo / ".trellis/.current-task").write_text("tasks/stale", encoding="utf-8")
        self.enterContext(patch.dict(os.environ, {}, clear=True))
        self.enterContext(patch("common.active_task._lookup_shell_ticket_context_key", return_value=None))
        self.enterContext(patch("subprocess.Popen", side_effect=AssertionError("禁止真实子进程")))

    def test_hook_sessions_do_not_share_tasks(self):
        for platform in ["claude", "codex"]:
            with self.subTest(platform=platform):
                one = {"session_id": "one"}
                two = {"session_id": "two"}
                self.assertTrue(set_current_task(str(self.alpha), self.repo, one, platform))
                self.assertTrue(set_current_task(str(self.beta), self.repo, two, platform))
                self.assertEqual(recovery_io.get_task_dir_from_current(self.repo, one, platform), self.alpha)
                self.assertEqual(recovery_io.get_task_dir_from_current(self.repo, two, platform), self.beta)

    def test_missing_identity_does_not_use_legacy_or_single_session(self):
        self.assertTrue(set_current_task(str(self.alpha), self.repo, {"session_id": "only"}, "codex"))
        self.assertIsNone(recovery_io.get_task_dir_from_current(self.repo))
        self.assertIsNone(recovery_io.get_task_dir_from_current(self.repo, {"session_id": "unknown"}, "codex"))

    def test_checkpoint_and_resume_keep_environment_identity(self):
        self.assertTrue(set_current_task(str(self.alpha), self.repo, {"session_id": "shell"}, "codex"))
        with patch.dict(os.environ, {"CODEX_THREAD_ID": "shell"}):
            self.assertEqual(recovery_io.get_task_dir_from_current(self.repo), self.alpha)

    def test_hooks_forward_stdin_identity_and_platform(self):
        cases = [
            (".claude/hooks/fusion-session-start.py", "claude"),
            (".claude/hooks/fusion-pre-compact.py", "claude"),
            (".codex/hooks/fusion-session-start.py", "codex"),
        ]
        for relative, platform in cases:
            with self.subTest(hook=relative):
                payload = {"cwd": str(self.repo), "session_id": "hook-session"}
                spec = importlib.util.spec_from_file_location("fusion_hook_test", ROOT / relative)
                module = importlib.util.module_from_spec(spec)
                with patch.object(recovery_io, "get_task_dir_from_current", return_value=None) as resolver:
                    spec.loader.exec_module(module)
                    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch("sys.stdout", io.StringIO()):
                        try:
                            module.main()
                        except SystemExit as error:
                            self.assertEqual(error.code, 0)
                resolver.assert_called_once_with(self.repo, payload, platform)

    def test_malformed_hook_input_does_not_select_other_task(self):
        spec = importlib.util.spec_from_file_location("fusion_codex_hook_test", ROOT / ".codex/hooks/fusion-session-start.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with patch.object(recovery_io, "get_task_dir_from_current", return_value=None) as resolver:
            with patch("sys.stdin", io.StringIO("[]")), patch("sys.stdout", io.StringIO()):
                with self.assertRaises(SystemExit) as result:
                    module.main()
            self.assertEqual(result.exception.code, 0)
            resolver.assert_called_once_with(Path.cwd().resolve(), {}, "codex")


if __name__ == "__main__":
    unittest.main()

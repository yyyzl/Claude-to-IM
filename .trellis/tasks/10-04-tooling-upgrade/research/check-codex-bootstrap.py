"""临时项目验证 Codex 新入口；不访问真实任务、会话或网络。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

# 任务可归档到 tasks/archive/<月份>，仓库位置不能依赖任务目录深度。
REPO = next(
    parent for parent in Path(__file__).resolve().parents
    if (parent / ".trellis/scripts/common").is_dir()
    and (parent / ".codex/hooks").is_dir()
)


class CodexBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="trellis-bootstrap-check-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        common = self.root / ".trellis/scripts/common"
        common.mkdir(parents=True)
        (common / "__init__.py").write_text("", encoding="utf-8")
        for name in ("active_task.py", "io.py", "trellis_config.py"):
            shutil.copyfile(REPO / ".trellis/scripts/common" / name, common / name)
        hooks = self.root / ".codex/hooks"
        hooks.mkdir(parents=True)
        self.hook = hooks / "inject-workflow-state.py"
        shutil.copyfile(REPO / ".codex/hooks/inject-workflow-state.py", self.hook)
        (self.root / ".trellis/workflow.md").write_text(
            "[workflow-state:no_task]\nNO_TASK_FIXTURE\n[/workflow-state:no_task]\n"
            "[workflow-state:in_progress]\nACTIVE_FIXTURE\n[/workflow-state:in_progress]\n",
            encoding="utf-8",
        )
        guard = self.root / "sitecustomize.py"
        guard.write_text(
            "import socket, subprocess\n"
            "def deny(*args, **kwargs):\n    raise RuntimeError('fixture 禁止网络及嵌套子进程')\n"
            "socket.socket.connect = deny\nsocket.create_connection = deny\n"
            "subprocess.Popen = deny\n",
            encoding="utf-8",
        )
        self.env = {k: os.environ[k] for k in ("SystemRoot", "PATH", "TEMP", "TMP") if k in os.environ}
        self.env.update({"PYTHONPATH": str(self.root), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1"})

    def run_hook(self, session="fixture-one", prompt="check", cwd=None):
        payload = {"cwd": str(cwd or self.root), "prompt": prompt}
        if session is not None:
            payload["session_id"] = session
        result = subprocess.run(
            [sys.executable, str(self.hook)], input=json.dumps(payload), text=True,
            encoding="utf-8", capture_output=True, cwd=self.root, env=self.env, timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        if not result.stdout:
            return ""
        output = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "UserPromptSubmit")
        return output["additionalContext"]

    def bind_fixture(self):
        task = self.root / ".trellis/tasks/fixture-task"
        task.mkdir(parents=True)
        (task / "task.json").write_text(json.dumps({"id": "fixture-task", "status": "in_progress"}), encoding="utf-8")
        sessions = self.root / ".trellis/.runtime/sessions"
        sessions.mkdir(parents=True)
        (sessions / "codex_fixture-one.json").write_text(
            json.dumps({"current_task": ".trellis/tasks/fixture-task"}), encoding="utf-8",
        )

    def test_no_task_has_start_skill_bootstrap(self):
        text = self.run_hook()
        self.assertIn("<trellis-bootstrap>", text)
        self.assertIn("trellis-start", text)
        self.assertIn("NO_TASK_FIXTURE", text)

    def test_bound_task_uses_current_session_from_subdirectory(self):
        self.bind_fixture()
        nested = self.root / "nested"
        nested.mkdir()
        text = self.run_hook(cwd=nested)
        self.assertIn("Task: fixture-task (in_progress)", text)
        self.assertIn("ACTIVE_FIXTURE", text)
        self.assertNotIn("<trellis-bootstrap>", text)

    def test_missing_or_foreign_session_never_inherits_single_task(self):
        self.bind_fixture()
        for session in (None, "fixture-two"):
            with self.subTest(session=session):
                text = self.run_hook(session=session)
                self.assertIn("NO_TASK_FIXTURE", text)
                self.assertNotIn("Task: fixture-task", text)

    def test_skip_keyword_remains_honored(self):
        self.assertEqual(self.run_hook(prompt="check no-trellis"), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Fusion Session Start Hook — 在新会话开始时注入 .fusion/ 恢复数据。
独立于 upstream session-start.py，不修改任何原有文件。
"""
import json
import os
import sys
from io import StringIO
from pathlib import Path

if sys.platform == "win32":
    import io as _io
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 复用 recovery_io 的路径解析逻辑（消除 DRY 违反）
_project_dir = Path(os.environ.get("CLAUDE_PROJECT_DIR", ".")).resolve()
_scripts_dir = _project_dir / ".trellis" / "scripts"
if str(_scripts_dir) not in sys.path:
    sys.path.insert(0, str(_scripts_dir))

from fusion.recovery_io import get_task_dir_from_current


def read_file(path: Path, fallback: str = "") -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (FileNotFoundError, PermissionError, OSError):
        return fallback


def main():
    # 非交互模式跳过
    if os.environ.get("CLAUDE_NON_INTERACTIVE") == "1":
        sys.exit(0)

    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, OSError):
        hook_input = {}
    if not isinstance(hook_input, dict):
        hook_input = {}
    project_dir = Path(hook_input.get("cwd") or _project_dir).resolve()

    task_dir = get_task_dir_from_current(project_dir, hook_input, "claude")
    if not task_dir or not task_dir.is_dir():
        # 无活跃任务，不注入任何内容
        sys.exit(0)

    fusion_dir = task_dir / ".fusion"
    if not fusion_dir.is_dir():
        # 无 .fusion/ 目录，不注入
        sys.exit(0)

    output = StringIO()
    injected = False

    # 1. 注入 handoff.md（短摘要，适合上下文）
    handoff_file = fusion_dir / "handoff.md"
    if handoff_file.is_file():
        content = read_file(handoff_file)
        if content.strip():
            output.write("<fusion-handoff>\n")
            output.write(content)
            output.write("\n</fusion-handoff>\n\n")
            injected = True

    # 2. 注入 recovery.json 的关键字段摘要（不注入全量）
    recovery_file = fusion_dir / "recovery.json"
    if recovery_file.is_file():
        try:
            data = json.loads(recovery_file.read_text(encoding="utf-8"))
            progress = data.get("plan_progress", {})
            if progress:
                current = progress.get("current_slice", "?")
                total = progress.get("total_slices", "?")
                next_action = progress.get("next_recommended_action", "")
                output.write("<fusion-recovery-summary>\n")
                output.write(f"Plan Progress: Slice {current} / {total}\n")
                if next_action:
                    output.write(f"Next Action: {next_action}\n")
                blockers = data.get("blockers", [])
                if blockers:
                    output.write(f"Blockers: {'; '.join(blockers)}\n")
                validation = data.get("validation", {})
                if validation:
                    build = validation.get("build_status", "")
                    test = validation.get("test_status", "")
                    if build or test:
                        output.write(f"Build: {build}, Tests: {test}\n")
                output.write(f"\nFull recovery data: {recovery_file}\n")
                output.write("</fusion-recovery-summary>\n\n")
                injected = True
        except (json.JSONDecodeError, OSError):
            pass

    # 3. 注入 contract.md（如有）
    contract_file = fusion_dir / "contract.md"
    if contract_file.is_file():
        content = read_file(contract_file)
        if content.strip():
            output.write("<fusion-contract>\n")
            output.write(content)
            output.write("\n</fusion-contract>\n\n")
            injected = True

    if not injected:
        sys.exit(0)

    # 输出 hook 结果
    result = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": output.getvalue(),
        }
    }
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()

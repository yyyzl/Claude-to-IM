#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Codex Fusion Session Start Hook — Inject .fusion/ recovery data into Codex sessions.

Independent from upstream session-start.py — does NOT modify any existing files.

Output format follows Codex hook protocol:
  stdout JSON → { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "..." } }
"""
from __future__ import annotations

import json
import os
import sys
import warnings
from io import StringIO
from pathlib import Path

warnings.filterwarnings("ignore")

if sys.platform == "win32":
    import io as _io
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def should_skip_injection() -> bool:
    return os.environ.get("CODEX_NON_INTERACTIVE") == "1"


def read_file(path: Path, fallback: str = "") -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (FileNotFoundError, PermissionError, OSError):
        return fallback


def main() -> None:
    if should_skip_injection():
        sys.exit(0)

    # Read hook input from stdin (Codex protocol)
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, OSError):
        hook_input = {}
    if not isinstance(hook_input, dict):
        hook_input = {}
    project_dir = Path(hook_input.get("cwd") or ".").resolve()
    scripts_dir = str(project_dir / ".trellis" / "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    from fusion.recovery_io import get_task_dir_from_current

    task_dir = get_task_dir_from_current(project_dir, hook_input, "codex")
    if not task_dir or not task_dir.is_dir():
        # No active task — nothing to inject
        sys.exit(0)

    fusion_dir = task_dir / ".fusion"
    if not fusion_dir.is_dir():
        # No .fusion/ directory — nothing to inject
        sys.exit(0)

    output = StringIO()
    injected = False

    # 1. Inject handoff.md (short summary, ideal for context)
    handoff_file = fusion_dir / "handoff.md"
    if handoff_file.is_file():
        content = read_file(handoff_file)
        if content.strip():
            output.write("<fusion-handoff>\n")
            output.write(content)
            output.write("\n</fusion-handoff>\n\n")
            injected = True

    # 2. Inject recovery.json key fields summary (not full JSON)
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

    # 3. Inject contract.md (if present)
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

    # Emit Codex hook protocol output
    context = output.getvalue()
    result = {
        "suppressOutput": True,
        "systemMessage": f"Fusion context injected ({len(context)} chars)",
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context,
        },
    }

    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()

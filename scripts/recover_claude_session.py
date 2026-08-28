import json
import re
import sys
from pathlib import Path


SOURCE_MARKER = "matt-pocock-setup"
PROJECT_PARTS = ("packages/web/", "packages/server/")


def normalized(path: str) -> str:
    return path.replace("\\", "/")


def destination(path: str, root: Path) -> Path | None:
    path = normalized(path)
    for prefix, target in (("packages/web/", "front/"), ("packages/server/", "back/")):
        marker = f"{SOURCE_MARKER}/{prefix}"
        if marker in path:
            relative = path.split(marker, 1)[1]
            if relative and "node_modules/" not in relative and not relative.startswith("dist/"):
                return root / target / relative
    return None


def read_text(content) -> str | None:
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        texts = [part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text"]
        text = "\n".join(texts)
    else:
        return None
    lines = text.splitlines()
    cleaned = []
    numbered = 0
    for line in lines:
        match = re.match(r"^\s*\d+[→\t](.*)$", line)
        if match:
            numbered += 1
            cleaned.append(match.group(1))
        else:
            cleaned.append(line)
    if numbered < max(1, len(lines) // 2):
        return None
    return "\n".join(cleaned) + "\n"


def main() -> int:
    log_path = Path(sys.argv[1])
    output_root = Path(sys.argv[2])
    calls: dict[str, dict] = {}
    states: dict[Path, str] = {}
    failures: list[str] = []

    for raw_line in log_path.open(encoding="utf-8"):
        try:
            record = json.loads(raw_line)
        except json.JSONDecodeError:
            continue
        message = record.get("message")
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "tool_use":
                tool_id = item.get("id")
                tool_name = item.get("name")
                tool_input = item.get("input") or {}
                if tool_id:
                    calls[tool_id] = {"name": tool_name, "input": tool_input}
                path = tool_input.get("file_path")
                target = destination(path, output_root) if isinstance(path, str) else None
                if target is None:
                    continue
                if tool_name == "Write":
                    states[target] = tool_input.get("content", "")
                elif tool_name == "Edit" and target in states:
                    old = tool_input.get("old_string", "")
                    new = tool_input.get("new_string", "")
                    replace_all = bool(tool_input.get("replace_all"))
                    current = states[target]
                    if old not in current:
                        failures.append(f"Edit pattern missing: {target}")
                    else:
                        states[target] = current.replace(old, new) if replace_all else current.replace(old, new, 1)
            elif item.get("type") == "tool_result":
                call = calls.get(item.get("tool_use_id"))
                if not call or call["name"] != "Read":
                    continue
                tool_input = call["input"]
                if tool_input.get("offset") is not None or tool_input.get("limit") is not None:
                    continue
                path = tool_input.get("file_path")
                target = destination(path, output_root) if isinstance(path, str) else None
                recovered = read_text(item.get("content"))
                if target is not None and recovered is not None:
                    states[target] = recovered

    for path, content in states.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
    print(f"Recovered {len(states)} files")
    print(f"Unapplied edits: {len(failures)}")
    for failure in failures[-30:]:
        print(failure)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

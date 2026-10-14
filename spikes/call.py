#!/usr/bin/env python3
"""One MCP tool call from the command line — for driving Figma step by step.

    python spikes/call.py figma_status
    python spikes/call.py figma_create_frame '{"name": "Card", "layout": "vertical"}'

Prints the structured result as JSON. An image result (figma_export_node) is
saved to spikes/results/last-export.png and its path printed, so a person — or an
agent — can look at it before the next step.
"""
import base64
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcpc import REPO, Session  # noqa: E402


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    name = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    with Session(allow_eval=False) as s:
        r = s.rpc("tools/call", {"name": name, "arguments": args})
    if "error" in r:
        print("TRANSPORT ERROR", json.dumps(r["error"])[:500])
        return 1
    res = r.get("result", {})
    for block in res.get("content", []):
        if block.get("type") == "image":
            out = os.path.join(REPO, "spikes", "results", "last-export.png")
            with open(out, "wb") as f:
                f.write(base64.b64decode(block["data"]))
            print(f"[image saved: {out}]")
    if res.get("isError"):
        print("ERROR", " ".join(c.get("text", "") for c in res.get("content", []))[:1500])
        return 1
    sc = res.get("structuredContent")
    if sc is not None:
        print(json.dumps(sc, indent=1, ensure_ascii=False)[:12000])
    else:
        for block in res.get("content", []):
            if block.get("type") == "text":
                print(block["text"][:12000])
    return 0


if __name__ == "__main__":
    sys.exit(main())

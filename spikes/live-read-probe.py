#!/usr/bin/env python3
"""Exercise every registered read tool against the operator's real Figma canvas.

This is the test that automated tests cannot do: the mocks in test/ implement
the Figma API as this project *believes* it works. A wrong belief — like `Buffer`
being available in the sandbox — passes every test and throws only here.

Read-only by construction: nothing in this script writes to the document. Each
call goes over stdio to the real bridge, which forwards to the real plugin.
"""
import json
import os
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Mcp:
    def __init__(self):
        self.p = subprocess.Popen(
            ["node", "dist/server.js"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, cwd=REPO,
            env={**os.environ, "BRIDGE_SESSION_WAIT_MS": "5000"},
        )
        self.id = 0
        self.req("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                "clientInfo": {"name": "live-read-probe", "version": "0"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.p.stdin.flush()

    def req(self, method, params, timeout=25):
        self.id += 1
        mid = self.id
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        end = time.time() + timeout
        while time.time() < end:
            line = self.p.stdout.readline()
            if not line:
                time.sleep(0.05)
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == mid:
                return msg
        return {"error": {"message": f"timeout after {timeout}s"}}

    def call(self, name, args=None, timeout=25):
        r = self.req("tools/call", {"name": name, "arguments": args or {}}, timeout)
        if "error" in r:
            return {"__transport_error": r["error"].get("message", str(r["error"]))}
        res = r.get("result", {})
        if res.get("isError"):
            txt = " ".join(c.get("text", "") for c in res.get("content", []))
            return {"__tool_error": txt[:400]}
        return res.get("structuredContent") or {"__content": res.get("content")}

    def close(self):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.terminate()
        except Exception:
            pass


def brief(v, n=200):
    s = json.dumps(v, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + "…"


def main():
    c = Mcp()
    results = []

    def run(name, args=None, note=""):
        out = c.call(name, args)
        results.append((name, args or {}, out, note))
        return out

    # 1. metadata — the entry point; also proves the plugin's own figma root read.
    md = run("figma_get_metadata", note="file + page list")
    # Pick a real node id from the canvas to use as a target for the node tools.
    sel = run("figma_get_selection", {"depth": 1}, "whatever is selected")
    ids = []
    if isinstance(sel, dict) and isinstance(sel.get("nodes"), list):
        ids = [n.get("id") for n in sel["nodes"] if isinstance(n, dict) and n.get("id")]
    search = run("figma_search_nodes", {"query": "yield", "limit": 5}, "name substring")
    if not ids and isinstance(search, dict) and isinstance(search.get("nodes"), list):
        ids = [n.get("id") for n in search["nodes"] if isinstance(n, dict) and n.get("id")]
    target = ids[0] if ids else None

    run("figma_get_pages")
    if target:
        run("figma_get_node", {"nodeId": target, "depth": 2}, f"target {target}")
        run("figma_get_nodes_info", {"nodeIds": ids[:3], "depth": 0}, "batch of 3")
    run("figma_get_design_context", {"depth": 2, "maxNodes": 200}, "bounded tree")
    run("figma_scan_nodes_by_types", {"types": ["FRAME", "RECTANGLE"], "limit": 20})
    run("figma_scan_text_nodes", {"limit": 20}, "copy audit")
    run("figma_get_styles")
    run("figma_get_variable_defs", note="tokens; C-046/C-047 apply")
    run("figma_get_local_components")
    run("figma_get_fonts", {"scope": "page"}, "fonts on the page")
    run("figma_get_annotations")
    if target:
        run("figma_get_reactions", {"nodeId": target})

    c.close()

    # ── report ──────────────────────────────────────────────────────────────
    ok, failed = 0, 0
    print("\n" + "=" * 78)
    print("LIVE READ TOOLS AGAINST THE REAL FIGMA CANVAS")
    print("=" * 78)
    for name, args, out, note in results:
        if "__transport_error" in out:
            failed += 1
            print(f"\n✗ {name}  [{note}]")
            print(f"    TRANSPORT: {out['__transport_error']}")
        elif "__tool_error" in out:
            failed += 1
            print(f"\n✗ {name}  {brief(args, 60)}  [{note}]")
            print(f"    TOOL ERROR: {out['__tool_error']}")
        else:
            ok += 1
            print(f"\n✓ {name}  {brief(args, 60)}  [{note}]")
            print(f"    {brief(out, 320)}")

    print("\n" + "=" * 78)
    print(f"  {ok} ok, {failed} failed, {len(results)} total")
    print("=" * 78)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

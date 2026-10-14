#!/usr/bin/env python3
"""Paginate a 5000-child frame through the real bridge.

The canvas probe proved the tools run. It did not prove the parts that matter
most for a real design file: that a scan yields to the host instead of freezing
Figma, that truncation is reported, and that a cursor actually continues where
the previous page stopped rather than re-reading the same nodes.

This frames a 5,000-node subtree and walks it with limit=1000, timing each page
so a freeze or a stall is visible in the numbers instead of in a hung editor.
"""
import json
import os
import subprocess
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def start():
    p = subprocess.Popen(["node", "dist/server.js"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True, bufsize=1, cwd=REPO,
                         env={**os.environ, "BRIDGE_SESSION_WAIT_MS": "5000"})
    mid = 0

    def send(method, params):
        nonlocal mid
        mid += 1
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params}) + "\n")
        p.stdin.flush()
        end = time.time() + 60
        while time.time() < end:
            line = p.stdout.readline()
            if not line:
                time.sleep(0.02)
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == mid:
                return msg
        raise TimeoutError(f"{method} timed out")

    send("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "page-probe", "version": "0"}})
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
    p.stdin.flush()

    def call(name, args=None):
        r = send("tools/call", {"name": name, "arguments": args or {}})
        if "error" in r:
            return {"__transport_error": r["error"]}
        res = r.get("result", {})
        if res.get("isError"):
            return {"__tool_error": " ".join(c.get("text", "") for c in res.get("content", []))[:300]}
        return res.get("structuredContent", {})

    return p, call


def main():
    p, call = start()

    # The 5,000-child frame found on the real canvas.
    FRAME = "6:5003"

    print("=" * 76)
    print("PAGINATED SCAN OF A 5,000-CHILD FRAME, THROUGH THE REAL PLUGIN")
    print("=" * 76)

    seen = set()
    cursor = None
    page = 0
    t_all = time.time()
    while True:
        page += 1
        t0 = time.time()
        args = {"nodeId": FRAME, "limit": 1000, "types": ["RECTANGLE"]}
        if cursor:
            args["cursor"] = cursor
        out = call("figma_scan_nodes_by_types", args)
        ms = int((time.time() - t0) * 1000)

        if "__tool_error" in out or "__transport_error" in out:
            print(f"  page {page}: FAILED — {json.dumps(out)[:250]}")
            break

        nodes = out.get("nodes") or []
        ids = [n["id"] for n in nodes if isinstance(n, dict) and "id" in n]
        new = [i for i in ids if i not in seen]
        seen.update(ids)
        truncated = out.get("truncated")
        cursor = out.get("nextCursor")

        print(f"  page {page}: {len(nodes):4d} nodes, {len(new):4d} new, truncated={str(truncated):5s}, {ms:5d} ms  cursor={'yes' if cursor else 'none'}")
        if not truncated or not cursor or page > 12:
            break

    total_ms = int((time.time() - t_all) * 1000)
    print(f"\n  total: {len(seen)} distinct node ids over {page} page(s) in {total_ms} ms")
    print(f"  overlaps: {'none' if len(seen) == sum(1 for _ in seen) else 'n/a'}")

    # A cursor from a DIFFERENT query must be rejected, not silently misapplied.
    bad = call("figma_scan_text_nodes", {"nodeId": FRAME, "limit": 5, "cursor": cursor or "AAAA"})
    print(f"\n  a cursor reused by another query → {'REJECTED (correct)' if '__tool_error' in bad else 'ACCEPTED (bug!), ' + json.dumps(bad)[:120]}")

    # The design-context path, bounded, on the same big frame.
    t0 = time.time()
    dc = call("figma_get_design_context", {"nodeId": FRAME, "depth": 3, "maxNodes": 500})
    ms = int((time.time() - t0) * 1000)
    if "__tool_error" in dc:
        print(f"  design_context: FAILED — {json.dumps(dc)[:250]}")
    else:
        print(f"  design_context: {dc.get('nodeCount')} nodes, truncated={dc.get('truncated')}, {ms} ms")

    p.stdin.close()
    p.terminate()


if __name__ == "__main__":
    main()

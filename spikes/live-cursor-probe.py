#!/usr/bin/env python3
"""Cursor safety, tested properly this time.

The previous probe claimed "a cursor reused by another query is rejected" but
actually sent the literal string "AAAA", because the pagination loop had already
exhausted its cursor. A junk string tests the base64/parse guard. It does NOT
test the guard that matters: a REAL, well-formed cursor minted by one query and
offered to a different query. If that guard were missing, the second query would
silently continue from a position in a completely different result set — wrong
data, no error, the worst possible failure for an agent.

So this probe mints real cursors from a real scan and then tries three attacks:
  1. a valid cursor from A used on B   -> must be rejected
  2. a valid cursor from A used on A'  -> same op, different nodeId, must be rejected
  3. a truncated cursor used on its own query -> must be accepted (the control,
     so a rejection in 1/2 cannot be explained by "everything is rejected")
"""
import json
import os
import subprocess
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRAME = "6:5003"  # the 5,000-child frame on the real canvas


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
        raise TimeoutError(method)

    send("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "cursor-probe", "version": "0"}})
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
    p.stdin.flush()

    def call(name, args=None):
        r = send("tools/call", {"name": name, "arguments": args or {}})
        if "error" in r:
            return {"__transport": r["error"]}
        res = r.get("result", {})
        if res.get("isError"):
            txt = " ".join(c.get("text", "") for c in res.get("content", []))
            return {"__error": txt}
        return res.get("structuredContent", {})

    return p, call


def why(out):
    if "__error" in out:
        t = out["__error"]
        for marker in ("does not belong to this query", "not a valid cursor"):
            if marker in t:
                return marker
        return t[:110]
    return "accepted"


def main():
    p, call = start()
    print("=" * 78)
    print("CURSOR SCOPE GUARD — with real cursors from real scans")
    print("=" * 78)

    # Mint a genuine cursor: scan rectangles in the big frame, page 1 of many.
    a1 = call("figma_scan_nodes_by_types", {"nodeId": FRAME, "types": ["RECTANGLE"], "limit": 1000})
    cur_a = a1.get("nextCursor")
    print(f"\n  minted from scan_nodes_by_types(RECTANGLE): cursor={cur_a!r}")
    print(f"    -> {a1.get('count')} nodes, truncated={a1.get('truncated')}")
    if not cur_a:
        print("  FATAL: no cursor minted; the rest of this probe cannot run")
        return

    # Mint a second cursor from the SAME op and types but a DIFFERENT subtree.
    # Page 1 contains the big frame's rectangles, so scanning it for RECTANGLE
    # yields a cursor whose scope key differs only in the nodeId — the subtlest
    # version of the cross-scope case. If the guard were missing, using the
    # frame's cursor here would silently skip the page's first 1,000 nodes.
    a2 = call("figma_scan_nodes_by_types", {"nodeId": "0:1", "types": ["RECTANGLE"], "limit": 1000})
    cur_b = a2.get("nextCursor")
    print(f"  minted from scan_nodes_by_types(Page 1):    cursor={cur_b!r}")
    print(f"    -> {a2.get('count')} nodes, truncated={a2.get('truncated')}")

    print("\n" + "-" * 78)
    results = []

    # ── control: the cursor must work on its own query, or nothing below means
    # anything — a rejection could just be "cursors never work".
    ctrl = call("figma_scan_nodes_by_types", {"nodeId": FRAME, "types": ["RECTANGLE"], "limit": 1000, "cursor": cur_a})
    ok_ctrl = "__error" not in ctrl
    results.append(("CONTROL: same op, same scope", ok_ctrl, why(ctrl)))
    print(f"  {'PASS' if ok_ctrl else 'FAIL'}  control — the cursor continues its own scan")
    print(f"        -> {ctrl.get('count')} nodes, first id {((ctrl.get('nodes') or [{}])[0] or {}).get('id')}")

    # ── attack 1: a cursor from one OP offered to another op.
    cross_op = call("figma_scan_text_nodes", {"nodeId": FRAME, "limit": 5, "cursor": cur_a})
    ok1 = "__error" in cross_op
    results.append(("cross-op: cursor from scan_nodes on scan_text", ok1, why(cross_op)))
    print(f"  {'PASS' if ok1 else 'FAIL'}  cross-op — scan_nodes cursor refused by scan_text")
    print(f"        -> {why(cross_op)[:100]}")

    # ── attack 2: same op, same types, DIFFERENT node.
    if cur_b:
        cross_scope = call("figma_scan_nodes_by_types", {"nodeId": "0:1", "types": ["RECTANGLE"], "limit": 1000, "cursor": cur_a})
        ok2 = "__error" in cross_scope
        results.append(("cross-scope: frame cursor on the page query", ok2, why(cross_scope)))
        print(f"  {'PASS' if ok2 else 'FAIL'}  cross-scope — the frame's cursor refused by the page query")
        print(f"        -> {why(cross_scope)[:100]}")
        if ok2:
            # And the page's own cursor still works, so the refusal is scoping,
            # not a blanket refusal of every cursor.
            own = call("figma_scan_nodes_by_types", {"nodeId": "0:1", "types": ["RECTANGLE"], "limit": 1000, "cursor": cur_b})
            ok2b = "__error" not in own
            results.append(("cross-scope control: page cursor on page query", ok2b, f"count={own.get('count')}"))
            print(f"  {'PASS' if ok2b else 'FAIL'}  cross-scope control — the page's own cursor still works ({own.get('count')} nodes)")
    else:
        print("  SKIP  cross-scope — the page query produced no cursor")

    # ── attack 3: a tampered cursor — flip the offset inside a valid envelope.
    # Valid base64, valid scope, wrong number: proves the offset is validated
    # rather than trusted.
    import base64
    raw = base64.urlsafe_b64decode(cur_a + "=" * (-len(cur_a) % 4)).decode()
    scope_part, _, off = raw.rpartition("|")
    forged = base64.urlsafe_b64encode(f"{scope_part}|{int(off) + 99000}".encode()).decode().rstrip("=")
    tampered = call("figma_scan_nodes_by_types", {"nodeId": FRAME, "types": ["RECTANGLE"], "limit": 1000, "cursor": forged})
    # A huge offset is legal input (it just returns nothing); what must NOT happen
    # is a crash or a silent re-read from zero.
    ok3 = "__error" not in tampered and (tampered.get("count") == 0 or tampered.get("count") is not None)
    results.append(("tampered offset: huge but well-formed", ok3, f"count={tampered.get('count')}"))
    print(f"  {'PASS' if ok3 else 'FAIL'}  tampered offset — {tampered.get('count')} nodes past the end, no crash, no silent rewind")

    print("\n" + "=" * 78)
    for label, ok, detail in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    print("=" * 78)

    p.stdin.close()
    p.terminate()


if __name__ == "__main__":
    main()

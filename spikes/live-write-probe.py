#!/usr/bin/env python3
"""Exercise the Phase 2 write tools against the real canvas, then clean up.

Every write here is one commitUndo step, so the whole probe is revertible by the
operator with a single Ctrl+Z per call — and this script deletes what it created
anyway. It checks the things a mock cannot:

  - does create_from_spec actually build a nested tree with auto-layout,
  - does the returned id match what a read then sees,
  - do the per-item results name the failures instead of throwing,
  - does delete_nodes leave the canvas as it found it.

Read-only with respect to anything the operator made: it creates its own section
named for the probe and deletes exactly the ids it created.
"""
import base64
import json
import os
import re
import subprocess
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Unique per run: the plugin remembers a key for 15 minutes, so a fixed key
# would replay the previous run instead of exercising this one.
RUN_KEY = f"probe-spec-{int(time.time())}"


class Mcp:
    def __init__(self):
        self.p = subprocess.Popen(
            ["node", "dist/server.js"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1, cwd=REPO,  # the server speaks UTF-8; Windows locales may not (cp932 here)
            env={**os.environ, "BRIDGE_SESSION_WAIT_MS": "5000"},
        )
        self.id = 0
        self.rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                "clientInfo": {"name": "live-write-probe", "version": "0"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.p.stdin.flush()

    def rpc(self, method, params, timeout=40):
        self.id += 1
        mid = self.id
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        end = time.time() + timeout
        while time.time() < end:
            line = self.p.stdout.readline()
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

    def call(self, name, args=None):
        r = self.rpc("tools/call", {"name": name, "arguments": args or {}})
        if "error" in r:
            return {"__transport": str(r["error"])[:200]}
        res = r.get("result", {})
        if res.get("isError"):
            return {"__error": " ".join(c.get("text", "") for c in res.get("content", []))[:400],
                    "__structured": res.get("structuredContent", {})}
        return res.get("structuredContent", {})

    def call_raw(self, name, args=None):
        """The whole tool result: an image export has content blocks and no structuredContent."""
        r = self.rpc("tools/call", {"name": name, "arguments": args or {}})
        return r.get("result", {"isError": True, "content": [{"type": "text", "text": str(r.get("error"))[:200]}]})

    def close(self):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.terminate()
        except Exception:
            pass


def show(label, out, keys=("rootId", "created", "nodeCount", "id", "deleted", "items")):
    if "__error" in out:
        print(f"  {label}: TOOL ERROR — {out['__error'][:220]}")
        return False
    if "__transport" in out:
        print(f"  {label}: TRANSPORT — {out['__transport'][:160]}")
        return False
    parts = []
    for k in keys:
        if k in out:
            v = out[k]
            if k == "created" and isinstance(v, list):
                parts.append(f"created={len(v)}")
            elif isinstance(v, (dict, list)):
                parts.append(f"{k}={json.dumps(v)[:90]}")
            else:
                parts.append(f"{k}={v}")
    print(f"  {label}: {', '.join(parts) if parts else json.dumps(out)[:160]}")
    return True


def main():
    c = Mcp()
    print("=" * 78)
    print("PHASE 2 WRITE TOOLS, LIVE ON THE OPERATOR'S CANVAS")
    print("=" * 78)

    created_ids = []
    failures = 0

    # ── 1. create_from_spec: a nested tree with auto-layout and text ───────────
    spec = {
        "type": "frame",
        "name": "figma-mcp write probe (delete me)",
        "width": 400,
        "height": 240,
        "layout": "vertical",
        "gap": 12,
        "padding": [24, 24, 24, 24],
        "background": "#101014",
        "cornerRadius": 12,
        "x": 4000,
        "y": 4000,
        "children": [
            {"type": "text", "name": "Title", "content": "Built by figma-mcp", "fontSize": 24, "color": "#ffffff", "weight": "Semi Bold"},
            {"type": "text", "name": "Body", "content": "One call = one screen.", "fontSize": 14, "color": "#9aa0a6"},
            {"type": "frame", "name": "Row", "layout": "horizontal", "gap": 8, "sizing": "hug", "padding": 0,
             "children": [
                 {"type": "rectangle", "name": "Chip A", "width": 64, "height": 24, "fill": "#2f6feb", "cornerRadius": 6},
                 {"type": "rectangle", "name": "Chip B", "width": 64, "height": 24, "fill": "#3a3a42", "cornerRadius": 6},
             ]},
        ],
    }
    def count(node):
        return 1 + sum(count(ch) for ch in node.get("children", []))

    out = c.call("figma_create_from_spec", {"spec": json.dumps(spec), "idempotencyKey": RUN_KEY})
    ok = show(f"create_from_spec ({count(spec)}-node tree)", out)
    if ok:
        created_ids.append(out["rootId"])
        built = out.get("created") or []
        print(f"      built {len(built)} nodes; paths: {[b.get('path') for b in built][:6]}")
        print(f"      created[0] is the root: {bool(built) and built[0].get('id') == out['rootId']}  <- pre-order since the audit fix")

    # ── 2. read it back: does the returned id describe the same tree? ─────────
    if created_ids:
        back = c.call("figma_get_node", {"nodeId": created_ids[0], "depth": 2})
        if "__error" in back:
            print(f"  read-back: ERROR — {back['__error'][:160]}")
            failures += 1
        else:
            node = back.get("node", {})
            kids = node.get("children") or []
            print(f"  read-back: {node.get('name')!r} type={node.get('type')} children={len(kids)} "
                  f"childCount={node.get('childCount')}")
            print(f"      names: {[k.get('name') for k in kids]}")

    # ── 2b. style group + export: what a mock cannot show ────────────────────
    # The SVG export is Figma's own rendering of the gradient, so its
    # x1/y1/x2/y2 settle which way the identity gradientTransform runs.
    if created_ids:
        root = created_ids[0]
        grad = {"gradient": {"type": "linear", "stops": [{"position": 0, "color": "#000000"},
                                                        {"position": 1, "color": "#ffffff"}]}}
        if not show("set_fills (linear gradient)", c.call("figma_set_fills", {"nodeIds": [root], "fills": [grad]}),
                    keys=("updated", "items")):
            failures += 1
        if not show("set_strokes", c.call("figma_set_strokes", {"nodeIds": [root], "color": "#ff0000",
                                                                "weight": 2, "align": "INSIDE"}), keys=("updated", "items")):
            failures += 1
        cr = c.call("figma_set_corner_radius", {"nodeIds": [root, "999:999999"], "radius": 20})
        show("set_corner_radius (1 real + 1 missing)", cr, keys=("updated", "items"))
        if cr.get("updated") != 1:
            failures += 1

        img = c.call_raw("figma_export_node", {"nodeId": root, "scale": 1})
        block = (img.get("content") or [{}])[0]
        png_ok = block.get("type") == "image" and base64.b64decode(block.get("data", ""))[:8] == bytes([137, 80, 78, 71, 13, 10, 26, 10])  # the PNG signature
        print(f"  export_node PNG inline: image block={block.get('type') == 'image'}, real PNG bytes={png_ok}")
        if not png_ok:
            failures += 1

        svg = c.call_raw("figma_export_node", {"nodeId": root, "format": "SVG"})
        text = "".join(b.get("text", "") for b in (svg.get("content") or [])[1:])
        m = re.search(r"<linearGradient[^>]*>", text)
        attrs = dict(re.findall(r'(x1|y1|x2|y2)="([-0-9.e]+)"', m.group(0))) if m else {}
        if attrs:
            x1, y1, x2, y2 = (float(attrs.get(k, "nan")) for k in ("x1", "y1", "x2", "y2"))
            print(f"  export_node SVG: linearGradient x1={x1} y1={y1} x2={x2} y2={y2} "
                  f"-> left-to-right: {x2 > x1 and abs(y2 - y1) < 1e-6}  <- identity transform, measured")
        elif m:
            # Figma may express the direction as an SVG transform instead; record it for reading by hand.
            print(f"  export_node SVG: linearGradient without x1/x2 — {m.group(0)[:200]}")
        else:
            print(f"  export_node SVG: no linearGradient found ({len(text)} chars) — record what Figma emitted")
            failures += 1

        saved = c.call("figma_export_node", {"nodeId": root, "saveTo": "probe/write-probe.png"})
        path = saved.get("path")
        on_disk = bool(path) and os.path.isfile(path) and os.path.getsize(path) == saved.get("bytes")
        print(f"  export_node saveTo: path={path} written={on_disk}")
        if not on_disk:
            failures += 1
        if path and os.path.isfile(path):
            os.remove(path)  # the probe's own file

    # ── 3. per-item results: one good id and one that cannot exist ────────────
    if created_ids:
        batch = c.call("figma_move_nodes", {
            "nodeIds": [created_ids[0], "999:999999"],
            "x": 4100, "y": 4100,
        })
        show("move_nodes (1 real + 1 missing)", batch)
        items = batch.get("items") or []
        good = [i for i in items if i.get("ok")]
        bad = [i for i in items if not i.get("ok")]
        print(f"      {len(good)} moved, {len(bad)} reported: {[i.get('error') for i in bad]}")

    # ── 4. idempotency: the same key must not build a second copy ─────────────
    again = c.call("figma_create_from_spec", {"spec": json.dumps(spec), "idempotencyKey": RUN_KEY})
    if "__error" in again:
        print(f"  idempotency replay: ERROR — {again['__error'][:140]}")
    else:
        same = again.get("rootId") == (created_ids[0] if created_ids else None)
        replayed = again.get("replayed") is True
        print(f"  idempotency replay: rootId same={same}, replayed flag={replayed}  <- must not have built twice")

    # ── 5. text edit + rename, then verify ───────────────────────────────────
    if created_ids:
        txt = c.call("figma_scan_text_nodes", {"nodeId": created_ids[0], "limit": 10})
        nodes = txt.get("nodes") or []
        print(f"  scan_text_nodes: {len(nodes)} TEXT node(s) inside the new frame")
        if nodes:
            tid = nodes[0]["id"]
            r = c.call("figma_set_text", {"nodeId": tid, "content": "Edited by the probe"})
            show("set_text", r, keys=("id", "characters"))
            r2 = c.call("figma_rename_node", {"nodeId": tid, "name": "Renamed Title"})
            show("rename_node", r2, keys=("id", "name", "previousName"))

    # ── 6. clean up: delete exactly what this probe created ──────────────────
    if created_ids:
        dele = c.call("figma_delete_nodes", {"nodeIds": created_ids})
        ok = show("delete_nodes (cleanup)", dele)
        if not ok:
            failures += 1
        else:
            verify = c.call("figma_get_node", {"nodeId": created_ids[0]})
            gone = "__error" in verify
            print(f"      gone afterwards: {gone}  <- canvas must look as it did before")

    # ── 7. partial failure: nothing on the canvas may go unreported ──────────
    # children[1] is an instance of a component that cannot exist, so the build
    # fails after the root and children[0] already sit on the page. The error
    # must name both (partial.created) and where it stopped (partial.failedAt).
    # Cleanup goes by name, so even an unreported orphan (the pre-fix bug) is
    # removed — and counted, because an unreported orphan is the failure.
    pname = "figma-mcp partial probe (delete me)"
    pspec = {"type": "frame", "name": pname, "x": 4000, "y": 4400, "width": 200, "height": 100,
             "children": [{"type": "rectangle", "name": "Built", "width": 20, "height": 20},
                          {"type": "instance", "componentId": "999:999999"},
                          {"type": "rectangle", "name": "Never built", "width": 20, "height": 20}]}
    bad = c.call("figma_create_from_spec", {"spec": json.dumps(pspec), "idempotencyKey": RUN_KEY + "-partial"})
    st = bad.get("__structured", {}) if "__error" in bad else {}
    partial = st.get("partial") or {}
    reported = [x.get("id") for x in partial.get("created", [])]
    print(f"  partial failure: code={st.get('code')} failedAt={partial.get('failedAt')} reported={len(reported)}")
    found = c.call("figma_search_nodes", {"query": pname, "limit": 10})
    roots = [n.get("id") for n in (found.get("nodes") or [])]
    unreported = [i for i in roots if i not in reported]
    print(f"      roots on canvas: {len(roots)}; unreported: {len(unreported)}  <- must be 0")
    if unreported:
        failures += 1
    if roots:
        clean = c.call("figma_delete_nodes", {"nodeIds": roots})
        show("delete_nodes (partial cleanup)", clean)

    c.close()
    print("\n" + "=" * 78)
    print(f"  probe finished; created ids were {'cleaned up' if created_ids else 'none'}")
    if created_ids:
        print("  If anything is left behind, one Ctrl+Z per call reverts it.")
    print("=" * 78)
    return failures


if __name__ == "__main__":
    raise SystemExit(main())

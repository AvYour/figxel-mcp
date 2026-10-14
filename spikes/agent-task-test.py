#!/usr/bin/env python3
"""Build a real pricing card with figma_create_from_spec, then read it back.

This is the test that unit tests cannot do: it exercises the tool the way an
agent would, against the live canvas, using the documented spec grammar. It
asserts what a human would check — the card exists, the text is right, the
auto-layout happened — and deletes what it made.

Run:  PYTHONIOENCODING=utf-8 python spikes/agent-task-test.py
"""
import json
import os
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUN = str(int(time.time()))


class Mcp:
    def __init__(self, allow_eval=False):
        env = {**os.environ, "BRIDGE_SESSION_WAIT_MS": "8000"}
        if allow_eval:
            env["BRIDGE_ALLOW_EVAL"] = "1"
        self.p = subprocess.Popen(
            ["node", "dist/server.js"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1, cwd=REPO, env=env,
        )
        self.id = 0
        self.rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                "clientInfo": {"name": "agent-task", "version": "0"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.p.stdin.flush()

    def rpc(self, method, params, timeout=90):
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
                return msg.get("result", {})
        raise TimeoutError(f"{method} timed out")

    def call(self, tool, args=None):
        r = self.rpc("tools/call", {"name": tool, "arguments": args or {}})
        if r.get("isError"):
            text = (r.get("content") or [{}])[0].get("text", "")
            raise RuntimeError(f"{tool}: {text[:400]}")
        return r.get("structuredContent", {})

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(timeout=5)
        except Exception:
            self.p.kill()


def main():
    m = Mcp()
    failures = []
    created = []

    def check(label, ok, detail=""):
        print(f"  {'ok ' if ok else 'BAD'} {label}{('   ' + str(detail)) if detail else ''}")
        if not ok:
            failures.append(label)

    try:
        # ── the task: one call, one pricing card ────────────────────────────
        print("\n-- the task: build a pricing card in one call")
        spec = {
            "type": "frame",
            "name": f"zz agent task {RUN} — Pricing",
            "x": 5200, "y": 4000,
            "width": 320,
            "sizing": "hug",
            "layout": "vertical",
            "gap": 12,
            "padding": 24,
            "background": "#ffffff",
            "cornerRadius": 16,
            "stroke": "#e5e7eb",
            "strokeWeight": 1,
            "children": [
                {"type": "text", "name": "Plan", "content": "Pro", "fontSize": 13, "color": "#6b7280", "weight": "Medium"},
                {"type": "text", "name": "Price", "content": "$20", "fontSize": 40, "color": "#111827", "weight": "Bold"},
                {"type": "text", "name": "Blurb", "content": "Everything in Free, plus unlimited files.",
                 "fontSize": 14, "color": "#4b5563"},
                {"type": "frame", "name": "Chip row", "height": 28, "layout": "horizontal",
                 "gap": 8,  # height only: the width must hug its chips
                 "children": [
                     {"type": "frame", "name": "Chip 1", "width": 84, "height": 28, "cornerRadius": 14,
                      "background": "#eef2ff", "layout": "horizontal", "alignX": "center", "alignY": "center",
                      "children": [{"type": "text", "content": "Unlimited", "fontSize": 11, "color": "#4338ca"}]},
                     {"type": "frame", "name": "Chip 2", "width": 66, "height": 28, "cornerRadius": 14,
                      "background": "#ecfdf5", "layout": "horizontal", "alignX": "center", "alignY": "center",
                      "children": [{"type": "text", "content": "Local", "fontSize": 11, "color": "#047857"}]},
                 ]},
            ],
        }

        res = m.call("figma_create_from_spec", {"spec": json.dumps(spec), "idempotencyKey": f"agent-{RUN}"})
        root = res.get("rootId") or res.get("id")
        made = res.get("created") or []
        check("create_from_spec returned a root id", bool(root), root)
        check("it built the whole tree (9 nodes)", len(made) == 9, f"{len(made)} nodes")
        if not root:
            return 1
        created.append(root)

        # Idempotency is the promise that a retry cannot duplicate work.
        again = m.call("figma_create_from_spec", {"spec": json.dumps(spec), "idempotencyKey": f"agent-{RUN}"})
        check("re-sending the same idempotencyKey returns the same root",
              (again.get("rootId") or again.get("id")) == root)
        found = m.call("figma_search_nodes", {"query": f"zz agent task {RUN} — Pricing", "scope": "page"})
        check("the retry did not create a second card", found.get("count") == 1, f"count={found.get('count')}")

        # ── read it back: the way an agent checks its own work ──────────────
        print("\n-- read back")
        # get_design_context carries the properties; get_node is deliberately a
        # small DTO (id/name/type/childCount), which is why an agent checks its
        # own work with this one.
        # get_node with geometry is how an agent checks its own work. Before the
        # DTO carried geometry, this was impossible: you could WRITE padding and
        # layout and had no way to READ them back.
        got = m.call("figma_get_node", {"nodeId": root, "depth": 1, "includeGeometry": True})
        root_node = got.get("node") or {}
        check("the card is a FRAME", (root_node.get("type") or "").upper() == "FRAME", root_node.get("type"))
        check("it got auto-layout", str(root_node.get("layoutMode") or "").upper() == "VERTICAL", root_node.get("layoutMode"))
        padding = root_node.get("padding") or {}
        top = padding.get("top") if isinstance(padding, dict) else None
        check("padding landed", top == 24, f"padding={padding}")
        check("corner radius landed", root_node.get("cornerRadius") == 16, root_node.get("cornerRadius"))
        check("the background colour round-trips", str(root_node.get("fill") or "").lower() == "#ffffff", root_node.get("fill"))
        check("spacing landed", root_node.get("itemSpacing") == 12, root_node.get("itemSpacing"))

        # The row was given a height and nothing else: its width must hug the two
        # chips (84 + 8 + 66 = 158). Before the per-axis fix it was a hard 100 and
        # the second chip was clipped — visible in the screenshot, which is how it
        # was found.
        kids = root_node.get("children") or []
        row = next((c for c in kids if c.get("name") == "Chip row"), None)
        if row:
            rw = row.get("width")
            check("the chip row hugs its chips instead of clipping them", rw is not None and rw >= 150,
                  f"row width={rw} (chips need 158)")

        texts = m.call("figma_scan_text_nodes", {"nodeId": root})
        contents = [t.get("characters") or t.get("text") or "" for t in (texts.get("texts") or texts.get("nodes") or [])]
        if not contents:
            print("      scan_text_nodes returned:", json.dumps(texts)[:200])
        check("all four strings survived exactly",
              sorted(contents) == sorted(["Pro", "$20", "Everything in Free, plus unlimited files.", "Unlimited", "Local"]),
              contents)

        # ── render it, so a human can look ─────────────────────────────────
        print("\n-- render")
        shot = m.call("figma_save_screenshots", {"nodeIds": [root], "format": "PNG", "scale": 2,
                                                 "dir": f"spikes/results/agent-{RUN}"})
        files = shot.get("files") or []
        check("screenshot written", len(files) == 1, files[0].get("path") if files else shot)
        if files:
            p = files[0]["path"]
            ok = os.path.isfile(p) and os.path.getsize(p) > 1000
            check("file exists and is not a stub", ok, f"{os.path.getsize(p) if os.path.isfile(p) else 0} bytes")

        # ── a wrong edit must be refused, not half-applied ─────────────────
        print("\n-- refusals that matter")
        try:
            m.call("figma_set_text", {"nodeIds": [root], "text": "nope"})
            check("set_text refuses a FRAME (only TEXT can hold characters)", False, "it succeeded!")
        except RuntimeError as err:
            check("set_text refuses a FRAME (only TEXT can hold characters)", "TEXT" in str(err) or "text" in str(err).lower(),
                  str(err)[:90])

        try:
            m.call("figma_get_node", {"nodeId": "9999:9999"})
            check("get_node refuses a missing id", False, "it succeeded!")
        except RuntimeError as err:
            check("get_node refuses a missing id", "NODE_NOT_FOUND" in str(err) or "not found" in str(err).lower(),
                  str(err)[:90])

    finally:
        # ── clean up: nothing is left behind ────────────────────────────────
        print("\n-- cleanup")
        if created:
            try:
                m.call("figma_delete_nodes", {"nodeIds": created})
            except RuntimeError as err:
                print("   delete failed:", err)
        try:
            left = m.call("figma_search_nodes", {"query": f"zz agent task {RUN}", "scope": "page"})
            check("nothing left on the canvas", left.get("count") == 0, f"count={left.get('count')}")
        except Exception as err:
            print("   verify failed:", err)
        m.close()

    print("\n" + "=" * 80)
    print(f"  failures: {len(failures)} {failures if failures else ''}")
    print("=" * 80)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

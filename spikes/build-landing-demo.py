#!/usr/bin/env python3
"""Build a SaaS landing page in the live Figma file and LEAVE IT THERE.

Unlike the other spikes in this folder, this one does NOT clean up: it exists so
a human can look at the result in Figma. It prints every id it created, which is
also the list to select if you want to delete it (one Ctrl+Z does not work after
other calls, but selecting the root and pressing Delete does).

Nothing existing is touched: everything is built at x=2000, far from whatever is
already on the page.

Run:  PYTHONIOENCODING=utf-8 python spikes/build-landing-demo.py
"""
import json
import os
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
X, Y = 2000, 0
RUN = str(int(time.time()))


class Mcp:
    def __init__(self):
        self.p = subprocess.Popen(
            ["node", "dist/server.js"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1, cwd=REPO,
            env={**os.environ, "BRIDGE_SESSION_WAIT_MS": "10000"},
        )
        self.id = 0
        self.rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                "clientInfo": {"name": "landing-demo", "version": "0"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.p.stdin.flush()

    def rpc(self, method, params, timeout=180):
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
                if "error" in msg:
                    raise RuntimeError(json.dumps(msg["error"])[:400])
                return msg.get("result", {})
        raise TimeoutError(f"{method} timed out")

    def call(self, tool, args=None):
        r = self.rpc("tools/call", {"name": tool, "arguments": args or {}})
        if r.get("isError"):
            raise RuntimeError(f"{tool}: {(r.get('content') or [{}])[0].get('text', '')[:400]}")
        return r.get("structuredContent", {})

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(timeout=5)
        except Exception:
            self.p.kill()


# ── design tokens ────────────────────────────────────────────────────────────

INK = "#0f172a"        # headings
BODY = "#475569"       # paragraphs
MUTED = "#64748b"      # labels
LINE = "#e5e7eb"       # borders
SURFACE = "#f8fafc"    # subtle panels
BRAND = "#4f46e5"
BRAND_SOFT = "#eef2ff"
BRAND_TEXT = "#4338ca"


def text(content, size, color, weight="Regular", **kw):
    return {"type": "text", "content": content, "fontSize": size, "color": color, "weight": weight, **kw}


def button(label, bg, fg, *, padding=(14, 24), radius=10, size=16, weight="Medium"):
    # `padding` takes a number or exactly four numbers [top, right, bottom, left];
    # the (vertical, horizontal) shorthand this helper wants is expanded here.
    vertical, horizontal = padding
    return {
        "type": "button", "name": label, "layout": "horizontal",
        "alignX": "center", "alignY": "center",
        "padding": [vertical, horizontal, vertical, horizontal],
        "cornerRadius": radius, "background": bg,
        "children": [text(label, size, fg, weight)],
    }


def feature_card(icon_bg, title, body):
    return {
        "type": "frame", "name": title, "width": 333, "layout": "vertical", "sizing": {"height": "hug"},
        "gap": 12, "padding": 24, "cornerRadius": 14, "background": "#ffffff",
        "stroke": LINE, "strokeWeight": 1, "alignX": "start",
        "children": [
            {"type": "frame", "name": "Icon", "width": 40, "height": 40, "cornerRadius": 10,
             "background": icon_bg, "opacity": 0.14},
            text(title, 17, INK, "Semi Bold"),
            text(body, 14, BODY, lineHeight=22),
        ],
    }


def stat_card(value, label):
    return {
        "type": "frame", "name": label, "width": 333, "layout": "vertical", "sizing": {"height": "hug"},
        "gap": 4, "padding": [20, 24, 20, 24], "cornerRadius": 12,
        "background": SURFACE, "stroke": LINE, "strokeWeight": 1,
        "children": [text(value, 28, INK, "Bold"), text(label, 14, MUTED)],
    }


def landing_spec():
    return {
        "type": "frame", "name": "figma-mcp — Landing demo", "x": X, "y": Y,
        "width": 1440, "layout": "vertical", "sizing": {"height": "hug"},
        "background": "#ffffff", "gap": 0,
        "children": [
            # ── header ──────────────────────────────────────────────────────
            # `sizing: "fill"` on every section: without it, a section hugs its
            # own content and sits cramped at the left edge of a 1440 frame.
            {
                "type": "frame", "name": "Header", "layout": "horizontal", "alignX": "space-between",
                "alignY": "center", "padding": [20, 64, 20, 64], "background": "#ffffff", "gap": 24,
                "sizing": {"width": "fill", "height": "hug"},
                "children": [
                    {"type": "frame", "name": "Logo", "layout": "horizontal", "alignY": "center", "gap": 10,
                     "background": "#ffffff", "children": [
                         {"type": "frame", "name": "Mark", "width": 28, "height": 28, "cornerRadius": 8,
                          "background": BRAND},
                         text("figma-mcp", 17, INK, "Bold"),
                     ]},
                    {"type": "frame", "name": "Nav", "layout": "horizontal", "alignY": "center", "gap": 32,
                     "background": "#ffffff", "children": [
                         text("Product", 15, BODY), text("Pricing", 15, BODY),
                         text("Docs", 15, BODY), text("Changelog", 15, BODY),
                     ]},
                    button("Get started", BRAND, "#ffffff", padding=(10, 18), radius=8, size=15),
                ],
            },
            # ── hero ────────────────────────────────────────────────────────
            {
                "type": "frame", "name": "Hero", "layout": "vertical", "alignX": "center",
                "padding": [84, 200, 72, 200], "gap": 22, "background": "#ffffff",
                "sizing": {"width": "fill", "height": "hug"},
                "children": [
                    {"type": "frame", "name": "Eyebrow", "layout": "horizontal", "alignX": "center",
                     "alignY": "center", "padding": [6, 14, 6, 14], "cornerRadius": 999,
                     "background": BRAND_SOFT, "children": [text("Free & unlimited", 13, BRAND_TEXT, "Medium")]},
                    text("Build in Figma from your terminal", 56, INK, "Bold", align="center", lineHeight=64),
                    text("Read and write the canvas through an MCP server that runs on your machine. "
                         "No quota, no cloud, no client lock-in — exactly the Figma you already have open.",
                         19, BODY, align="center", lineHeight=30),
                    {"type": "frame", "name": "CTAs", "layout": "horizontal", "alignX": "center",
                     "gap": 12, "padding": [10, 0, 0, 0], "background": "#ffffff", "sizing": {"width": "fill", "height": "hug"}, "children": [
                         button("Get started", BRAND, "#ffffff"),
                         button("Read the docs", "#f1f5f9", INK),
                     ]},
                ],
            },
            # ── stats ───────────────────────────────────────────────────────
            # Vertical padding is REQUIRED, not cosmetic. With top=0/bottom=0 the
            # cards sit flush against this section's bounds, their drop shadows
            # fall outside it, and the neighbouring opaque sections paint over
            # them — the shadow is drawn and then covered, which reads as a
            # clipped shadow but is not clipping at all. Found by looking at the
            # rendered output; every assertion was green.
            {
                "type": "frame", "name": "Stats", "layout": "horizontal", "alignX": "center",
                "gap": 20, "padding": [56, 200, 56, 200], "background": "#ffffff",
                "sizing": {"width": "fill", "height": "hug"},
                "children": [
                    stat_card("72", "tools, all exercised live"),
                    stat_card("0", "Figma API calls, ever"),
                    stat_card("1", "Ctrl+Z per tool call"),
                ],
            },
            # ── features ────────────────────────────────────────────────────
            {
                "type": "frame", "name": "Features", "layout": "vertical", "alignX": "center",
                "padding": [88, 200, 96, 200], "gap": 32, "background": "#ffffff",
                "sizing": {"width": "fill", "height": "hug"},
                "children": [
                    {"type": "frame", "name": "Heading", "layout": "vertical", "alignX": "center",
                     "gap": 12, "background": "#ffffff", "sizing": {"width": "fill", "height": "hug"}, "children": [
                         text("Everything the official server does — and the writes too", 34, INK, "Bold",
                              align="center", lineHeight=42),
                         text("Granular tools instead of one eval, so every change is validated, typed and reported on.",
                              17, BODY, align="center", lineHeight=26),
                     ]},
                    {"type": "frame", "name": "Cards", "layout": "horizontal", "gap": 20,
                     "alignY": "start", "background": "#ffffff", "sizing": {"width": "fill", "height": "hug"}, "children": [
                         feature_card("#4f46e5", "Reads that verify",
                                      "The node DTO carries layout, padding, radius and fill, so an agent can check "
                                      "what it just wrote instead of assuming it worked."),
                         feature_card("#059669", "Writes that undo",
                                      "One tool call is one undo step. Every result reports per item, so one bad id "
                                      "never loses the other thirty-nine."),
                         feature_card("#d97706", "No quota, honestly",
                                      "The plugin talks to loopback only. Figma's API is never called — but plan "
                                      "limits still apply, and the docs say which."),
                     ]},
                ],
            },
        ],
    }


def main():
    m = Mcp()
    created = []
    try:
        # Do not disturb whatever is already here.
        before = m.call("figma_get_design_context", {"depth": 1, "maxNodes": 300})
        print(f"  before: {before.get('nodeCount')} node(s) on the page")

        res = m.call("figma_create_from_spec", {"spec": json.dumps(landing_spec()), "idempotencyKey": f"landing-demo-{RUN}"})
        root = res.get("rootId")
        created = [c["id"] for c in res.get("created", [])]
        print(f"  built {res.get('nodeCount')} nodes, root {root}")

        # A soft shadow is not part of the spec grammar; applying effects is its
        # own tool, and the card ids came back so we can target them.
        cards = m.rpc("tools/call", {"name": "figma_get_node", "arguments": {"nodeId": root, "depth": 3}})
        sc = cards.get("structuredContent", {})

        def find(node, name):
            if node.get("name") == name:
                return node
            for c in node.get("children") or []:
                hit = find(c, name)
                if hit:
                    return hit
            return None

        stats = find(sc.get("node") or {}, "Stats")
        if stats:
            ids = [c["id"] for c in stats.get("children") or []]
            if ids:
                # Match the feature cards' treatment, so the two rows read as the
                # same design. Measured by looking: alpha 0.06 with no stroke was
                # so faint that the shadow looked absent on the top edge, while
                # the feature cards below (stroke + shadow) looked deliberate.
                # The row was not broken — it was inconsistent, which is its own
                # defect in a landing page.
                m.call("figma_set_effects", {"nodeIds": ids, "effects": [
                    {"type": "DROP_SHADOW", "x": 0, "y": 2, "radius": 10, "spread": 0,
                     "color": "#0f172a", "alpha": 0.10}]})
                m.call("figma_set_strokes", {"nodeIds": ids, "color": LINE, "weight": 1})
                print(f"  shadow + border on {len(ids)} stat card(s)")

        print(f"\n  LEFT IN YOUR FILE — nothing was deleted.")
        print(f"  root: {root}   (double-click it in the Layers panel, or scroll to x={X})")
        print(f"  created {len(created)} node(s)")

        # Render it so the result can be looked at without opening Figma.
        shot = m.call("figma_save_screenshots", {"nodeIds": [root], "format": "PNG", "scale": 1,
                                                 "dir": "spikes/results/landing-demo"})
        for f in shot.get("files") or []:
            print(f"  screenshot: {f['path']}")
    finally:
        m.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

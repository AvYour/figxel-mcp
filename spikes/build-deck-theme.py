#!/usr/bin/env python3
"""Build a five-slide deck on ONE theme, driven by design variables.

The point is not the five slides. The point is that every colour, radius and gap
in them is BOUND to a variable, so changing one variable changes all five. A deck
where each frame has its own hardcoded "#6D28D9" is five designs that happen to
agree; this is one design used five times, and the difference shows the moment
anyone wants to retheme it.

Does NOT clean up: the slides stay so a human can look at them, and the variable
names are printed at the end so the theme can be changed by hand.

Run:  PYTHONIOENCODING=utf-8 python spikes/build-deck-theme.py
"""
import json
import os
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COLLECTION = "v2 Theme"
RUN = str(int(time.time()))

W, H = 1440, 900
GUTTER = 120


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
                                "clientInfo": {"name": "deck-theme", "version": "0"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.p.stdin.flush()

    def rpc(self, method, params, timeout=240):
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


# ── the theme ────────────────────────────────────────────────────────────────
#
# Every entry here becomes a variable. Nothing below this block hardcodes a
# colour, a radius or a gap: the specs reference these by name, so the theme is
# one object rather than a convention spread across five frames.

COLORS = {
    "bg": "#FAFAF9",
    "surface": "#FFFFFF",
    "ink": "#18181B",
    "muted": "#71717A",
    "line": "#E4E4E7",
    "brand": "#6D28D9",
    "brandSoft": "#EDE9FE",
    "brandInk": "#4C1D95",
    "accent": "#059669",
    "accentSoft": "#D1FAE5",
    "accentInk": "#065F46",
}
FLOATS = {
    "space/1": 8, "space/2": 16, "space/3": 24, "space/4": 32, "space/5": 48, "space/6": 64,
    "radius/sm": 8, "radius/md": 16, "radius/lg": 24, "radius/pill": 999,
}


def text(content, size, color, weight="Regular", **kw):
    return {"type": "text", "content": content, "fontSize": size, "color": color, "weight": weight, **kw}


def bound(content, size, color_var, weight="Regular", **kw):
    """Text whose colour comes from a variable rather than a literal."""
    node = text(content, size, "#000000", weight, **kw)
    node["variables"] = {"fill": color_var}
    return node


def pill(label, fill_var, ink_var, size=13, padding=(6, 14)):
    v, h = padding
    return {
        "type": "frame", "name": f"Pill — {label}", "layout": "horizontal",
        "alignX": "center", "alignY": "center",
        "padding": [v, h, v, h], "cornerRadius": 999, "sizing": "hug",
        "variables": {"fill": fill_var, "radius": "radius/pill"},
        "children": [bound(label, size, ink_var, "Medium")],
    }


def slide_base(name, index, x, children, gap_var="space/6"):
    """The shared skeleton: every slide differs only in its contents."""
    return {
        "type": "frame", "name": f"v2 / {name}", "x": x, "y": 0,
        "width": W, "height": H, "layout": "vertical", "sizing": "fixed",
        "gap": 0, "padding": [72, 96, 72, 96],
        "variables": {"fill": "color/bg", "padding": "space/4"},
        "children": [
            # Header row: shared by every slide, so the deck reads as one document.
            {
                "type": "frame", "name": "Slide header", "layout": "horizontal",
                "alignX": "space-between", "alignY": "center",
                "sizing": {"width": "fill", "height": "hug"}, "gap": "space/3",
                "children": [
                    {
                        "type": "frame", "name": "Brand", "layout": "horizontal",
                        "alignY": "center", "gap": "space/1", "sizing": "hug",
                        "children": [
                            {"type": "frame", "name": "Mark", "width": 26, "height": 26,
                             "variables": {"fill": "color/brand", "radius": "radius/sm"}},
                            bound("figma-mcp", 16, "color/ink", "Bold"),
                        ],
                    },
                    bound(f"{index:02d} / 05", 13, "color/muted", "Medium"),
                ],
            },
            # The body absorbs whatever height is left, so the footer sits on the
            # baseline of every slide regardless of how much content is above it.
            {
                "type": "frame", "name": "Body", "layout": "vertical", "alignX": "start",
                "gap": gap_var, "sizing": {"width": "fill", "height": "fill"},
                "children": children,
            },
            {
                "type": "frame", "name": "Slide footer", "layout": "horizontal",
                "alignX": "space-between", "alignY": "center",
                "sizing": {"width": "fill", "height": "hug"},
                "children": [
                    bound("figma-mcp — read and write Figma from your terminal", 12, "color/muted"),
                    bound("Confidential", 12, "color/muted"),
                ],
            },
        ],
    }


def stat(value, label, accent=False):
    return {
        "type": "frame", "name": f"Stat — {label}", "layout": "vertical", "gap": "space/1",
        "sizing": "fill", "padding": 24, "variables": {
            "fill": "color/surface" if not accent else "color/accentSoft",
            "radius": "radius/md", "padding": "space/3",
        },
        "children": [
            bound(value, 40, "color/accentInk" if accent else "color/ink", "Bold"),
            bound(label, 13, "color/muted"),
        ],
    }


def cover():
    return slide_base("01 Cover", 1, 0, [
        {"type": "frame", "name": "Spacer", "sizing": {"width": "fill", "height": "fill"}},
        pill("Seed round · 2026", "color/brandSoft", "color/brandInk"),
        bound("The design canvas,\nscriptable.", 76, "color/ink", "Bold", lineHeight=84),
        bound(
            "An MCP server that reads and writes real Figma files — locally, with no API quota, "
            "from any client you already use.",
            22, "color/muted", lineHeight=34),
    ], gap_var="space/4")


def problem():
    return slide_base("02 Problem", 2, W + GUTTER, [
        pill("The problem", "color/brandSoft", "color/brandInk"),
        bound("Design work does not\nfit in a chat window.", 52, "color/ink", "Bold", lineHeight=60),
        bound(
            "Every design tool now has an AI surface. Almost none of them can see the file. "
            "What they generate is a picture of a layout, not a layout — so a designer redraws it "
            "by hand, and the redraw is where the intent is lost.",
            20, "color/muted", lineHeight=32),
        {"type": "frame", "name": "Spacer", "sizing": {"width": "fill", "height": "fill"}},
        {
            "type": "frame", "name": "Contrast", "layout": "horizontal", "gap": "space/3",
            "sizing": {"width": "fill", "height": "hug"}, "variables": {"gap": "space/3"},
            "children": [
                {"type": "frame", "name": "Them", "layout": "vertical", "gap": "space/2",
                 "sizing": "fill", "padding": 24, "variables": {"fill": "color/surface", "radius": "radius/md", "padding": "space/3"},
                 "children": [bound("Screenshot out", 17, "color/ink", "Semi Bold"),
                              bound("A PNG of a screen that has to be rebuilt.", 14, "color/muted", lineHeight=22)]},
                {"type": "frame", "name": "Us", "layout": "vertical", "gap": "space/2",
                 "sizing": "fill", "padding": 24, "variables": {"fill": "color/brandSoft", "radius": "radius/md", "padding": "space/3"},
                 "children": [bound("Canvas in, canvas out", 17, "color/brandInk", "Semi Bold"),
                              bound("Real frames, components and variables — the file itself.", 14, "color/brandInk", lineHeight=22)]},
            ],
        },
    ])


def approach():
    return slide_base("03 Approach", 3, (W + GUTTER) * 2, [
        pill("How it works", "color/brandSoft", "color/brandInk"),
        bound("A plugin, not an API key.", 52, "color/ink", "Bold", lineHeight=60),
        bound(
            "Figma has no write API. The official MCP edits files through a plugin, and so does this one — "
            "which is why there is no quota, no upload and no seat to buy. The bridge runs on loopback; "
            "Figma's servers are never contacted.",
            20, "color/muted", lineHeight=32),
        {"type": "frame", "name": "Spacer", "sizing": {"width": "fill", "height": "fill"}},
        {
            "type": "frame", "name": "Stats", "layout": "horizontal", "gap": "space/3",
            "sizing": {"width": "fill", "height": "hug"}, "variables": {"gap": "space/3"},
            "children": [
                stat("72", "tools, all exercised live"),
                stat("0", "Figma API calls, ever"),
                stat("1", "Ctrl+Z per tool call", accent=True),
            ],
        },
    ])


def traction():
    return slide_base("04 Traction", 4, (W + GUTTER) * 3, [
        pill("Where it is", "color/accentSoft", "color/accentInk"),
        bound("Built in the open,\nand used daily.", 52, "color/ink", "Bold", lineHeight=60),
        bound(
            "The hard part was never the protocol — it was making the writes trustworthy. Every tool call "
            "is one undo step, every multi-item result reports per item, and a stale plugin says so "
            "instead of failing quietly.",
            20, "color/muted", lineHeight=32),
        {"type": "frame", "name": "Spacer", "sizing": {"width": "fill", "height": "fill"}},
        {
            "type": "frame", "name": "Proof", "layout": "vertical", "gap": "space/2",
            "sizing": {"width": "fill", "height": "hug"}, "padding": 24,
            "variables": {"fill": "color/surface", "radius": "radius/lg", "padding": "space/3"},
            "children": [
                bound("Read the design, then write it back", 17, "color/ink", "Semi Bold"),
                bound("The node DTO carries layout, padding, radius and fill, so an agent can verify what it "
                      "just wrote rather than assuming it worked.", 14, "color/muted", lineHeight=22),
            ],
        },
    ])


def ask():
    return slide_base("05 Ask", 5, (W + GUTTER) * 4, [
        {"type": "frame", "name": "Spacer", "sizing": {"width": "fill", "height": "fill"}},
        pill("The ask", "color/brandSoft", "color/brandInk"),
        bound("Fund the bridge.", 76, "color/ink", "Bold", lineHeight=84),
        bound(
            "A seed round to keep it free, local and client-agnostic — and to finish the parity work "
            "against the official server.",
            22, "color/muted", lineHeight=34),
        {
            "type": "frame", "name": "CTA", "layout": "horizontal", "gap": "space/3",
            "alignY": "center", "sizing": "hug", "padding": 32,
            "variables": {"fill": "color/brand", "radius": "radius/md", "padding": "space/4"},
            "children": [bound("alex@example.com", 16, "color/surface", "Medium")],
        },
    ], gap_var="space/4")


def main():
    m = Mcp()
    print("  building one theme from variables, then five slides that use it\n")

    # ── the theme ────────────────────────────────────────────────────────────
    col = m.call("figma_create_variable_collection", {"name": COLLECTION})
    cid = col["id"]
    print(f"  collection {COLLECTION} -> {cid}")

    names = []
    for name, value in COLORS.items():
        v = m.call("figma_create_variable",
                   {"collectionId": cid, "name": f"color/{name}", "type": "COLOR", "value": value})
        names.append(v["name"])
    for name, value in FLOATS.items():
        v = m.call("figma_create_variable",
                   {"collectionId": cid, "name": name, "type": "FLOAT", "value": str(value)})
        names.append(v["name"])
    print(f"  {len(names)} variables: {', '.join(sorted(names)[:6])}, …\n")

    # ── the slides ───────────────────────────────────────────────────────────
    ids = []
    for build in (cover, problem, approach, traction, ask):
        spec = build()
        res = m.call("figma_create_from_spec",
                     {"spec": json.dumps(spec), "idempotencyKey": f"deck-{RUN}-{spec['name']}"})
        ids.append(res["rootId"])
        print(f"  {spec['name']:14s} -> {res['rootId']}  ({res['nodeCount']} nodes)")

    # ── prove the theme is real ──────────────────────────────────────────────
    # A deck that merely looks consistent proves nothing. The test is whether one
    # edit moves every slide, so change the background and the brand colour and
    # count how many nodes follow.
    print("\n  retheming: color/bg #FAFAF9 -> #0B1020, color/brand #6D28D9 -> #10B981")
    m.call("figma_set_variable_value", {"variableName": "color/bg", "value": "#0B1020"})
    m.call("figma_set_variable_value", {"variableName": "color/brand", "value": "#10B981"})

    r = m.rpc("tools/call", {"name": "figma_eval", "arguments": {"code": f"""
const ids = {json.dumps(ids)};
const out = [];
for (const id of ids) {{
  const n = await figma.getNodeByIdAsync(id);
  const bg = (n.fills || [])[0];
  out.push({{ name: n.name, bg: bg && bg.boundVariables ? Object.keys(bg.boundVariables).length : 0,
             hex: bg && bg.color ? '#' + [bg.color.r, bg.color.g, bg.color.b].map(v => Math.round(v*255).toString(16).padStart(2,'0')).join('') : null }});
}}
return out;
"""}})
    for row in r.get("structuredContent", {}).get("value", []):
        print(f"    {row['name']:16s} bg={row['hex']}  boundVars={row['bg']}")

    print("\n  THEME — edit these and all five slides follow:")
    print(f"    collection : {COLLECTION}  ({cid})")
    for n in sorted(COLORS):
        print(f"      color/{n}")
    print(f"    slides     : {', '.join(str(i) for i in ids)}")
    m.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

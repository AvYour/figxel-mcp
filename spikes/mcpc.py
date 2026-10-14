#!/usr/bin/env python3
"""A persistent MCP session for the figma-mcp server, with per-call measurement.

Why a module: the previous approach wrote one large `create_from_spec` payload and
sent it in a single shot. That has no observation point — if element 40 of 61 is
wrong, the error only shows up at the end, in a picture, where it is hard to
localise. This module keeps one process alive and exposes `Session.call()`, so a
build can be a *sequence* of discrete tool calls with a measurement after each
one. One call = one thing on the canvas = one thing to verify.

Usage:
    from mcpc import Session, active
    with Session() as s:
        s.call("figma_create_frame", {...})
        print(s.measure("11:10898"))
"""
import json
import os
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def active(frame_id):
    """Node ids that are alive in the document right now (read-only probe)."""
    return (
        f'const n = await figma.getNodeByIdAsync("{frame_id}");'
        f'return n ? {{ id: n.id, name: n.name }} : null;'
    )


class Session:
    def __init__(self, allow_eval=True, wait_ms=10000, timeout=180):
        env = {**os.environ, "BRIDGE_SESSION_WAIT_MS": str(wait_ms)}
        if allow_eval:
            env["BRIDGE_ALLOW_EVAL"] = "1"
        self.p = subprocess.Popen(
            ["node", "dist/server.js"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1, cwd=REPO, env=env,
        )
        self.timeout = timeout
        self._id = 0
        self._notify("initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "stepwise", "version": "0"},
        })
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    # ── transport ────────────────────────────────────────────────────────
    def _send(self, msg):
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()

    def _read_until(self, mid):
        end = time.time() + self.timeout
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
        raise TimeoutError(f"no reply to id={mid} within {self.timeout}s")

    def _notify(self, method, params):
        self._id += 1
        self._send({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params})
        return self._read_until(self._id)

    def rpc(self, method, params):
        return self._notify(method, params)

    def tools(self):
        return self.rpc("tools/list", {}).get("result", {}).get("tools", [])

    # ── calls ────────────────────────────────────────────────────────────
    def call(self, name, args=None):
        """One tool call.

        Returns structuredContent when the tool has one. Some tools — figma_get_guide
        among them — return their payload as text content instead, and an empty
        structuredContent then reads as "the tool returned nothing", which is wrong.
        """
        r = self.rpc("tools/call", {"name": name, "arguments": args or {}})
        if "error" in r:
            raise RuntimeError(f"{name}: {json.dumps(r['error'])[:300]}")
        res = r.get("result", {})
        if res.get("isError"):
            text = (res.get("content") or [{}])[0].get("text", "")
            raise RuntimeError(f"{name}: {text[:300]}")
        sc = res.get("structuredContent")
        if sc:
            return sc
        blocks = res.get("content") or []
        if len(blocks) == 1 and blocks[0].get("type") == "text":
            return {"text": blocks[0].get("text", "")}
        return {"content": blocks} if blocks else {}

    def eval(self, code):
        """figma_eval, unwrapped. The plugin returns {value: ...}."""
        out = self.call("figma_eval", {"code": code})
        return out.get("value", out)

    def measure(self, frame_id):
        """Everything needed to judge one built frame, in one read.

        Returns text boxes with absolute coordinates, pairwise overlaps, the
        deepest/bottom-most edge, the two column gutters, the fonts actually
        present, and whether anything sits outside the frame.
        """
        return self.eval(f"""
const nx = await figma.getNodeByIdAsync({json.dumps(frame_id)});
if (!nx) return null;
const hex = (n) => {{ const f=(n.fills||[])[0]; if(!f||!f.color) return null;
  return '#'+[f.color.r,f.color.g,f.color.b].map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join(''); }};
const boxes = [], fonts = [], outside = [];
const walk = (n, ox, oy) => {{ for (const c of n.children || []) {{
  const cx = ox + c.x, cy = oy + c.y;
  if (c.type === 'TEXT') {{
    if (c.fontName && c.fontName.family && !fonts.includes(c.fontName.family)) fonts.push(c.fontName.family);
    if (c.characters && c.characters.trim()) boxes.push({{ name: c.name, t: (c.characters||'').slice(0,24),
      x: Math.round(cx), y: Math.round(cy), r: Math.round(cx+c.width), b: Math.round(cy+c.height) }});
  }}
  if (cx < -1 || cy < -1 || cx + c.width > nx.width + 1 || cy + c.height > nx.height + 1)
    outside.push(c.name);
  walk(c, cx, cy); }} }};
walk(nx, 0, 0);
const hits = [];
for (let i=0;i<boxes.length;i++) for (let j=i+1;j<boxes.length;j++) {{
  const A=boxes[i], B=boxes[j];
  const ox = Math.min(A.r,B.r)-Math.max(A.x,B.x), oy = Math.min(A.b,B.b)-Math.max(A.y,B.y);
  if (ox > 2 && oy > 2) hits.push(A.name + ' x ' + B.name + ' (' + ox + 'x' + oy + ')');
}}
return {{
  name: nx.name, w: Math.round(nx.width), h: Math.round(nx.height), fill: hex(nx),
  clips: nx.clipsContent, layout: nx.layoutMode, fonts, nText: boxes.length,
  lowest: boxes.reduce((m,b) => Math.max(m, b.b), 0),
  rightmost: boxes.reduce((m,b) => Math.max(m, b.r), 0),
  overlaps: hits, outside,
  boxes: boxes.map(b => b.name + '@' + b.x + ',' + b.y + ' ' + b.r + 'x' + b.b),
}};
""")

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(timeout=5)
        except Exception:
            self.p.kill()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


if __name__ == "__main__":
    with Session() as s:
        tools = s.tools()
        print(f"  {len(tools)} tools\n")
        groups = {}
        for t in tools:
            n = t["name"].replace("figma_", "")
            head = (t.get("description") or "").split("\n")[0][:88]
            verb = n.split("_")[0]
            groups.setdefault(verb, []).append((n, head))
        for verb in sorted(groups):
            print(f"  ── {verb} ({len(groups[verb])})")
            for n, head in groups[verb]:
                print(f"     figma_{n:34s} {head}")

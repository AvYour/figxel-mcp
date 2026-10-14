#!/usr/bin/env python3
"""Page 04 — dark band hero, left-aligned text, no display headline.

Run:  PYTHONIOENCODING=utf-8 python spikes/build-04.py
"""
import sys, json, time, pathlib
sys.path.insert(0, "spikes")
from mcpc import Session

INK="#0022CD"; BG="#F0F0F0"; WHITE="#FFFFFF"
D1, LB, BD = "Michroma", "Silkscreen", "Inter"
X, Y = 3725, 4604
PAD, RIGHT = 36, 1884

def step(s, label, name, args):
    t = time.time()
    r = s.call(name, args)
    if "font" in r:
        print(f"  [{time.time()-t:4.2f}s] {label:22s} {r['font']['family']:12s} fellBack={r['font']['fellBack']}")
    else:
        print(f"  [{time.time()-t:4.2f}s] {label:22s} id={r.get('id')}")
    return r

def centred(s, rid, width=1920):
    s.eval(f'const t = await figma.getNodeByIdAsync({json.dumps(rid)});'
           f't.textAutoResize="HEIGHT"; t.resize({width}, t.height);'
           f't.textAlignHorizontal="CENTER"; t.x=0; return true;')

t0 = time.time()
with Session() as s:
    ids = pathlib.Path("spikes/.ids04.json")
    if ids.exists():
        old = json.loads(ids.read_text()).get("root")
        if old and s.eval(f'const n = await figma.getNodeByIdAsync({json.dumps(old)}); return n ? n.id : null;'):
            s.call("figma_delete_nodes", {"nodeIds": [old]})
            print(f"  old draft {old} deleted")

    RID = step(s, "root frame", "figma_create_frame", {"name": "v2 / 04 Case Study", "x": X, "y": Y,
        "width": 1920, "height": 1080, "background": BG})["id"]
    s.eval(f'const n = await figma.getNodeByIdAsync({json.dumps(RID)}); n.clipsContent = true; return true;')

    BAND = step(s, "ink band", "figma_create_frame", {"parentId": RID, "x": 0, "y": 0, "width": 1920,
        "height": 300, "name": "Band", "background": INK})["id"]
    step(s, "band label", "figma_create_text", {"parentId": BAND, "x": PAD, "y": 44,
        "content": "CASE STUDY \u2014 01", "fontFamily": LB, "fontSize": 12,
        "letterSpacing": 0.24, "color": WHITE, "name": "Band label"})
    step(s, "band title", "figma_create_text", {"parentId": BAND, "x": PAD, "y": 92,
        "content": "FIGMA MCP", "fontFamily": D1, "fontSize": 130, "lineHeight": 137,
        "letterSpacing": -1.3, "color": WHITE, "name": "Band title"})
    step(s, "band summary", "figma_create_text", {"parentId": BAND, "x": PAD, "y": 240,
        "content": "A local bridge between an AI agent and the Figma canvas \u2014 no API quota, no paid seat.",
        "fontFamily": BD, "fontSize": 23, "lineHeight": 33, "color": WHITE, "name": "Band summary"})

    meta = [step(s, f"meta {i+1}", "figma_create_text", {"parentId": BAND, "x": 1584, "y": 44+i*24,
        "content": t, "fontFamily": LB, "fontSize": 12, "letterSpacing": 0.24, "color": WHITE,
        "name": f"Meta {i+1}"})["id"] for i, t in enumerate(["MCP SERVER","OPEN SOURCE","2026"])]
    for mid in meta:
        s.eval(f'const t = await figma.getNodeByIdAsync({json.dumps(mid)});'
               f't.textAutoResize="HEIGHT"; t.resize(300, t.height);'
               f't.textAlignHorizontal="RIGHT"; t.x=1584; return true;')

    lead = step(s, "lead", "figma_create_text", {"parentId": RID, "x": PAD, "y": 360,
        "content": "Figma\u2019s own MCP server is the right idea with the wrong economics: read a file and you have spent quota. This is the same idea moved onto the plugin path, where a local bridge does the talking and the canvas never leaves the machine.",
        "fontFamily": BD, "fontSize": 23, "lineHeight": 33, "color": INK, "name": "Lead"})["id"]
    r = s.eval(f'const t = await figma.getNodeByIdAsync({json.dumps(lead)});'
               f't.textAutoResize="HEIGHT"; t.resize(1300, t.height);'
               f'return {{ w: Math.round(t.width), h: Math.round(t.height), right: Math.round(t.x+t.width) }};')
    print(f"       lead: {r['w']}x{r['h']} right={r['right']}")

    ROWS = [("01","Measured, not guessed",
             "Every tool call answers for itself. A batch payload has no observation point."),
            ("02","The plugin, not the API",
             "Read and write on the plugin path. No REST calls, so no rate limit to spend."),
            ("03","Failures recorded, not fixed quietly",
             "Six defects found by measuring are written down, with the numbers that exposed them.")]
    for i, (num, title, desc) in enumerate(ROWS):
        ry = 560 + i*140
        row = step(s, f"row {num}", "figma_create_frame", {"parentId": RID, "x": PAD, "y": ry,
            "width": 1848, "height": 140, "name": f"Row {num}"})["id"]
        rule = step(s, f"rule {num}", "figma_create_rectangle", {"parentId": RID, "x": PAD, "y": ry,
            "width": 1848, "height": 1, "fill": INK, "name": f"Rule {num}"})["id"]
        s.eval(f'const n = await figma.getNodeByIdAsync({json.dumps(rule)}); n.opacity = 0.3; return true;')
        step(s, f"number {num}", "figma_create_text", {"parentId": row, "x": 0, "y": 16, "content": num,
            "fontFamily": LB, "fontSize": 44, "letterSpacing": 0.24, "color": INK, "name": f"Num {num}"})
        ttl = step(s, f"title {num}", "figma_create_text", {"parentId": row, "x": 180, "y": 20, "content": title,
            "fontFamily": D1, "fontSize": 34, "lineHeight": 44, "color": INK, "name": f"Title {num}"})["id"]
        # Michroma at 34 px runs wide: "Failures recorded, not fixed quietly" measured
        # 728 px and crossed the description column at x=900 by 8 px. A fixed measure
        # makes the title wrap instead of reaching the next column.
        s.eval(f'const t = await figma.getNodeByIdAsync({json.dumps(ttl)});'
               f't.textAutoResize="HEIGHT"; t.resize(660, t.height); return true;')
        d = step(s, f"description {num}", "figma_create_text", {"parentId": row, "x": 900, "y": 26,
            "content": desc, "fontFamily": BD, "fontSize": 20, "lineHeight": 30, "color": INK,
            "name": f"Desc {num}"})["id"]
        s.eval(f'const t = await figma.getNodeByIdAsync({json.dumps(d)});'
               f't.textAutoResize="HEIGHT"; t.resize(948, t.height); return true;')

    step(s, "page number", "figma_create_text", {"parentId": RID, "x": 1804, "y": 1028,
        "content": "04 / 17", "fontFamily": LB, "fontSize": 12, "letterSpacing": 0.24,
        "color": INK, "name": "Page"})
    PROG = step(s, "progress", "figma_create_frame", {"parentId": RID, "x": 50, "y": 1036,
        "width": 470, "height": 4, "name": "Progress"})["id"]
    seg = [step(s, f"seg {i+1:02d}", "figma_create_rectangle", {"parentId": PROG, "x": i*28, "y": 0,
           "width": 22, "height": 4, "fill": INK, "name": f"Seg {i+1:02d}"})["id"] for i in range(17)]
    s.call("figma_set_opacity", {"nodeIds": seg, "opacity": 0.22})
    s.call("figma_set_opacity", {"nodeIds": [seg[3]], "opacity": 1})

    pathlib.Path("spikes/.ids04.json").write_text(json.dumps({"root": RID, "band": BAND, "segments": seg}, indent=1))
    m = s.measure(RID)
    print(f"\n  total {time.time()-t0:.1f}s")
    print(f"  MEASURE: {m['w']}x{m['h']} clips={m['clips']}  {m['nText']} texts")
    print(f"    fonts   : {m['fonts']}")
    print(f"    lowest y={m['lowest']}  rightmost x={m['rightmost']}")
    print(f"    overlaps: {len(m['overlaps'])} {m['overlaps']}")
    print(f"    outside : {m['outside']}")

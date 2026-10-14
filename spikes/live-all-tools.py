#!/usr/bin/env python3
"""Run EVERY registered figma-mcp tool once against the real canvas.

Why this exists: the 2026-10-07 audit found tools that passed their unit tests
and could never work in Figma (figma.createInstance, node.createComponent(),
createVariable(name, collectionId) under dynamic-page). Unit tests run against
fakes; fakes encode the author's assumptions. Only the real Plugin API settles
whether a call exists.

So the probe asks the server for its tool list (tools/list), exercises each
one, and prints coverage: a tool that is registered but never exercised is
reported, never silently skipped.

Everything it builds sits in one frame named "figma-mcp all-tools probe
(delete me)" far off-canvas, and is deleted at the end. What cannot be deleted
by figma-mcp's own tools yet — variables and styles have no delete tool — is
named "zz figma-mcp probe …" and listed at the end.

Run:  PYTHONIOENCODING=utf-8 <python> spikes/live-all-tools.py
"""
import base64
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUN = str(int(time.time()))
X, Y = 9000, 9000


class Mcp:
    def __init__(self):
        self.p = subprocess.Popen(
            ["node", "dist/server.js"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1, cwd=REPO,
            env={**os.environ, "BRIDGE_SESSION_WAIT_MS": "5000", "BRIDGE_ALLOW_EVAL": "1"},
        )
        self.id = 0
        self.rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                "clientInfo": {"name": "live-all-tools", "version": "0"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.p.stdin.flush()

    def rpc(self, method, params, timeout=60):
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

    def close(self):
        try:
            self.p.stdin.close()
            self.p.terminate()
        except Exception:
            pass


class Probe:
    def __init__(self, mcp):
        self.mcp = mcp
        self.called = set()
        self.failures = []
        self.cleanup = []          # node ids to delete at the end
        self.styles_to_delete = []       # style ids (delete_style covers these now)
        self.collections_to_delete = []  # variable collection ids (delete_variable_collection)
        self.leftovers = []        # anything that still cannot be removed

    def call(self, tool, args=None, expect_error=None, label=None):
        """Call a tool. expect_error: a regex the error text must match (a refusal path)."""
        self.called.add(tool)
        r = self.mcp.rpc("tools/call", {"name": tool, "arguments": args or {}})
        res = r.get("result") or {}
        text = " ".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
        is_err = bool(res.get("isError")) or "error" in r
        tag = label or tool.replace("figma_", "")
        if expect_error is not None:
            ok = is_err and re.search(expect_error, text or str(r.get("error")), re.I) is not None
            print(f"  {'ok ' if ok else 'BAD'} {tag:34} refused as expected: {text[:90]}" if ok else
                  f"  BAD {tag:34} expected an error matching /{expect_error}/, got: {text[:160]}")
            if not ok:
                self.failures.append(tag)
            return res
        if is_err:
            print(f"  BAD {tag:34} {text[:200] or r.get('error')}")
            self.failures.append(tag)
            return None
        sc = res.get("structuredContent")
        if sc is None:
            # image / markup results carry only content blocks
            return res
        items = sc.get("items")
        bad_items = [i for i in (items or []) if not i.get("ok")]
        note = f" items not ok: {bad_items}" if bad_items else ""
        print(f"  ok  {tag:34} {json.dumps({k: v for k, v in sc.items() if k not in ('items', 'note', 'idempotencyKey')})[:110]}{note}")
        return sc

    def check(self, label, cond, detail=""):
        print(f"  {'ok ' if cond else 'BAD'} {label:34} {detail}")
        if not cond:
            self.failures.append(label)


def main():
    mcp = Mcp()
    p = Probe(mcp)
    tools = sorted(t["name"] for t in mcp.rpc("tools/list", {})["result"]["tools"])
    print("=" * 96)
    print(f"ALL TOOLS, LIVE — {len(tools)} registered")
    print("=" * 96)

    st = p.call("figma_status")
    session = (st or {}).get("sessions", [{}])[0] if st else {}
    print(f"      plugin advertises {session.get('opsAdvertised')} ops; file {session.get('file', {}).get('name')!r}")

    # ── read ────────────────────────────────────────────────────────────────
    print("\n-- read")
    meta = p.call("figma_get_metadata")
    page_id = (meta or {}).get("currentPage", {}).get("id")
    page_name = (meta or {}).get("currentPage", {}).get("name")
    p.call("figma_get_pages")
    p.call("figma_get_selection")
    p.call("figma_get_fonts", {"scope": "page"})
    p.call("figma_get_styles")
    p.call("figma_get_variable_defs")
    p.call("figma_get_local_components")
    p.call("figma_get_annotations")

    # ── create: the sandbox everything else lives in ────────────────────────
    print("\n-- create")
    spec = {
        "type": "frame", "name": "figma-mcp all-tools probe (delete me)", "x": X, "y": Y, "width": 640,
        "layout": "vertical", "sizing": "hug", "gap": 16, "padding": [24, 24, 24, 24], "background": "#f4f4f6",
        "children": [
            {"type": "text", "name": "Title", "content": "All tools probe", "fontSize": 20, "weight": "Semi Bold"},
            {"type": "frame", "name": "Row", "layout": "horizontal", "alignX": "space-between", "alignY": "center",
             "width": 400, "height": 40, "sizing": "fixed",
             "children": [{"type": "rectangle", "name": "A", "width": 40, "height": 20, "fill": "#2f6feb"},
                          {"type": "button", "name": "Go", "padding": [6, 12, 6, 12],
                           "children": [{"type": "text", "content": "Go", "color": "#ffffff"}]}]},
            {"type": "component", "name": "Probe Chip", "layout": "horizontal", "padding": 6, "background": "#ffd166",
             "children": [{"type": "text", "content": "chip"}]},
        ],
    }
    built = p.call("figma_create_from_spec", {"spec": json.dumps(spec), "idempotencyKey": f"all-{RUN}-spec"})
    if not built:
        print("\nThe sandbox could not be built; stopping.")
        mcp.close()
        return 1
    root = built["rootId"]
    p.cleanup.append(root)
    by_path = {c["path"]: c["id"] for c in built["created"]}
    title, row, rect_a, chip = by_path["spec.children[0]"], by_path["spec.children[1]"], by_path["spec.children[1].children[0]"], by_path["spec.children[2]"]
    node = p.call("figma_get_node", {"nodeId": chip})
    p.check("spec 'component' became COMPONENT", (node or {}).get("node", {}).get("type") == "COMPONENT",
            str((node or {}).get("node", {}).get("type")))
    rowinfo = p.call("figma_get_nodes_info", {"nodeIds": [row]})
    p.call("figma_get_design_context", {"nodeId": root, "depth": 3})
    p.call("figma_search_nodes", {"query": "Probe Chip", "scope": "subtree", "nodeId": root})
    p.call("figma_scan_nodes_by_types", {"types": ["TEXT", "RECTANGLE"], "nodeId": root})
    p.call("figma_scan_text_nodes", {"nodeId": root})

    frame = p.call("figma_create_frame", {"name": "Free frame", "width": 120, "height": 80, "parentId": root,
                                          "layout": "horizontal", "padding": "8,16,8,16", "idempotencyKey": f"all-{RUN}-frame"})
    free = (frame or {}).get("id")
    txt = p.call("figma_create_text", {"content": "hello probe", "parentId": free, "weight": "Bold", "idempotencyKey": f"all-{RUN}-text"})
    if txt:
        p.check("create_text weight 'Bold' honoured", txt.get("font", {}).get("style") == "Bold", json.dumps(txt.get("font")))
    rect = p.call("figma_create_rectangle", {"width": 30, "height": 30, "parentId": root, "fill": "#06d6a0", "idempotencyKey": f"all-{RUN}-rect"})
    ell = p.call("figma_create_ellipse", {"width": 30, "height": 30, "parentId": root, "fill": "#ef476f", "idempotencyKey": f"all-{RUN}-ell"})
    p.call("figma_create_rectangle", {"width": 10, "height": 10, "parentId": "404:404"}, expect_error="No node", label="create_rectangle bad parent")
    sec = p.call("figma_create_section", {"name": "zz probe section", "x": X, "y": Y - 900, "width": 300, "height": 200, "idempotencyKey": f"all-{RUN}-sec"})
    if sec:
        p.cleanup.append(sec["id"])
    newpage = p.call("figma_create_page", {"name": f"zz figma-mcp probe page {RUN}", "idempotencyKey": f"all-{RUN}-page"})

    # ── components ──────────────────────────────────────────────────────────
    print("\n-- components")
    conv_src = p.call("figma_create_frame", {"name": "Probe Badge", "width": 40, "height": 16, "parentId": root, "background": "#118ab2"})
    badge = p.call("figma_convert_to_component", {"nodeId": conv_src["id"], "name": "Probe Badge"}) if conv_src else None
    inst = p.call("figma_create_instance", {"componentId": chip, "parentId": root, "idempotencyKey": f"all-{RUN}-inst"})
    if inst and badge:
        p.call("figma_swap_component", {"nodeId": inst["id"], "componentId": badge["id"]})
        det = p.call("figma_detach_instance", {"nodeIds": [inst["id"]]})
        p.check("detach reports the new frameId", bool(det and det["items"][0].get("frameId")))

    # ── styles & variables (deletable since the Phase 3 delete triad) ───────
    print("\n-- styles & variables")
    ps = p.call("figma_create_paint_style", {"name": f"zz figma-mcp probe/{RUN}/paint", "color": "#073b4c"})
    # lineHeight is a string ("20", "150%", "auto"): the schema refuses a bare number.
    ts = p.call("figma_create_text_style", {"name": f"zz figma-mcp probe/{RUN}/text", "fontSize": 14, "weight": "Medium", "lineHeight": "20"})
    es = p.call("figma_create_effect_style", {"name": f"zz figma-mcp probe/{RUN}/effect", "effects": [{"y": 2, "radius": 6}, {"type": "LAYER_BLUR", "radius": 1}]})
    for s in (ps, ts, es):
        if s:
            p.styles_to_delete.append(s["id"])
    if ps:
        p.call("figma_apply_style_to_node", {"nodeIds": [rect_a], "styleId": ps["id"]})
    if ts:
        p.call("figma_apply_style_to_node", {"nodeIds": [title], "styleName": ts["name"], "type": "text"})
    if es:
        p.call("figma_apply_style_to_node", {"nodeIds": [row], "styleId": es["id"]})
    col = p.call("figma_create_variable_collection", {"name": f"zz figma-mcp probe {RUN}"})
    if col:
        p.collections_to_delete.append(col["id"])
        cv = p.call("figma_create_variable", {"collectionId": col["id"], "name": "probe/color", "type": "COLOR", "value": "#ff006e"})
        fv = p.call("figma_create_variable", {"collectionId": col["id"], "name": "probe/gap", "type": "FLOAT", "value": "12"})
        p.call("figma_create_variable", {"collectionId": col["id"], "name": "probe/flag", "type": "BOOLEAN", "value": "true"})
        p.call("figma_add_variable_mode", {"collectionId": col["id"], "name": "Dark"},
               expect_error="mode|plan", label="add_variable_mode (Starter: refused)") if "Starter" in json.dumps(meta or {}) else \
            p.call("figma_add_variable_mode", {"collectionId": col["id"], "name": "Dark"})
        if cv and fv:
            p.call("figma_set_variable_value", {"variableId": fv["id"], "value": "20"})
            p.call("figma_set_variable_value", {"variableName": "probe/color", "value": "#8338ec"})
            p.call("figma_bind_variable_to_node", {"nodeIds": [rect_a], "field": "fill", "variableId": cv["id"]})
            p.call("figma_bind_variable_to_node", {"nodeIds": [row], "field": "gap", "variableName": "probe/gap"})
            # Exercise the delete tools on a throwaway variable, so they are
            # covered without disturbing the ones the binds above rely on.
            throwaway = p.call("figma_create_variable", {"collectionId": col["id"], "name": "probe/throwaway", "type": "STRING", "value": "x"})
            if throwaway:
                p.call("figma_delete_variable", {"variableIds": [throwaway["id"]]})

    # ── design tokens: every design-token tool once ─────────────────────────
    print("\n-- design tokens")
    # A library listing needs the teamlibrary permission and an enabled library;
    # without them UNSUPPORTED is the documented answer, not a failure.
    lib = p.mcp.rpc("tools/call", {"name": "figma_get_library_variables", "arguments": {}}).get("result") or {}
    p.called.add("figma_get_library_variables")
    lib_text = " ".join(c.get("text", "") for c in lib.get("content", []) if c.get("type") == "text")
    p.check("get_library_variables: list or UNSUPPORTED",
            (not lib.get("isError") and isinstance((lib.get("structuredContent") or {}).get("collections"), list))
            or (bool(lib.get("isError")) and lib_text.startswith("UNSUPPORTED")), lib_text[:100])
    gs = p.call("figma_create_grid_style", {"name": f"zz figma-mcp probe/{RUN}/grid",
                                             "grids": [{"pattern": "columns", "count": 12, "gutter": 24, "margin": 64}]})
    if gs:
        p.styles_to_delete.append(gs["id"])
        up = p.call("figma_update_style", {"styleId": gs["id"], "grids": [{"pattern": "columns", "count": 8, "gutter": 16, "margin": 32}]})
        if up:
            p.check("update_style grid value", up.get("value") == "columns 8, gutter 16, margin 32", up.get("value"))
    if ps:
        fade = p.call("figma_update_style", {"styleId": ps["id"], "opacity": 0.5}, label="update_style (opacity alone)")
        if fade:
            p.check("opacity alone fades the paint", "50%" in str(fade.get("value")), fade.get("value"))
    if col:
        mode0 = (col.get("modes") or [{}])[0].get("name", "Default")
        made = p.call("figma_create_variables", {"collectionId": col["id"], "variables": [
            {"name": "probe/space/base", "type": "FLOAT", "values": [{"mode": mode0, "value": "8"}], "scopes": []},
            {"name": "probe/space/gap", "type": "FLOAT", "values": [{"mode": mode0, "value": "alias:probe/space/base"}],
             "scopes": ["GAP"], "codeSyntax": {"WEB": "var(--space-gap)"}},
        ]})
        if made:
            p.check("create_variables made both", made.get("created") == 2, json.dumps(made)[:120])
        p.call("figma_create_variables", {"collectionId": col["id"], "variables": [
            {"name": "probe/space/0.5", "type": "FLOAT", "values": [{"mode": mode0, "value": "2"}]}]},
               expect_error="does not allow", label="create_variables refuses a dotted name")
        p.call("figma_set_variable_properties", {"variableNames": ["probe/space/gap"], "description": "Gap between items",
                                                 "codeSyntax": {"WEB": "var(--gap)"}})
        p.call("figma_update_variable_collection", {"collectionId": col["id"], "renameModes": [{"mode": mode0, "name": "Light"}]})
        p.call("figma_set_variable_mode", {"nodeIds": [root], "collectionId": col["id"], "mode": "Light"})
        p.call("figma_set_variable_mode", {"nodeIds": [root], "collectionId": col["id"], "clear": True}, label="set_variable_mode (clear)")
        # MEASURE, not pass/fail: whether the Plugin API itself refuses the
        # names checkVariableName / checkModeName refuse. The rule comes from
        # the REST variables page; this is the Plugin API's own answer.
        rule = p.call("figma_eval", {"code": (
            f"const c = await figma.variables.getVariableCollectionByIdAsync({json.dumps(col['id'])});\n"
            "const out = {};\n"
            "for (const name of ['probe/dot.5', 'probe/{brace}']) {\n"
            "  try { const v = figma.variables.createVariable(name, c, 'FLOAT'); out[name] = 'accepted'; v.remove(); }\n"
            "  catch (e) { out[name] = 'refused: ' + String((e && e.message) || e).slice(0, 120); }\n"
            "}\n"
            "const m = c.modes[0];\n"
            "try { c.renameMode(m.modeId, 'L'.repeat(41)); out.mode41 = 'accepted'; c.renameMode(m.modeId, m.name); }\n"
            "catch (e) { out.mode41 = 'refused: ' + String((e && e.message) || e).slice(0, 120); }\n"
            "return out;")}, label="eval: Plugin API on . {} and 41-char modes")
        if rule:
            print(f"      MEASURE createVariable / renameMode: {json.dumps(rule.get('value'))}")

    # ── style group on nodes ────────────────────────────────────────────────
    print("\n-- fills, strokes, effects, blend, reactions")
    p.call("figma_set_fills", {"nodeIds": [free], "fills": [{"gradient": {"type": "linear", "stops": [{"position": 0, "color": "#000"}, {"position": 1, "color": "#fff"}]}}]})
    p.call("figma_set_strokes", {"nodeIds": [free], "color": "#ff0000", "weight": 2, "align": "INSIDE", "dashPattern": [4, 2]})
    p.call("figma_set_corner_radius", {"nodeIds": [free], "radii": [2, 4, 6, 8]})
    p.call("figma_set_effects", {"nodeIds": [free], "effects": [{"type": "DROP_SHADOW", "color": "#00000033", "y": 3, "radius": 6, "showBehindNode": True}, {"type": "INNER_SHADOW", "y": -1}]})
    p.call("figma_set_blend_mode", {"nodeIds": [free], "blendMode": "MULTIPLY"})
    # A NAVIGATE destination must be another top-level frame: Figma rejects the
    # frame that contains the source itself (measured on the first run).
    dest = p.call("figma_create_frame", {"name": "zz probe destination", "x": X + 800, "y": Y, "width": 100, "height": 100},
                  label="create_frame (destination)")
    if dest:
        p.cleanup.append(dest["id"])
    if rect and ell and dest:
        p.call("figma_set_reactions", {"nodeId": rect["id"], "reactions": json.dumps([
            {"trigger": "ON_CLICK", "action": {"type": "NODE", "destinationId": dest["id"], "transition": "SMART_ANIMATE", "duration": 0.25}}])})
        rr = p.call("figma_get_reactions", {"nodeId": rect["id"]})
        if rr:
            tr = (rr.get("reactions") or [{}])[0].get("actions", [{}])[0].get("transition") or {}
            p.check("reaction transition stored", tr.get("type") == "SMART_ANIMATE", json.dumps(tr)[:120])
        p.call("figma_remove_reactions", {"nodeId": rect["id"]})

    # ── modify ──────────────────────────────────────────────────────────────
    print("\n-- modify")
    p.call("figma_set_text", {"nodeId": title, "content": "All tools probe ✓"})
    p.call("figma_find_replace_text", {"find": "hello probe", "replace": "hi probe", "scope": "subtree", "nodeId": root})
    p.call("figma_rename_node", {"nodeId": free, "name": "Free frame (renamed)"})
    p.call("figma_batch_rename_nodes", {"pattern": "^(A)$", "replace": "Chip $1", "regex": True, "scope": "subtree", "nodeId": root})
    if rect and ell:
        p.call("figma_move_nodes", {"nodeIds": [rect["id"]], "x": 10, "y": 0, "relative": True})
        p.call("figma_resize_nodes", {"nodeIds": [ell["id"]], "width": 36, "height": 36})
        p.call("figma_rotate_nodes", {"nodeIds": [ell["id"]], "angle": 15})
        p.call("figma_reorder_nodes", {"nodeIds": [ell["id"]], "position": "0"})
        p.call("figma_set_visible", {"nodeIds": [ell["id"]], "visible": False})
        p.call("figma_set_visible", {"nodeIds": [ell["id"]], "visible": True}, label="set_visible (back)")
        p.call("figma_set_locked", {"nodeIds": [ell["id"]], "locked": True})
        p.call("figma_set_locked", {"nodeIds": [ell["id"]], "locked": False}, label="set_locked (back)")
        p.call("figma_set_opacity", {"nodeIds": [ell["id"]], "opacity": 0.5})
        grp = p.call("figma_group_nodes", {"nodeIds": [rect["id"], ell["id"]], "name": "Probe group"})
        if grp:
            p.call("figma_ungroup_nodes", {"nodeIds": [grp["id"]]})
        cl = p.call("figma_clone_node", {"nodeId": rect["id"], "parentId": root})
        p.call("figma_set_constraints", {"nodeIds": [rect["id"]], "horizontal": "center", "vertical": "top-bottom"})
        p.call("figma_reparent_nodes", {"nodeIds": [ell["id"]], "parentId": free})
        if cl:
            p.call("figma_delete_nodes", {"nodeIds": [cl["id"]]})
    al = p.call("figma_set_auto_layout", {"nodeId": row, "mode": "horizontal", "alignX": "end", "alignY": "center", "padding": "4", "wrap": True})
    if al:
        p.check("auto-layout alignX end → primary MAX", al.get("primaryAxisAlignItems") == "MAX" and al.get("layoutWrap") == "WRAP", json.dumps(al)[:120])
    p.call("figma_set_auto_layout", {"nodeId": row, "mode": "vertical", "wrap": True}, expect_error="horizontal", label="set_auto_layout wrap on vertical")

    # ── meta: what the user sees ────────────────────────────────────────────
    print("\n-- select, navigate, zoom")
    p.call("figma_navigate_page", {"pageName": page_name})
    p.call("figma_select", {"nodeIds": [root]})
    p.call("figma_zoom_to", {"nodeId": root, "zoom": "fit"})
    p.call("figma_select", {"nodeIds": [root], "mode": "toggle"}, label="select (toggle off)")

    # ── export: look at it ──────────────────────────────────────────────────
    print("\n-- export")
    img = p.call("figma_export_node", {"nodeId": root, "scale": 1})
    blocks = (img or {}).get("content") or []
    png = blocks and blocks[0].get("type") == "image" and base64.b64decode(blocks[0].get("data", ""))[:4] == bytes([137, 80, 78, 71])
    p.check("export PNG is an image block", bool(png))
    if png:
        out = os.path.join(REPO, "spikes", "results", "live-all-tools.png")
        with open(out, "wb") as f:
            f.write(base64.b64decode(blocks[0]["data"]))
        print(f"      saved {os.path.relpath(out, REPO)} for a human look")
    p.call("figma_export_node", {"nodeId": chip, "format": "SVG"})

    # ── Phase 4: batch screenshots, PDF merge, and the escape hatch ──────────
    print("\n-- phase 4: save_screenshots / export_frames_to_pdf / eval")
    shots = p.call("figma_save_screenshots", {"nodeIds": [root], "format": "PNG", "scale": 1,
                                              "dir": f"spikes/results/probe-{RUN}"})
    if shots:
        files = shots.get("files", [])
        print(f"      save_screenshots wrote {len(files)} file(s): "
              f"{[os.path.basename(f['path']) for f in files]}")
        # A path that claims success but wrote nothing is the failure this catches.
        for f in files:
            p.check(f"file exists: {os.path.basename(f['path'])}", Path(f["path"]).is_file())
        # One bad id must not lose the good one (per-item results).
        mixed = p.call("figma_save_screenshots", {"nodeIds": [root, "9999:9999"], "format": "PNG", "scale": 1,
                                                  "dir": f"spikes/results/probe-{RUN}"})
        if mixed:
            p.check("save_screenshots: good node survived a bad id",
                    len(mixed.get("files", [])) == 1 and len(mixed.get("failed", [])) == 1,
                    f"files={len(mixed.get('files', []))} failed={len(mixed.get('failed', []))}")
        # Path escape must be refused, and refused BEFORE rendering.
        p.call("figma_save_screenshots", {"nodeIds": [root], "dir": "../../../../tmp"},
               expect_error="root|outside|allowed|escape", label="save_screenshots refuses an escaping dir")

    # A RELATIVE outputPath resolves inside the export directory, which is the
    # documented way to write without configuring BRIDGE_EXPORT_ROOTS.
    pdf_path = f"probe-{RUN}.pdf"
    pdf = p.call("figma_export_frames_to_pdf", {"nodeIds": [root], "outputPath": pdf_path})
    if pdf:
        p.check("PDF written", Path(pdf["path"]).is_file())
        if Path(pdf["path"]).is_file():
            head = Path(pdf["path"]).read_bytes()[:5]
            # %PDF- is the only honest proof it is a PDF and not an error message.
            p.check("PDF has a %PDF- header", head == b"%PDF-", head)
            print(f"      {pdf['pageCount']} page(s), {pdf['bytes']} bytes")
    # A non-frame must be reported per-item, not take the whole call down.
    bad_pdf = p.call("figma_export_frames_to_pdf", {"nodeIds": [root, chip], "outputPath": pdf_path},
                     label="export_frames_to_pdf with a non-frame page")
    if bad_pdf:
        print(f"      mixed frames: pages={bad_pdf.get('pageCount')} failed={len(bad_pdf.get('failed', []))}")

    # figma_eval: the escape hatch is on (BRIDGE_ALLOW_EVAL=1 in this probe).
    ev = p.call("figma_eval", {"code": "return { root: figma.root.name, n: 1 + 1 };"})
    if ev:
        p.check("eval returned its value", (ev.get("value") or {}).get("n") == 2, ev.get("value"))
    # It must refuse code that cannot compile, naming the reason rather than hanging.
    p.call("figma_eval", {"code": "this is not javascript"}, expect_error="compile|Unexpected", label="eval rejects a syntax error")
    # It must refuse a non-serializable return, rather than failing later in the transport.
    p.call("figma_eval", {"code": "return figma.currentPage;"}, expect_error="serializ|JSON", label="eval rejects a live node as a return value")
    # A write through eval must be one Ctrl+Z like any other write (proved by undo).
    evw = p.call("figma_eval", {"code": f"const r = figma.createRectangle(); r.name = 'eval made me'; return {{ id: r.id }};"})
    if evw:
        made = (evw.get("value") or {}).get("id")
        print(f"      eval created {made}")
        if made:
            # Delete it with a tool rather than undo, so the rest of the probe survives.
            p.call("figma_delete_nodes", {"nodeIds": [made]}, label="cleanup the eval-created node")

    # ── undo: measured, right after our own change ──────────────────────────
    print("\n-- undo (measured)")
    p.call("figma_undo_step", {"count": 1}, expect_error="confirm", label="undo_step without confirm")
    victim = p.call("figma_create_rectangle", {"width": 5, "height": 5, "parentId": root, "name": "undo victim"})
    if victim:
        p.call("figma_undo_step", {"confirm": True})
        gone = p.mcp.rpc("tools/call", {"name": "figma_get_node", "arguments": {"nodeId": victim["id"]}}).get("result", {}).get("isError", False)
        print(f"      after undo_step, the rectangle created by the previous call is {'GONE' if gone else 'STILL THERE'}"
              f"  <- measures what triggerUndo reverts (spec §14.8)")
        if not gone:
            p.cleanup.append(victim["id"])

    # ── cleanup: everything this probe made, styles and variables included ──
    print("\n-- cleanup")
    if newpage:
        p.cleanup.append(newpage["id"])
    p.call("figma_delete_nodes", {"nodeIds": p.cleanup}, label="delete_nodes (cleanup)")
    if p.styles_to_delete:
        # The delete triad exists now, so a run leaves the file as it found it.
        # Before it, every run added three styles and a collection that no tool
        # could remove — and a probe that quietly pollutes the user's file is a
        # probe people stop running.
        p.call("figma_delete_style", {"styleIds": p.styles_to_delete}, label="delete_style (cleanup)")
    for cid in p.collections_to_delete:
        p.call("figma_delete_variable_collection", {"collectionId": cid}, label="delete_variable_collection (cleanup)")
    left = p.call("figma_search_nodes", {"query": "all-tools probe"})
    p.check("sandbox gone", (left or {}).get("count") == 0, f"{(left or {}).get('count')} left")
    styles_left = (p.call("figma_get_styles", {}) or {}).get("styles", {})
    mine = [n["name"] for kind in styles_left.values() for n in kind if f"zz figma-mcp probe/{RUN}/" in n.get("name", "")]
    p.check("probe styles gone (this run)", not mine, f"{mine}")
    # Leftovers from earlier runs are reported, not failed: the probe cannot
    # clean what a previous version of it created, and a red line for history
    # would train the reader to ignore red lines.
    stale = [n["name"] for kind in styles_left.values() for n in kind if "zz figma-mcp probe" in n.get("name", "") and n["name"] not in mine]
    if stale:
        print(f"  note  {len(stale)} style(s) left by an earlier run: {stale}")
    all_cols = (p.call("figma_get_variable_defs", {}) or {}).get("collections", [])
    mine_cols = [c["name"] for c in all_cols if f"zz figma-mcp probe {RUN}" in c.get("name", "")]
    p.check("probe variable collections gone (this run)", not mine_cols, f"{mine_cols}")
    stale_cols = [c["name"] for c in all_cols if "zz figma-mcp probe" in c.get("name", "") and c["name"] not in mine_cols]
    if stale_cols:
        print(f"  note  {len(stale_cols)} collection(s) left by an earlier run: {stale_cols}")

    mcp.close()
    missing = [t for t in tools if t not in p.called]
    print("\n" + "=" * 96)
    print(f"  tools registered: {len(tools)}   exercised: {len(set(tools) & p.called)}   not exercised: {missing or 'none'}")
    print(f"  failures: {len(p.failures)} {p.failures if p.failures else ''}")
    if p.leftovers:
        print("  left in the file (figma-mcp has no delete tool for these yet):")
        for item in p.leftovers:
            print(f"    - {item}")
    print("=" * 96)
    return 1 if (p.failures or missing) else 0


if __name__ == "__main__":
    sys.exit(main())

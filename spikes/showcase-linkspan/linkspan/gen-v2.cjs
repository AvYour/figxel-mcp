// Linkspan v2: generates section specs for figma_create_from_spec.
const fs = require("fs");
const path = require("path");
const ICONS = path.join(__dirname, "..", "heroicons");
const out = (name, obj) => fs.writeFileSync(path.join(__dirname, `v2-${name}.json`), JSON.stringify(obj));

const INK = "#1C1C1C", GROUND = "#F3F4F1", PANEL = "#FFFFFF", LINE = "#E1E3DE", HAIR = "#ECEEEA";
const GREY = "#5F6368", AMBER = "#F5B800", AMBER_SOFT = "#FBE3A1", AMBER_DEEP = "#806200", AMBER_EDGE = "#B98A00";
const DONE = "#E3E5E0";
const D = "Barlow Semi Condensed", T = "IBM Plex Sans";

const icon = (n, color = INK, size = 24, name) => {
  const svg = fs.readFileSync(path.join(ICONS, `${n}.svg`), "utf8").replace(/\s*\n\s*/g, "").replace(/ aria-hidden="true" data-slot="icon"/, "");
  return { type: "svg", name: name || `Icon / ${n}`, svg, width: size, height: size, color };
};
const tx = (name, content, family, weight, size, color = INK, extra = {}) => ({ type: "text", name, content, fontFamily: family, weight, fontSize: size, color, ...extra });

// ── rail ─────────────────────────────────────────────────────────────
const navItem = (label, ic, current = false) => ({
  type: "frame", name: `Nav item / ${label}${current ? " (current)" : ""}`, layout: "vertical", width: 72, height: 60, gap: 4,
  alignX: "center", alignY: "center", cornerRadius: 10,
  ...(current ? { background: PANEL, stroke: LINE, strokeWeight: 1 } : {}),
  children: [icon(ic, current ? INK : GREY), tx("Label", label, T, current ? "SemiBold" : "Medium", 13, current ? INK : GREY)],
});
out("rail", {
  type: "frame", name: "Rail", layout: "vertical", width: 88, sizing: { height: "fill" }, padding: [20, 8, 20, 8], gap: 4, alignX: "center",
  children: [
    { type: "frame", name: "Logo", layout: "horizontal", width: 40, height: 40, cornerRadius: 10, background: INK, alignX: "center", alignY: "center",
      children: [tx("Mark", "L", D, "SemiBold", 24, "#FFFFFF")] },
    { type: "frame", name: "Spacer", width: 72, height: 16 },
    navItem("Today", "calendar-days", true), navItem("Timetable", "clock"), navItem("Vessels", "lifebuoy"), navItem("Berths", "map"),
    navItem("Crew", "user-group"), navItem("Notices", "bell-alert"), navItem("Reports", "chart-bar"),
  ],
});

// ── header ───────────────────────────────────────────────────────────
out("header", {
  type: "frame", name: "Header", layout: "horizontal", sizing: { width: "fill" }, height: 48, alignX: "space-between", alignY: "center",
  children: [
    { type: "frame", name: "Title", layout: "horizontal", gap: 16, alignY: "baseline", children: [
      tx("Screen title", "Today", D, "SemiBold", 36, INK, { lineHeight: "40" }),
      tx("Date", "Tue 20 Oct, 42 sailings on 3 routes", T, "Regular", 15, GREY) ] },
    { type: "frame", name: "Tools", layout: "horizontal", gap: 12, alignY: "center", children: [
      { type: "frame", name: "Live", layout: "horizontal", gap: 8, alignY: "center", children: [icon("signal", GREY), tx("Live label", "Car counts live, 07:38", T, "Regular", 14, GREY)] },
      { type: "frame", name: "Search field", layout: "horizontal", width: 320, height: 40, padding: [0, 12, 0, 12], gap: 8, alignY: "center", cornerRadius: 8, background: PANEL, stroke: LINE, strokeWeight: 1, children: [
        icon("magnifying-glass", GREY), tx("Placeholder", "Search sailings, vessels, berths", T, "Regular", 14, GREY, { sizing: { width: "fill" } }),
        { type: "frame", name: "Shortcut", layout: "horizontal", padding: [2, 6, 2, 6], cornerRadius: 4, stroke: LINE, strokeWeight: 1, children: [tx("Keys", "Ctrl K", T, "Medium", 13, GREY)] } ] },
      { type: "frame", name: "Dispatcher", layout: "horizontal", width: 40, height: 40, cornerRadius: 20, background: INK, alignX: "center", alignY: "center", children: [tx("Initials", "RM", T, "SemiBold", 14, "#FFFFFF")] },
    ] },
  ],
});

// ── finding card ─────────────────────────────────────────────────────
const cells = (plan, w, h, gap, loaded, outline) => plan.map(([l, t, s], i) => ({
  type: "frame", name: `Lane ${i + 1}`, layout: "horizontal", gap,
  children: [
    ...Array.from({ length: l }, () => ({ type: "rectangle", name: "On board", width: w, height: h, cornerRadius: 2, fill: loaded })),
    ...Array.from({ length: t }, () => ({ type: "rectangle", name: "To load", width: w, height: h, cornerRadius: 2, stroke: outline, strokeWeight: 1.5 })),
    ...Array.from({ length: s }, () => ({ type: "rectangle", name: "Spare", width: w, height: h, cornerRadius: 2, stroke: outline, strokeWeight: 1, opacity: 0.45 })),
  ],
}));
const PLAN = [[16, 0, 0], [16, 0, 0], [16, 0, 0], [2, 14, 0], [0, 12, 4]];
const btn = (label, primary, ic) => ({
  type: "frame", name: `Button / ${label}`, layout: "horizontal", height: 44, padding: [0, 18, 0, 18], gap: 8, alignY: "center", cornerRadius: 8,
  ...(primary ? { background: INK } : { stroke: INK, strokeWeight: 1.5 }),
  children: [...(ic ? [icon(ic, primary ? "#FFFFFF" : INK)] : []), tx("Label", label, T, "SemiBold", 15, primary ? "#FFFFFF" : INK)],
});
out("finding", {
  type: "frame", name: "Finding · 07:20 is 18 min late", layout: "horizontal", sizing: { width: "fill" }, padding: 24, gap: 28, cornerRadius: 14, background: AMBER,
  children: [
    { type: "frame", name: "Delay", layout: "vertical", width: 136, children: [
      tx("Minutes late", "+18", D, "SemiBold", 88, INK, { lineHeight: "88" }), tx("Unit", "min late", T, "Medium", 15) ] },
    { type: "frame", name: "Sailing, reason and fix", layout: "vertical", sizing: { width: "fill" }, gap: 6, children: [
      { type: "frame", name: "Kind", layout: "horizontal", gap: 6, alignY: "center", children: [icon("exclamation-triangle", INK), tx("Kind label", "Needs you now", T, "SemiBold", 14)] },
      tx("Sailing", "07:20 Port Ellery to Marrow Island", D, "SemiBold", 32, INK, { lineHeight: "36", sizing: { width: "fill" } }),
      tx("Reason", "Corran is still loading lane 4 at berth 2: 26 cars to go.", T, "Regular", 16, INK, { lineHeight: "22", sizing: { width: "fill" } }),
      tx("Knock-on", "If she sails at 07:45, her 08:40 return leaves about 09:05.", T, "Regular", 14, "#3A3420", { lineHeight: "20", sizing: { width: "fill" } }),
      { type: "frame", name: "Actions", layout: "horizontal", gap: 10, padding: [10, 0, 0, 0], children: [btn("Delay sailing", true, "clock"), btn("Hold at berth", false), btn("Notify 212 passengers", false, "chat-bubble-left-right")] },
    ] },
    { type: "frame", name: "Deck chart · Corran car deck", layout: "vertical", width: 212, gap: 6, children: [
      tx("Chart title", "Corran car deck", T, "SemiBold", 13), tx("Chart count", "26 to go, 50 on board", T, "Regular", 13),
      { type: "frame", name: "Lanes", layout: "vertical", gap: 4, padding: [6, 0, 0, 0], children: cells(PLAN, 10, 8, 3, AMBER_DEEP, INK) },
    ] },
  ],
});

// ── timeline ─────────────────────────────────────────────────────────
const X0 = 6, PX = 90; // 06:00 at x 0, 90 px per hour
const at = (h, m = 0) => Math.round((h + m / 60 - X0) * PX);
const bar = (name, from, to, kind, label) => {
  const x = at(...from), w = at(...to) - x;
  const st = {
    done: { fill: DONE, color: GREY },
    live: { fill: INK, color: "#FFFFFF" },
    next: { fill: PANEL, stroke: INK, strokeWeight: 1.5, color: INK },
    late: { fill: AMBER, color: INK },
    knock: { fill: AMBER_SOFT, stroke: AMBER_EDGE, strokeWeight: 1.5, color: INK },
    crew: { fill: HAIR, stroke: LINE, strokeWeight: 1, color: GREY },
  }[kind];
  return { type: "frame", name: `Bar / ${name}`, x, y: 8, width: w, height: 28, layout: "horizontal", padding: [0, 8, 0, 8], alignY: "center", cornerRadius: 6, clipsContent: true,
    background: st.fill, ...(st.stroke ? { stroke: st.stroke, strokeWeight: st.strokeWeight } : {}),
    children: [tx("Bar label", label, T, kind === "late" || kind === "live" ? "SemiBold" : "Medium", 13, st.color)] };
};
const lane = (vessel, cap, bars) => ({
  type: "frame", name: `Lane / ${vessel}`, layout: "horizontal", sizing: { width: "fill" }, height: 44, alignY: "center", children: [
    { type: "frame", name: "Vessel", layout: "vertical", width: 104, children: [tx("Name", vessel, T, "SemiBold", 14), tx("Capacity", cap, T, "Regular", 13, GREY)] },
    { type: "frame", name: "Track", width: 720, height: 44, layout: "none", clipsContent: true, children: bars },
  ],
});
const hours = Array.from({ length: 9 }, (_, i) => i + 6);
out("timeline", {
  type: "frame", name: "Day timeline", layout: "vertical", sizing: { width: "fill" }, padding: [18, 24, 18, 24], gap: 8, cornerRadius: 14, background: PANEL, stroke: LINE, strokeWeight: 1,
  children: [
    { type: "frame", name: "Timeline header", layout: "horizontal", sizing: { width: "fill" }, alignX: "space-between", alignY: "center", children: [
      tx("Panel title", "Day timeline", T, "SemiBold", 16),
      { type: "frame", name: "Legend", layout: "horizontal", gap: 16, alignY: "center", children: [
        ...[["On time", { background: PANEL, stroke: INK, strokeWeight: 1.5 }], ["Late", { background: AMBER }], ["Knock-on", { background: AMBER_SOFT, stroke: AMBER_EDGE, strokeWeight: 1.5 }], ["Done", { background: DONE }]].map(([l, s]) => ({
          type: "frame", name: `Legend / ${l}`, layout: "horizontal", gap: 6, alignY: "center", children: [{ type: "frame", name: "Swatch", width: 14, height: 10, cornerRadius: 3, ...s }, tx("Legend label", l, T, "Regular", 13, GREY)] })),
      ] },
    ] },
    { type: "frame", name: "Axis", layout: "horizontal", sizing: { width: "fill" }, height: 20, alignY: "center", children: [
      { type: "frame", name: "Axis spacer", width: 104, height: 20 },
      { type: "frame", name: "Hours", width: 720, height: 20, layout: "none", children: hours.map((h) => tx(`Hour ${h}`, `${String(h).padStart(2, "0")}:00`, T, "Regular", 13, GREY, { x: Math.min(at(h), 680), y: 1 })) },
    ] },
    { type: "frame", name: "Lanes", layout: "vertical", sizing: { width: "fill" }, children: [
      lane("Corran", "76 cars", [bar("06:00 done", [6, 0], [6, 40], "done", "06:00"), bar("06:55 done", [6, 55], [7, 15], "done", "06:55"),
        bar("07:20 late", [7, 20], [8, 25], "late", "07:20 Marrow, +18"), bar("08:40 knock-on", [9, 5], [9, 45], "knock", "08:40 now 09:05"),
        bar("10:10", [10, 10], [10, 50], "next", "10:10"), bar("11:40", [11, 40], [12, 20], "next", "11:40")]),
      lane("Wren", "58 cars", [bar("06:30 done", [6, 30], [7, 0], "done", "06:30"), bar("07:40 boarding", [7, 40], [8, 10], "live", "07:40 boarding"),
        bar("09:00", [9, 0], [9, 30], "next", "09:00"), bar("10:30", [10, 30], [11, 0], "next", "10:30"), bar("12:00", [12, 0], [12, 30], "next", "12:00")]),
      lane("Halcyon", "76 cars", [bar("06:45 done", [6, 45], [7, 4], "done", "06:45"), bar("07:04 crossing", [7, 4], [7, 44], "live", "07:04 crossing"),
        bar("08:00", [8, 0], [8, 40], "next", "08:00"), bar("09:20", [9, 20], [10, 0], "next", "09:20 full"), bar("11:10", [11, 10], [11, 50], "next", "11:10")]),
      lane("Brigid", "44 cars", [bar("06:15 done", [6, 15], [6, 45], "done", "06:15"), bar("crew change", [7, 0], [7, 55], "crew", "Crew change"),
        bar("08:15", [8, 15], [8, 45], "next", "08:15"), bar("09:45", [9, 45], [10, 15], "next", "09:45"), bar("11:30", [11, 30], [12, 0], "next", "11:30")]),
    ] },
  ],
});

// ── departures ───────────────────────────────────────────────────────
const W = { dep: 64, route: 260, vessel: 96, berth: 56, cars: 96, status: 168 };
const cell = (name, content, w, align = "left", family = T, weight = "Regular", color = INK) => tx(name, content, family, weight, 14, color, { width: w, align });
const chip = (kind) => {
  const c = { late: ["Late, 18 min", "exclamation-triangle", AMBER, INK], boarding: ["Boarding", "arrow-path", PANEL, INK], ontime: ["On time", "check-circle", PANEL, GREY], full: ["Full for cars", "truck", PANEL, GREY] }[kind];
  return { type: "frame", name: "Status", layout: "horizontal", width: W.status, children: [{ type: "frame", name: "Chip", layout: "horizontal", gap: 6, padding: [3, 10, 3, 8], alignY: "center", cornerRadius: 999,
    background: c[2], ...(c[2] === PANEL ? { stroke: LINE, strokeWeight: 1 } : {}), children: [icon(c[1], c[3], 18), tx("Chip label", c[0], T, "Medium", 13, c[3])] }] };
};
const row = (dep, route, vessel, berth, cars, kind, shade) => ({
  type: "frame", name: `Row ${dep}`, layout: "horizontal", sizing: { width: "fill" }, height: 44, gap: 16, padding: [0, 8, 0, 8], alignY: "center", cornerRadius: 8,
  ...(shade ? { background: GROUND } : {}),
  children: [cell("Dep", dep, W.dep, "left", T, "SemiBold"), cell("Route", route, W.route), cell("Vessel", vessel, W.vessel), cell("Berth", berth, W.berth, "right"), cell("Cars", cars, W.cars, "right"), chip(kind)],
});
out("departures", {
  type: "frame", name: "Next departures", layout: "vertical", sizing: { width: "fill", height: "fill" }, padding: [18, 24, 18, 24], gap: 6, cornerRadius: 14, background: PANEL, stroke: LINE, strokeWeight: 1,
  children: [
    { type: "frame", name: "Departures header", layout: "horizontal", sizing: { width: "fill" }, alignX: "space-between", alignY: "center", children: [
      tx("Panel title", "Next departures", T, "SemiBold", 16), tx("All", "All 37 today", T, "Medium", 14, GREY)] },
    { type: "frame", name: "Table header", layout: "horizontal", sizing: { width: "fill" }, height: 28, gap: 16, padding: [0, 8, 0, 8], alignY: "center", children: [
      cell("Dep", "Dep", W.dep, "left", T, "Medium", GREY), cell("Route", "Route", W.route, "left", T, "Medium", GREY), cell("Vessel", "Vessel", W.vessel, "left", T, "Medium", GREY),
      cell("Berth", "Berth", W.berth, "right", T, "Medium", GREY), cell("Cars", "Cars booked", W.cars, "right", T, "Medium", GREY), cell("Status", "Status", W.status, "left", T, "Medium", GREY)] },
    { type: "frame", name: "Sailings table", layout: "vertical", sizing: { width: "fill" }, children: [
      row("07:20", "Port Ellery to Marrow Island", "Corran", "2", "76", "late", true),
      row("07:40", "Port Ellery to Tansy Point", "Wren", "1", "58", "boarding", false),
      row("08:00", "Marrow Island to Port Ellery", "Halcyon", "M1", "64", "ontime", true),
      row("08:15", "Tansy Point to Port Ellery", "Brigid", "T1", "40", "ontime", false),
      row("09:20", "Port Ellery to Marrow Island", "Halcyon", "2", "76", "full", true),
    ] },
  ],
});

// ── vessel panel ─────────────────────────────────────────────────────
const stat = (label, value) => ({ type: "frame", name: `Stat / ${label}`, layout: "horizontal", sizing: { width: "fill" }, alignX: "space-between", alignY: "center", height: 32, children: [
  tx("Stat label", label, T, "Regular", 14, GREY), tx("Stat value", value, T, "SemiBold", 14, INK)] });
out("vessel", {
  type: "frame", name: "Vessel · Corran", layout: "vertical", width: 360, sizing: { height: "fill" }, padding: 20, gap: 14, cornerRadius: 14, background: PANEL, stroke: LINE, strokeWeight: 1,
  children: [
    { type: "frame", name: "Vessel header", layout: "horizontal", sizing: { width: "fill" }, alignX: "space-between", alignY: "center", children: [
      tx("Vessel name", "Corran", D, "SemiBold", 32, INK, { lineHeight: "36" }),
      { type: "frame", name: "Vessel status", layout: "horizontal", gap: 6, padding: [4, 10, 4, 8], alignY: "center", cornerRadius: 999, background: AMBER, children: [icon("truck", INK, 18), tx("Status label", "Loading, berth 2", T, "Medium", 13)] }] },
    { type: "frame", name: "Camera", layout: "vertical", sizing: { width: "fill" }, gap: 8, children: [
      { type: "rectangle", name: "Berth 2 camera still", width: 320, height: 180, cornerRadius: 10, fill: "#8C8C8C" },
      { type: "frame", name: "Camera caption", layout: "horizontal", gap: 6, alignY: "center", children: [icon("video-camera", GREY, 18), tx("Caption", "Berth 2 camera, 07:38", T, "Regular", 13, GREY)] }] },
    { type: "frame", name: "Deck chart · Corran car deck", layout: "vertical", sizing: { width: "fill" }, gap: 6, children: [
      { type: "frame", name: "Deck header", layout: "horizontal", sizing: { width: "fill" }, alignX: "space-between", children: [tx("Deck title", "Car deck", T, "SemiBold", 14), tx("Deck count", "50 of 76", T, "SemiBold", 14)] },
      { type: "frame", name: "Lanes", layout: "vertical", gap: 4, children: cells(PLAN, 16, 10, 4, "#9AA09A", INK) },
      tx("Deck note", "Lane 4 stalled at 2 cars. Lane 5 waiting.", T, "Regular", 13, GREY)] },
    { type: "frame", name: "Stats", layout: "vertical", sizing: { width: "fill" }, children: [
      stat("Foot passengers", "212"), stat("Crew", "9 of 9"), stat("Next sailing", "08:40, now 09:05"), stat("Wind at berth 2", "SW 18 kn, gusts 26")] },
    btn("Message berth 2", false, "chat-bubble-left-right"),
  ],
});
console.log(fs.readdirSync(__dirname).filter((f) => f.startsWith("v2-")).map((f) => `${f} ${fs.statSync(path.join(__dirname, f)).size}`).join("\n"));

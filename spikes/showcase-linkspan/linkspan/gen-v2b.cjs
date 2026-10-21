// Linkspan v2, second pass: timeline (06:00-12:00, now line, room for labels) and a 3-row departures table.
const fs = require("fs");
const path = require("path");
const ICONS = path.join(__dirname, "..", "heroicons");
const out = (name, obj) => fs.writeFileSync(path.join(__dirname, `v2-${name}.json`), JSON.stringify(obj));

const INK = "#1C1C1C", GROUND = "#F3F4F1", PANEL = "#FFFFFF", LINE = "#E1E3DE", HAIR = "#ECEEEA";
const GREY = "#5F6368", AMBER = "#F5B800", AMBER_SOFT = "#FBE3A1", AMBER_DEEP = "#806200", AMBER_EDGE = "#B98A00";
const DONE = "#E3E5E0";
const T = "IBM Plex Sans";

const icon = (n, color = INK, size = 24, name) => {
  const svg = fs.readFileSync(path.join(ICONS, `${n}.svg`), "utf8").replace(/\s*\n\s*/g, "").replace(/ aria-hidden="true" data-slot="icon"/, "");
  return { type: "svg", name: name || `Icon / ${n}`, svg, width: size, height: size, color };
};
const tx = (name, content, family, weight, size, color = INK, extra = {}) => ({ type: "text", name, content, fontFamily: family, weight, fontSize: size, color, ...extra });

// ── timeline ─────────────────────────────────────────────────────────
const TRACK = 756, X0 = 6, X1 = 12, PX = TRACK / (X1 - X0); // 126 px per hour
const at = (h, m = 0) => Math.round((h + m / 60 - X0) * PX);
const NOW = at(7, 38);
const ST = {
  done: { fill: DONE, color: GREY, weight: "Medium" },
  live: { fill: INK, color: "#FFFFFF", weight: "SemiBold" },
  next: { fill: PANEL, stroke: INK, strokeWeight: 1.5, color: INK, weight: "Medium" },
  late: { fill: AMBER, color: INK, weight: "SemiBold" },
  knock: { fill: AMBER_SOFT, stroke: AMBER_EDGE, strokeWeight: 1.5, color: INK, weight: "SemiBold" },
  crew: { fill: HAIR, stroke: LINE, strokeWeight: 1, color: GREY, weight: "Medium" },
};
const bar = (name, from, to, kind, label) => {
  const x = at(...from), w = at(...to) - x, st = ST[kind];
  return { type: "frame", name: `Bar / ${name}`, x, y: 8, width: w, height: 28, layout: "horizontal", padding: [0, 8, 0, 8], alignY: "center", cornerRadius: 6,
    background: st.fill, ...(st.stroke ? { stroke: st.stroke, strokeWeight: st.strokeWeight } : {}),
    children: [tx("Bar label", label, T, st.weight, 13, st.color)] };
};
const lateBar = () => { const x = at(7, 20), w = at(8, 25) - x, over = NOW - x;
  return { type: "frame", name: "Bar / 07:20 late", x, y: 8, width: w, height: 28, layout: "horizontal", padding: [0, 8, 0, 0], gap: 8, alignY: "center", cornerRadius: 6, clipsContent: true, background: AMBER,
    children: [{ type: "rectangle", name: "Overdue so far", width: over, height: 28, fill: AMBER_EDGE }, tx("Bar label", "07:20, +18", T, "SemiBold", 13, INK)] }; };
const note = (name, content, x) => tx(name, content, T, "Medium", 13, AMBER_DEEP, { x, y: 13 });
const ticks = () => Array.from({ length: X1 - X0 - 1 }, (_, i) => ({ type: "rectangle", name: `Hour line ${X0 + i + 1}`, x: at(X0 + i + 1), y: 0, width: 1, height: 44, fill: HAIR }));
const lane = (vessel, cap, items) => ({
  type: "frame", name: `Lane / ${vessel}`, layout: "horizontal", sizing: { width: "fill" }, height: 44, alignY: "center", children: [
    { type: "frame", name: "Vessel", layout: "vertical", width: 104, children: [tx("Name", vessel, T, "SemiBold", 14), tx("Capacity", cap, T, "Regular", 13, GREY)] },
    { type: "frame", name: "Track", width: TRACK, height: 44, layout: "none", children: [
      { type: "rectangle", name: "Elapsed", x: 0, y: 0, width: NOW, height: 44, fill: GROUND },
      ...ticks(),
      ...items,
      { type: "rectangle", name: "Now line", x: NOW - 1, y: 0, width: 2, height: 44, fill: INK },
    ] },
  ],
});
const legend = [
  ["Done", { background: DONE }],
  ["Under way", { background: INK }],
  ["Scheduled", { background: PANEL, stroke: INK, strokeWeight: 1.5 }],
  ["Late", { background: AMBER }],
  ["Knock-on", { background: AMBER_SOFT, stroke: AMBER_EDGE, strokeWeight: 1.5 }],
];
const hourLabels = Array.from({ length: X1 - X0 }, (_, i) => X0 + i).map((h) =>
  tx(`Hour ${h}`, `${String(h).padStart(2, "0")}:00`, T, "Regular", 13, GREY, { x: at(h) + 4, y: 1 }));
out("timeline", {
  type: "frame", name: "Day timeline", layout: "vertical", sizing: { width: "fill" }, padding: [18, 24, 18, 24], gap: 8, cornerRadius: 14, background: PANEL, stroke: LINE, strokeWeight: 1,
  children: [
    { type: "frame", name: "Timeline header", layout: "horizontal", sizing: { width: "fill" }, alignX: "space-between", alignY: "center", children: [
      tx("Panel title", "Day timeline", T, "SemiBold", 16),
      { type: "frame", name: "Legend", layout: "horizontal", gap: 16, alignY: "center", children: legend.map(([l, s]) => ({
        type: "frame", name: `Legend / ${l}`, layout: "horizontal", gap: 6, alignY: "center", children: [{ type: "frame", name: "Swatch", width: 14, height: 10, cornerRadius: 3, ...s }, tx("Legend label", l, T, "Regular", 13, GREY)] })) },
    ] },
    { type: "frame", name: "Axis", layout: "horizontal", sizing: { width: "fill" }, height: 22, alignY: "center", children: [
      { type: "frame", name: "Axis spacer", width: 104, height: 22 },
      { type: "frame", name: "Hours", width: TRACK, height: 22, layout: "none", children: [
        ...hourLabels,
        { type: "frame", name: "Now tag", x: NOW - 23, y: 0, width: 46, height: 22, layout: "horizontal", alignX: "center", alignY: "center", cornerRadius: 4, background: INK,
          children: [tx("Now time", "07:38", T, "SemiBold", 13, "#FFFFFF")] },
      ] },
    ] },
    { type: "frame", name: "Lanes", layout: "vertical", sizing: { width: "fill" }, children: [
      // Corran: overnight at Marrow, 40 min crossings, 40 min turnaround.
      lane("Corran", "76 cars", [bar("06:00 done", [6, 0], [6, 40], "done", "06:00"), lateBar(),
        bar("08:40 knock-on", [9, 5], [9, 45], "knock", "09:05"), note("Was 08:40", "was 08:40", at(9, 45) + 8), bar("10:30", [10, 30], [11, 10], "next", "10:30")]),
      // Wren: Port Ellery to Tansy Point, 30 min crossings.
      lane("Wren", "58 cars", [bar("06:30 done", [6, 30], [7, 0], "done", "06:30"), bar("07:40 boarding", [7, 40], [8, 10], "live", "07:40"),
        bar("09:00", [9, 0], [9, 30], "next", "09:00"), bar("10:30", [10, 30], [11, 0], "next", "10:30"), bar("11:20", [11, 20], [11, 50], "next", "11:20")]),
      lane("Halcyon", "76 cars", [bar("06:20 done", [6, 20], [7, 0], "done", "06:20"), bar("07:10 crossing", [7, 10], [7, 50], "live", "07:10"),
        bar("08:10", [8, 10], [8, 50], "next", "08:10"), bar("09:20", [9, 20], [10, 0], "next", "09:20"), bar("10:50", [10, 50], [11, 30], "next", "10:50")]),
      lane("Brigid", "44 cars", [bar("06:15 done", [6, 15], [6, 45], "done", "06:15"), bar("crew change", [7, 45], [8, 35], "crew", "Crew change"),
        bar("08:50", [8, 50], [9, 20], "next", "08:50"), bar("10:15", [10, 15], [10, 45], "next", "10:15"), bar("11:20", [11, 20], [11, 50], "next", "11:20")]),
    ] },
  ],
});

// ── departures ───────────────────────────────────────────────────────
const W = { dep: 64, route: 260, vessel: 96, berth: 56, cars: 96, status: 168 };
const cell = (name, content, w, align = "left", weight = "Regular", color = INK) => tx(name, content, T, weight, 14, color, { width: w, align });
const chip = (kind) => {
  const c = { late: ["Late, 18 min", "exclamation-triangle", AMBER, INK], boarding: ["Boarding", "arrow-path", PANEL, INK], ontime: ["On time", "check-circle", PANEL, GREY] }[kind];
  return { type: "frame", name: "Status", layout: "horizontal", width: W.status, children: [{ type: "frame", name: "Chip", layout: "horizontal", gap: 6, padding: [3, 10, 3, 8], alignY: "center", cornerRadius: 999,
    background: c[2], ...(c[2] === PANEL ? { stroke: LINE, strokeWeight: 1 } : {}), children: [icon(c[1], c[3], 18), tx("Chip label", c[0], T, "Medium", 13, c[3])] }] };
};
const row = (dep, route, vessel, berth, cars, kind, shade) => ({
  type: "frame", name: `Row ${dep}`, layout: "horizontal", sizing: { width: "fill" }, height: 44, gap: 16, padding: [0, 8, 0, 8], alignY: "center", cornerRadius: 8,
  ...(shade ? { background: GROUND } : {}),
  children: [cell("Dep", dep, W.dep, "left", "SemiBold"), cell("Route", route, W.route), cell("Vessel", vessel, W.vessel), cell("Berth", berth, W.berth, "right"), cell("Cars", cars, W.cars, "right"), chip(kind)],
});
out("departures", {
  type: "frame", name: "Next departures", layout: "vertical", sizing: { width: "fill", height: "fill" }, padding: [18, 24, 18, 24], gap: 6, cornerRadius: 14, background: PANEL, stroke: LINE, strokeWeight: 1,
  children: [
    { type: "frame", name: "Departures header", layout: "horizontal", sizing: { width: "fill" }, alignX: "space-between", alignY: "center", children: [
      tx("Panel title", "Next departures", T, "SemiBold", 16), tx("All", "All 42 sailings", T, "Medium", 14, GREY)] },
    { type: "frame", name: "Table header", layout: "horizontal", sizing: { width: "fill" }, height: 28, gap: 16, padding: [0, 8, 0, 8], alignY: "center", children: [
      cell("Dep", "Dep", W.dep, "left", "Medium", GREY), cell("Route", "Route", W.route, "left", "Medium", GREY), cell("Vessel", "Vessel", W.vessel, "left", "Medium", GREY),
      cell("Berth", "Berth", W.berth, "right", "Medium", GREY), cell("Cars", "Cars booked", W.cars, "right", "Medium", GREY), cell("Status", "Status", W.status, "left", "Medium", GREY)] },
    { type: "frame", name: "Sailings table", layout: "vertical", sizing: { width: "fill" }, children: [
      row("07:20", "Port Ellery to Marrow Island", "Corran", "2", "76", "late", true),
      row("07:40", "Port Ellery to Tansy Point", "Wren", "1", "58", "boarding", false),
      row("08:10", "Marrow Island to Port Ellery", "Halcyon", "M1", "64", "ontime", true),
    ] },
  ],
});
console.log("timeline", fs.statSync(path.join(__dirname, "v2-timeline.json")).size, "departures", fs.statSync(path.join(__dirname, "v2-departures.json")).size, "now", NOW);

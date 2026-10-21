// Two more departures rows: Corran's knock-on return and Brigid's 08:50.
const fs = require("fs"), path = require("path");
const ICONS = path.join(__dirname, "..", "heroicons");
const INK = "#1C1C1C", GROUND = "#F3F4F1", PANEL = "#FFFFFF", LINE = "#E1E3DE", GREY = "#5F6368", SOFT = "#FBE3A1", EDGE = "#B98A00", T = "IBM Plex Sans";
const icon = (n, color, size) => ({ type: "svg", name: `Icon / ${n}`, svg: fs.readFileSync(path.join(ICONS, `${n}.svg`), "utf8").replace(/\s*\n\s*/g, "").replace(/ aria-hidden="true" data-slot="icon"/, ""), width: size, height: size, color });
const tx = (name, content, weight, color, extra = {}) => ({ type: "text", name, content, fontFamily: T, weight, fontSize: 14, color, ...extra });
const W = { dep: 64, route: 260, vessel: 96, berth: 56, cars: 96, status: 168 };
const chip = (label, ic, bg, stroke, color) => ({ type: "frame", name: "Status", layout: "horizontal", width: W.status, children: [{ type: "frame", name: "Chip", layout: "horizontal", gap: 6, padding: [3, 10, 3, 8], alignY: "center", cornerRadius: 999,
  background: bg, stroke, strokeWeight: 1, children: [icon(ic, color, 18), { type: "text", name: "Chip label", content: label, fontFamily: T, weight: "Medium", fontSize: 13, color }] }] });
const row = (dep, route, vessel, berth, cars, st, shade) => ({ type: "frame", name: `Row ${dep}`, layout: "horizontal", sizing: { width: "fill" }, height: 44, gap: 16, padding: [0, 8, 0, 8], alignY: "center", cornerRadius: 8,
  ...(shade ? { background: GROUND } : {}),
  children: [tx("Dep", dep, "SemiBold", INK, { width: W.dep, align: "left" }), tx("Route", route, "Regular", INK, { width: W.route, align: "left" }), tx("Vessel", vessel, "Regular", INK, { width: W.vessel, align: "left" }),
    tx("Berth", berth, "Regular", INK, { width: W.berth, align: "right" }), tx("Cars", cars, "Regular", INK, { width: W.cars, align: "right" }), st] });
const rows = [
  row("08:40", "Marrow Island to Port Ellery", "Corran", "M1", "71", chip("Knock-on, 09:10", "clock", SOFT, EDGE, INK), false),
  row("08:50", "Tansy Point to Port Ellery", "Brigid", "T1", "40", chip("On time", "check-circle", PANEL, LINE, GREY), true),
];
fs.writeFileSync(path.join(__dirname, "v2-rows.json"), JSON.stringify(rows));
console.log(JSON.stringify(rows));

// Today / Empty: the all-clear card and five more departures rows.
const fs = require("fs"), path = require("path");
const ICONS = path.join(__dirname, "..", "heroicons");
const INK = "#1C1C1C", GROUND = "#F3F4F1", PANEL = "#FFFFFF", LINE = "#E1E3DE", GREY = "#5F6368", D = "Barlow Semi Condensed", T = "IBM Plex Sans";
const icon = (n, color, size) => ({ type: "svg", name: `Icon / ${n}`, svg: fs.readFileSync(path.join(ICONS, `${n}.svg`), "utf8").replace(/\s*\n\s*/g, "").replace(/ aria-hidden="true" data-slot="icon"/, ""), width: size, height: size, color });
const tx = (name, content, weight, size, color = INK, extra = {}) => ({ type: "text", name, content, fontFamily: T, weight, fontSize: size, color, ...extra });
const card = { type: "frame", name: "All clear · every sailing on time", layout: "horizontal", sizing: { width: "fill" }, padding: 24, gap: 20, alignY: "center", cornerRadius: 14, background: PANEL, stroke: LINE, strokeWeight: 1, children: [
  icon("check-circle", INK, 40),
  { type: "frame", name: "All clear text", layout: "vertical", sizing: { width: "fill" }, gap: 4, children: [
    { type: "text", name: "Title", content: "Every sailing is on time", fontFamily: D, weight: "SemiBold", fontSize: 32, color: INK, lineHeight: "36" },
    tx("Body", "A sailing shows here the moment it runs late or puts the next one at risk.", "Regular", 14, GREY, { sizing: { width: "fill" } })] },
  { type: "frame", name: "Next up", layout: "vertical", width: 240, gap: 2, children: [
    tx("Next label", "Next departure", "Regular", 13, GREY),
    tx("Next sailing", "07:40 Wren to Tansy Point", "SemiBold", 16),
    tx("Next detail", "Boarding at berth 1, 58 cars", "Regular", 13, GREY)] }] };
const W = { dep: 64, route: 260, vessel: 96, berth: 56, cars: 96 };
const chip = (kind) => {
  const c = { ontime: ["On time", "check-circle", PANEL, GREY], full: ["Full for cars", "truck", PANEL, INK] }[kind];
  return { type: "frame", name: "Status", layout: "horizontal", sizing: { width: "fill" }, children: [{ type: "frame", name: "Chip", layout: "horizontal", gap: 6, padding: [3, 10, 3, 8], alignY: "center", cornerRadius: 999,
    background: c[2], stroke: LINE, strokeWeight: 1, children: [icon(c[1], c[3], 18), tx("Chip label", c[0], "Medium", 13, c[3])] }] };
};
const cell = (name, content, w, align, weight = "Regular") => tx(name, content, weight, 14, INK, { width: w, align });
const row = (dep, route, vessel, berth, cars, kind, shade) => ({ type: "frame", name: `Row ${dep} ${vessel}`, layout: "horizontal", sizing: { width: "fill" }, height: 44, gap: 16, padding: [0, 8, 0, 8], alignY: "center", cornerRadius: 8,
  ...(shade ? { background: GROUND } : {}),
  children: [cell("Dep", dep, W.dep, "left", "SemiBold"), cell("Route", route, W.route, "left"), cell("Vessel", vessel, W.vessel, "left"), cell("Berth", berth, W.berth, "right"), cell("Cars", cars, W.cars, "right"), chip(kind)] });
const rows = [
  row("09:00", "Tansy Point to Port Ellery", "Wren", "T1", "52", "ontime", false),
  row("09:20", "Port Ellery to Marrow Island", "Halcyon", "2", "76", "full", true),
  row("10:15", "Port Ellery to Tansy Point", "Brigid", "1", "33", "ontime", false),
  row("10:30", "Port Ellery to Marrow Island", "Corran", "2", "61", "ontime", true),
  row("10:30", "Port Ellery to Tansy Point", "Wren", "1", "47", "ontime", false),
];
const checkChip = icon("check-circle", GREY, 18);
fs.writeFileSync(path.join(__dirname, "v2-empty-card.json"), JSON.stringify(card));
fs.writeFileSync(path.join(__dirname, "v2-empty-rows.json"), JSON.stringify(rows));
fs.writeFileSync(path.join(__dirname, "v2-check-chip-icon.json"), JSON.stringify(checkChip));
console.log(JSON.stringify(card).length, JSON.stringify(rows).length);

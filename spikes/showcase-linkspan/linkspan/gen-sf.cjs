// Generates the two styleframe specs (compact JSON) for figma_create_from_spec.
const BSC = "Barlow Semi Condensed", B = "Barlow", MONO = "Overpass Mono";
const t = (name, content, fontFamily, weight, fontSize, extra = {}) => ({ type: "text", name, content, fontFamily, weight, fontSize, ...extra });
function lanes(o) {
  return o.plan.map(([l, tl, sp], i) => ({
    type: "frame", name: `Lane ${i + 1}`, layout: "horizontal", gap: o.gap, alignY: "center",
    children: [
      t("Lane number", String(i + 1), o.labelFont, "Medium", 13, { color: o.labelColor, width: 12, align: "right" }),
      ...Array.from({ length: l }, (_, k) => ({ type: "rectangle", name: "On board", width: o.cell[0], height: o.cell[1], cornerRadius: 2, fill: o.filled })),
      ...Array.from({ length: tl }, (_, k) => ({ type: "rectangle", name: "To load", width: o.cell[0], height: o.cell[1], cornerRadius: 2, stroke: o.outline, strokeWeight: 2, fill: o.ground })),
      ...Array.from({ length: sp }, (_, k) => ({ type: "rectangle", name: "Spare", width: o.cell[0], height: o.cell[1], cornerRadius: 2, stroke: o.spare, strokeWeight: 1, fill: o.ground })),
    ],
  }));
}
const plan = [[16, 0, 0], [16, 0, 0], [16, 0, 0], [2, 14, 0], [0, 12, 4]];

// B · Step-back band
const ink = "#1C1C1C", amber = "#F5B800", ground = "#EDEEEC", grey = "#595959";
const navItem = (label, current) => current
  ? { type: "frame", name: `Nav item / ${label} (current)`, layout: "vertical", height: 48, alignY: "end", gap: 11, children: [t("Label", label, BSC, "SemiBold", 16, { color: ink }), { type: "rectangle", name: "Current marker", height: 3, sizing: { width: "fill" }, fill: ink }] }
  : { type: "frame", name: `Nav item / ${label}`, layout: "vertical", height: 48, alignY: "center", children: [t("Label", label, BSC, "Medium", 16, { color: grey })] };
const btnB = (label, primary) => ({ type: "frame", name: `Button / ${label}`, layout: "horizontal", height: 56, padding: [0, 24, 0, 24], alignY: "center", cornerRadius: 4,
  ...(primary ? { background: ink } : { stroke: ink, strokeWeight: 2 }),
  children: [t("Label", label, BSC, "SemiBold", 20, { color: primary ? "#FFFFFF" : ink })] });
const sfB = { type: "frame", name: "Direction B · Step-back band", x: 0, y: 800, width: 1440, layout: "vertical", background: ground, children: [
  { type: "frame", name: "Top bar", layout: "horizontal", height: 48, sizing: { width: "fill" }, padding: [0, 32, 0, 32], alignX: "space-between", alignY: "center", children: [
    { type: "frame", name: "Product and navigation", layout: "horizontal", gap: 32, alignY: "center", children: [
      t("Product", "Linkspan", BSC, "SemiBold", 20, { color: ink }),
      { type: "frame", name: "Navigation", layout: "horizontal", gap: 24, alignY: "center", children: [navItem("Today", true), navItem("Sailings"), navItem("Vessels"), navItem("Berths"), navItem("Notices")] },
    ] },
    { type: "frame", name: "Clock and freshness", layout: "horizontal", gap: 16, alignY: "center", children: [
      t("Date", "Tue 20 Oct", BSC, "Medium", 16, { color: ink }), t("Clock", "07:38", MONO, "Medium", 20, { color: ink }), t("Freshness", "Car counts 07:38", BSC, "Regular", 13, { color: grey }),
    ] },
  ] },
  { type: "frame", name: "Finding · 07:20 is 18 min late", layout: "horizontal", sizing: { width: "fill" }, padding: 32, gap: 16, background: amber, children: [
    { type: "frame", name: "Delay", layout: "vertical", width: 216, children: [
      t("Minutes late", "+18", BSC, "SemiBold", 96, { color: ink, lineHeight: "96" }), t("Unit", "min late", BSC, "Medium", 20, { color: ink }) ] },
    { type: "frame", name: "Sailing, reason and fix", layout: "vertical", width: 680, gap: 8, children: [
      t("Sailing", "07:20 Port Ellery to Marrow Island", BSC, "SemiBold", 40, { color: ink, lineHeight: "44", sizing: { width: "fill" } }),
      t("Reason", "Corran still loading lane 4 at berth 2", BSC, "Regular", 40, { color: ink, lineHeight: "44", sizing: { width: "fill" } }),
      t("Knock-on", "Last car boards about 07:45 at 4 cars a minute. Her 08:40 return then leaves about 09:05.", BSC, "Regular", 20, { color: ink, lineHeight: "26", sizing: { width: "fill" } }),
      { type: "frame", name: "Actions", layout: "horizontal", gap: 16, padding: [16, 0, 0, 0], children: [btnB("Delay to 07:50", true), btnB("Hold at berth"), btnB("Notify 212 passengers")] },
    ] },
    { type: "frame", name: "Evidence", layout: "vertical", width: 448, gap: 8, children: [
      { type: "rectangle", name: "Berth 2 camera still", width: 448, height: 152, fill: "#8C8C8C" },
      t("Camera caption", "Berth 2 camera, 07:38", BSC, "Regular", 13, { color: ink }),
      { type: "frame", name: "Deck gauge · Corran", layout: "vertical", gap: 4, padding: [8, 0, 0, 0], children: [
        t("Gauge label", "Corran car deck: 50 of 76 on board", BSC, "SemiBold", 13, { color: ink }),
        ...lanes({ cell: [22, 12], gap: 4, filled: ink, outline: ink, spare: "#7A5C00", ground: amber, plan, labelFont: BSC, labelColor: ink }),
        t("Gauge note", "Lane 4 loading, 14 to go. Lane 5 waiting, 12 cars.", BSC, "Regular", 13, { color: ink }),
      ] },
    ] },
  ] },
] };

// A · Loading Lanes
const deck = "#2E3D35", yellow = "#F5B700", inkA = "#232323", groundA = "#E6E8E3", soft = "#C9D1CC", greyA = "#5A5A5A";
const navA = (label, current) => current
  ? { type: "frame", name: `Nav item / ${label} (current)`, layout: "vertical", height: 55, alignY: "end", gap: 16, children: [t("Label", label, B, "SemiBold", 16, { color: inkA }), { type: "rectangle", name: "Current marker", height: 2, sizing: { width: "fill" }, fill: inkA }] }
  : { type: "frame", name: `Nav item / ${label}`, layout: "vertical", height: 55, alignY: "center", children: [t("Label", label, B, "Medium", 16, { color: greyA })] };
const btnA = (label, primary) => ({ type: "frame", name: `Button / ${label}`, layout: "horizontal", height: 44, padding: [0, 20, 0, 20], alignY: "center", cornerRadius: 4,
  ...(primary ? { background: yellow } : { stroke: "#FFFFFF", strokeWeight: 1 }),
  children: [t("Label", label, B, "SemiBold", 16, { color: primary ? inkA : "#FFFFFF" })] });
const sfA = { type: "frame", name: "Direction A · Loading Lanes", x: 1540, y: 800, width: 1440, layout: "vertical", background: groundA, children: [
  { type: "frame", name: "Top bar", layout: "vertical", sizing: { width: "fill" }, children: [
    { type: "frame", name: "Top bar row", layout: "horizontal", height: 55, sizing: { width: "fill" }, padding: [0, 48, 0, 48], alignX: "space-between", alignY: "center", children: [
      { type: "frame", name: "Product and navigation", layout: "horizontal", gap: 40, alignY: "center", children: [
        t("Product", "Linkspan", B, "SemiBold", 20, { color: inkA }),
        { type: "frame", name: "Navigation", layout: "horizontal", gap: 28, alignY: "center", children: [navA("Today", true), navA("Timetable"), navA("Vessels"), navA("Berths")] },
      ] },
      { type: "frame", name: "Clock and freshness", layout: "horizontal", gap: 16, alignY: "center", children: [
        t("Date", "Tue 20 Oct", B, "Medium", 16, { color: inkA }), t("Clock", "07:38", MONO, "Medium", 16, { color: inkA }), t("Freshness", "Car counts 07:38", BSC, "Regular", 13, { color: greyA }) ] },
    ] },
    { type: "rectangle", name: "Hairline", height: 1, sizing: { width: "fill" }, fill: "#B9BDB7" },
  ] },
  { type: "frame", name: "Finding · 07:20 is 18 min late", layout: "horizontal", sizing: { width: "fill" }, padding: [32, 48, 32, 48], gap: 24, background: deck, children: [
    { type: "frame", name: "Sailing, reason and fix", layout: "vertical", width: 888, gap: 12, children: [
      t("Sailing", "07:20 Port Ellery to Marrow Island is 18 min late", B, "SemiBold", 31, { color: "#FFFFFF", lineHeight: "36", sizing: { width: "fill" } }),
      t("Reason", "Corran is still loading lane 4 at berth 2: 26 cars to go.", B, "Regular", 20, { color: "#FFFFFF", lineHeight: "26", sizing: { width: "fill" } }),
      t("Knock-on", "At 3 cars a minute she sails about 07:47; her 08:40 return leaves about 09:05.", B, "Regular", 16, { color: soft, lineHeight: "22", sizing: { width: "fill" } }),
      { type: "frame", name: "Deck strip · Corran", layout: "vertical", gap: 4, padding: [8, 0, 8, 0], children: [
        ...lanes({ cell: [24, 12], gap: 4, filled: "#FFFFFF", outline: yellow, spare: "#8A968F", ground: deck, plan, labelFont: BSC, labelColor: soft }),
        t("Gauge label", "Corran car deck: 50 of 76 on board", BSC, "Regular", 13, { color: soft }),
      ] },
      { type: "frame", name: "Actions", layout: "horizontal", gap: 12, children: [btnA("Delay sailing to 07:50", true), btnA("Hold at berth"), btnA("Notify 212 passengers")] },
    ] },
    { type: "frame", name: "Evidence", layout: "vertical", width: 432, gap: 8, children: [
      { type: "rectangle", name: "Berth 2 camera still", width: 432, height: 243, fill: "#8C8C8C" },
      t("Camera caption", "Berth 2 camera, 07:37", BSC, "Regular", 13, { color: soft }),
    ] },
  ] },
] };
const fs = require("fs");
fs.writeFileSync(__dirname + "/sfB.json", JSON.stringify(sfB));
fs.writeFileSync(__dirname + "/sfA.json", JSON.stringify(sfA));
console.log("B", JSON.stringify(sfB).length, "A", JSON.stringify(sfA).length);

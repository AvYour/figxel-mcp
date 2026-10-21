// Linkspan v2 / 02 Delay: scrim + dialog with an impact preview. Absolute children of the cloned Today frame.
const fs = require("fs"), path = require("path");
const ICONS = path.join(__dirname, "..", "heroicons");
const INK = "#1C1C1C", GROUND = "#F3F4F1", PANEL = "#FFFFFF", LINE = "#E1E3DE", HAIR = "#ECEEEA", GREY = "#5F6368";
const AMBER = "#F5B800", SOFT = "#FBE3A1", EDGE = "#B98A00", D = "Barlow Semi Condensed", T = "IBM Plex Sans";
const icon = (n, color = INK, size = 24) => ({ type: "svg", name: `Icon / ${n}`, svg: fs.readFileSync(path.join(ICONS, `${n}.svg`), "utf8").replace(/\s*\n\s*/g, "").replace(/ aria-hidden="true" data-slot="icon"/, ""), width: size, height: size, color });
// The icon paths below are Heroicons (MIT, Tailwind Labs): see ../heroicons/LICENSE.
const CHECK = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5"/></svg>';
const tx = (name, content, weight, size, color = INK, extra = {}) => ({ type: "text", name, content, fontFamily: T, weight, fontSize: size, color, ...extra });

const W = 600, PAD = 28, IN = W - 2 * PAD; // 544 inner width
// impact track: 07:00 to 11:30, 120 px an hour
const TRACK = 540, at = (h, m = 0) => Math.round((h + m / 60 - 7) * 120);
const bar = (name, from, to, kind, label) => {
  const x = at(...from), w = at(...to) - x;
  const st = {
    was: { stroke: "#9AA09A", strokeWeight: 1.5, color: GREY, weight: "Medium" },
    late: { background: AMBER, color: INK, weight: "SemiBold" },
    knock: { background: SOFT, stroke: EDGE, strokeWeight: 1.5, color: INK, weight: "SemiBold" },
    next: { background: PANEL, stroke: INK, strokeWeight: 1.5, color: INK, weight: "Medium" },
  }[kind];
  const { color, weight, ...box } = st;
  return { type: "frame", name: `Bar / ${name}`, x, y: 8, width: w, height: 28, layout: "horizontal", padding: [0, 8, 0, 8], alignY: "center", cornerRadius: 6, ...box,
    children: [tx("Bar label", label, weight, 13, color)] };
};
const hourLines = [8, 9, 10, 11].map((h) => ({ type: "rectangle", name: `Hour line ${h}`, x: at(h), y: 0, width: 1, height: 44, fill: HAIR }));
const impactRow = (label, value, strong) => ({ type: "frame", name: `Impact / ${label}`, layout: "horizontal", sizing: { width: "fill" }, height: 32, alignX: "space-between", alignY: "center", children: [
  tx("Impact label", label, "Regular", 14, GREY), tx("Impact value", value, strong ? "SemiBold" : "Medium", 14, INK)] });
const option = (label, selected) => ({ type: "frame", name: `Option / ${label}${selected ? " (selected)" : ""}`, layout: "horizontal", height: 44, padding: [0, 18, 0, 18], alignY: "center", cornerRadius: 8,
  ...(selected ? { background: INK } : { stroke: LINE, strokeWeight: 1 }), children: [tx("Option label", label, "SemiBold", 14, selected ? "#FFFFFF" : INK)] });
const checkbox = (label) => ({ type: "frame", name: `Checkbox / ${label}`, layout: "horizontal", gap: 10, alignY: "center", children: [
  { type: "frame", name: "Box (checked)", layout: "horizontal", width: 20, height: 20, cornerRadius: 4, background: INK, alignX: "center", alignY: "center", children: [{ type: "svg", name: "Icon / check", svg: CHECK, width: 14, height: 14, color: "#FFFFFF" }] },
  tx("Checkbox label", label, "Regular", 14)] });
const btn = (label, primary, ic) => ({ type: "frame", name: `Button / ${label}`, layout: "horizontal", height: 44, padding: [0, 18, 0, 18], gap: 8, alignY: "center", cornerRadius: 8,
  ...(primary ? { background: INK } : { stroke: INK, strokeWeight: 1.5 }), children: [...(ic ? [icon(ic, primary ? "#FFFFFF" : INK)] : []), tx("Label", label, "SemiBold", 14, primary ? "#FFFFFF" : INK)] });
const section = (name, title, children, gap = 8) => ({ type: "frame", name, layout: "vertical", sizing: { width: "fill" }, gap, children: [tx("Section title", title, "SemiBold", 14), ...children] });

const scrim = { type: "rectangle", name: "Scrim", positioning: "absolute", x: 0, y: 0, width: 1440, height: 1024, fill: INK, opacity: 0.4 };
const dialog = { type: "frame", name: "Dialog · Delay the 07:20", positioning: "absolute", x: 420, y: 150, width: W, layout: "vertical", padding: PAD, gap: 22, cornerRadius: 16, background: PANEL, children: [
  { type: "frame", name: "Dialog header", layout: "horizontal", sizing: { width: "fill" }, alignX: "space-between", alignY: "start", children: [
    { type: "frame", name: "Dialog title", layout: "vertical", gap: 2, children: [tx("Kicker", "Delay sailing", "Medium", 14, GREY),
      { type: "text", name: "Title", content: "07:20 Port Ellery to Marrow Island", fontFamily: D, weight: "SemiBold", fontSize: 32, color: INK, lineHeight: "36" }] },
    { type: "frame", name: "Button / Close", layout: "horizontal", width: 40, height: 40, cornerRadius: 8, alignX: "center", alignY: "center", children: [icon("x-mark", INK)] }] },
  section("New departure", "New departure", [
    { type: "frame", name: "Options", layout: "horizontal", gap: 8, children: [option("07:45"), option("07:50", true), option("08:00"), option("Other time")] },
    tx("Option note", "07:50 fits her usual pace: 26 cars at about 2.4 a minute.", "Regular", 13, GREY, { sizing: { width: "fill" } })]),
  section("What changes", "What changes for Corran", [
    { type: "frame", name: "Impact axis", layout: "none", width: TRACK, height: 20, children: [7, 8, 9, 10, 11].map((h) => tx(`Hour ${h}`, `${String(h).padStart(2, "0")}:00`, "Regular", 13, GREY, { x: at(h) + 8, y: 1 })) },
    { type: "frame", name: "Impact track", layout: "none", width: TRACK, height: 44, children: [
      ...hourLines,
      bar("07:20 as planned", [7, 20], [8, 0], "was", "07:20"), bar("07:50 new", [7, 50], [8, 30], "late", "07:50"),
      bar("08:40 as planned", [8, 40], [9, 20], "was", "08:40"), bar("09:10 new", [9, 10], [9, 50], "knock", "09:10"),
      bar("10:30", [10, 30], [11, 10], "next", "10:30")] },
    { type: "frame", name: "Impact list", layout: "vertical", sizing: { width: "fill" }, children: [
      impactRow("07:20 to Marrow Island, 76 cars", "Leaves 07:50, arrives 08:30", true),
      impactRow("08:40 return, 164 passengers", "Leaves 09:10, 30 min late", true),
      impactRow("10:30 to Marrow Island", "On time, 40 min turnaround")] }]),
  section("Tell passengers", "Tell passengers", [
    checkbox("212 passengers on the 07:20, by SMS"), checkbox("164 passengers on the 08:40 return, by SMS"),
    { type: "frame", name: "SMS preview", layout: "vertical", sizing: { width: "fill" }, gap: 6, padding: [12, 14, 12, 14], cornerRadius: 12, background: GROUND, children: [
      tx("SMS text", "Kettle Sound Ferries: the 07:20 Port Ellery to Marrow Island now leaves at 07:50. Sorry for the wait.", "Regular", 14, INK, { lineHeight: "20", sizing: { width: "fill" } }),
      tx("SMS meta", "SMS preview, 101 characters, one message", "Regular", 13, GREY)] }], 10),
  { type: "frame", name: "Dialog footer", layout: "horizontal", sizing: { width: "fill" }, gap: 10, alignX: "end", children: [btn("Cancel", false), btn("Delay to 07:50 and notify", true, "clock")] },
] };
fs.writeFileSync(path.join(__dirname, "v2-delay.json"), JSON.stringify([scrim, dialog]));
const sms = "Kettle Sound Ferries: the 07:20 Port Ellery to Marrow Island now leaves at 07:50. Sorry for the wait.";
console.log("sms chars", sms.length, "spec", JSON.stringify([scrim, dialog]).length);

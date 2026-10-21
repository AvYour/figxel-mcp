// Loading pace chart for the finding card: cars loaded per minute, 07:09 to 07:38.
const fs = require("fs");
const INK = "#1C1C1C", DEEP = "#806200", NOTE = "#3A3420", T = "IBM Plex Sans";
const pre = [2,3,2,3,2,2,3,2,3,2,2,3,2,2,3,2,2];          // 07:09-07:25, 40 cars
const jam = Array(11).fill(0);                              // 07:26-07:36, ramp blocked
const post = [1,1];                                         // 07:37-07:38, lane 4 moving
const v = [...pre, ...jam, ...post];
const tx = (name, content, weight, color = INK, extra = {}) => ({ type: "text", name, content, fontFamily: T, weight, fontSize: 13, color, ...extra });
const bars = v.map((n, i) => {
  const m = 9 + i, t = `07:${String(m).padStart(2, "0")}`;
  return n ? { type: "rectangle", name: `Minute ${t}, ${n} cars`, width: 5, height: n * 10, cornerRadius: 1, fill: DEEP }
           : { type: "rectangle", name: `Minute ${t}, none`, width: 5, height: 2, fill: INK };
});
const spec = { type: "frame", name: "Pace chart · Corran loading pace", layout: "vertical", width: 212, gap: 6, children: [
  tx("Chart title", "Loading pace", "SemiBold"),
  tx("Chart unit", "Cars a minute, last 30 min", "Regular"),
  { type: "frame", name: "Bars", layout: "horizontal", gap: 2, height: 36, alignY: "end", padding: [6, 0, 0, 0], children: bars },
  { type: "frame", name: "Time axis", layout: "horizontal", sizing: { width: "fill" }, alignX: "space-between", children: [tx("Start", "07:09", "Regular", NOTE), tx("End", "Now", "Medium", NOTE)] },
  tx("Jam note", "Ramp blocked for 10 minutes", "Medium", NOTE, { sizing: { width: "fill" } }),
] };
fs.writeFileSync(__dirname + "/v2-pace.json", JSON.stringify(spec));
console.log(v.length, v.reduce((a, b) => a + b, 0), JSON.stringify(spec).length);

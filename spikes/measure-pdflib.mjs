// Measure what pdf-lib actually costs the shipped bundle, with a real import,
// rather than guessing from its unpacked size on npm. Unpacked size counts
// source, types and docs; what matters is what esbuild carries into dist/.
import { build } from "esbuild";
import { statSync } from "node:fs";

const opts = {
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  external: ["ws"],
  absWorkingDir: process.cwd(),
  metafile: true,
  logLevel: "silent",
};

const base = statSync("dist/server.js").size;
console.log(`  dist/server.js today:            ${(base / 1024 / 1024).toFixed(2)} MB`);

const plain = await build({ ...opts, stdin: { contents: `export * from "./src/server/mcp.ts";`, resolveDir: process.cwd(), loader: "ts" } });
const plainSize = plain.outputFiles[0].contents.length;

const withLib = await build({
  ...opts,
  stdin: {
    contents: `import { PDFDocument } from "pdf-lib";\nexport const _x = PDFDocument;\nexport * from "./src/server/mcp.ts";`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
});
const libSize = withLib.outputFiles[0].contents.length;

console.log(`  server alone:                    ${(plainSize / 1024 / 1024).toFixed(2)} MB`);
console.log(`  server + pdf-lib:                ${(libSize / 1024 / 1024).toFixed(2)} MB`);
console.log(`  cost of pdf-lib:                 +${((libSize - plainSize) / 1024 / 1024).toFixed(2)} MB`);

const contrib = Object.entries(withLib.metafile.inputs)
  .filter(([k]) => /pdf-lib|pako|upng|standard-fonts|tslib/.test(k))
  .map(([k, v]) => [k.replace(/\\/g, "/"), v.bytes])
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8);
console.log("  contributors:");
for (const [k, v] of contrib) console.log(`    ${(v / 1024).toFixed(0).padStart(6)} KB  ${k}`);

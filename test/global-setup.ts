import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The lifecycle tests spawn dist/server.js, so build once before any test runs.
export default function setup(): void {
  execFileSync(process.execPath, [fileURLToPath(new URL("../tools/build.mjs", import.meta.url))], {
    stdio: "inherit",
  });
}

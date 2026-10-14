// The files the plugin build id is hashed from (tools/build.mjs).
//
// Every file under src/plugin and src/shared, at any depth: the plugin bundle
// is built from them, op modules in subfolders included (figjam/, slides/). A
// hard-coded list went stale as soon as a package added a module beside it —
// that module changed the bundle without changing its id, and figma_status
// would have called a stale plugin current. Dotfiles and OS files are skipped
// (stray-files.mjs): a .DS_Store is not a source, and hashing it changed the id.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isStrayFile } from "./stray-files.mjs";

/** Sorted repository-relative paths (forward slashes, so the id is the same on every OS). */
export function pluginSourceFiles(root) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (isStrayFile(e.name)) continue;
      const path = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk("src/plugin");
  walk("src/shared");
  return out.sort();
}

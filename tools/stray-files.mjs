// Files an operating system or a tool drops into a folder on its own: macOS
// Finder's .DS_Store (and every other dotfile or dot-folder), Windows
// Explorer's Thumbs.db and desktop.ini.
//
// The skills walker (skills-tree.mjs) and the plugin source hash
// (plugin-sources.mjs) read every file under their folders. Without this
// filter a stray .DS_Store in src/skills became a "skill folder" without a
// SKILL.md, and the server refused to start; inside a skill folder it would
// have been baked into the bundle and served, and under src/plugin it changed
// the plugin build id, so figma_status asked for a plugin re-run that changed
// nothing. .gitignore keeps these files out of git, not out of a local build.

const OS_FILES = new Set(["thumbs.db", "desktop.ini"]);

/** True for a file or folder name the walkers skip. */
export function isStrayFile(name) {
  return name.startsWith(".") || OS_FILES.has(name.toLowerCase());
}

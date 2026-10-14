// Sandbox globals that EXIST at runtime but are missing from
// @figma/plugin-typings, declared as narrowly as the measured behaviour allows.
//
// Source of truth: spikes/results/probe.json — the global list read from
// `Object.getOwnPropertyNames(globalThis)` inside the sandbox on Figma desktop
// 126.9.11. That run recorded `atob` and `btoa` as present, and `Buffer`,
// `TextEncoder`, `TextDecoder`, `queueMicrotask` and `structuredClone` as
// ABSENT. Nothing here declares a global the probe did not see: a wrong
// declaration is worse than a missing one, because it turns a runtime failure
// into a compile-time success.
//
// Deliberately NOT declared, because the sandbox has them and the typings
// already cover them: setTimeout, setInterval, clearTimeout, clearInterval,
// fetch, console.
//
// setTimeout and friends are also deliberately left to the typings: the rule
// that sandbox code must not call them directly is enforced by
// test/sandbox-globals.test.ts (source) and test/plugin-bundle.test.ts (bundle),
// not by the absence of a type.

declare function btoa(data: string): string;
declare function atob(data: string): string;

/**
 * The content hash of the plugin sources, injected by tsup/esbuild at build time
 * (tools/build.mjs). Declared because the compiler has no other way to know it
 * exists; the `typeof` check at the use site handles the unbundled test case,
 * where it is genuinely undefined.
 */
declare const __PLUGIN_BUILD_ID__: string | undefined;

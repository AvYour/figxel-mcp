// Types for spikes/video-greys.mjs, so test/video-greys.test.ts can import it.

/** A child_process.execFileSync-shaped runner; tests pass a fake. */
export type RunSync = (file: string, args: readonly string[], options: { windowsHide: boolean; maxBuffer?: number }) => Buffer | string;

export function frameSize(file: string, run?: RunSync): { width: number; height: number };
export function greyDecodeArgs(file: string): string[];
export function meanGreys(bytes: Uint8Array, frameBytes: number): number[];
export function greysOf(file: string, run?: RunSync): number[];
export function panelOfGrey(level: number, greys: readonly number[], tolerance: number): number;

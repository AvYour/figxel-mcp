import { randomBytes } from "node:crypto";
import { Bridge, type BridgeOptions } from "../src/server/bridge.js";
import type { Logger } from "../src/server/config.js";
// @ts-expect-error — plain .mjs tool without type declarations
import { startMockPlugin as startMockPluginJs } from "../tools/mock-plugin.mjs";

export const quietLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

export async function startBridge(overrides: Partial<BridgeOptions> = {}): Promise<Bridge> {
  const bridge = new Bridge({
    token: overrides.token ?? newToken(),
    logger: quietLogger,
    port: 0,
    sessionWaitMs: 0,
    ...overrides,
  });
  await bridge.start();
  return bridge;
}

export interface MockPlugin {
  instanceId: string;
  state: { sessionId: string | null; closeCode: number | null; closeReason: string };
  received: { t: string; [k: string]: unknown }[];
  store: Map<string, unknown>;
  send(msg: unknown): void;
  welcomed(): Promise<{ sessionId: string }>;
  closed(): Promise<{ code: number; reason: string }>;
  reconnect(): void;
  close(): void;
}

export interface MockOptions {
  token: string;
  port: number;
  instanceId?: string;
  ops?: string[];
  fileName?: string;
  editorType?: string;
  scenario?: "normal" | "slow" | "stall" | "drop";
  durationMs?: number;
  progressMs?: number;
  protocolVersion?: number;
  reconnectDelayMs?: number;
}

export function startMock(opts: MockOptions): MockPlugin {
  return startMockPluginJs({ ...opts, url: `ws://127.0.0.1:${opts.port}` }) as MockPlugin;
}

export async function connectedMock(bridge: Bridge, token: string, extra: Partial<MockOptions> = {}): Promise<MockPlugin> {
  const mock = startMock({ token, port: bridge.port, ...extra });
  await mock.welcomed();
  // let the post-welcome selection/page sync land
  await new Promise((r) => setTimeout(r, 30));
  return mock;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

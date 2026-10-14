// Messages between the plugin sandbox (code.ts) and its UI iframe (ui.ts).
// Internal to the plugin — the wire protocol to the bridge is in
// src/shared/protocol.ts.

import type { HelloMsg, PluginToServer, RequestMsg, CancelMsg } from "../shared/protocol.js";

export type HelloInfo = Omit<HelloMsg, "t" | "token">;

export type SandboxToUi =
  | { kind: "init"; token: string | null; hello: HelloInfo }
  | { kind: "hello-info"; hello: HelloInfo }
  | { kind: "wire"; msg: Exclude<PluginToServer, HelloMsg> }
  | { kind: "tick-request"; id: number; ms: number }
  | { kind: "activity"; text: string };

export type UiToSandbox =
  | { kind: "wire"; msg: RequestMsg | CancelMsg }
  | { kind: "tick"; id: number }
  | { kind: "save-token"; token: string }
  | { kind: "connected"; sessionId: string }
  | { kind: "need-hello" };

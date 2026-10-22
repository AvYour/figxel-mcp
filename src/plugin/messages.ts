// Messages between the plugin sandbox (code.ts) and its UI iframe (ui.ts).
// Internal to the plugin — the wire protocol to the bridge is in
// src/shared/protocol.ts.

import type { HelloMsg, PluginToServer, RequestMsg, CancelMsg } from "../shared/protocol.js";

export type HelloInfo = Omit<HelloMsg, "t" | "token">;

export type SandboxToUi =
  /** The server to connect to (null: this computer), the token saved for it, and the last team hub used. */
  | { kind: "init"; token: string | null; server: string | null; lastHub: string | null; hello: HelloInfo }
  | { kind: "hello-info"; hello: HelloInfo }
  | { kind: "wire"; msg: Exclude<PluginToServer, HelloMsg> }
  | { kind: "tick-request"; id: number; ms: number }
  | { kind: "activity"; text: string };

export type UiToSandbox =
  | { kind: "wire"; msg: RequestMsg | CancelMsg }
  | { kind: "tick"; id: number }
  | { kind: "save-token"; token: string }
  /** A new server (null: this computer): saved, and answered with an `init` that carries its token; an invite brings the token along. */
  | { kind: "save-server"; server: string | null; token?: string }
  | { kind: "connected"; sessionId: string }
  /** Opens the hub's sign-in page in the browser (figma.openExternal) [C-417]. */
  | { kind: "open-url"; url: string }
  /** Forget every setting and token this plugin saved (clientStorage), then send a fresh init. */
  | { kind: "reset" }
  | { kind: "need-hello" };

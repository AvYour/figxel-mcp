// Plugin `progress` → MCP, per protocol.md §9:
//   1. coalescing: at most 10 notifications/s, newest value wins, and the final
//      value is always sent before the result;
//   2. monotonically increasing [C-029]: a lower value (a new phase) becomes
//      previous + 1;
//   3. nothing after completion.
// A request without a progressToken gets an `info` log at most once per 5 s.

import { SERVER_NAME } from "../shared/version.js";
import type { Progress } from "./bridge.js";

export interface Notifier {
  progressToken: string | number | undefined;
  send(notification: { method: string; params: Record<string, unknown> }): Promise<void>;
}

export interface ForwarderOptions {
  label: string;
  intervalMs?: number;
  fallbackIntervalMs?: number;
}

export class ProgressForwarder {
  private readonly notifier: Notifier;
  private readonly label: string;
  private readonly intervalMs: number;
  private readonly fallbackIntervalMs: number;
  private pending: Progress | null = null;
  private lastSent = -Infinity;
  private lastSentAt = -Infinity;
  private timer: NodeJS.Timeout | null = null;
  private done = false;

  constructor(notifier: Notifier, opts: ForwarderOptions) {
    this.notifier = notifier;
    this.label = opts.label;
    // 120, not 100: protocol.md §9 promises "at most 10 notifications/s", and a
    // 100 ms gap does not deliver that over a bounded window — the first message
    // is sent immediately, so 100 ms spacing yields up to 11 or 12 in a second,
    // plus one more from finish(). 120 ms is the smallest interval that actually
    // keeps the count at or under 10 including the final value. The test that
    // found this asserted the documented bound; the code was what was wrong.
    this.intervalMs = opts.intervalMs ?? 120;
    this.fallbackIntervalMs = opts.fallbackIntervalMs ?? 5_000;
  }

  update(p: Progress): void {
    if (this.done) return;
    this.pending = p;
    if (this.timer) return;
    const gap = this.notifier.progressToken === undefined ? this.fallbackIntervalMs : this.intervalMs;
    const wait = Math.max(0, this.lastSentAt + gap - Date.now());
    if (wait === 0) {
      this.flush();
    } else {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, wait);
    }
  }

  /** Send the final value (if a progress token exists) and stop. Call before the result. */
  async finish(): Promise<void> {
    if (this.done) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const final = this.pending;
    if (final && this.notifier.progressToken !== undefined) await this.sendProgress(final);
    this.done = true;
    this.pending = null;
  }

  private flush(): void {
    const p = this.pending;
    if (!p || this.done) return;
    if (this.notifier.progressToken === undefined) {
      this.pending = null;
      this.lastSentAt = Date.now();
      void this.notifier
        .send({
          method: "notifications/message",
          params: { level: "info", logger: SERVER_NAME, data: `${this.label}: ${describe(p)}` },
        })
        .catch(() => {});
      return;
    }
    void this.sendProgress(p);
  }

  private async sendProgress(p: Progress): Promise<void> {
    this.pending = null;
    let value = p.done;
    if (value === this.lastSent) return; // nothing new; MCP requires strictly increasing values
    if (value < this.lastSent) value = this.lastSent + 1;
    this.lastSent = value;
    this.lastSentAt = Date.now();
    const params: Record<string, unknown> = {
      progressToken: this.notifier.progressToken,
      progress: value,
      message: `${this.label}: ${describe(p)}`,
    };
    if (p.total !== undefined && p.total >= value) params.total = p.total;
    await this.notifier.send({ method: "notifications/progress", params }).catch(() => {});
  }
}

function describe(p: Progress): string {
  const amount = p.total !== undefined ? `${p.done} of ${p.total}` : `${p.done}`;
  return p.phase ? `${p.phase} — ${amount}` : amount;
}

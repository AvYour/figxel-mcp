// Video renders as jobs — figma_export_video's job mode [C-249].
//
// A render takes tens of seconds to minutes, and the client that asked may cut
// the call first: some clients stop waiting at 60 s whatever progress arrives
// [C-170] [C-197]. Figma cannot interrupt an exportAsync it has begun, so the
// old path — the client's cancel forwarded to the bridge job — threw away a
// render that went on anyway (C-197). Here the render belongs to a job, not to
// the call. A call waits for it at most `wait` seconds; a cancelled call ends
// only that wait and sends no response [C-171], while the job keeps running
// and keeps its result for a later call to collect. Keeping it is the one
// deliberate departure from "free associated resources": the job is a thing
// the agent names and comes back to, separate from the request.
//
// The store lives in the process that took the call: at most 8 jobs, and a
// finished one is dropped 30 minutes after it ends.

import { BridgeError, ErrorCode } from "../shared/errors.js";

export type JobStatus = "rendering" | "done" | "failed" | "cancelled";

export interface VideoJob<T> {
  readonly id: string;
  /** Session, node, settings and target file: what makes two calls ask for the same render. */
  readonly key: string;
  /** The node the call named, as addressed. */
  readonly nodeId: string;
  readonly format: string;
  readonly startedAt: number;
  /** writeEpoch() when the render started (tools/forward.ts). */
  readonly epoch: number;
  status: JobStatus;
  endedAt: number | undefined;
  result: T | undefined;
  error: unknown;
  /** The plugin's last progress phase ("rendering MP4", "encoding"), once one arrived. */
  phase: string | undefined;
  /** Settles when the render ends, whatever the outcome; never rejects. */
  readonly settled: Promise<void>;
  /** Aborts the bridge request. Only an explicit cancel uses it, never a call's own signal. */
  readonly controller: AbortController;
}

export interface JobSpec {
  id: string;
  key: string;
  nodeId: string;
  format: string;
  epoch: number;
}

export interface VideoJobsOptions {
  max?: number;
  ttlMs?: number;
  now?: () => number;
}

export const MAX_JOBS = 8;
export const JOB_TTL_MS = 30 * 60_000;

export class VideoJobs<T> {
  private readonly jobs = new Map<string, VideoJob<T>>();
  private readonly settles = new WeakMap<VideoJob<T>, () => void>();
  readonly max: number;
  readonly ttlMs: number;
  readonly now: () => number;

  constructor(opts: VideoJobsOptions = {}) {
    this.max = opts.max ?? MAX_JOBS;
    this.ttlMs = opts.ttlMs ?? JOB_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  get(id: string): VideoJob<T> | undefined {
    this.prune();
    return this.jobs.get(id);
  }

  /** The newest job for `key` that may still be handed out: rendering, or done. */
  find(key: string): VideoJob<T> | undefined {
    this.prune();
    let best: VideoJob<T> | undefined;
    for (const job of this.jobs.values()) {
      if (job.key !== key || (job.status !== "rendering" && job.status !== "done")) continue;
      if (!best || job.startedAt >= best.startedAt) best = job;
    }
    return best;
  }

  /**
   * Start a render under `spec.id`, replacing a finished job of that name.
   * `run` gets the job's own abort signal — not any call's.
   */
  start(spec: JobSpec, run: (signal: AbortSignal, job: VideoJob<T>) => Promise<T>): VideoJob<T> {
    this.prune();
    const existing = this.jobs.get(spec.id);
    if (existing?.status === "rendering") {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `Render "${spec.id}" is still running.`, { hint: "Collect it with its jobId, or cancel it first." });
    }
    if (!existing && this.jobs.size >= this.max) this.evictOne();
    const controller = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const job: VideoJob<T> = {
      ...spec,
      startedAt: this.now(),
      status: "rendering",
      endedAt: undefined,
      result: undefined,
      error: undefined,
      phase: undefined,
      settled,
      controller,
    };
    this.jobs.set(spec.id, job);
    this.settles.set(job, settle);
    const end = (status: JobStatus) => {
      job.status = status;
      job.endedAt = this.now();
    };
    // A cancelled job keeps "cancelled" whatever the bridge answers afterwards.
    run(controller.signal, job).then(
      (result) => {
        if (job.status === "rendering") {
          job.result = result;
          end("done");
        }
        settle();
      },
      (error: unknown) => {
        if (job.status === "rendering") {
          job.error = error;
          end("failed");
        }
        settle();
      },
    );
    return job;
  }

  /** Stop waiting for a running render and drop its result; the bridge is told to cancel. */
  cancel(id: string): VideoJob<T> | undefined {
    const job = this.get(id);
    if (!job || job.status !== "rendering") return job;
    job.status = "cancelled";
    job.endedAt = this.now();
    job.controller.abort();
    // Waiters answer now, not whenever the bridge gets round to rejecting.
    this.settles.get(job)?.();
    return job;
  }

  delete(id: string): boolean {
    return this.jobs.delete(id);
  }

  elapsedMs(job: VideoJob<T>): number {
    return (job.endedAt ?? this.now()) - job.startedAt;
  }

  /** Make room: the finished job that ended first goes; with every job still rendering, refuse. */
  private evictOne(): void {
    let oldest: VideoJob<T> | undefined;
    for (const job of this.jobs.values()) {
      if (job.status === "rendering") continue;
      if (!oldest || (job.endedAt ?? 0) < (oldest.endedAt ?? 0)) oldest = job;
    }
    if (!oldest) {
      throw new BridgeError(ErrorCode.BUSY, `${this.max} renders are already running or queued.`, {
        hint: "Collect one with figma_export_video { jobId }, or drop one with { jobId, cancel: true }, then retry.",
      });
    }
    this.jobs.delete(oldest.id);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, job] of this.jobs) if (job.endedAt !== undefined && now - job.endedAt >= this.ttlMs) this.jobs.delete(id);
  }
}

/**
 * Wait for a job at most `ms`. "aborted" means the call that waits was
 * cancelled — the job itself goes on.
 */
export function waitFor(job: { status: JobStatus; settled: Promise<void> }, ms: number, signal?: AbortSignal): Promise<"settled" | "timeout" | "aborted"> {
  if (job.status !== "rendering") return Promise.resolve("settled");
  if (signal?.aborted) return Promise.resolve("aborted");
  if (ms <= 0) return Promise.resolve("timeout");
  return new Promise((resolve) => {
    let over = false;
    const end = (why: "settled" | "timeout" | "aborted") => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(why);
    };
    const onAbort = () => end("aborted");
    const timer = setTimeout(() => end("timeout"), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    void job.settled.then(() => end("settled"));
  });
}

export interface HeartbeatTarget {
  progressToken: string | number | undefined;
  send(notification: { method: string; params: Record<string, unknown> }): Promise<void>;
}

/**
 * notifications/progress every `everyMs` while a call waits, to a caller that
 * sent a progressToken: `progress` is whole seconds since the render started,
 * strictly increasing [C-029]. A client that resets its timeout on progress
 * keeps the call alive [C-170]; for the others the early return at `wait` is
 * what does. Nothing is sent after stop(), nor to a caller without a token.
 */
export function heartbeat(target: HeartbeatTarget, label: string, since: number, now: () => number, everyMs = 5_000): { stop(): void } {
  if (target.progressToken === undefined) return { stop() {} };
  let last = -1;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const value = Math.max(last + 1, Math.floor((now() - since) / 1000));
    last = value;
    void target
      .send({ method: "notifications/progress", params: { progressToken: target.progressToken, progress: value, message: `${label}: ${value} s` } })
      .catch(() => {});
  }, everyMs);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Renders a batch inside a Vercel Sandbox microVM (FREE-TIER.md §5.1): created from the render
 * snapshot with `persistent: false` and a `deny-all` network policy, hygiene asserted right
 * after creation (abort otherwise), jobs written as files, `node render.js` run with a timeout,
 * results read back and validated as untrusted, and the VM always stopped in `finally`.
 *
 * Never uses `name`, `getOrCreate` or `update({ persistent })` on render VMs.
 */
import { Sandbox } from "@vercel/sandbox";
import type { RenderJob, RenderOutcome } from "@edf/design";
import { type Renderer, deadlineOutcome } from "./renderer";
import {
  VM_APP_DIR,
  VM_BUNDLE_PATH,
  VM_JOB_DIR,
  VM_OUT_DIR,
  type VmJobFile,
  jobFileName,
  parseResultFile,
} from "./vm/protocol";

/** Seconds of VM timeout added after the batch deadline (FREE-TIER.md §5.1 step 3). */
export const SANDBOX_TIMEOUT_SLACK_MS = 15_000;
export const SANDBOX_VCPUS = 2;

/** Timestamps of one VM as reported by the Sandbox API (see `sweepSandboxes`). */
export interface SandboxUsage {
  createdAt: Date;
  /** null while the VM is still running. */
  stoppedAt: Date | null;
  vcpus: number;
}

/**
 * vCPU × wall-clock seconds for budget metering (FREE-TIER.md §5.1 "Metering": count
 * vCPUs × wall-clock until calibrated). A running VM is metered up to `now`. Feed it the
 * `finished` entries of `sweepSandboxes` — the renderer itself never meters.
 */
export function sandboxUsage(
  u: SandboxUsage,
  now: Date = new Date(),
): { wallSeconds: number; vcpuSeconds: number } {
  const end = u.stoppedAt ?? now;
  const wallSeconds = Math.max(0, (end.getTime() - u.createdAt.getTime()) / 1000);
  return { wallSeconds, vcpuSeconds: wallSeconds * u.vcpus };
}

export class SandboxHygieneError extends Error {
  constructor(readonly reason: "persistent" | "network_policy") {
    super(`sandbox hygiene: ${reason}`);
  }
}

/** The subset of the Sandbox surface we rely on (lets tests substitute a fake). */
export interface SandboxHandle {
  readonly name: string;
  readonly persistent: boolean;
  readonly networkPolicy: unknown;
  readonly createdAt: Date;
  readonly vcpus: number | undefined;
  writeFiles(files: { path: string; content: string | Uint8Array; mode?: number }[]): Promise<void>;
  runCommand(params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
  }): Promise<{ exitCode: number; stdout(): Promise<string> }>;
  readFileToBuffer(file: { path: string }): Promise<Buffer | null>;
  stop(): Promise<void>;
}

/** Tag on every render VM; the sweep only ever stops VMs carrying it. */
export const RENDER_VM_TAGS = { edf: "render" } as const;

export type SandboxFactory = (params: {
  source: { type: "snapshot"; snapshotId: string };
  persistent: false;
  networkPolicy: "deny-all";
  resources: { vcpus: number };
  timeout: number;
  tags: typeof RENDER_VM_TAGS;
}) => Promise<SandboxHandle>;

/** Default factory: the real `@vercel/sandbox` SDK (authenticates with the Vercel OIDC token). */
export const vercelSandboxFactory: SandboxFactory = async (params) => {
  const sb = await Sandbox.create(params);
  return {
    get name() {
      return sb.name;
    },
    get persistent() {
      return sb.persistent;
    },
    get networkPolicy() {
      return sb.networkPolicy;
    },
    get createdAt() {
      return sb.createdAt;
    },
    get vcpus() {
      return sb.vcpus;
    },
    writeFiles: (files) => sb.writeFiles(files),
    runCommand: async (p) => {
      const done = await sb.runCommand({
        cmd: p.cmd,
        args: p.args,
        cwd: p.cwd,
        timeoutMs: p.timeoutMs,
      });
      return { exitCode: done.exitCode, stdout: () => done.stdout() };
    },
    readFileToBuffer: (f) => sb.readFileToBuffer(f),
    stop: async () => {
      await sb.stop();
    },
  };
};

/**
 * Assert the VM can't persist email content or reach the network (FREE-TIER.md §5.1
 * "Hygiene assertions"). Throws SandboxHygieneError otherwise.
 */
export function assertSandboxHygiene(
  sb: Pick<SandboxHandle, "persistent" | "networkPolicy">,
): void {
  if (sb.persistent !== false) throw new SandboxHygieneError("persistent");
  if (sb.networkPolicy !== "deny-all") throw new SandboxHygieneError("network_policy");
}

export interface SandboxRendererOptions {
  snapshotId: string;
  /**
   * The esbuild bundle (dist/render.js). When given it is written into the VM on every run, so
   * code updates don't need a snapshot rebuild; otherwise the snapshot's copy is used.
   */
  bundle?: Uint8Array | string;
  factory?: SandboxFactory;
  now?: () => number;
}

/**
 * Renders a batch in one fresh, non-persistent, deny-all Sandbox VM tagged `edf=render`.
 * Metering is not done here: VM time is read from the Sandbox API by `sweepSandboxes`, so a VM
 * left behind by a crashed step is still counted (FREE-TIER.md §5.1 "Metering").
 */
export class SandboxRenderer implements Renderer {
  constructor(private readonly opts: SandboxRendererOptions) {}

  async renderBatch(jobs: RenderJob[], opts: { deadlineMs: number }): Promise<RenderOutcome[]> {
    if (jobs.length === 0) return [];
    const now = this.opts.now ?? (() => Date.now());
    const factory = this.opts.factory ?? vercelSandboxFactory;
    const deadlineAt = now() + opts.deadlineMs;
    let sb: SandboxHandle;
    try {
      sb = await factory({
        source: { type: "snapshot", snapshotId: this.opts.snapshotId },
        persistent: false,
        networkPolicy: "deny-all",
        resources: { vcpus: SANDBOX_VCPUS },
        timeout: Math.max(30_000, opts.deadlineMs + SANDBOX_TIMEOUT_SLACK_MS),
        tags: RENDER_VM_TAGS,
      });
    } catch {
      return jobs.map((j) => deadlineOutcome(j, "sandbox_error"));
    }
    try {
      assertSandboxHygiene(sb);
      const files: { path: string; content: string | Uint8Array }[] = jobs.map((job, i) => {
        const file: VmJobFile = { v: 1, job, deadlineAt };
        return { path: `${VM_JOB_DIR}/${jobFileName(i)}`, content: JSON.stringify(file) };
      });
      if (this.opts.bundle) files.push({ path: VM_BUNDLE_PATH, content: this.opts.bundle });
      await sb.writeFiles(files);
      const remaining = Math.max(1_000, deadlineAt - now());
      const cmd = await sb.runCommand({
        cmd: "node",
        args: [VM_BUNDLE_PATH, VM_JOB_DIR, VM_OUT_DIR],
        cwd: VM_APP_DIR,
        timeoutMs: remaining,
      });
      void cmd.exitCode; // render.js prints only fixed status codes; outcomes come from the files.
      const out: RenderOutcome[] = [];
      for (let i = 0; i < jobs.length; i++) {
        const raw = await sb
          .readFileToBuffer({ path: `${VM_OUT_DIR}/${jobFileName(i)}` })
          .catch(() => null);
        out.push(parseResultFile(raw ? new Uint8Array(raw) : null, jobs[i]!));
      }
      return out;
    } catch (e) {
      if (e instanceof SandboxHygieneError) throw e;
      return jobs.map((j) => deadlineOutcome(j, "sandbox_error"));
    } finally {
      try {
        await sb.stop();
      } catch {
        // The tick's sweep stops tagged VMs older than 250 s (FREE-TIER.md §5.1 "Metering").
      }
    }
  }
}

// ───────────────────────── orphan sweep and API metering ─────────────────────────

export type SandboxStatus =
  "pending" | "running" | "stopping" | "stopped" | "failed" | "aborted" | "snapshotting";

export interface SandboxListing {
  name: string;
  status: SandboxStatus;
  createdAt: Date;
  updatedAt: Date;
  vcpus: number | null;
  tags: Record<string, string>;
}

/** The Sandbox API surface the sweep needs (fake-able in tests). */
export interface SandboxOps {
  /** Newest first; stop paging once createdAt < since. */
  list(opts: { since: Date }): Promise<SandboxListing[]>;
  stop(name: string): Promise<void>;
}

/** Real ops: `Sandbox.list` newest-first with paging, and `Sandbox.get({ name }).stop()`. */
export const vercelSandboxOps: SandboxOps = {
  async list({ since }) {
    const out: SandboxListing[] = [];
    const pages = await Sandbox.list({ sortBy: "createdAt", sortOrder: "desc" });
    for await (const s of pages) {
      const createdAt = new Date(s.createdAt);
      if (createdAt.getTime() < since.getTime()) break;
      out.push({
        name: s.name,
        status: s.status,
        createdAt,
        updatedAt: new Date(s.updatedAt),
        vcpus: typeof s.vcpus === "number" ? s.vcpus : null,
        tags: s.tags ?? {},
      });
    }
    return out;
  },
  async stop(name) {
    const sb = await Sandbox.get({ name });
    await sb.stop();
  },
};

/** Render VMs time out after ≤ 245 s, so anything older than this is an orphan. */
export const SWEEP_OLDER_THAN_MS = 250_000;

export interface SweepResult {
  /** Tagged edf=render, status pending|running, older than `olderThanMs`. */
  stopped: string[];
  stopFailed: string[];
  /** Every VM (tagged or not) in status stopped|failed|aborted, for exactly-once metering. */
  finished: Array<{ name: string; createdAt: Date; stoppedAt: Date; vcpus: number }>;
}

/**
 * The tick's sweep (FREE-TIER.md §5.1 "Metering"): stop render VMs older than 250 s (only VMs
 * tagged `edf=render`, never "snapshotting" ones) and report every finished VM on the account
 * with its API timestamps. A failed stop never aborts the sweep; `list` failures propagate.
 */
export async function sweepSandboxes(
  ops: SandboxOps,
  opts: { now: Date; since: Date; olderThanMs?: number },
): Promise<SweepResult> {
  const olderThan = opts.olderThanMs ?? SWEEP_OLDER_THAN_MS;
  const listing = await ops.list({ since: opts.since });
  const result: SweepResult = { stopped: [], stopFailed: [], finished: [] };
  for (const s of listing) {
    if (s.status === "stopped" || s.status === "failed" || s.status === "aborted") {
      const stoppedAt = s.updatedAt.getTime() < s.createdAt.getTime() ? s.createdAt : s.updatedAt;
      result.finished.push({
        name: s.name,
        createdAt: s.createdAt,
        stoppedAt,
        vcpus: s.vcpus ?? SANDBOX_VCPUS,
      });
      continue;
    }
    const tagged = s.tags.edf === RENDER_VM_TAGS.edf;
    const live = s.status === "pending" || s.status === "running";
    const age = opts.now.getTime() - s.createdAt.getTime();
    if (!tagged || !live || age <= olderThan) continue;
    try {
      await ops.stop(s.name);
      result.stopped.push(s.name);
    } catch {
      result.stopFailed.push(s.name);
    }
  }
  return result;
}

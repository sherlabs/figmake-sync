import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import fs from "fs-extra";

import type { PushResult, StatusResult } from "../core/service.js";
import { runNpmInstall } from "../core/service.js";
import { ProjectStateStore } from "../core/state.js";
import type { CommandRuntimeOptions, ProjectConfig } from "../types/config.js";
import { updateProjectConfig } from "../types/config.js";
import { getManagedRuntimeRoot } from "../runtime/managed.js";
import { AgentCliManager } from "./agentCli.js";
import { ensureAgentReady, ensureProjectRunning, type NodeEnsureResult } from "./ensure.js";
import { createClaudeAdapter } from "./agents/claude.js";
import { createCodexAdapter } from "./agents/codex.js";
import type { AgentAdapter, AgentEvent, AgentId } from "./agents/types.js";
import { DevServer } from "./devserver.js";
import {
  buildEnv,
  defaultKillTree,
  defaultSpawn,
  probe,
  resolveBinary,
  type KillTreeFn,
  type SpawnFn,
} from "./process.js";
import { runAgent } from "./runner.js";
import {
  HarnessError,
  type AgentInfo,
  type ChangeSet,
  type DevStatus,
  type HarnessEvent,
  type HarnessSettings,
  type PushOutcome,
  type RunOutcome,
  type SetupResult,
} from "./types.js";

export * from "./types.js";
export { isAllowedLoginUrl, redactUrls, stripUrlQuery, buildInstallArgs } from "./agentCli.js";
export { ensureAgentReady, ensureProjectRunning } from "./ensure.js";
export { isSafeLocalUrl, parseDevUrl, detectDevScript } from "./devserver.js";
export { runAgentInputSchema, rootDirInputSchema, updateSettingsInputSchema, agentInputSchema } from "./schemas.js";

export interface HarnessSyncPort {
  status(options: CommandRuntimeOptions): Promise<StatusResult>;
  push(
    options: CommandRuntimeOptions & { signal?: AbortSignal; requireRemoteCheck?: boolean },
  ): Promise<PushResult>;
}

export interface HarnessDeps {
  sync: HarnessSyncPort;
  emit: (event: HarnessEvent) => void;
  spawn?: SpawnFn;
  killTree?: KillTreeFn;
  env?: NodeJS.ProcessEnv;
  adapters?: AgentAdapter[];
  /** Override binary lookup (tests). */
  resolveBin?: (name: string) => Promise<string | null>;
  /** Override npm install (tests). */
  installDeps?: (cwd: string, signal: AbortSignal | undefined, onLog: (line: string) => void) => Promise<void>;
  /** Where the private runtime lives (default: the registered managed root). */
  runtimeRoot?: () => string | null;
  /** Installs a private Node.js when none exists (wired in main; absent in tests). */
  ensureNode?: (signal?: AbortSignal) => Promise<NodeEnsureResult>;
  /** Override npm lookup / timings for agent CLI install + sign-in (tests). */
  resolveNpm?: () => Promise<string | null>;
  agentInstallTimeoutMs?: number;
  agentLoginTimeoutMs?: number;
  agentKillGraceMs?: number;
  /** Dev-server stop grace before SIGKILL (tests). */
  stopGraceMs?: number;
}

/** Thrown from the push confirm hook so an unattended push aborts instead of overwriting. */
class AutoPushAbort extends Error {}

interface ActiveRun {
  runId: string;
  controller: AbortController;
  done?: Promise<unknown>;
}

/** Matches the push remote-divergence confirm prompt in core/service.ts. */
export const REMOTE_DIVERGED_PROMPT = /changed in Figma Make since the last pull/;
const STAMP_FILE = ".figmake-deps-stamp";
const LOCKFILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock"];

export class HarnessService {
  private readonly adapters: Map<AgentId, AgentAdapter>;
  private readonly devServers = new Map<string, DevServer>();
  private readonly runs = new Map<string, ActiveRun>();
  private configQueue: Promise<unknown> = Promise.resolve();

  private readonly cli: AgentCliManager;

  constructor(private readonly deps: HarnessDeps) {
    const list = deps.adapters ?? [createClaudeAdapter(), createCodexAdapter()];
    this.adapters = new Map(list.map((a) => [a.id, a]));
    this.cli = new AgentCliManager({
      emit: deps.emit,
      runtimeRoot: deps.runtimeRoot ?? (() => getManagedRuntimeRoot()),
      adapters: () => this.adapters,
      spawn: deps.spawn,
      killTree: deps.killTree,
      env: deps.env,
      resolveNpm: deps.resolveNpm,
      resolveBin: deps.resolveBin,
      installTimeoutMs: deps.agentInstallTimeoutMs,
      loginTimeoutMs: deps.agentLoginTimeoutMs,
      killGraceMs: deps.agentKillGraceMs,
    });
  }

  // ---- 1b. In-app agent CLI install / sign-in / one-call ensure ----------

  async detectAgent(id: AgentId): Promise<AgentInfo> {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new HarnessError("invalid_input", `Unknown agent: ${id}`);
    return this.detectOne(adapter);
  }

  installAgentCli(id: AgentId, signal?: AbortSignal) {
    return this.cli.install(id, signal);
  }

  loginAgent(id: AgentId, signal?: AbortSignal) {
    return this.cli.login(id, signal);
  }

  /** Full sign-in URL for the main process to open (re-validated against the host allowlist). */
  pendingLoginUrl(id: AgentId): string | null {
    return this.cli.pendingLoginUrl(id);
  }

  private nodePort() {
    return {
      emit: this.deps.emit,
      hasNpm: () => this.cli.hasNpm(),
      ensureNode: (signal?: AbortSignal) =>
        this.deps.ensureNode ? this.deps.ensureNode(signal) : Promise.resolve({ ok: false, message: "Node.js isn't available." }),
    };
  }

  /** install if missing -> sign in if needed -> ready. Emits agent-ensure events; never throws. */
  ensureAgentReady(id: AgentId, signal?: AbortSignal) {
    return ensureAgentReady(
      { ...this.nodePort(), detectAgent: (a) => this.detectAgent(a), installAgentCli: (a, s) => this.installAgentCli(a, s), loginAgent: (a, s) => this.loginAgent(a, s) },
      id,
      signal,
    );
  }

  /** Node -> npm install -> dev server -> url. Emits project-ensure events; never throws. */
  ensureProjectRunning(rootDir: string, signal?: AbortSignal) {
    return ensureProjectRunning(
      { ...this.nodePort(), setup: (r, s) => this.setup(r, s), startDev: (r) => this.startDev(r), devStatus: (r) => this.devStatus(r) },
      rootDir,
      signal,
    );
  }

  // ---- 1. Connect -------------------------------------------------------

  async detectAgents(): Promise<AgentInfo[]> {
    return Promise.all([...this.adapters.values()].map((a) => this.detectOne(a)));
  }

  private async detectOne(adapter: AgentAdapter): Promise<AgentInfo> {
    const base = {
      id: adapter.id,
      displayName: adapter.displayName,
      ...(adapter.experimental ? { experimental: true } : {}),
    };
    const env = buildEnv(this.deps.env);
    const bin = await this.locate(adapter.binary);
    if (!bin) {
      return { ...base, installed: false, version: null, signedIn: null, usable: false, hint: adapter.installHint };
    }
    const spawn = this.deps.spawn ?? defaultSpawn;
    const killTree = this.deps.killTree ?? defaultKillTree;
    const v = await probe(spawn, killTree, bin, adapter.versionArgs(), env);
    const version = adapter.parseVersion(v.stdout);
    if (v.error || v.code !== 0 || !version) {
      return {
        ...base,
        installed: true,
        version,
        signedIn: null,
        usable: false,
        hint: `\`${adapter.binary} --version\` failed${v.error ? `: ${v.error}` : ""}. Reinstall it or run it once in a terminal.`,
      };
    }
    let signedIn: boolean | null = null;
    const authArgs = adapter.authArgs();
    if (authArgs) {
      const a = await probe(spawn, killTree, bin, authArgs, env);
      signedIn = a.error ? null : adapter.parseAuth(a.stdout, a.code);
    }
    return {
      ...base,
      installed: true,
      version,
      signedIn,
      usable: signedIn !== false,
      hint: signedIn === false ? adapter.loginHint : null,
    };
  }

  private locate(name: string): Promise<string | null> {
    return this.deps.resolveBin ? this.deps.resolveBin(name) : resolveBinary(name, buildEnv(this.deps.env));
  }

  // ---- 6. Settings ------------------------------------------------------

  async getSettings(rootDir: string): Promise<HarnessSettings> {
    const config = await new ProjectStateStore(rootDir).loadProjectConfig();
    return config.harness;
  }

  updateSettings(
    rootDir: string,
    patch: { preferredAgent?: AgentId | undefined; autoPush?: boolean | undefined },
  ): Promise<HarnessSettings> {
    return this.mutateConfig(rootDir, (config) => ({ harness: { ...config.harness, ...stripUndefined(patch) } as ProjectConfig["harness"] })).then(
      (c) => c.harness,
    );
  }

  /** Serialized read-modify-write; the file itself is written atomically by saveProjectConfig. */
  private mutateConfig(
    rootDir: string,
    fn: (config: ProjectConfig) => Partial<ProjectConfig>,
  ): Promise<ProjectConfig> {
    const run = this.configQueue.then(async () => {
      const store = new ProjectStateStore(rootDir);
      const current = await store.loadProjectConfig();
      const next = updateProjectConfig(current, fn(current));
      await store.saveProjectConfig(next);
      return next;
    });
    this.configQueue = run.catch(() => undefined);
    return run;
  }

  // ---- 2. Setup ---------------------------------------------------------

  async setup(rootDir: string, signal?: AbortSignal): Promise<SetupResult> {
    const stampPath = path.join(rootDir, "node_modules", STAMP_FILE);
    if (!(await fs.pathExists(path.join(rootDir, "package.json")))) {
      return { installed: false, skipped: true, reason: "No package.json in the project." };
    }
    const wanted = await depsFingerprint(rootDir);
    const hasModules = await fs.pathExists(path.join(rootDir, "node_modules"));
    const current = await fs.readFile(stampPath, "utf8").catch(() => null);
    if (hasModules && current === wanted) {
      return { installed: false, skipped: true, reason: "Dependencies are up to date." };
    }
    const reason = hasModules ? "package.json or lockfile changed." : "node_modules is missing.";
    const onLog = (line: string): void => this.deps.emit({ kind: "setup-log", rootDir, line });
    onLog(`Running npm install (${reason})`);
    const install =
      this.deps.installDeps ?? ((cwd, sig, log) => runNpmInstall(cwd, sig, undefined, log));
    await install(rootDir, signal, onLog);
    // Fingerprint taken before install: if install rewrote the lockfile the next run reinstalls once, then settles.
    await fs.ensureDir(path.dirname(stampPath));
    await fs.writeFile(stampPath, await depsFingerprint(rootDir));
    return { installed: true, skipped: false, reason };
  }

  // ---- 3. Dev server ----------------------------------------------------

  private devFor(rootDir: string): DevServer {
    const key = path.resolve(rootDir);
    let server = this.devServers.get(key);
    if (!server) {
      server = new DevServer(key, {
        ...(this.deps.spawn ? { spawn: this.deps.spawn } : {}),
        ...(this.deps.killTree ? { killTree: this.deps.killTree } : {}),
        ...(this.deps.env ? { env: this.deps.env } : {}),
        ...(this.deps.stopGraceMs != null ? { stopGraceMs: this.deps.stopGraceMs } : {}),
        onChange: (status) => this.deps.emit({ kind: "dev-status", rootDir, status }),
        onLog: (line) => this.deps.emit({ kind: "dev-log", rootDir, line }),
      });
      this.devServers.set(key, server);
    }
    return server;
  }

  async startDev(rootDir: string): Promise<DevStatus> {
    await this.stopDevExcept(rootDir);
    try {
      return await this.devFor(rootDir).start();
    } catch (error) {
      throw new HarnessError("no_dev_script", error instanceof Error ? error.message : String(error));
    }
  }

  stopDev(rootDir: string): Promise<DevStatus> {
    return this.devFor(rootDir).stop();
  }

  devStatus(rootDir: string): DevStatus {
    return this.devFor(rootDir).status();
  }

  /** Project switch: stop dev servers belonging to every other project. */
  async stopDevExcept(rootDir: string | null, force = false): Promise<void> {
    const keep = rootDir ? path.resolve(rootDir) : null;
    await Promise.all(
      [...this.devServers.entries()]
        .filter(([key]) => key !== keep)
        .map(([, server]) => server.stop(force)),
    );
  }

  // ---- 4/5. Agent run + resync -----------------------------------------

  isRunning(rootDir: string): boolean {
    return this.runs.has(path.resolve(rootDir));
  }

  cancelRun(rootDir: string): boolean {
    const run = this.runs.get(path.resolve(rootDir));
    if (!run || run.controller.signal.aborted) return false;
    run.controller.abort();
    return true;
  }

  /**
   * Validates preconditions synchronously-ish and returns the runId plus a
   * promise for the final outcome. Progress streams through deps.emit.
   */
  async startRun(
    input: { rootDir: string; prompt: string; agent?: AgentId | undefined; newSession?: boolean | undefined },
    externalSignal?: AbortSignal,
  ): Promise<{ runId: string; done: Promise<RunOutcome> }> {
    const rootDir = path.resolve(input.rootDir);
    if (this.runs.has(rootDir)) {
      throw new HarnessError("run_in_progress", "An agent run is already in progress for this project.");
    }
    // Reserve the slot before any await so concurrent calls cannot both start.
    const runId = randomUUID();
    const controller = new AbortController();
    const entry: ActiveRun = { runId, controller };
    this.runs.set(rootDir, entry);
    let settings: HarnessSettings;
    let agentId: AgentId;
    let adapter: AgentAdapter | undefined;
    let bin: string | null;
    try {
      settings = await this.getSettings(rootDir);
      agentId = input.agent ?? settings.preferredAgent;
      adapter = this.adapters.get(agentId);
      if (!adapter) throw new HarnessError("invalid_input", `Unknown agent: ${agentId}`);
      bin = await this.locate(adapter.binary);
      if (!bin) throw new HarnessError("agent_unavailable", `${adapter.displayName} not found. ${adapter.installHint}`);
    } catch (error) {
      this.runs.delete(rootDir);
      throw error;
    }
    const onExternalAbort = (): void => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    const done = this.execute({ rootDir, runId, adapter, bin, prompt: input.prompt, settings, newSession: input.newSession === true, signal: controller.signal })
      .catch((error: unknown): RunOutcome => ({
        runId,
        agent: agentId,
        success: false,
        cancelled: controller.signal.aborted,
        sessionId: null,
        resultText: "",
        error: error instanceof Error ? error.message : String(error),
        backupDir: null,
        changes: null,
        push: { status: "skipped", reason: "Run did not complete." },
      }))
      .then((outcome) => {
        if (this.runs.get(rootDir) === entry) this.runs.delete(rootDir);
        externalSignal?.removeEventListener("abort", onExternalAbort);
        this.deps.emit({ kind: "run-done", rootDir, runId, outcome });
        return outcome;
      });
    entry.done = done;
    return { runId, done };
  }

  private async execute(ctx: {
    rootDir: string;
    runId: string;
    adapter: AgentAdapter;
    bin: string;
    prompt: string;
    settings: HarnessSettings;
    newSession: boolean;
    signal: AbortSignal;
  }): Promise<RunOutcome> {
    const { rootDir, runId, adapter, signal } = ctx;
    const phase = (p: "backup" | "agent" | "diff" | "push", message: string): void =>
      this.deps.emit({ kind: "run-phase", rootDir, runId, phase: p, message });
    const outcome: RunOutcome = {
      runId,
      agent: adapter.id,
      success: false,
      cancelled: false,
      sessionId: null,
      resultText: "",
      error: null,
      backupDir: null,
      changes: null,
      push: { status: "skipped", reason: "Not attempted." },
    };

    // 5a. Backup snapshot before the agent touches anything.
    const store = new ProjectStateStore(rootDir);
    const config = await store.loadProjectConfig();
    phase("backup", "Saving a backup snapshot");
    try {
      outcome.backupDir = await store.createBackup("pre-agent", config.sync.ignore);
    } catch (error) {
      throw new HarnessError(
        "backup_failed",
        `Backup failed, agent was not started: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (signal.aborted) {
      outcome.cancelled = true;
      outcome.error = "Cancelled.";
      return outcome;
    }

    // 4. Agent run (resume only when the stored session belongs to this agent).
    const resumeId =
      !ctx.newSession && ctx.settings.lastSession?.agent === adapter.id ? ctx.settings.lastSession.id : undefined;
    phase("agent", resumeId ? `Continuing ${adapter.displayName} session` : `Starting ${adapter.displayName}`);
    const result = await runAgent({
      adapter,
      command: ctx.bin,
      cwd: rootDir,
      prompt: ctx.prompt,
      sessionId: resumeId,
      signal,
      onEvent: (event: AgentEvent) => {
        this.deps.emit({ kind: "run-agent", rootDir, runId, event });
        if (event.type === "session") {
          void this.rememberSession(rootDir, adapter.id, event.sessionId);
        }
      },
      ...(this.deps.spawn ? { spawn: this.deps.spawn } : {}),
      ...(this.deps.killTree ? { killTree: this.deps.killTree } : {}),
      ...(this.deps.env ? { env: this.deps.env } : {}),
    });
    outcome.success = result.success;
    outcome.cancelled = result.cancelled;
    outcome.sessionId = result.sessionId;
    outcome.resultText = result.resultText;
    outcome.error = result.error;
    if (result.sessionId && result.sessionId !== resumeId) {
      await this.rememberSession(rootDir, adapter.id, result.sessionId);
    }

    // 5b. Change set vs. last-pull baseline (existing ignore rules apply).
    phase("diff", "Computing changes");
    try {
      outcome.changes = toChangeSet(await this.deps.sync.status({ projectRoot: rootDir }));
    } catch (error) {
      outcome.error ??= `Could not compute changes: ${error instanceof Error ? error.message : String(error)}`;
    }

    // 5c. Opt-in auto-push; manual push stays with the existing push action.
    outcome.push = await this.maybeAutoPush(rootDir, outcome, ctx.settings.autoPush, signal, phase);
    return outcome;
  }

  private async maybeAutoPush(
    rootDir: string,
    outcome: RunOutcome,
    enabled: boolean,
    signal: AbortSignal,
    phase: (p: "push", message: string) => void,
  ): Promise<PushOutcome> {
    if (!enabled) return { status: "skipped", reason: "Auto-push is off." };
    if (!outcome.success) return { status: "skipped", reason: "Run did not succeed." };
    if (signal.aborted) return { status: "skipped", reason: "Cancelled." };
    if (!outcome.changes || !outcome.changes.hasBaseline) {
      return { status: "skipped", reason: "No baseline; pull from Figma Make first." };
    }
    if (outcome.changes.total === 0) return { status: "skipped", reason: "No changes to push." };

    phase("push", "Auto-pushing to Figma Make");
    try {
      const result = await this.deps.sync.push({
        projectRoot: rootDir,
        signal,
        // Unattended: if the remote check cannot run, fail closed instead of overwriting blindly.
        requireRemoteCheck: true,
        progress: (message) => phase("push", message),
        // Remote divergence is raised before anything is written: abort the whole push so nothing is overwritten.
        // Other prompts (deletions) come after edits were applied; decline them (left unresolved) instead of aborting midway.
        confirm: (message) =>
          REMOTE_DIVERGED_PROMPT.test(message)
            ? Promise.reject(new AutoPushAbort(message))
            : Promise.resolve(false),
      });
      const unresolved = result.unresolved.map((u) => u.path);
      return { status: "pushed", summary: result.summary, unresolved };
    } catch (error) {
      if (error instanceof AutoPushAbort) {
        return { status: "aborted", reason: `Push aborted, nothing was overwritten: ${error.message}` };
      }
      return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private rememberSession(rootDir: string, agent: AgentId, id: string): Promise<unknown> {
    return this.mutateConfig(rootDir, (config) => ({ harness: { ...config.harness, lastSession: { agent, id } } })).catch(
      () => undefined,
    );
  }

  /** Quit / shutdown: cancel runs and stop every dev server. */
  async shutdown(): Promise<void> {
    const runs = [...this.runs.values()];
    for (const run of runs) run.controller.abort();
    const stopping = this.stopDevExcept(null, true);
    const settled = Promise.allSettled(runs.map((r) => r.done ?? Promise.resolve()));
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 4000);
    });
    await Promise.race([Promise.all([settled, stopping]), cap]);
    if (timer) clearTimeout(timer);
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function toChangeSet(status: StatusResult): ChangeSet {
  const diff = status.diff;
  return {
    hasBaseline: status.hasBaseline,
    added: diff?.added.map((e) => e.path) ?? [],
    modified: diff?.modified.map((e) => e.current.path) ?? [],
    deleted: diff?.deleted.map((e) => e.path) ?? [],
    renamed: diff?.renamed.map((e) => ({ from: e.from, to: e.to })) ?? [],
    total: status.summary.total,
  };
}

async function depsFingerprint(rootDir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const name of ["package.json", ...LOCKFILES]) {
    const content = await fs.readFile(path.join(rootDir, name)).catch(() => null);
    if (content) hash.update(name).update(content);
  }
  return hash.digest("hex");
}

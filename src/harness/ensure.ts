import type {
  AgentEnsureStage,
  AgentInfo,
  AgentInstallResult,
  AgentLoginResult,
  DevStatus,
  EnsureAgentResult,
  EnsureProjectResult,
  HarnessEvent,
  ProjectEnsureStage,
  SetupResult,
} from "./types.js";
import type { AgentId } from "./agents/types.js";

/**
 * One-call orchestration for a no-decisions UI. Each function drives its whole chain, emits stage events
 * (agent-ensure / project-ensure) for a progress display, honours the AbortSignal, and never throws.
 */

export interface NodeEnsureResult {
  ok: boolean;
  message?: string;
}

export interface AgentEnsurePort {
  emit(event: HarnessEvent): void;
  detectAgent(id: AgentId): Promise<AgentInfo>;
  hasNpm(): Promise<boolean>;
  /** Installs the app's private Node.js when no usable Node/npm exists. */
  ensureNode(signal?: AbortSignal): Promise<NodeEnsureResult>;
  installAgentCli(id: AgentId, signal?: AbortSignal): Promise<AgentInstallResult>;
  loginAgent(id: AgentId, signal?: AbortSignal): Promise<AgentLoginResult>;
}

/** installed -> signed in. Missing CLI is installed privately; signed-out CLI runs its own browser sign-in. */
export async function ensureAgentReady(port: AgentEnsurePort, id: AgentId, signal?: AbortSignal): Promise<EnsureAgentResult> {
  const say = (stage: AgentEnsureStage, message: string): void => port.emit({ kind: "agent-ensure", agent: id, stage, message });
  const fail = (code: Extract<EnsureAgentResult, { ok: false }>["code"], message: string, agent: AgentInfo | null): EnsureAgentResult => {
    say("failed", message);
    return { ok: false, code, message, agent };
  };
  try {
    say("checking", "Checking this computer");
    let info = await port.detectAgent(id);

    if (!info.installed) {
      if (!(await port.hasNpm())) {
        say("installing-node", "Setting up the tools this app needs");
        const node = await port.ensureNode(signal);
        if (signal?.aborted) return fail("cancelled", "Stopped.", info);
        if (!node.ok) return fail("node_failed", node.message ?? "Couldn't set up Node.js.", info);
      }
      say("installing", `Installing ${info.displayName}`);
      const inst = await port.installAgentCli(id, signal);
      if (!inst.ok) return fail(inst.code === "cancelled" ? "cancelled" : "install_failed", inst.message, info);
      info = await port.detectAgent(id);
      if (!info.installed) return fail("install_failed", `${info.displayName} was installed but couldn't be found.`, info);
    }

    if (info.signedIn === false) {
      say("needs-browser-signin", "Finish signing in in your browser");
      const login = await port.loginAgent(id, signal);
      if (!login.ok) return fail(login.code === "cancelled" ? "cancelled" : "signin_failed", login.message, info);
      info = await port.detectAgent(id);
      if (info.signedIn === false) return fail("signin_failed", "Sign-in didn't finish. Try again.", info);
    }

    if (!info.usable) return fail("unusable", info.hint ?? `${info.displayName} didn't run correctly.`, info);
    say("ready", `${info.displayName} is ready`);
    return { ok: true, agent: info };
  } catch (e) {
    if (signal?.aborted) return fail("cancelled", "Stopped.", null);
    return fail("install_failed", e instanceof Error ? e.message : String(e), null);
  }
}

export interface ProjectEnsurePort {
  emit(event: HarnessEvent): void;
  hasNpm(): Promise<boolean>;
  ensureNode(signal?: AbortSignal): Promise<NodeEnsureResult>;
  setup(rootDir: string, signal?: AbortSignal): Promise<SetupResult>;
  startDev(rootDir: string): Promise<DevStatus>;
  devStatus(rootDir: string): DevStatus;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Node (private if needed) -> npm install if stale -> dev server -> URL. */
export async function ensureProjectRunning(
  port: ProjectEnsurePort,
  rootDir: string,
  signal?: AbortSignal,
  opts: { urlTimeoutMs?: number; pollMs?: number } = {},
): Promise<EnsureProjectResult> {
  const say = (stage: ProjectEnsureStage, message: string, url?: string): void =>
    port.emit({ kind: "project-ensure", rootDir, stage, message, ...(url ? { url } : {}) });
  const fail = (code: Extract<EnsureProjectResult, { ok: false }>["code"], message: string): EnsureProjectResult => {
    say("failed", message);
    return { ok: false, code, message };
  };
  try {
    say("checking", "Checking this computer");
    if (!(await port.hasNpm())) {
      say("installing-node", "Setting up the tools this app needs");
      const node = await port.ensureNode(signal);
      if (signal?.aborted) return fail("cancelled", "Stopped.");
      if (!node.ok) return fail("node_failed", node.message ?? "Couldn't set up Node.js.");
    }
    say("installing-deps", "Getting the project ready");
    try {
      await port.setup(rootDir, signal);
    } catch (e) {
      if (signal?.aborted) return fail("cancelled", "Stopped.");
      return fail("deps_failed", e instanceof Error ? e.message : String(e));
    }
    if (signal?.aborted) return fail("cancelled", "Stopped.");
    say("starting", "Starting the app");
    try {
      await port.startDev(rootDir);
    } catch (e) {
      return fail("no_dev_script", e instanceof Error ? e.message : String(e));
    }
    // Generous: on slow disks the first start reads thousands of fresh files and can take minutes. The person can always Stop.
    const deadline = Date.now() + (opts.urlTimeoutMs ?? 600_000);
    for (;;) {
      const s = port.devStatus(rootDir);
      if (s.state === "running" && s.url) {
        say("running", "The app is running", s.url);
        return { ok: true, url: s.url };
      }
      if (s.state === "crashed" || s.state === "stopped") {
        return fail("dev_failed", s.logTail.slice(-3).join(" ") || "The app stopped before it was ready.");
      }
      if (signal?.aborted) return fail("cancelled", "Stopped.");
      if (Date.now() > deadline) return fail("dev_failed", "The app didn't start in time.");
      await sleep(opts.pollMs ?? 250);
    }
  } catch (e) {
    return fail(signal?.aborted ? "cancelled" : "dev_failed", e instanceof Error ? e.message : String(e));
  }
}

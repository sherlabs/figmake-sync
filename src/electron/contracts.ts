import type {
  InitResult,
  ProjectInspection,
  PullResult,
  PushResult,
  StatusResult,
  VerifyResult,
} from "../core/service.js";
import type {
  AgentInfo,
  ChangeSet,
  DevStatus,
  EnsureAgentResult,
  EnsureProjectResult,
  AgentInstallResult,
  AgentLoginResult,
  HarnessEvent,
  HarnessSettings,
  SetupResult,
} from "../harness/types.js";
import type { AgentId } from "../harness/agents/types.js";
import type { BrowserInstallResult } from "../browser/install.js";
import type { PullStrategy } from "../types/config.js";

/**
 * Agent harness IPC (implemented in src/harness, wired in main.ts). All inputs are zod-validated in main;
 * rootDir must be a known, initialised project. The app never handles agent credentials: it only spawns
 * the user's own signed-in `claude` / `codex` CLI.
 *
 * invoke channels (window.figmakeSyncDesktop.*):
 *   figmake:harness:detect-agents     harnessDetectAgents()              -> AgentInfo[]
 *   figmake:harness:get-settings      harnessGetSettings(rootDir)        -> HarnessSettings
 *   figmake:harness:update-settings   harnessUpdateSettings(rootDir, {preferredAgent?, autoPush?}) -> HarnessSettings
 *   figmake:harness:setup             harnessSetup(rootDir)              -> SetupResult (npm install if needed; cancel via cancelOperation; logs as "setup-log")
 *   figmake:harness:dev-start         harnessStartDev(rootDir)           -> DevStatus (also stops dev servers of other projects)
 *   figmake:harness:dev-stop          harnessStopDev(rootDir)            -> DevStatus
 *   figmake:harness:dev-status        harnessDevStatus(rootDir)          -> DevStatus
 *   figmake:harness:dev-open          harnessOpenDev(rootDir)            -> {opened, url?, error?}  (only http(s)://localhost|127.0.0.1)
 *   figmake:harness:run-agent         harnessRunAgent({rootDir,prompt,agent?,newSession?}) -> {runId} (returns once the run started;
 *                                       the final RunOutcome arrives as a "run-done" event; cancelOperation also cancels it)
 *   figmake:harness:cancel-run        harnessCancelRun(rootDir)          -> {cancelled}
 *   figmake:harness:changes           harnessChanges(rootDir)            -> ChangeSet (local vs last-pull baseline; same ignore rules as status)
 *
 * Private Node runtime (src/runtime/managed.ts; isolated install under <userData>/runtime, NOT an OS sandbox):
 *   figmake:check-runtime-deps        checkRuntimeDeps()   -> RuntimeDepsResult (source system|managed|missing + version per tool)
 *   figmake:runtime:install           installRuntime()     -> RuntimeInstallResult (never throws; cancel via cancelOperation)
 *   figmake:runtime:remove            removeRuntime()      -> {removed}  (deletes <userData>/runtime)
 * event channel "figmake:runtime:progress" (onRuntimeProgress): RuntimeProgressEvent
 *
 * Manual push to Figma Make stays the existing pushProject().
 *
 * event channel "figmake:harness:event" (onHarnessEvent), payload HarnessEvent (discriminated by `kind`):
 *   setup-log   {rootDir, line}
 *   dev-status  {rootDir, status: DevStatus}      state: stopped|starting|running|crashed, url, logTail
 *   dev-log     {rootDir, line}
 *   run-phase   {rootDir, runId, phase: backup|agent|diff|push, message}
 *   run-agent   {rootDir, runId, event: AgentEvent}  AgentEvent: session|text|tool|file_edit|result|error
 *   run-done    {rootDir, runId, outcome: RunOutcome} outcome.push: skipped|pushed|aborted|failed
 *   agent-install-log / agent-login-log {agent, line}   (URL query strings already stripped)
 *   agent-login-url {agent, url}   origin+path only; open with harnessOpenAgentLogin(agent)
 *   agent-ensure   {agent, stage: checking|installing-node|installing|needs-browser-signin|ready|failed, message}
 *   project-ensure {rootDir, stage: checking|installing-node|installing-deps|starting|running|failed, message, url?}
 * Private agent CLIs install into <userData>/runtime/tools-agents (npm --prefix, never -g).
 */

export interface DesktopAppState {
  lastProjectRoot: string | null;
  /** ISO time of the last real pull/push/verify/sign-in that succeeded; cleared on AuthRequiredError. */
  lastAuthOkAt?: string | null | undefined;
}

export interface DesktopProjectCommandOptions {
  rootDir: string;
  dryRun: boolean;
  verbose: boolean;
  prompt: boolean;
  strategy: PullStrategy;
  headless?: boolean;
}

export interface DesktopProgressEvent {
  message: string;
  timestamp: string;
  percent?: number;
  scope?: "browser-install" | "command";
}

export interface DeleteProjectResult {
  removedStateDir: boolean;
  removedFromAppState: boolean;
}

export interface ClearAppDataResult {
  clearedPaths: string[];
}

/** Per tool: where it resolves from (a working system install wins over the app-managed copy). */
export interface RuntimeToolInfo {
  source: "system" | "managed" | "missing";
  version: string | null;
}

export interface RuntimeDepsResult {
  node: RuntimeToolInfo;
  npm: RuntimeToolInfo;
  pnpm: RuntimeToolInfo;
  managed: { installed: boolean; version: string | null; dir: string | null };
}

/** Streamed on "figmake:runtime:progress" while figmake:runtime:install runs. */
export interface RuntimeProgressEvent {
  phase: "resolving" | "downloading" | "verifying" | "extracting" | "installing-pnpm" | "done";
  message: string;
  percent?: number;
}

export type RuntimeInstallResult =
  | { ok: true; version: string; nodeVersion: string | null; npmVersion: string | null; pnpmVersion: string | null; alreadyInstalled: boolean }
  | { ok: false; code: "offline" | "http" | "checksum" | "unsupported" | "extract" | "install" | "cancelled" | "busy" | "unknown"; message: string };

export interface FigmakeDesktopApi {
  loadAppState(): Promise<DesktopAppState>;
  selectProjectDirectory(): Promise<ProjectInspection | null>;
  inspectProject(rootDir: string): Promise<ProjectInspection>;
  deleteProject(rootDir: string): Promise<DeleteProjectResult>;
  clearAppData(): Promise<ClearAppDataResult>;
  installBrowser(): Promise<BrowserInstallResult>;
  initProject(rootDir: string, figmaMakeUrl: string): Promise<InitResult>;
  authProject(options: DesktopProjectCommandOptions): Promise<void>;
  authStandalone(): Promise<void>;
  pullProject(options: DesktopProjectCommandOptions): Promise<PullResult>;
  syncFromFigma(options: DesktopProjectCommandOptions): Promise<PullResult>;
  statusProject(options: DesktopProjectCommandOptions): Promise<StatusResult>;
  pushProject(options: DesktopProjectCommandOptions): Promise<PushResult>;
  verifyProject(options: DesktopProjectCommandOptions): Promise<VerifyResult>;
  openInEditor(editor: string, path: string): Promise<{ success: boolean; error?: string }>;
  readFile(filePath: string): Promise<string>;
  addIgnorePattern(rootDir: string, pattern: string): Promise<{ success: boolean }>;
  removeIgnorePattern(rootDir: string, pattern: string): Promise<{ success: boolean }>;
  getCustomIgnorePatterns(rootDir: string): Promise<string[]>;
  rebaselineProject(options: DesktopProjectCommandOptions): Promise<{ filesSnapshotted: number }>;
  checkRuntimeDeps(): Promise<RuntimeDepsResult>;
  installRuntime(): Promise<RuntimeInstallResult>;
  removeRuntime(): Promise<{ removed: boolean; error?: string }>;
  onRuntimeProgress(listener: (event: RuntimeProgressEvent) => void): () => void;
  checkAuthStatus(): Promise<{
    authenticated: boolean | null;
    profileDir: string;
    unknown?: boolean;
    unconfirmed?: boolean;
    reason?: string;
  }>;
  cancelOperation(): Promise<{ cancelled: boolean }>;
  harnessDetectAgents(): Promise<AgentInfo[]>;
  harnessGetSettings(rootDir: string): Promise<HarnessSettings>;
  harnessUpdateSettings(
    rootDir: string,
    patch: { preferredAgent?: AgentId; autoPush?: boolean },
  ): Promise<HarnessSettings>;
  harnessSetup(rootDir: string): Promise<SetupResult>;
  harnessStartDev(rootDir: string): Promise<DevStatus>;
  harnessStopDev(rootDir: string): Promise<DevStatus>;
  harnessDevStatus(rootDir: string): Promise<DevStatus>;
  harnessOpenDev(rootDir: string): Promise<{ opened: boolean; url?: string; error?: string }>;
  harnessRunAgent(input: {
    rootDir: string;
    prompt: string;
    agent?: AgentId;
    newSession?: boolean;
  }): Promise<{ runId: string }>;
  harnessCancelRun(rootDir: string): Promise<{ cancelled: boolean }>;
  harnessChanges(rootDir: string): Promise<ChangeSet>;
  /** install if missing -> sign in if needed -> ready. Streams "agent-ensure" (+ install/login log) events. Cancel via cancelOperation. */
  harnessEnsureAgent(agent: AgentId): Promise<EnsureAgentResult>;
  /** Node (private if needed) -> npm install -> dev server -> url. Streams "project-ensure" events. Cancel via cancelOperation. */
  harnessEnsureProject(rootDir: string): Promise<EnsureProjectResult>;
  harnessInstallAgent(agent: AgentId): Promise<AgentInstallResult>;
  harnessLoginAgent(agent: AgentId): Promise<AgentLoginResult>;
  /** Opens the sign-in page the CLI printed, only if its host is allowlisted. The renderer never passes a URL. */
  harnessOpenAgentLogin(agent: AgentId): Promise<{ opened: boolean }>;
  /** Writes plain text (<= 4096 chars) to the system clipboard via main. */
  clipboardWrite(text: string): Promise<boolean>;
  onHarnessEvent(listener: (event: HarnessEvent) => void): () => void;
  onProgress(listener: (event: DesktopProgressEvent) => void): () => void;
}

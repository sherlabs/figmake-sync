/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method, @typescript-eslint/no-misused-promises -- mock rig */
import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatStore } from "../src/app/chatStore.js";
import { PROMPT_PREFACE, Session, conflictFiles, errorCode, parseChange, plainError, type SessionDeps } from "../src/app/session.js";
import { AuthRequiredError } from "../src/browser/session.js";
import { FigmakeSyncService } from "../src/core/service.js";
import { ProjectStateStore, STATE_DIRECTORY_NAME } from "../src/core/state.js";
import { DesktopAppStateStore } from "../src/electron/appState.js";
import type { ChatState, SessionState } from "../src/electron/contracts.js";
import type { AgentEvent } from "../src/harness/agents/types.js";
import type { RunOutcome } from "../src/harness/index.js";
import { LocalFixtureAdapter } from "./support/localFixtureAdapter.js";

const LINK = "https://www.figma.com/make/AbC123/Checkout-Flow";
const dirs: string[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.flush()));
  await Promise.all(dirs.splice(0).map((d) => fs.remove(d)));
});

interface Rig {
  session: Session;
  states: SessionState[];
  phases: () => string[];
  remote: string;
  workspace: string;
  project: string;
  deps: SessionDeps;
  harness: { startRun: ReturnType<typeof vi.fn>; ensureAgentReady: ReturnType<typeof vi.fn>; ensureProjectRunning: ReturnType<typeof vi.fn>; stopDevExcept: ReturnType<typeof vi.fn>; stopDev: ReturnType<typeof vi.fn> };
  sync: { pull: ReturnType<typeof vi.fn>; push: ReturnType<typeof vi.fn>; auth: ReturnType<typeof vi.fn> };
  edit: { fn: (root: string) => Promise<void>; outcome: Partial<RunOutcome>; hold?: Promise<void>; events?: AgentEvent[] };
  store: DesktopAppStateStore;
}

async function rig(opts: { agent?: "claude" | "codex" | null; saved?: boolean; connected?: boolean } = {}): Promise<Rig> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "session-")));
  dirs.push(base);
  const remote = path.join(base, "remote");
  const documents = path.join(base, "Documents");
  await fs.outputFile(path.join(remote, "src", "app.ts"), "export const v = 1;\n");
  await fs.outputJson(path.join(remote, "package.json"), { name: "p", scripts: { dev: "vite" } });
  const service = new FigmakeSyncService({ adapterFactory: ({ logger }) => new LocalFixtureAdapter(remote, logger) });
  const sync = {
    init: service.init.bind(service),
    status: service.status.bind(service),
    push: vi.fn((o: Parameters<typeof service.push>[0]) => service.push(o)),
    pull: vi.fn((o: Parameters<typeof service.pull>[0]) => service.pull(o)),
    auth: vi.fn(async () => undefined),
  };
  const store = new DesktopAppStateStore(path.join(base, "app-state.json"));
  if (opts.agent !== null) await store.update({ agent: opts.agent ?? "claude", agentConnected: opts.connected ?? true });

  const edit: Rig["edit"] = {
    fn: async (root) => {
      await fs.outputFile(path.join(root, "src", "app.ts"), "export const v = 2;\n");
      await fs.outputFile(path.join(root, "src", "new.ts"), "export {};\n");
    },
    outcome: { resultText: "Made the button blue.", success: true, cancelled: false, error: null },
  };
  const ref: { session?: Session } = {};
  const harness = {
    ensureProjectRunning: vi.fn(async () => ({ ok: true as const, url: "http://localhost:5173/" })),
    ensureAgentReady: vi.fn(async () => ({ ok: true as const, agent: {} as never })),
    pendingLoginUrl: vi.fn(() => null),
    updateSettings: vi.fn(async () => ({})),
    stopDevExcept: vi.fn(async () => undefined),
    stopDev: vi.fn(async () => ({})),
    startRun: vi.fn(async (input: { rootDir: string; prompt: string }, signal?: AbortSignal) => {
      const projectStore = new ProjectStateStore(input.rootDir);
      const config = await projectStore.loadProjectConfig();
      const backupDir = await projectStore.createBackup("pre-agent", config.sync.ignore);
      const done = (async (): Promise<RunOutcome> => {
        for (const event of edit.events ?? []) ref.session?.handleHarnessEvent({ kind: "run-agent", rootDir: input.rootDir, runId: "r", event });
        if (edit.hold && !signal?.aborted) {
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        }
        if (!signal?.aborted) await edit.fn(input.rootDir);
        return { runId: "r", agent: "claude", sessionId: null, changes: null, push: { status: "skipped", reason: "" }, resultText: "", success: true, cancelled: Boolean(signal?.aborted), error: null, backupDir, ...edit.outcome, ...(signal?.aborted ? { cancelled: true, success: false } : {}) };
      })();
      return { runId: "r", done };
    }),
  };
  const deps: SessionDeps = {
    sync: sync as unknown as SessionDeps["sync"],
    harness: harness as unknown as SessionDeps["harness"],
    appState: store,
    chatStore: new ChatStore(path.join(base, "chats")),
    documentsDir: documents,
    guard: { home: path.join(base, "home"), forbidden: [] },
    chooseFolder: vi.fn(async () => null),
    openExternal: vi.fn(),
    reloadPreview: vi.fn(),
    signOutFigma: vi.fn(async () => undefined),
    withBrowser: (run) => run(),
    waitForFigmaSignin: vi.fn(async () => undefined),
    log: vi.fn(),
  };
  const session = new Session(deps);
  ref.session = session;
  sessions.push(session);
  const states: SessionState[] = [];
  session.onState((s) => states.push(s));
  await session.start();
  return { session, states, phases: () => states.map((s) => s.phase), remote, workspace: path.join(documents, "figmake-sync"), project: path.join(documents, "figmake-sync", "checkout-flow"), deps, harness, sync, edit, store };
}

const read = (p: string): Promise<string> => fs.readFile(p, "utf8");

describe("session: happy path", () => {
  it("open -> ready -> ask -> working -> ready -> send", async () => {
    const r = await rig();
    expect(r.workspace && (await fs.pathExists(r.workspace))).toBe(true);
    await r.session.openProject(LINK);
    expect(r.phases().filter((p) => p !== "start")[0]).toBe("connecting");
    expect(r.phases()).toContain("preparing");
    expect(r.session.state).toMatchObject({ phase: "ready", projectName: "Checkout Flow", previewUrl: "http://localhost:5173/", canSend: false, canUndo: false, changes: [] });
    expect(await read(path.join(r.project, "src", "app.ts"))).toContain("v = 1");

    await r.session.ask("make the button blue");
    const run = r.harness.startRun.mock.calls[0]?.[0] as { prompt: string; agent: string };
    expect(run.prompt.startsWith(PROMPT_PREFACE)).toBe(true);
    expect(run.prompt.endsWith("make the button blue")).toBe(true);
    expect(run.agent).toBe("claude");
    expect(r.phases()).toContain("working");
    expect(r.session.state).toMatchObject({ phase: "ready", changes: ["Made the button blue"], canSend: true, canUndo: true });
    expect(r.deps.reloadPreview).toHaveBeenCalled();
    // The app never writes helper files into the project.
    for (const name of ["CLAUDE.md", "AGENTS.md", ".claude", ".codex"]) expect(await fs.pathExists(path.join(r.project, name))).toBe(false);

    await r.session.send();
    expect(r.phases()).toContain("sending");
    expect(await read(path.join(r.remote, "src", "app.ts"))).toContain("v = 2");
    expect(r.session.state).toMatchObject({ phase: "ready", canSend: false, canUndo: false, changes: [] });
  });

  it("never sends anything the app added or agent helper files", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.edit.fn = async (root) => {
      await fs.outputFile(path.join(root, "src", "app.ts"), "export const v = 3;\n");
      await fs.outputFile(path.join(root, "CLAUDE.md"), "x");
      await fs.outputFile(path.join(root, ".claude", "s.json"), "{}");
    };
    await r.session.ask("x");
    await r.session.send();
    expect(await fs.pathExists(path.join(r.remote, "CLAUDE.md"))).toBe(false);
    expect(await fs.pathExists(path.join(r.remote, ".claude"))).toBe(false);
    expect(await fs.pathExists(path.join(r.remote, ".figmake-sync"))).toBe(false);
  });

  it("reopens the last project straight into preparing, without pulling again", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.sync.pull.mockClear();
    const again = new Session(r.deps);
    const seen: string[] = [];
    again.onState((s) => seen.push(s.phase));
    await again.start();
    expect(seen.find((p) => p !== "start")).toBe("preparing");
    expect(seen).not.toContain("connecting");
    expect(r.sync.pull).not.toHaveBeenCalled();
    expect(again.state).toMatchObject({ phase: "ready", projectName: "Checkout Flow" });
  });
});

describe("session: sign-in and AI choice", () => {
  it("needs-figma-signin, then retry signs in and continues", async () => {
    const r = await rig();
    r.sync.pull.mockRejectedValueOnce(new AuthRequiredError());
    await r.session.openProject(LINK);
    expect(r.session.state.phase).toBe("needs-figma-signin");
    await r.session.retry();
    expect(r.sync.auth).toHaveBeenCalledTimes(1);
    expect(r.session.state.phase).toBe("ready");
  });

  it("asks Claude or ChatGPT once, then continues to ready", async () => {
    const r = await rig({ agent: null });
    expect(r.session.state).toMatchObject({ phase: "needs-ai-choice", agentConnected: false, previewUrl: null });
    await r.session.openProject(LINK);
    expect(r.session.state).toMatchObject({ phase: "needs-ai-choice", previewUrl: "http://localhost:5173/" });
    await r.session.setAgent("codex");
    expect(r.harness.ensureAgentReady).toHaveBeenCalledWith("codex", expect.anything());
    expect(r.session.state).toMatchObject({ phase: "ready", agent: "codex" });
    expect((await r.store.load())).toMatchObject({ agent: "codex", agentConnected: true });
  });

  it("first run asks for the AI before anything else, connects it, then shows the start screen", async () => {
    const r = await rig({ agent: null });
    expect(r.session.state).toMatchObject({ phase: "needs-ai-choice", agent: null, agentConnected: false });
    expect(r.harness.ensureAgentReady).not.toHaveBeenCalled();
    await r.session.setAgent("claude");
    expect(r.harness.ensureAgentReady).toHaveBeenCalledWith("claude", expect.anything());
    expect(r.session.state).toMatchObject({ phase: "start", agent: "claude", agentConnected: true });
    expect(await r.store.load()).toMatchObject({ agent: "claude", agentConnected: true });
    await r.session.openProject(LINK);
    expect(r.session.state).toMatchObject({ phase: "ready", previewUrl: "http://localhost:5173/" });
  });

  it("an AI saved by an older version counts as not connected and is asked about again", async () => {
    const r = await rig({ agent: "codex", connected: false });
    expect(r.session.state).toMatchObject({ phase: "needs-ai-choice", agent: "codex", agentConnected: false });
    expect(r.harness.ensureAgentReady).not.toHaveBeenCalled();
    await r.session.setAgent("codex");
    expect(r.harness.ensureAgentReady).toHaveBeenCalledWith("codex", expect.anything());
    expect(r.session.state).toMatchObject({ phase: "start", agentConnected: true });
  });

  it("the last project reopens only after the AI is connected", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    await r.store.update({ agentConnected: false });
    const again = new Session(r.deps);
    sessions.push(again);
    await again.start();
    expect(again.state).toMatchObject({ phase: "needs-ai-choice", previewUrl: null, projectName: null });
    await again.setAgent("claude");
    expect(again.state).toMatchObject({ phase: "ready", projectName: "Checkout Flow", agentConnected: true });
  });

  it("a failed sign-in keeps the AI unconnected and says so plainly", async () => {
    const r = await rig({ agent: null });
    r.harness.ensureAgentReady.mockResolvedValueOnce({ ok: false, code: "signin_failed" });
    await r.session.setAgent("claude");
    expect(r.session.state).toMatchObject({ phase: "error", message: "Couldn't sign in to Claude. Try again.", agentConnected: false });
    expect((await r.store.load()).agentConnected).toBe(false);
    await r.session.retry();
    expect(r.session.state).toMatchObject({ phase: "start", agentConnected: true });
  });

  it("cancelling the sign-in goes back to the choice", async () => {
    const r = await rig({ agent: null });
    r.harness.ensureAgentReady.mockImplementationOnce((_a: string, signal: AbortSignal) => new Promise((res) => void signal.addEventListener("abort", () => res({ ok: false, code: "cancelled" }))));
    const pending = r.session.setAgent("claude");
    await vi.waitFor(() => expect(r.session.state.phase).toBe("preparing"));
    await r.session.cancel();
    await pending;
    expect(r.session.state).toMatchObject({ phase: "needs-ai-choice", agentConnected: false });
  });

  it("switching the AI from Settings connects the new one; the same one is a no-op", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.harness.ensureAgentReady.mockClear();
    await r.session.setAgent("claude");
    expect(r.harness.ensureAgentReady).not.toHaveBeenCalled();
    await r.session.setAgent("codex");
    expect(r.harness.ensureAgentReady).toHaveBeenCalledWith("codex", expect.anything());
    expect(r.session.state).toMatchObject({ phase: "ready", agent: "codex", agentConnected: true });
  });

  it("shows the AI sign-in state and opens only allowlisted sign-in pages", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.session.handleHarnessEvent({ kind: "agent-ensure", agent: "claude", stage: "needs-browser-signin", message: "" });
    expect(r.session.state).toMatchObject({ phase: "needs-ai-signin", message: "Sign in to Claude in your browser" });
    (r.harness as unknown as { pendingLoginUrl: ReturnType<typeof vi.fn> }).pendingLoginUrl.mockReturnValueOnce("https://claude.ai/oauth/authorize");
    r.session.handleHarnessEvent({ kind: "agent-login-url", agent: "claude", url: "x" });
    expect(r.deps.openExternal).toHaveBeenCalledTimes(1);
    (r.harness as unknown as { pendingLoginUrl: ReturnType<typeof vi.fn> }).pendingLoginUrl.mockReturnValueOnce("https://evil.example/login");
    r.session.handleHarnessEvent({ kind: "agent-login-url", agent: "claude", url: "x" });
    expect(r.deps.openExternal).toHaveBeenCalledTimes(1);
  });
});

describe("session: conflict", () => {
  async function conflicted(): Promise<Rig> {
    const r = await rig();
    await r.session.openProject(LINK);
    await r.session.ask("change");
    await fs.outputFile(path.join(r.remote, "src", "app.ts"), "export const v = 'figma';\n");
    await r.session.send();
    expect(r.session.state).toMatchObject({ phase: "conflict", message: "Figma has newer changes." });
    expect(r.session.state.conflictFiles).toEqual(["src/app.ts"]);
    expect(await read(path.join(r.remote, "src", "app.ts"))).toContain("figma");
    return r;
  }
  const backups = (r: Rig): Promise<string[]> => fs.readdir(path.join(r.project, ".figmake-sync", "backups"));

  it("Keep mine overwrites Figma, after a backup", async () => {
    const r = await conflicted();
    await r.session.send("mine");
    expect(await read(path.join(r.remote, "src", "app.ts"))).toContain("v = 2");
    expect((await backups(r)).some((n) => n.endsWith("pre-resolve"))).toBe(true);
    expect(r.session.state).toMatchObject({ phase: "ready", canSend: false });
    expect(r.session.state.conflictFiles).toBeUndefined();
  });

  it("Use Figma's replaces local work, after a backup", async () => {
    const r = await conflicted();
    await r.session.send("figma");
    expect(await read(path.join(r.project, "src", "app.ts"))).toContain("figma");
    expect(await fs.pathExists(path.join(r.project, "src", "new.ts"))).toBe(false);
    const names = await backups(r);
    const resolve = names.find((n) => n.endsWith("pre-resolve")) as string;
    expect(await read(path.join(r.project, ".figmake-sync", "backups", resolve, "workspace", "src", "app.ts"))).toContain("v = 2");
    expect(r.session.state).toMatchObject({ phase: "ready", canSend: false, canUndo: false });
    expect(r.session.state.message).toBeUndefined();
  });

  it("Esc dismisses the sheet and nothing is overwritten", async () => {
    const r = await conflicted();
    await r.session.cancel();
    expect(r.session.state).toMatchObject({ phase: "ready", canSend: true });
    expect(await read(path.join(r.remote, "src", "app.ts"))).toContain("figma");
  });

  it("a resolution outside the conflict sheet is ignored", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    await r.session.send("mine");
    expect(r.phases()).not.toContain("sending");
  });
});

describe("errorCode", () => {
  it("maps failures to stable codes", () => {
    expect(errorCode(new Error("Couldn't find newer changes"), "figma")).toBe("figma_unreachable");
    expect(errorCode(new Error("weird"), "figma")).toBe("unknown");
    expect(errorCode(new Error("x"), "project")).toBe("preview_failed");
    expect(errorCode(new Error("x"), "agent")).toBe("agent_failed");
    expect(errorCode(new Error("Backup failed"), "figma")).toBe("backup_failed");
  });
});

describe("session: undo, cancel, errors", () => {
  it("undo puts the files back exactly, one change at a time", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    await r.session.ask("one");
    r.edit.fn = async (root) => fs.outputFile(path.join(root, "src", "app.ts"), "export const v = 9;\n");
    r.edit.outcome = { ...r.edit.outcome, resultText: "Changed the title." };
    await r.session.ask("two");
    expect(r.session.state.changes).toEqual(["Made the button blue", "Changed the title"]);

    await r.session.undo();
    expect(await read(path.join(r.project, "src", "app.ts"))).toContain("v = 2");
    expect(r.session.state).toMatchObject({ changes: ["Made the button blue"], canUndo: true });
    await r.session.undo();
    expect(await read(path.join(r.project, "src", "app.ts"))).toContain("v = 1");
    expect(await fs.pathExists(path.join(r.project, "src", "new.ts"))).toBe(false);
    expect(r.session.state).toMatchObject({ phase: "ready", changes: [], canUndo: false, canSend: false });
  });

  it("cancel stops the run and leaves the files as they were", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.edit.hold = Promise.resolve();
    const asking = r.session.ask("slow");
    await vi.waitFor(() => expect(r.session.state.phase).toBe("working"));
    await r.session.cancel();
    await asking;
    expect(r.session.state).toMatchObject({ phase: "ready", canUndo: false, canSend: false, changes: [] });
    expect(await read(path.join(r.project, "src", "app.ts"))).toContain("v = 1");
  });

  it("a failed run is restored and shows one plain sentence; Try again re-asks", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.edit.outcome = { success: false, error: "ENOTFOUND api.anthropic.com\n at stack" };
    await r.session.ask("go");
    expect(r.session.state).toMatchObject({ phase: "error", message: "Couldn't reach Claude. Try again." });
    expect(await read(path.join(r.project, "src", "app.ts"))).toContain("v = 1");
    r.edit.outcome = { success: true, error: null, resultText: "Done." };
    await r.session.retry();
    expect(r.session.state).toMatchObject({ phase: "ready", changes: ["Done"] });
  });

  it("a bad link or a failing start shows a sentence and one action", async () => {
    const r = await rig();
    await r.session.openProject("https://example.com/nope");
    expect(r.session.state).toMatchObject({ phase: "error", message: "That doesn't look like a Figma Make link. Try again." });
    await r.session.retry();
    expect(r.session.state.phase).toBe("start");

    r.harness.ensureProjectRunning.mockResolvedValueOnce({ ok: false, code: "dev_failed", message: "vite exploded /Users/x/y" } as never);
    await r.session.openProject(LINK);
    expect(r.session.state).toMatchObject({ phase: "error", message: "Couldn't start the project. Try again." });
    await r.session.retry();
    expect(r.session.state.phase).toBe("ready");
  });

  it("a Figma failure while sending is plain and retryable", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    await r.session.ask("x");
    await fs.remove(r.remote);
    await r.session.send();
    expect(r.session.state.phase).toBe("error");
    expect(r.session.state.message).toMatch(/^Couldn't (reach Figma|check Figma for newer changes)\. Try again\.$/u);
  });

  it("error states carry a stable code and the phase they failed in; other states carry none", async () => {
    const r = await rig();
    await r.session.openProject("https://example.com/nope");
    expect(r.session.state).toMatchObject({ phase: "error", code: "invalid_link" });
    await r.session.retry();
    expect(r.session.state).not.toHaveProperty("code");

    r.harness.ensureProjectRunning.mockResolvedValueOnce({ ok: false, code: "dev_failed", message: "x" } as never);
    await r.session.openProject(LINK);
    expect(r.session.state).toMatchObject({ phase: "error", code: "preview_failed", failedIn: "preparing" });
    await r.session.retry();
    expect(r.session.state).not.toHaveProperty("code");
    expect(r.session.state).not.toHaveProperty("failedIn");

    r.edit.outcome = { success: false, error: "boom" };
    await r.session.ask("go");
    expect(r.session.state).toMatchObject({ phase: "error", code: "agent_failed", failedIn: "working" });
    r.edit.outcome = { success: true, error: null, resultText: "Done." };
    await r.session.retry();

    r.sync.push.mockRejectedValueOnce(Object.assign(new Error("Selector missing"), { code: "UI_CHANGED" }));
    await r.session.send();
    expect(r.session.state).toMatchObject({ phase: "error", code: "figma_ui_changed", failedIn: "sending" });
  });

  it("isBusy is true while connecting, preparing, working, sending or in conflict", async () => {
    const r = await rig();
    expect(r.session.isBusy()).toBe(false);
    const seen = new Set<string>();
    r.session.onState((s) => {
      if (r.session.isBusy()) seen.add(s.phase);
    });
    await r.session.openProject(LINK);
    await r.session.ask("x");
    await r.session.send();
    expect([...seen]).toEqual(expect.arrayContaining(["connecting", "preparing", "working", "sending"]));
    expect(r.session.isBusy()).toBe(false);
  });

  it("signed out while sending asks for sign-in, then sends", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    await r.session.ask("x");
    r.sync.push.mockRejectedValueOnce(new AuthRequiredError());
    await r.session.send();
    expect(r.session.state.phase).toBe("needs-figma-signin");
    await r.session.retry();
    expect(r.sync.auth).toHaveBeenCalled();
    expect(r.session.state).toMatchObject({ phase: "ready", canSend: false });
  });
});

describe("session: workspace", () => {
  it("falls back to the default folder and says so when the saved one is invalid", async () => {
    const r = await rig();
    await r.store.update({ workspace: "/" });
    const again = new Session(r.deps);
    sessions.push(again);
    await again.start();
    expect(again.state.workspace).toBe("figmake-sync");
    expect(again.state.workspaceError).toBe("That folder can't be used, so the default one is in use.");
  });

  it("changing it affects new projects only", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    const elsewhere = path.join(path.dirname(r.workspace), "Designs");
    (r.deps.chooseFolder as ReturnType<typeof vi.fn>).mockResolvedValueOnce(elsewhere);
    await r.session.chooseWorkspace();
    expect(r.session.state).toMatchObject({ workspace: "Designs" });
    await r.session.openProject(LINK);
    expect(await fs.pathExists(path.join(elsewhere, "checkout-flow"))).toBe(false);
    await r.session.openProject("https://www.figma.com/make/Zzz999/Brand-Site");
    expect(await fs.pathExists(path.join(elsewhere, "brand-site", ".figmake-sync"))).toBe(true);
  });

  it("rejects an unusable folder with one sentence and keeps the old one", async () => {
    const r = await rig();
    (r.deps.chooseFolder as ReturnType<typeof vi.fn>).mockResolvedValueOnce(r.deps.guard.home);
    await r.session.chooseWorkspace();
    expect(r.session.state).toMatchObject({ workspace: "figmake-sync", workspaceError: "That folder can't be used." });
  });
});

describe("plain language", () => {
  it("parses the agent's sentence", () => {
    expect(parseChange("I looked around.\n\n**Made the button blue.** Hope that helps")).toBe("Made the button blue");
    expect(parseChange("- Updated `Cart.tsx` to show totals.")).toBe("Updated Cart.tsx to show totals");
    expect(parseChange("   ")).toBeNull();
    expect((parseChange("x".repeat(300)) ?? "").length).toBeLessThanOrEqual(140);
  });

  it("never leaks raw errors", () => {
    for (const raw of ["ENOTFOUND x", "Error: spawn /usr/bin/node ENOENT", "at Object.<anonymous> (/Users/a/b.js:1:1)"]) {
      for (const kind of ["figma", "project", "agent"] as const) {
        const text = plainError(new Error(raw), kind, "codex");
        expect(text).toMatch(/^[^/\n]+\.$/u);
        expect(text).not.toMatch(/ENOENT|ENOTFOUND|\/Users/u);
      }
    }
    expect(plainError(new Error("x"), "agent", "codex")).toBe("Couldn't reach ChatGPT. Try again.");
    expect(plainError(new Error("Backup failed, agent was not started"), "agent")).toBe("Couldn't make a backup, so nothing was changed.");
  });
});

const LINK2 = "https://www.figma.com/make/Zed999/Other-App";

describe("session: multiple projects", () => {
  it("lists projects with statuses and keeps one active", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    await r.session.openProject(LINK2);
    expect(r.session.state.activeKey).toBe("Zed999");
    expect(r.session.state.projects.map((p) => [p.key, p.name, p.status])).toEqual([
      ["AbC123", "Checkout Flow", "synced"],
      ["Zed999", "Other App", "synced"],
    ]);
    expect(r.session.state.syncedAt).not.toBeNull();
    await r.session.ask("x");
    expect(r.session.state.projects.map((p) => p.status)).toEqual(["synced", "changes"]);
    expect(r.session.state.changeFiles).toEqual([2]);
    await r.session.undo();
    expect(r.session.state.projects.map((p) => p.status)).toEqual(["synced", "synced"]);
  });

  it("switching stops the other dev server, skips the pull, and keeps each change list", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    await r.session.ask("x");
    await r.session.openProject(LINK2);
    expect(r.session.state.changes).toEqual([]);
    expect(r.session.state.projects[0]?.status).toBe("changes");
    r.sync.pull.mockClear();
    r.harness.stopDevExcept.mockClear();
    await r.session.switchProject("AbC123");
    expect(r.sync.pull).not.toHaveBeenCalled();
    expect(r.harness.stopDevExcept).toHaveBeenCalledWith(r.project);
    expect(r.session.state).toMatchObject({ activeKey: "AbC123", phase: "ready", changes: ["Made the button blue"], canSend: true });
    await r.session.switchProject("AbC123");
    await r.session.switchProject("nope");
    expect(r.session.state.activeKey).toBe("AbC123");
  });

  it("restores the project list and links after a restart", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    await r.session.openProject(LINK2);
    expect(Object.keys((await r.store.load()).links)).toEqual(["AbC123", "Zed999"]);
    const again = new Session(r.deps);
    sessions.push(again);
    await again.start();
    expect(again.state.projects.map((p) => p.key)).toEqual(["AbC123", "Zed999"]);
    expect(again.state.activeKey).toBe("Zed999");
  });

  it("seeds links from the last link of an older saved state", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    await r.store.update({ links: {} });
    const again = new Session(r.deps);
    sessions.push(again);
    await again.start();
    expect(again.state.projects.map((p) => p.key)).toEqual(["AbC123"]);
  });

  it("marks a project with a missing folder as needing attention", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    await r.session.openProject(LINK2);
    await fs.remove(r.project);
    await r.session.ask("noop");
    expect(r.session.state.projects.find((p) => p.key === "AbC123")?.status).toBe("attention");
  });

  it("remove keeps the files by default", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    await r.session.removeProject("AbC123");
    expect(r.session.state).toMatchObject({ phase: "start", projects: [], activeKey: null, projectName: null });
    expect(r.harness.stopDevExcept).toHaveBeenCalledWith(null, true);
    expect(await fs.pathExists(r.project)).toBe(true);
    const saved = await r.store.load();
    expect(saved).toMatchObject({ lastLink: null, links: {}, projects: {} });
  });

  it("remove deletes the folder only on request and only inside the workspace", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    await r.session.openProject(LINK2);
    await r.session.removeProject("AbC123", true);
    expect(await fs.pathExists(r.project)).toBe(false);
    expect(r.session.state.activeKey).toBe("Zed999");

    // A folder outside the workspace is never deleted.
    const outside = path.join(path.dirname(r.workspace), "elsewhere");
    await fs.outputFile(path.join(outside, ".figmake-sync", "x"), "x");
    await r.store.update({ projects: { ...(await r.store.load()).projects, Out1: outside }, links: { ...(await r.store.load()).links, Out1: "https://www.figma.com/make/Out1/Out" } });
    const again = new Session(r.deps);
    sessions.push(again);
    await again.start();
    await again.removeProject("Out1", true);
    expect(await fs.pathExists(outside)).toBe(true);
  });

  it("undo(index) restores that change's backup and drops later ones", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.edit.fn = (root) => fs.outputFile(path.join(root, "src", "app.ts"), "export const v = 5;\n");
    await r.session.ask("one");
    r.edit.fn = (root) => fs.outputFile(path.join(root, "src", "app.ts"), "export const v = 6;\n");
    r.edit.outcome = { ...r.edit.outcome, resultText: "Second." };
    await r.session.ask("two");
    expect(r.session.state.changes).toHaveLength(2);
    await r.session.undo(1);
    expect(await read(path.join(r.project, "src", "app.ts"))).toContain("v = 5");
    expect(r.session.state.changes).toHaveLength(1);
    await r.session.ask("three");
    await r.session.undo(0);
    expect(await read(path.join(r.project, "src", "app.ts"))).toContain("v = 1");
    expect(r.session.state).toMatchObject({ changes: [], canSend: false });
  });

  it("describeChange shows edited, added and binary files, and never throws", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.edit.fn = async (root) => {
      await fs.outputFile(path.join(root, "src", "app.ts"), "export const v = 2;\n");
      await fs.outputFile(path.join(root, "src", "new.ts"), "export {};\n");
      await fs.outputFile(path.join(root, "src", "pic.bin"), Buffer.from([0, 1, 2]));
    };
    await r.session.ask("x");
    const files = await r.session.describeChange(0);
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ["src/app.ts", "edited", false],
      ["src/new.ts", "added", false],
      ["src/pic.bin", "added", true],
    ]);
    expect(files[0]?.rows.map((x) => x.left?.mark ?? null)).toEqual(["del", ]);
    expect(await r.session.describeChange(9)).toEqual([]);
    expect(await r.session.describeChange(Number.NaN)).toEqual([]);
  });
});

describe("session: sign-in wait and updates", () => {
  it("waits for the browser to detect the sign-in, and cancel returns to the button", async () => {
    const r = await rig();
    r.sync.pull.mockRejectedValueOnce(new AuthRequiredError());
    await r.session.openProject(LINK);
    r.sync.auth.mockImplementationOnce((o: { waitForManualAction: () => Promise<void> }) => o.waitForManualAction());
    const wait = r.deps.waitForFigmaSignin as ReturnType<typeof vi.fn>;
    wait.mockImplementationOnce((signal: AbortSignal) => new Promise<void>((_res, rej) => void signal.addEventListener("abort", () => rej(new Error("aborted")))));
    const pending = r.session.retry();
    await vi.waitFor(() => expect(r.session.state.message).toBe("Waiting for sign-in in your browser"));
    expect(r.session.state.phase).toBe("needs-figma-signin");
    expect(r.sync.auth).toHaveBeenCalledWith(expect.objectContaining({ autoDetectLogin: true }));
    await r.session.cancel();
    await pending;
    expect(r.session.state).toMatchObject({ phase: "needs-figma-signin" });
    expect(r.session.state.message).toBeUndefined();
    await r.session.retry();
    expect(r.session.state.phase).toBe("ready");
  });

  it("persists the updates switch", async () => {
    const r = await rig();
    expect(r.session.state.updatesEnabled).toBe(true);
    await r.session.setUpdates(false);
    expect(r.session.state.updatesEnabled).toBe(false);
    expect((await r.store.load()).updates.enabled).toBe(false);
    const again = new Session(r.deps);
    sessions.push(again);
    await again.start();
    expect(again.state.updatesEnabled).toBe(false);
  });

  it("parses diverged file lists", () => {
    expect(conflictFiles("7 file(s) changed in Figma Make since the last pull (a.ts, b/c.ts, ...). Overwrite them with local content?")).toEqual(["a.ts", "b/c.ts"]);
    expect(conflictFiles("nothing")).toEqual([]);
  });
});


describe("session: chat", () => {
  const SAY: AgentEvent[] = [
    { type: "text", text: "Looking at the button", delta: true },
    { type: "tool", name: "Read", summary: "Read /secret/home/proj/src/app.ts" },
    { type: "file_edit", path: "/secret/home/proj/src/app.ts", tool: "Edit" },
    { type: "text", text: "Made the button blue." },
  ];
  const last = (c: ChatState) => c.messages.at(-1);

  it("a turn becomes a user message plus an assistant message with friendly activity and a change card", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.edit.events = SAY;
    r.edit.outcome = { resultText: "Made the button blue.", success: true, cancelled: false, error: null, sessionId: "sess-12345678" };
    await r.session.ask("make the button blue");
    const chat = r.session.chat;
    expect(chat.active).toBe(false);
    expect(chat.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(chat.messages[0]?.text).toBe("make the button blue");
    const a = last(chat);
    expect(a?.status).toBe("done");
    expect(a?.parts.map((p) => p.type)).toEqual(["text", "activity"]);
    expect(JSON.stringify(a)).not.toMatch(/secret|Read \/|home/u);
    expect(a?.parts[1]).toMatchObject({ items: [{ label: "Looked at app.ts" }, { label: "Edited app.ts" }] });
    expect(a?.change).toMatchObject({ summary: "Made the button blue", fate: "active", previewUpdated: true });
    expect(a?.change?.files.map((f) => f.name).sort()).toEqual(["app.ts", "new.ts"]);
    expect(r.session.state.changeIds).toEqual([a?.change?.turnId]);
    expect(r.session.state.changes).toEqual(["Made the button blue"]);
  });

  it("streams: partial text lands in the live message before the run finishes", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.edit.events = [{ type: "text", text: "Partial thou", delta: true }];
    let release = (): void => undefined;
    r.edit.hold = new Promise<void>((resolve) => (release = resolve));
    const snapshots: ChatState[] = [];
    r.session.onChat((c) => snapshots.push(c));
    const run = r.session.ask("go");
    await vi.waitFor(() => expect(r.session.chat.active).toBe(true));
    await vi.waitFor(() => expect(last(r.session.chat)?.parts).toEqual([{ type: "text", text: "Partial thou" }]));
    expect(last(r.session.chat)?.status).toBe("streaming");
    // Cancel mid-stream: partial text stays, status is "stopped", no card, nothing changed.
    await r.session.cancel();
    release();
    await run;
    expect(last(r.session.chat)).toMatchObject({ status: "stopped", parts: [{ type: "text", text: "Partial thou" }] });
    expect(last(r.session.chat)?.change).toBeUndefined();
    expect(r.session.chat.active).toBe(false);
    expect(await read(path.join(r.project, "src", "app.ts"))).toContain("v = 1");
    expect(r.session.state.phase).toBe("ready");
    expect(snapshots.length).toBeGreaterThan(1);
  });

  it("events from another project never reach this chat", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.edit.events = [];
    let release = (): void => undefined;
    r.edit.hold = new Promise<void>((resolve) => (release = resolve));
    const run = r.session.ask("go");
    await vi.waitFor(() => expect(r.session.chat.active).toBe(true));
    r.session.handleHarnessEvent({ kind: "run-agent", rootDir: path.join(r.workspace, "elsewhere"), runId: "x", event: { type: "text", text: "LEAK" } });
    r.session.handleHarnessEvent({ kind: "run-agent", rootDir: r.project, runId: "x", event: { type: "text", text: "mine" } });
    expect(JSON.stringify(r.session.chat)).not.toContain("LEAK");
    expect(JSON.stringify(r.session.chat)).toContain("mine");
    await r.session.cancel();
    release();
    await run;
  });

  it("a failed run leaves a calm error message; Try again re-asks without a second user message", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.edit.outcome = { success: false, cancelled: false, error: "spawn /usr/bin/claude ENOENT at node:internal", resultText: "" };
    await r.session.ask("make it blue");
    expect(last(r.session.chat)).toMatchObject({ status: "error", error: { message: "Couldn't reach Claude. Try again.", code: "agent_failed" } });
    expect(JSON.stringify(r.session.chat)).not.toMatch(/ENOENT|node:internal|usr\/bin/u);
    expect(r.session.state.phase).toBe("error");
    r.edit.outcome = { success: true, cancelled: false, error: null, resultText: "Made it blue." };
    await r.session.retry();
    const roles = r.session.chat.messages.map((m) => `${m.role}:${m.status}`);
    expect(roles).toEqual(["user:done", "assistant:done"]);
    expect(r.session.state.phase).toBe("ready");
  });

  it("typing again after an error simply carries on", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.edit.outcome = { success: false, cancelled: false, error: "x", resultText: "" };
    await r.session.ask("first");
    r.edit.outcome = { success: true, cancelled: false, error: null, resultText: "Did it." };
    await r.session.ask("second");
    expect(r.session.state.phase).toBe("ready");
    expect(r.session.chat.messages.map((m) => `${m.role}:${m.status}`)).toEqual(["user:done", "assistant:error", "user:done", "assistant:done"]);
  });

  it("a question that changes nothing is a plain answer: no card, no change to send", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.edit.fn = async () => undefined;
    r.edit.events = [{ type: "text", text: "The cart reads once on load, so it never updates." }];
    r.edit.outcome = { resultText: "The cart reads once on load, so it never updates.", success: true, cancelled: false, error: null };
    await r.session.ask("why does the cart not update?");
    const a = last(r.session.chat);
    expect(a?.change).toBeUndefined();
    expect(a?.parts).toEqual([{ type: "text", text: "The cart reads once on load, so it never updates." }]);
    expect(r.session.state).toMatchObject({ changes: [], changeIds: [], canSend: false });
  });

  it("follow-ups resume the same AI conversation; New chat starts a fresh one and archives the old", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.edit.outcome = { resultText: "Done one.", success: true, cancelled: false, error: null, sessionId: "sess-aaaaaaaa" };
    await r.session.ask("one");
    await r.session.ask("two");
    const arg = (n: number) => r.harness.startRun.mock.calls[n]?.[0] as { newSession?: boolean };
    expect(arg(0).newSession).toBeUndefined();
    expect(arg(1).newSession).toBeUndefined();
    expect(r.session.chat.messages).toHaveLength(4);

    await r.session.newChat();
    expect(r.session.chat).toMatchObject({ messages: [], fresh: true, active: false });
    const archive = path.join(path.dirname(path.dirname(r.workspace)), "chats");
    expect((await fs.readdir(archive)).some((f) => f.endsWith(".archive.json"))).toBe(true);
    await r.session.ask("three");
    expect(arg(2).newSession).toBe(true);
    expect(r.session.chat.fresh).toBe(false);
    await r.session.ask("four");
    expect(arg(3).newSession).toBeUndefined();
    expect(r.session.chat.messages.map((m) => m.text).filter(Boolean)).toEqual(["three", "four"]);
  });

  it("a New chat that never got to start keeps asking for a fresh session", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    await r.session.ask("one");
    await r.session.newChat();
    r.edit.outcome = { success: false, cancelled: false, error: "x", resultText: "", sessionId: null };
    await r.session.ask("two");
    expect(r.session.chat.fresh).toBe(true);
    await r.session.retry().catch(() => undefined);
    expect((r.harness.startRun.mock.calls.at(-1)?.[0] as { newSession?: boolean }).newSession).toBe(true);
  });

  it("restores the transcript when the project reopens, including after a restart", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.edit.events = SAY;
    await r.session.ask("make the button blue");
    const before = r.session.chat.messages;
    // Same saved files, brand new session object (an app restart).
    const again = new Session(r.deps);
    sessions.push(again);
    await again.start();
    expect(again.chat.projectKey).toBe("AbC123");
    expect(again.chat.messages.map((m) => [m.role, m.text, m.parts.length])).toEqual(before.map((m) => [m.role, m.text, m.parts.length]));
    // Cards from before the restart can't be undone any more (their backups' order is gone) but still read fine.
    expect(again.state.changeIds).toEqual([]);
    expect(last(again.chat)?.change?.fate).toBe("active");
  });

  it("per-turn undo: restores that turn's backup, marks later cards undone, keeps earlier ones", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.edit.fn = async (root) => fs.outputFile(path.join(root, "src", "app.ts"), "export const v = 2;\n");
    r.edit.outcome = { resultText: "First change.", success: true, cancelled: false, error: null };
    await r.session.ask("one");
    r.edit.fn = async (root) => fs.outputFile(path.join(root, "src", "app.ts"), "export const v = 3;\n");
    r.edit.outcome = { resultText: "Second change.", success: true, cancelled: false, error: null };
    await r.session.ask("two");
    const [c1, c2] = r.session.chat.messages.flatMap((m) => (m.change ? [m.change] : []));
    expect(r.session.state.changeIds).toEqual([c1?.turnId, c2?.turnId]);

    // Undo the newest turn only.
    await r.session.undo(1);
    expect(await read(path.join(r.project, "src", "app.ts"))).toContain("v = 2");
    expect(r.session.chat.messages.flatMap((m) => (m.change ? [m.change.fate] : []))).toEqual(["active", "undone"]);
    expect(r.session.state.changeIds).toEqual([c1?.turnId]);

    // Ids are stable: a new turn after the undo never takes over the old card's slot.
    r.edit.fn = async (root) => fs.outputFile(path.join(root, "src", "app.ts"), "export const v = 4;\n");
    r.edit.outcome = { resultText: "Third change.", success: true, cancelled: false, error: null };
    await r.session.ask("three");
    const ids = r.session.state.changeIds;
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(c2?.turnId);

    // Undoing the older turn also undoes the one after it.
    await r.session.undo(0);
    expect(await read(path.join(r.project, "src", "app.ts"))).toContain("v = 1");
    expect(r.session.chat.messages.flatMap((m) => (m.change ? [m.change.fate] : []))).toEqual(["undone", "undone", "undone"]);
    expect(r.session.state.changeIds).toEqual([]);
  });

  it("sending to Figma marks live cards as sent", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    await r.session.ask("one");
    await r.session.send();
    expect(r.session.chat.messages.flatMap((m) => (m.change ? [m.change.fate] : []))).toEqual(["sent"]);
  });

  it("the prompt asks for plain talk and keeps the safety rules", () => {
    expect(PROMPT_PREFACE).toMatch(/designer/u);
    expect(PROMPT_PREFACE).toMatch(/one plain sentence/u);
    expect(PROMPT_PREFACE).toMatch(/src/u);
    expect(PROMPT_PREFACE).toMatch(/lockfiles/u);
  });

  it("the prompt carries the Figma Make project guide", () => {
    for (const rule of [/Vite/u, /Tailwind/u, /src\/main\.tsx/u, /index\.html/u, /vite\.config\.ts/u, /re-export/u, /new-file/u, /dependencies/u, /CLAUDE\.md/u]) {
      expect(PROMPT_PREFACE).toMatch(rule);
    }
  });

  it("each project keeps its own conversation", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    await r.session.ask("in the first project");
    await r.session.openProject("https://www.figma.com/make/XyZ987/Landing-Page");
    expect(r.session.state.activeKey).toBe("XyZ987");
    expect(r.session.chat.messages).toEqual([]);
    await r.session.switchProject("AbC123");
    expect(r.session.chat.messages.map((m) => m.text).filter(Boolean)).toEqual(["in the first project"]);
  });
});

describe("session: files and running things", () => {
  it("lists and reads project files, and marks only what changed since the pull", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    const top = await r.session.listFolder("");
    expect(top.entries.map((e) => e.name)).toContain("src");
    expect(top.entries.map((e) => e.name)).not.toContain(".figmake-sync");
    expect((await r.session.readFile("src/app.ts")).kind).toBe("text");
    expect((await r.session.readFile("../outside.txt")).kind).toBe("missing");
    expect(await r.session.changedPaths()).toEqual([]);
    await r.session.ask("Make the button blue");
    expect(await r.session.changedPaths()).toEqual(["src/app.ts", "src/new.ts"]);
  });

  it("shows the preview as running, and the AI helper only while it works", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    expect(r.session.state.processes).toEqual([expect.objectContaining({ id: "preview", name: "Preview", state: "running", canStop: true, canRestart: true })]);
    let release: () => void = () => undefined;
    r.edit.hold = new Promise<void>((resolve) => (release = resolve));
    const turn = r.session.ask("Hold on");
    await vi.waitFor(() => expect(r.session.state.processes.map((p) => p.id)).toContain("agent"));
    const agent = r.session.state.processes.find((p) => p.id === "agent");
    expect(agent).toMatchObject({ state: "running", canStop: true, canRestart: false });
    expect(r.session.state.processes.find((p) => p.id === "preview")).toMatchObject({ canStop: false, canRestart: false });
    await r.session.stopProcess("agent");
    release();
    await turn;
    expect(r.session.state.processes.map((p) => p.id)).toEqual(["preview"]);
    expect(r.session.state.phase).toBe("ready");
  });

  it("follows the preview server and tracks setup", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.session.handleHarnessEvent({ kind: "dev-status", rootDir: r.project, status: { rootDir: r.project, state: "crashed", url: null, script: "dev", exitCode: 1, logTail: [] } });
    expect(r.session.state.processes[0]).toMatchObject({ state: "failed", canRestart: true, canStop: false });
    r.session.handleHarnessEvent({ kind: "dev-status", rootDir: "/somewhere/else", status: { rootDir: "/somewhere/else", state: "running", url: null, script: null, exitCode: null, logTail: [] } });
    expect(r.session.state.processes[0]).toMatchObject({ state: "failed" });
    r.session.handleHarnessEvent({ kind: "project-ensure", rootDir: r.project, stage: "installing-deps", message: "" });
    expect(r.session.state.processes.map((p) => p.id)).toEqual(["preview", "install"]);
    r.session.handleHarnessEvent({ kind: "project-ensure", rootDir: r.project, stage: "running", message: "" });
    expect(r.session.state.processes.map((p) => p.id)).toEqual(["preview"]);
  });

  it("stops the preview on purpose, stays on the project, and starts it again", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    await r.session.stopProcess("preview");
    expect(r.harness.stopDev).toHaveBeenCalledWith(r.project);
    expect(r.session.state).toMatchObject({ phase: "ready", previewUrl: null });
    expect(r.session.state.processes[0]).toMatchObject({ state: "stopped", canStop: false, canRestart: true });
    r.harness.ensureProjectRunning.mockClear();
    await r.session.restartProcess("preview");
    expect(r.harness.ensureProjectRunning).toHaveBeenCalledTimes(1);
    expect(r.session.state).toMatchObject({ phase: "ready", previewUrl: "http://localhost:5173/" });
    expect(r.deps.reloadPreview).toHaveBeenCalled();
  });

  it("a failed restart says so plainly and Try again restarts again", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.harness.ensureProjectRunning.mockResolvedValueOnce({ ok: false, code: "dev_failed", message: "boom /Users/x" } as never);
    await r.session.restartProcess("preview");
    expect(r.session.state).toMatchObject({ phase: "error", message: "Couldn't start the preview. Try again.", code: "preview_failed" });
    await r.session.retry();
    expect(r.session.state).toMatchObject({ phase: "ready", previewUrl: "http://localhost:5173/" });
  });

  it("never restarts or stops the preview in the middle of another action", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.edit.hold = new Promise<void>(() => undefined);
    const turn = r.session.ask("Hold on");
    await vi.waitFor(() => expect(r.session.state.phase).toBe("working"));
    r.harness.stopDev.mockClear();
    await r.session.stopProcess("preview");
    await r.session.restartProcess("preview");
    expect(r.harness.stopDev).not.toHaveBeenCalled();
    await r.session.cancel();
    await turn;
  });
});

describe("session: clean up", () => {
  it("fix the preview removes only the project's node_modules, then reopens the preview", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    const modules = path.join(r.project, "node_modules");
    await fs.outputFile(path.join(modules, ".figmake-deps-stamp"), "x");
    await fs.outputFile(path.join(modules, "vite", "index.js"), "x");
    const sibling = path.join(r.workspace, "other", "node_modules", "keep.js");
    await fs.outputFile(sibling, "x");
    r.harness.ensureProjectRunning.mockClear();
    await r.session.fixPreview();
    expect(await fs.pathExists(modules)).toBe(false);
    expect(await fs.pathExists(sibling)).toBe(true);
    expect(await fs.pathExists(path.join(r.project, "src", "app.ts"))).toBe(true);
    expect(r.harness.stopDev).toHaveBeenCalledWith(r.project);
    expect(r.harness.ensureProjectRunning).toHaveBeenCalledTimes(1);
    expect(r.session.state).toMatchObject({ phase: "ready", previewUrl: "http://localhost:5173/" });
  });

  it("fix the preview never follows a node_modules link out of the project", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    const outside = path.join(r.workspace, "outside");
    await fs.outputFile(path.join(outside, "keep.js"), "x");
    await fs.symlink(outside, path.join(r.project, "node_modules"));
    await r.session.fixPreview();
    expect(await fs.pathExists(path.join(outside, "keep.js"))).toBe(true);
    expect(await fs.pathExists(path.join(r.project, "node_modules"))).toBe(false);
  });

  it("fix the preview does nothing while busy or with no project, and a failure offers a retry", async () => {
    const r = await rig();
    await r.session.fixPreview();
    expect(r.harness.stopDev).not.toHaveBeenCalled();
    await r.session.openProject(LINK);
    r.harness.ensureProjectRunning.mockResolvedValueOnce({ ok: false } as never);
    await r.session.fixPreview();
    expect(r.session.state).toMatchObject({ phase: "error", message: "Couldn't start the preview. Try again.", code: "preview_failed" });
    await r.session.retry();
    expect(r.session.state.phase).toBe("ready");
  });

  it("start over backs up unsent work, then pulls from Figma and restarts", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    await fs.outputFile(path.join(r.project, "src", "app.ts"), "export const v = 99;\n");
    const real = r.sync.pull.getMockImplementation() as (o: never) => Promise<unknown>;
    const seen: number[] = [];
    r.sync.pull.mockImplementation(async (o: never) => {
      seen.push((await fs.readdir(path.join(r.project, STATE_DIRECTORY_NAME, "backups")).catch(() => [] as string[])).length);
      return real(o);
    });
    await r.session.startOver();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(0); // the backup existed before the pull began
    expect(r.sync.pull).toHaveBeenCalledWith(expect.objectContaining({ strategy: "backup" }));
    expect(await read(path.join(r.project, "src", "app.ts"))).toContain("v = 1");
    const backups = await fs.readdir(path.join(r.project, STATE_DIRECTORY_NAME, "backups"));
    const saved = (await Promise.all(backups.map((b) => read(path.join(r.project, STATE_DIRECTORY_NAME, "backups", b, "workspace", "src", "app.ts")).catch(() => "")))).join("");
    expect(saved).toContain("v = 99");
    expect(r.session.state).toMatchObject({ phase: "ready", canSend: false, previewUrl: "http://localhost:5173/" });
    expect(r.deps.reloadPreview).toHaveBeenCalled();
  });

  it("start over says so plainly when Figma can't be reached, and retry works", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.sync.pull.mockRejectedValueOnce(new Error("net::ERR_FAILED"));
    await r.session.startOver();
    expect(r.session.state).toMatchObject({ phase: "error", message: "Couldn't reach Figma. Try again." });
    await r.session.retry();
    expect(r.session.state.phase).toBe("ready");
  });

  it("reset the app clears accounts and the projects list, keeps files, chats and the updates setting", async () => {
    const r = await rig();
    await r.session.setUpdates(false);
    await r.session.openProject(LINK);
    await r.session.resetApp();
    expect(r.deps.signOutFigma).toHaveBeenCalledTimes(1);
    expect(r.harness.stopDevExcept).toHaveBeenCalledWith(null, true);
    const saved = await r.store.load();
    expect(saved).toMatchObject({ agent: null, agentConnected: false, projects: {}, links: {}, lastLink: null, updates: { enabled: false } });
    expect(saved.workspace ?? r.workspace).toBeTruthy();
    expect(await fs.pathExists(path.join(r.project, "src", "app.ts"))).toBe(true);
    expect(r.session.state).toMatchObject({ phase: "needs-ai-choice", agent: null, agentConnected: false, projects: [], activeKey: null, previewUrl: null });
  });

  it("reset the app is ignored while busy", async () => {
    const r = await rig();
    await r.session.openProject(LINK);
    r.edit.hold = new Promise(() => undefined);
    const turn = r.session.ask("x");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await r.session.resetApp();
    expect(r.deps.signOutFigma).not.toHaveBeenCalled();
    await r.session.cancel();
    await turn;
  });
});

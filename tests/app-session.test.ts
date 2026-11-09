/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method -- mock rig */
import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROMPT_PREFACE, Session, errorCode, parseChange, plainError, type SessionDeps } from "../src/app/session.js";
import { AuthRequiredError } from "../src/browser/session.js";
import { FigmakeSyncService } from "../src/core/service.js";
import { ProjectStateStore } from "../src/core/state.js";
import { DesktopAppStateStore } from "../src/electron/appState.js";
import type { SessionState } from "../src/electron/contracts.js";
import type { RunOutcome } from "../src/harness/index.js";
import { LocalFixtureAdapter } from "./support/localFixtureAdapter.js";

const LINK = "https://www.figma.com/make/AbC123/Checkout-Flow";
const dirs: string[] = [];
afterEach(async () => {
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
  harness: { startRun: ReturnType<typeof vi.fn>; ensureAgentReady: ReturnType<typeof vi.fn>; ensureProjectRunning: ReturnType<typeof vi.fn> };
  sync: { pull: ReturnType<typeof vi.fn>; push: ReturnType<typeof vi.fn>; auth: ReturnType<typeof vi.fn> };
  edit: { fn: (root: string) => Promise<void>; outcome: Partial<RunOutcome>; hold?: Promise<void> };
  store: DesktopAppStateStore;
}

async function rig(opts: { agent?: "claude" | "codex" | null; saved?: boolean } = {}): Promise<Rig> {
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
  if (opts.agent !== null) await store.update({ agent: opts.agent ?? "claude" });

  const edit: Rig["edit"] = {
    fn: async (root) => {
      await fs.outputFile(path.join(root, "src", "app.ts"), "export const v = 2;\n");
      await fs.outputFile(path.join(root, "src", "new.ts"), "export {};\n");
    },
    outcome: { resultText: "Made the button blue.", success: true, cancelled: false, error: null },
  };
  const harness = {
    ensureProjectRunning: vi.fn(async () => ({ ok: true as const, url: "http://localhost:5173/" })),
    ensureAgentReady: vi.fn(async () => ({ ok: true as const, agent: {} as never })),
    pendingLoginUrl: vi.fn(() => null),
    updateSettings: vi.fn(async () => ({})),
    stopDevExcept: vi.fn(async () => undefined),
    startRun: vi.fn(async (input: { rootDir: string; prompt: string }, signal?: AbortSignal) => {
      const projectStore = new ProjectStateStore(input.rootDir);
      const config = await projectStore.loadProjectConfig();
      const backupDir = await projectStore.createBackup("pre-agent", config.sync.ignore);
      const done = (async (): Promise<RunOutcome> => {
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
    await r.session.openProject(LINK);
    expect(r.session.state).toMatchObject({ phase: "needs-ai-choice", previewUrl: "http://localhost:5173/" });
    await r.session.setAgent("codex");
    expect(r.harness.ensureAgentReady).toHaveBeenCalledWith("codex", expect.anything());
    expect(r.session.state).toMatchObject({ phase: "ready", agent: "codex" });
    expect((await r.store.load()).agent).toBe("codex");
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

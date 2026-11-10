/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method -- mock rig */
import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatStore } from "../src/app/chatStore.js";
import { Session, type SessionDeps } from "../src/app/session.js";
import { FigmakeSyncService } from "../src/core/service.js";
import { DesktopAppStateStore } from "../src/electron/appState.js";
import { LocalFixtureAdapter } from "./support/localFixtureAdapter.js";

const LINK = "https://www.figma.com/make/AbC123/Checkout-Flow";
const dirs: string[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.flush()));
  await Promise.all(dirs.splice(0).map((d) => fs.remove(d)));
});

const FIVE = "one\ntwo\nthree\nfour\nfive\n";
const read = (p: string): Promise<string> => fs.readFile(p, "utf8");

async function rig(): Promise<{ session: Session; remote: string; project: string; sync: { pull: ReturnType<typeof vi.fn> }; deps: SessionDeps }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-session-")));
  dirs.push(base);
  const remote = path.join(base, "remote");
  await fs.outputFile(path.join(remote, "src", "app.ts"), FIVE);
  await fs.outputFile(path.join(remote, "src", "clash.ts"), FIVE);
  await fs.outputFile(path.join(remote, "src", "other.ts"), "o1\n");
  await fs.outputJson(path.join(remote, "package.json"), { name: "p", scripts: { dev: "vite" } });
  const service = new FigmakeSyncService({ adapterFactory: ({ logger }) => new LocalFixtureAdapter(remote, logger) });
  const sync = {
    init: service.init.bind(service),
    status: service.status.bind(service),
    push: service.push.bind(service),
    pull: vi.fn((o: Parameters<typeof service.pull>[0]) => service.pull(o)),
    auth: vi.fn(async () => undefined),
  };
  const store = new DesktopAppStateStore(path.join(base, "app-state.json"));
  await store.update({ agent: "claude", agentConnected: true });
  const harness = {
    ensureProjectRunning: vi.fn(async () => ({ ok: true as const, url: "http://localhost:5173/" })),
    ensureAgentReady: vi.fn(async () => ({ ok: true as const, agent: {} as never })),
    pendingLoginUrl: vi.fn(() => null),
    updateSettings: vi.fn(async () => ({})),
    stopDevExcept: vi.fn(async () => undefined),
    stopDev: vi.fn(async () => ({})),
    startRun: vi.fn(),
  };
  const deps: SessionDeps = {
    sync: sync as unknown as SessionDeps["sync"],
    harness: harness as unknown as SessionDeps["harness"],
    appState: store,
    chatStore: new ChatStore(path.join(base, "chats")),
    documentsDir: path.join(base, "Documents"),
    guard: { home: path.join(base, "home"), forbidden: [] },
    chooseFolder: vi.fn(async () => null),
    openExternal: vi.fn(),
    reloadPreview: vi.fn(),
    signOutFigma: vi.fn(async () => undefined),
    trashFolder: vi.fn(async (dir: string) => { await fs.remove(dir); }),
    withBrowser: (run) => run(),
    waitForFigmaSignin: vi.fn(async () => undefined),
    log: vi.fn(),
  };
  const session = new Session(deps);
  sessions.push(session);
  await session.start();
  await session.openProject(LINK);
  return { session, remote, project: path.join(base, "Documents", "figmake-sync", "checkout-flow"), sync, deps };
}

describe("session: sync with Figma", () => {
  it("merge: combines both sides, advances the baseline, and Send only carries the local side", async () => {
    const r = await rig();
    await fs.outputFile(path.join(r.project, "src", "app.ts"), FIVE.replace("one", "ONE"));
    await fs.outputFile(path.join(r.remote, "src", "app.ts"), FIVE.replace("five", "FIVE"));
    await fs.outputFile(path.join(r.remote, "src", "other.ts"), "o2\n");
    await fs.outputFile(path.join(r.remote, "src", "fresh.ts"), "fresh\n");
    await r.session.syncWithFigma("merge");
    expect(r.session.state).toMatchObject({ phase: "ready", canSend: true, message: "Merged with Figma" });
    expect(r.sync.pull).toHaveBeenCalledWith(expect.objectContaining({ strategy: "merge" }));
    expect(await read(path.join(r.project, "src", "app.ts"))).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
    expect(await read(path.join(r.project, "src", "other.ts"))).toBe("o2\n");
    expect(await fs.readdir(path.join(r.project, ".figmake-sync", "backups"))).toHaveLength(1);
    expect(await r.session.changedPaths()).toEqual(["src/app.ts"]);
    expect(r.deps.reloadPreview).toHaveBeenCalled();
  });

  it("merge with a true conflict keeps the local file, then per-file choices are applied", async () => {
    const r = await rig();
    await fs.outputFile(path.join(r.project, "src", "clash.ts"), FIVE.replace("three", "mine"));
    await fs.outputFile(path.join(r.project, "src", "app.ts"), FIVE.replace("three", "mine"));
    await fs.outputFile(path.join(r.remote, "src", "clash.ts"), FIVE.replace("three", "figma"));
    await fs.outputFile(path.join(r.remote, "src", "app.ts"), FIVE.replace("three", "figma"));
    await r.session.syncWithFigma("merge");
    expect(r.session.state).toMatchObject({ phase: "resolving", mergeConflicts: ["src/app.ts", "src/clash.ts"] });
    expect(r.session.isBusy()).toBe(true);
    expect(await read(path.join(r.project, "src", "clash.ts"))).toContain("mine");
    expect(await r.session.mergeDiff("src/clash.ts")).toEqual({ kind: "text", before: FIVE.replace("three", "figma"), after: FIVE.replace("three", "mine") });
    expect(await r.session.mergeDiff("src/other.ts")).toEqual({ kind: "missing" });

    await r.session.resolveMerge([
      { path: "src/clash.ts", choice: "figma" },
      { path: "src/app.ts", choice: "mine" },
      { path: "src/other.ts", choice: "figma" },
    ]);
    expect(r.session.state.phase).toBe("ready");
    expect(r.session.state.mergeConflicts).toBeUndefined();
    expect(await read(path.join(r.project, "src", "clash.ts"))).toBe(FIVE.replace("three", "figma"));
    expect(await read(path.join(r.project, "src", "app.ts"))).toBe(FIVE.replace("three", "mine"));
    expect(await r.session.changedPaths()).toEqual(["src/app.ts"]);
  });

  it("closing the conflict list keeps every local version", async () => {
    const r = await rig();
    await fs.outputFile(path.join(r.project, "src", "clash.ts"), "local\n");
    await fs.outputFile(path.join(r.remote, "src", "clash.ts"), "figma\n");
    await r.session.syncWithFigma("merge");
    await r.session.cancel();
    expect(r.session.state.phase).toBe("ready");
    expect(await read(path.join(r.project, "src", "clash.ts"))).toBe("local\n");
  });

  it("replace discards local work and keeps a backup", async () => {
    const r = await rig();
    await fs.outputFile(path.join(r.project, "src", "app.ts"), "mine\n");
    await fs.outputFile(path.join(r.project, "src", "extra.ts"), "mine\n");
    expect(await r.session.localChangeCount()).toBe(2);
    await r.session.syncWithFigma("replace");
    expect(r.session.state).toMatchObject({ phase: "ready", canSend: false });
    expect(await read(path.join(r.project, "src", "app.ts"))).toBe(FIVE);
    expect(await fs.pathExists(path.join(r.project, "src", "extra.ts"))).toBe(false);
    const backups = await fs.readdir(path.join(r.project, ".figmake-sync", "backups"));
    const kept = backups.find((n) => n.endsWith("pre-start-over")) as string;
    expect(await read(path.join(r.project, ".figmake-sync", "backups", kept, "workspace", "src", "app.ts"))).toBe("mine\n");
  });

  it("a failed merge says so plainly and nothing is lost", async () => {
    const r = await rig();
    await fs.outputFile(path.join(r.project, "src", "app.ts"), "mine\n");
    r.sync.pull.mockRejectedValueOnce(new Error("net::ERR_FAILED"));
    await r.session.syncWithFigma("merge");
    expect(r.session.state).toMatchObject({ phase: "error", message: "Couldn't reach Figma. Try again." });
    expect(await read(path.join(r.project, "src", "app.ts"))).toBe("mine\n");
    await r.session.retry();
    expect(r.session.state.phase).toBe("ready");
  });

  it("is ignored while not ready", async () => {
    const r = await rig();
    await r.session.cancel();
    const idle = new Session(r.deps);
    sessions.push(idle);
    await idle.syncWithFigma("merge");
    expect(idle.state.phase).not.toBe("syncing");
  });
});

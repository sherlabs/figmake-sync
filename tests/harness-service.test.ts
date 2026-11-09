import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { FigmakeSyncService } from "../src/core/service.js";
import { HarnessService, type HarnessEvent } from "../src/harness/index.js";
import { createFakeKillTree, createFakeSpawn, type SpawnCall } from "./support/fakeChild.js";
import { LocalFixtureAdapter } from "./support/localFixtureAdapter.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.remove(d)));
});

async function setup(): Promise<{ project: string; remote: string; sync: FigmakeSyncService }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "harness-svc-"));
  dirs.push(base);
  const project = path.join(base, "project");
  const remote = path.join(base, "remote");
  await fs.ensureDir(project);
  await fs.outputFile(path.join(remote, "src", "app.ts"), "export const v = 1;\n");
  await fs.outputJson(path.join(remote, "package.json"), { name: "p", scripts: { dev: "vite" } });
  const sync = new FigmakeSyncService({
    adapterFactory: ({ logger }) => new LocalFixtureAdapter(remote, logger),
  });
  await sync.init("https://www.figma.com/make/test-project", project, { cwd: project, yes: true });
  await sync.pull({ cwd: project, yes: true });
  return { project, remote, sync };
}

/** Fake agent: on spawn, edits a project file (like the real agent would), then emits a result. */
function agentSpawn(_project: string, edit: () => Promise<void>) {
  return createFakeSpawn(({ child }: SpawnCall) => {
    void edit().then(() => {
      child.out('{"type":"system","subtype":"init","session_id":"sess-90001"}\n');
      child.out('{"type":"result","subtype":"success","is_error":false,"result":"edited","session_id":"sess-90001"}\n');
      child.exit(0);
    });
  });
}

function make(sync: FigmakeSyncService, spawn: ReturnType<typeof createFakeSpawn>["spawn"], events: HarnessEvent[]) {
  return new HarnessService({
    sync,
    spawn,
    emit: (e) => events.push(e),
    env: { PATH: "/usr/bin" },
    resolveBin: (name) => Promise.resolve(`/fake/bin/${name}`),
  });
}

describe("HarnessService run flow", () => {
  it("backs up before the agent runs, reports changes, persists session, does not push by default", async () => {
    const { project, sync } = await setup();
    const file = path.join(project, "src", "app.ts");
    let backupHadOriginal = false;
    const { spawn } = agentSpawn(project, async () => {
      const backups = await fs.readdir(path.join(project, ".figmake-sync", "backups"));
      const b = backups.find((n) => n.endsWith("pre-agent"));
      backupHadOriginal =
        !!b && (await fs.readFile(path.join(project, ".figmake-sync", "backups", b, "workspace", "src", "app.ts"), "utf8")) === "export const v = 1;\n";
      await fs.outputFile(file, "export const v = 2;\n");
    });
    const events: HarnessEvent[] = [];
    const harness = make(sync, spawn, events);

    const { done } = await harness.startRun({ rootDir: project, prompt: "bump v" });
    const outcome = await done;

    expect(backupHadOriginal).toBe(true);
    expect(outcome.success).toBe(true);
    expect(outcome.backupDir).toContain("pre-agent");
    expect(outcome.changes).toMatchObject({ modified: ["src/app.ts"], total: 1 });
    expect(outcome.push).toEqual({ status: "skipped", reason: "Auto-push is off." });
    expect((await harness.getSettings(project)).lastSession).toEqual({ agent: "claude", id: "sess-90001" });
    expect(events.filter((e) => e.kind === "run-phase").map((e) => (e as { phase: string }).phase)).toEqual([
      "backup", "agent", "diff",
    ]);
    expect(events.at(-1)?.kind).toBe("run-done");
    expect(harness.isRunning(project)).toBe(false);
  });

  it("resumes the stored session on the follow-up turn, but not with newSession", async () => {
    const { project, sync } = await setup();
    const { spawn, calls } = agentSpawn(project, () => Promise.resolve());
    const harness = make(sync, spawn, []);
    await (await harness.startRun({ rootDir: project, prompt: "one" })).done;
    await (await harness.startRun({ rootDir: project, prompt: "two" })).done;
    await (await harness.startRun({ rootDir: project, prompt: "three", newSession: true })).done;
    expect(calls[0]!.args).not.toContain("--resume");
    expect(calls[1]!.args.slice(-2)).toEqual(["--resume", "sess-90001"]);
    expect(calls[2]!.args).not.toContain("--resume");
  });

  it("auto-push on: pushes successful runs to the remote", async () => {
    const { project, remote, sync } = await setup();
    const { spawn } = agentSpawn(project, () => fs.outputFile(path.join(project, "src", "app.ts"), "export const v = 3;\n"));
    const harness = make(sync, spawn, []);
    await harness.updateSettings(project, { autoPush: true });
    const outcome = await (await harness.startRun({ rootDir: project, prompt: "go" })).done;
    expect(outcome.push.status).toBe("pushed");
    expect(await fs.readFile(path.join(remote, "src", "app.ts"), "utf8")).toBe("export const v = 3;\n");
  });

  it("auto-push aborts without overwriting when the remote diverged", async () => {
    const { project, remote, sync } = await setup();
    const { spawn } = agentSpawn(project, () => fs.outputFile(path.join(project, "src", "app.ts"), "export const v = 3;\n"));
    const harness = make(sync, spawn, []);
    await harness.updateSettings(project, { autoPush: true });
    await fs.outputFile(path.join(remote, "src", "app.ts"), "export const v = 'remote edit';\n");
    const outcome = await (await harness.startRun({ rootDir: project, prompt: "go" })).done;
    expect(outcome.success).toBe(true);
    expect(outcome.push.status).toBe("aborted");
    expect(await fs.readFile(path.join(remote, "src", "app.ts"), "utf8")).toBe("export const v = 'remote edit';\n");
    // Local work is kept, still shows as a pending change for a manual decision.
    expect(outcome.changes?.total).toBe(1);
  });

  it("auto-push fails closed when the remote check cannot run", async () => {
    const { project, remote } = await setup();
    let failDownload = false;
    const sync = new FigmakeSyncService({
      adapterFactory: ({ logger }) => {
        const adapter = new LocalFixtureAdapter(remote, logger);
        const openProject = adapter.openProject.bind(adapter);
        adapter.openProject = async (...args: Parameters<typeof openProject>) => {
          const session = await openProject(...args);
          const download = session.downloadLatestCodeZip.bind(session);
          session.downloadLatestCodeZip = (dir: string) =>
            failDownload ? Promise.reject(new Error("offline")) : download(dir);
          return session;
        };
        return adapter;
      },
    });
    const { spawn } = agentSpawn(project, () => fs.outputFile(path.join(project, "src", "app.ts"), "export const v = 4;\n"));
    const harness = make(sync, spawn, []);
    await harness.updateSettings(project, { autoPush: true });
    failDownload = true;
    const outcome = await (await harness.startRun({ rootDir: project, prompt: "go" })).done;
    expect(outcome.push.status).toBe("failed");
    expect(await fs.readFile(path.join(remote, "src", "app.ts"), "utf8")).toBe("export const v = 1;\n");
  });

  it("concurrent startRun for one project: only one is accepted", async () => {
    const { project, sync } = await setup();
    const { spawn, calls } = createFakeSpawn();
    const harness = new HarnessService({
      sync, spawn, emit: () => undefined, env: { PATH: "/usr/bin" },
      resolveBin: () => Promise.resolve("/fake/claude"),
    });
    const results = await Promise.allSettled([
      harness.startRun({ rootDir: project, prompt: "a" }),
      harness.startRun({ rootDir: project, prompt: "b" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    await waitUntil(() => calls.length === 1);
    harness.cancelRun(project);
  });

  it("does not auto-push when the agent run fails", async () => {
    const { project, sync } = await setup();
    const { spawn } = createFakeSpawn(({ child }) => {
      queueMicrotask(() => {
        child.out('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"bad"}\n');
        child.exit(1);
      });
    });
    const harness = make(sync, spawn, []);
    await harness.updateSettings(project, { autoPush: true });
    const outcome = await (await harness.startRun({ rootDir: project, prompt: "go" })).done;
    expect(outcome.success).toBe(false);
    expect(outcome.push).toMatchObject({ status: "skipped" });
  });

  it("cancel kills the agent tree; single run per project", async () => {
    const { project, sync } = await setup();
    const { spawn, calls } = createFakeSpawn();
    const { killTree, kills } = createFakeKillTree();
    const harness = new HarnessService({
      sync, spawn, killTree, emit: () => undefined, env: { PATH: "/usr/bin" },
      resolveBin: () => Promise.resolve("/fake/claude"),
    });
    const { done } = await harness.startRun({ rootDir: project, prompt: "long" });
    await expect(harness.startRun({ rootDir: project, prompt: "again" })).rejects.toMatchObject({ code: "run_in_progress" });
    await waitUntil(() => calls.length === 1);
    expect(harness.cancelRun(project)).toBe(true);
    const outcome = await done;
    expect(kills[0]?.signal).toBe("SIGTERM");
    expect(outcome).toMatchObject({ cancelled: true, success: false });
    expect(outcome.push.status).toBe("skipped");
  });

  it("refuses to start when the agent binary is missing", async () => {
    const { project, sync } = await setup();
    const harness = new HarnessService({ sync, emit: () => undefined, resolveBin: () => Promise.resolve(null) });
    await expect(harness.startRun({ rootDir: project, prompt: "x" })).rejects.toMatchObject({ code: "agent_unavailable" });
  });
});

async function waitUntil(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
}

describe("HarnessService settings, setup, dev, detect", () => {
  it("settings default to auto-push OFF and persist atomically in config.json", async () => {
    const { project, sync } = await setup();
    const harness = make(sync, createFakeSpawn().spawn, []);
    expect(await harness.getSettings(project)).toEqual({ preferredAgent: "claude", autoPush: false, lastSession: null });
    await harness.updateSettings(project, { preferredAgent: "codex", autoPush: true });
    const raw = (await fs.readJson(path.join(project, ".figmake-sync", "config.json"))) as { harness: unknown };
    expect(raw.harness).toEqual({ preferredAgent: "codex", autoPush: true, lastSession: null });
    const leftovers = (await fs.readdir(path.join(project, ".figmake-sync"))).filter((n) => n.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("setup installs when node_modules is missing, skips when fingerprint matches, reinstalls when package.json changes", async () => {
    const { project, sync } = await setup();
    let installs = 0;
    const logs: string[] = [];
    const harness = new HarnessService({
      sync,
      emit: (e) => e.kind === "setup-log" && logs.push(e.line),
      installDeps: async (cwd, _s, onLog) => {
        installs++;
        onLog("added 1 package");
        await fs.ensureDir(path.join(cwd, "node_modules"));
      },
    });
    expect((await harness.setup(project)).installed).toBe(true);
    expect((await harness.setup(project)).skipped).toBe(true);
    await fs.outputJson(path.join(project, "package.json"), { name: "p", scripts: { dev: "vite" }, dependencies: { a: "1" } });
    expect((await harness.setup(project)).installed).toBe(true);
    expect(installs).toBe(2);
    expect(logs).toContain("added 1 package");
  });

  it("dev servers: switching project stops the previous one; shutdown stops all", async () => {
    const a = await setup();
    const b = await setup();
    const { spawn, calls } = createFakeSpawn();
    const { killTree, kills } = createFakeKillTree();
    const harness = new HarnessService({ sync: a.sync, spawn, killTree, emit: () => undefined, env: { PATH: "/usr/bin" } });
    await harness.startDev(a.project);
    calls[0]!.child.out("Local: http://localhost:5173/\n");
    expect(harness.devStatus(a.project).state).toBe("running");
    await harness.startDev(b.project);
    expect(kills).toHaveLength(1);
    expect(harness.devStatus(a.project).state).toBe("stopped");
    await harness.shutdown();
    // shutdown sends SIGTERM then SIGKILL immediately (no grace on quit)
    expect(kills.map((k) => k.signal)).toEqual(expect.arrayContaining(["SIGTERM", "SIGKILL"]));
    expect(harness.devStatus(b.project).state).toBe("stopped");
  });

  it("detects agents: missing, not signed in, usable", async () => {
    const { spawn } = createFakeSpawn(({ command, args, child }) => {
      queueMicrotask(() => {
        if (args[0] === "--version") child.out("2.1.319 (Claude Code)\n");
        else if (command.endsWith("claude")) child.out('{"loggedIn":false}');
        child.exit(command.endsWith("claude") && args[0] === "auth" ? 1 : 0);
      });
    });
    const { sync } = await setup();
    const make2 = (bins: Record<string, string | null>) =>
      new HarnessService({ sync, spawn, emit: () => undefined, resolveBin: (n) => Promise.resolve(bins[n] ?? null) });
    const list = await make2({ claude: "/x/claude", codex: null }).detectAgents();
    expect(list.find((a) => a.id === "codex")).toMatchObject({ installed: false, usable: false });
    expect(list.find((a) => a.id === "codex")?.hint).toMatch(/Install/);
    expect(list.find((a) => a.id === "claude")).toMatchObject({ installed: true, version: "2.1.319", signedIn: false, usable: false });
    expect(list.find((a) => a.id === "claude")?.hint).toMatch(/Not signed in/);
  });
});

/* eslint-disable @typescript-eslint/require-await -- async fakes satisfy Promise-returning ports */
import { describe, expect, it } from "vitest";

import { ensureAgentReady, ensureProjectRunning, type AgentEnsurePort, type ProjectEnsurePort } from "../src/harness/ensure.js";
import type { AgentInfo, DevStatus, HarnessEvent } from "../src/harness/index.js";

const info = (o: Partial<AgentInfo> = {}): AgentInfo => ({
  id: "claude", displayName: "Claude Code", installed: true, version: "1.0.0", signedIn: true, usable: true, hint: null, ...o,
});

function agentPort(seq: AgentInfo[], over: Partial<AgentEnsurePort> = {}) {
  const calls: string[] = [];
  const events: HarnessEvent[] = [];
  let i = 0;
  const port: AgentEnsurePort = {
    emit: (e) => events.push(e),
    detectAgent: async () => seq[Math.min(i++, seq.length - 1)]!,
    hasNpm: async () => true,
    ensureNode: async () => { calls.push("node"); return { ok: true }; },
    installAgentCli: async () => { calls.push("install"); return { ok: true, version: "1", binPath: "/b" }; },
    loginAgent: async () => { calls.push("login"); return { ok: true }; },
    ...over,
  };
  const stages = (): string[] => events.flatMap((e) => (e.kind === "agent-ensure" ? [e.stage] : []));
  return { port, calls, stages };
}

describe("ensureAgentReady", () => {
  it("is a no-op when ready", async () => {
    const t = agentPort([info()]);
    expect((await ensureAgentReady(t.port, "claude")).ok).toBe(true);
    expect(t.calls).toEqual([]);
    expect(t.stages()).toEqual(["checking", "ready"]);
  });
  it("installs then signs in, in order", async () => {
    const t = agentPort([info({ installed: false, signedIn: null, usable: false }), info({ signedIn: false, usable: false }), info()]);
    const r = await ensureAgentReady(t.port, "claude");
    expect(r.ok).toBe(true);
    expect(t.calls).toEqual(["install", "login"]);
    expect(t.stages()).toEqual(["checking", "installing", "needs-browser-signin", "ready"]);
  });
  it("sets up Node first when npm is missing", async () => {
    const t = agentPort([info({ installed: false, usable: false }), info()], { hasNpm: async () => false });
    await ensureAgentReady(t.port, "claude");
    expect(t.calls).toEqual(["node", "install"]);
    expect(t.stages()).toContain("installing-node");
  });
  it("stops with a clear failure when install fails, node fails, or sign-in is incomplete", async () => {
    const a = agentPort([info({ installed: false, usable: false })], { installAgentCli: async () => ({ ok: false, code: "failed", message: "boom" }) });
    expect(await ensureAgentReady(a.port, "claude")).toMatchObject({ ok: false, code: "install_failed", message: "boom" });
    const b = agentPort([info({ installed: false, usable: false })], { hasNpm: async () => false, ensureNode: async () => ({ ok: false, message: "offline" }) });
    expect(await ensureAgentReady(b.port, "claude")).toMatchObject({ ok: false, code: "node_failed" });
    const c = agentPort([info({ signedIn: false, usable: false })]);
    expect(await ensureAgentReady(c.port, "claude")).toMatchObject({ ok: false, code: "signin_failed" });
    expect(c.stages().at(-1)).toBe("failed");
  });
  it("maps cancelled results and never throws", async () => {
    const t = agentPort([info({ signedIn: false, usable: false })], { loginAgent: async () => ({ ok: false, code: "cancelled", message: "x" }) });
    expect(await ensureAgentReady(t.port, "claude")).toMatchObject({ ok: false, code: "cancelled" });
    const e = agentPort([], { detectAgent: async () => { throw new Error("kaput"); } });
    expect(await ensureAgentReady(e.port, "claude")).toMatchObject({ ok: false });
  });
  it("treats unknown sign-in as ready", async () => {
    const t = agentPort([info({ signedIn: null })]);
    expect((await ensureAgentReady(t.port, "claude")).ok).toBe(true);
    expect(t.calls).toEqual([]);
  });
});

const dev = (o: Partial<DevStatus> = {}): DevStatus => ({ rootDir: "/p", state: "starting", url: null, script: "dev", exitCode: null, logTail: [], ...o });

describe("ensureProjectRunning", () => {
  function projPort(statuses: DevStatus[], over: Partial<ProjectEnsurePort> = {}) {
    const calls: string[] = [];
    const events: HarnessEvent[] = [];
    let i = 0;
    const port: ProjectEnsurePort = {
      emit: (e) => events.push(e),
      hasNpm: async () => true,
      ensureNode: async () => { calls.push("node"); return { ok: true }; },
      setup: async () => { calls.push("setup"); return { installed: true, skipped: false, reason: "" }; },
      startDev: async () => { calls.push("start"); return dev(); },
      devStatus: () => statuses[Math.min(i++, statuses.length - 1)]!,
      ...over,
    };
    return { port, calls, events };
  }
  it("node -> deps -> dev -> url", async () => {
    const t = projPort([dev(), dev({ state: "running", url: "http://localhost:5173/" })], { hasNpm: async () => false });
    const r = await ensureProjectRunning(t.port, "/p", undefined, { pollMs: 1 });
    expect(r).toEqual({ ok: true, url: "http://localhost:5173/" });
    expect(t.calls).toEqual(["node", "setup", "start"]);
    const last = t.events.at(-1);
    expect(last).toMatchObject({ kind: "project-ensure", stage: "running", url: "http://localhost:5173/" });
  });
  it("reports failures per step", async () => {
    expect(await ensureProjectRunning(projPort([dev()], { hasNpm: async () => false, ensureNode: async () => ({ ok: false }) }).port, "/p")).toMatchObject({ code: "node_failed" });
    expect(await ensureProjectRunning(projPort([dev()], { setup: async () => { throw new Error("npm broke"); } }).port, "/p")).toMatchObject({ code: "deps_failed", message: "npm broke" });
    expect(await ensureProjectRunning(projPort([dev()], { startDev: async () => { throw new Error("No dev script"); } }).port, "/p")).toMatchObject({ code: "no_dev_script" });
    expect(await ensureProjectRunning(projPort([dev({ state: "crashed", logTail: ["Error: x"] })]).port, "/p", undefined, { pollMs: 1 })).toMatchObject({ code: "dev_failed" });
    expect(await ensureProjectRunning(projPort([dev()]).port, "/p", undefined, { pollMs: 1, urlTimeoutMs: 20 })).toMatchObject({ code: "dev_failed" });
  });
  it("honours cancellation", async () => {
    const ctl = new AbortController();
    const t = projPort([dev()], { setup: async () => { ctl.abort(); return { installed: false, skipped: true, reason: "" }; } });
    expect(await ensureProjectRunning(t.port, "/p", ctl.signal)).toMatchObject({ code: "cancelled" });
  });
});

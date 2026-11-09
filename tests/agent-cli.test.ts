/* eslint-disable @typescript-eslint/require-await -- async fakes satisfy Promise-returning deps */
import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { AgentCliManager, buildInstallArgs, extractUrls, isAllowedLoginUrl, redactUrls, stripUrlQuery } from "../src/harness/agentCli.js";
import { createClaudeAdapter } from "../src/harness/agents/claude.js";
import { createCodexAdapter } from "../src/harness/agents/codex.js";
import type { HarnessEvent } from "../src/harness/index.js";
import { buildEnv } from "../src/harness/process.js";
import { agentBinDirFor, setManagedRuntimeRoot } from "../src/runtime/managed.js";
import { createFakeKillTree, createFakeSpawn } from "./support/fakeChild.js";

const dirs: string[] = [];
afterEach(async () => {
  setManagedRuntimeRoot(null);
  await Promise.all(dirs.splice(0).map((d) => fs.remove(d)));
});
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cli-"));
  dirs.push(d);
  return d;
}

describe("install argv", () => {
  it("uses --prefix, never -g, with the package last", () => {
    const args = buildInstallArgs("/p/tools-agents", "@openai/codex");
    expect(args.slice(0, 3)).toEqual(["install", "--prefix", "/p/tools-agents"]);
    expect(args).not.toContain("-g");
    expect(args).not.toContain("--global");
    expect(args.at(-1)).toBe("@openai/codex");
  });
});

describe("login URL allowlist", () => {
  it.each([
    "https://claude.ai/oauth/authorize?code=1",
    "https://console.anthropic.com/login",
    "https://claude.com/cai/oauth",
    "https://auth.openai.com/oauth/authorize?x=1",
    "https://chatgpt.com/auth",
    "https://login.chatgpt.com/x",
    "http://localhost:1455/auth/callback",
    "http://127.0.0.1:3000/x",
    "https://localhost/x",
  ])("accepts %s", (u) => expect(isAllowedLoginUrl(u)).toBe(true));
  it.each([
    "https://claude.ai.evil.com/x",
    "https://evilclaude.ai/x",
    "https://claude.ai@evil.com/x",
    "https://user:pw@claude.ai/x",
    "http://claude.ai/x",
    "http://openai.com/x",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://claude.ai:8443/x",
    "https://notopenai.com/x",
    "not a url",
  ])("rejects %s", (u) => expect(isAllowedLoginUrl(u)).toBe(false));
});

describe("URL redaction", () => {
  it("strips query and fragment from displayed and logged text", () => {
    const line = "Visit https://claude.ai/oauth/authorize?state=SECRET&code_challenge=abc#frag to sign in";
    const out = redactUrls(line);
    expect(out).not.toMatch(/SECRET|code_challenge|frag/);
    expect(out).toContain("https://claude.ai/oauth/authorize");
    expect(stripUrlQuery("https://a.com/p?q=1")).toBe("https://a.com/p");
    expect(extractUrls(line)).toHaveLength(1);
  });
});

describe("private bin lookup order", () => {
  it("appends the agent bin dir after system PATH and managed Node, without mutating the base env", async () => {
    const root = await tmp();
    const bin = agentBinDirFor(root);
    await fs.ensureDir(bin);
    setManagedRuntimeRoot(root);
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" + path.delimiter + "/bin" };
    const env = buildEnv(base);
    const parts = (env["PATH"] ?? "").split(path.delimiter);
    expect(parts.indexOf(bin)).toBeGreaterThan(parts.indexOf("/usr/bin"));
    expect(parts.indexOf(bin)).toBeGreaterThan(parts.indexOf("/usr/local/bin"));
    expect(parts.at(-1)).toBe(bin);
    expect(base["PATH"]).toBe("/usr/bin" + path.delimiter + "/bin");
  });
  it("omits it when the dir does not exist", async () => {
    setManagedRuntimeRoot(await tmp());
    expect(buildEnv({ PATH: "/usr/bin" })["PATH"]).not.toContain("tools-agents");
  });
});

function mgr(root: string, over: Partial<ConstructorParameters<typeof AgentCliManager>[0]> = {}) {
  const events: HarnessEvent[] = [];
  const adapters = new Map([createClaudeAdapter(), createCodexAdapter()].map((a) => [a.id, a] as const));
  return { events, adapters, make: (spawn: ReturnType<typeof createFakeSpawn>["spawn"], killTree = createFakeKillTree().killTree) =>
    new AgentCliManager({ emit: (e) => events.push(e), runtimeRoot: () => root, adapters: () => adapters, spawn, killTree, env: { PATH: "/usr/bin" }, resolveNpm: async () => "/usr/bin/npm", resolveBin: async (n) => `/x/${n}`, killGraceMs: 10, ...over }) };
}

describe("AgentCliManager.install", () => {
  it("spawns npm with --prefix into tools-agents (no shell, no -g) and streams logs", async () => {
    const root = await tmp();
    const { spawn, calls } = createFakeSpawn(({ child }) => {
      void fs.outputJson(path.join(root, "tools-agents", "node_modules", "@openai", "codex", "package.json"), { version: "9.9.9" }).then(() => {
        child.out("added 1 package\n");
        child.exit(0);
      });
    });
    const m = mgr(root);
    const res = await m.make(spawn).install("codex");
    expect(res).toMatchObject({ ok: true, version: "9.9.9" });
    const call = calls[0]!;
    expect(call.command).toBe("/usr/bin/npm");
    expect(call.args).toEqual(buildInstallArgs(path.join(root, "tools-agents"), "@openai/codex"));
    expect(call.options.shell).toBe(false);
    expect(m.events.some((e) => e.kind === "agent-install-log" && e.line === "added 1 package")).toBe(true);
  });
  it("reports no_npm when npm is missing and failure on non-zero exit", async () => {
    const root = await tmp();
    const m = mgr(root, { resolveNpm: async () => null });
    expect(await m.make(createFakeSpawn().spawn).install("claude")).toMatchObject({ ok: false, code: "no_npm" });
    const { spawn } = createFakeSpawn(({ child }) => queueMicrotask(() => child.exit(1)));
    expect(await mgr(root).make(spawn).install("claude")).toMatchObject({ ok: false, code: "failed" });
  });
  it("cancel kills the process tree and resolves cancelled", async () => {
    const root = await tmp();
    const { spawn } = createFakeSpawn();
    const { killTree, kills } = createFakeKillTree();
    const ctl = new AbortController();
    const p = mgr(root).make(spawn, killTree).install("codex", ctl.signal);
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    expect(await p).toMatchObject({ ok: false, code: "cancelled" });
    expect(kills[0]?.signal).toBe("SIGTERM");
  });
});

describe("AgentCliManager.login", () => {
  it("spawns the login command with array args, stdin ignored, no shell; keeps the full URL in memory only", async () => {
    const root = await tmp();
    let seen: string | null = null;
    const { spawn, calls } = createFakeSpawn(({ child }) => {
      setTimeout(() => {
        child.out("Opening browser...\nIf it did not open, visit: https://claude.ai/oauth/authorize?state=SECRET123&x=1\n");
        setTimeout(() => child.exit(0), 20);
      }, 5);
    });
    const m = mgr(root);
    const mm = m.make(spawn);
    const timer = setInterval(() => { seen ??= mm.pendingLoginUrl("claude"); }, 2);
    const res = await mm.login("claude");
    clearInterval(timer);
    expect(res).toEqual({ ok: true });
    expect(calls[0]!.command).toBe("/x/claude");
    expect(calls[0]!.args).toEqual(["auth", "login"]);
    expect(calls[0]!.options.shell).toBe(false);
    expect((calls[0]!.options as { stdio?: unknown }).stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(seen).toContain("SECRET123"); // available to main for openExternal
    expect(mm.pendingLoginUrl("claude")).toBeNull(); // cleared after exit
    const emitted = JSON.stringify(m.events);
    expect(emitted).not.toContain("SECRET123");
    expect(m.events).toContainEqual({ kind: "agent-login-url", agent: "claude", url: "https://claude.ai/oauth/authorize" });
  });
  it("ignores non-allowlisted URLs", async () => {
    const root = await tmp();
    const { spawn } = createFakeSpawn(({ child }) => setTimeout(() => { child.out("go https://claude.ai.evil.com/x\n"); child.exit(0); }, 5));
    const m = mgr(root);
    await m.make(spawn).login("claude");
    expect(m.events.some((e) => e.kind === "agent-login-url")).toBe(false);
  });
  it("times out, and a failure mentions the manual command", async () => {
    const root = await tmp();
    const t = await mgr(root, { loginTimeoutMs: 30 }).make(createFakeSpawn().spawn).login("codex");
    expect(t).toMatchObject({ ok: false, code: "timeout" });
    expect((t as { message: string }).message).toContain("codex login");
    const { spawn } = createFakeSpawn(({ child }) => queueMicrotask(() => child.exit(1)));
    const f = await mgr(root).make(spawn).login("claude");
    expect(f).toMatchObject({ ok: false, code: "failed" });
    expect((f as { message: string }).message).toContain("claude auth login");
  });
  it("cancel kills the tree", async () => {
    const root = await tmp();
    const { killTree, kills } = createFakeKillTree();
    const ctl = new AbortController();
    const p = mgr(root).make(createFakeSpawn().spawn, killTree).login("claude", ctl.signal);
    await new Promise((r) => setTimeout(r, 10));
    ctl.abort();
    expect(await p).toMatchObject({ ok: false, code: "cancelled" });
    expect(kills.length).toBeGreaterThan(0);
  });
});

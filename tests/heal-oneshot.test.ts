/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from "vitest";

import { buildOneShotArgs, createOneShotRunner, parseOneShotOutput } from "../src/harness/oneshot.js";
import { createHealer } from "../src/heal/index.js";
import { buildHealPrompt, parseHealReply } from "../src/heal/prompt.js";
import { createFakeKillTree, createFakeSpawn } from "./support/fakeChild.js";

const bin = async (): Promise<string> => "/fake/bin/agent";

describe("one-shot args", () => {
  it("claude: tool-less, json, no persistence, no mcp/hooks/settings", () => {
    const a = buildOneShotArgs("claude", "/tmp/x");
    expect(a).toEqual(expect.arrayContaining(["-p", "--no-session-persistence", "--strict-mcp-config"]));
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--output-format") + 1]).toBe("json");
    expect(a[a.indexOf("--setting-sources") + 1]).toBe("");
    expect(a).not.toContain("--allowedTools");
    expect(a).not.toContain("acceptEdits");
  });
  it("codex: read-only sandbox, prompt from stdin", () => {
    const a = buildOneShotArgs("codex", "/tmp/x");
    expect(a[a.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(a.at(-1)).toBe("-");
    expect(a).not.toContain("workspace-write");
  });
});

describe("parseOneShotOutput", () => {
  it("claude json result", () => {
    expect(parseOneShotOutput("claude", JSON.stringify({ result: '{"a":1}', is_error: false }))).toEqual({ ok: true, text: '{"a":1}' });
    expect(parseOneShotOutput("claude", JSON.stringify({ result: "x", is_error: true })).ok).toBe(false);
    expect(parseOneShotOutput("claude", "garbage").ok).toBe(false);
  });
  it("codex jsonl last agent message", () => {
    const out = [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final" } }),
    ].join("\n");
    expect(parseOneShotOutput("codex", out)).toEqual({ ok: true, text: "final" });
  });
});

describe("createOneShotRunner", () => {
  it("writes the prompt to stdin, strips secrets from env, returns text", async () => {
    const { spawn, calls } = createFakeSpawn((c) => {
      setTimeout(() => {
        c.child.out(JSON.stringify({ result: "hello" }));
        c.child.exit(0);
      }, 5);
    });
    const { killTree } = createFakeKillTree();
    const run = createOneShotRunner({ spawn, killTree, resolveBin: bin, env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-secret", MY_TOKEN: "t" } });
    const res = await run("claude", "PROMPT BODY");
    expect(res).toEqual({ ok: true, text: "hello" });
    const call = calls[0]!;
    expect(call.child.stdinData).toBe("PROMPT BODY");
    expect(call.child.stdinEnded).toBe(true);
    expect(call.command).toBe("/fake/bin/agent");
    expect(call.args.join(" ")).not.toContain("PROMPT BODY");
    expect(call.options.shell).toBe(false);
    expect(Object.keys(call.options.env ?? {})).not.toContain("ANTHROPIC_API_KEY");
    expect(Object.keys(call.options.env ?? {})).not.toContain("MY_TOKEN");
  });

  it("times out and kills", async () => {
    const { spawn } = createFakeSpawn();
    const { killTree, kills } = createFakeKillTree();
    const run = createOneShotRunner({ spawn, killTree, resolveBin: bin, timeoutMs: 20 });
    const res = await run("claude", "p");
    expect(res).toMatchObject({ ok: false, code: "timeout" });
    expect(kills[0]?.signal).toBe("SIGTERM");
  });

  it("is cancellable", async () => {
    const { spawn } = createFakeSpawn();
    const { killTree } = createFakeKillTree();
    const ac = new AbortController();
    const run = createOneShotRunner({ spawn, killTree, resolveBin: bin });
    setTimeout(() => ac.abort(), 10);
    expect(await run("codex", "p", ac.signal)).toMatchObject({ ok: false, code: "cancelled" });
    expect(await run("codex", "p", ac.signal)).toMatchObject({ ok: false, code: "cancelled" });
  });

  it("reports not installed and non-zero exit", async () => {
    const { spawn } = createFakeSpawn((c) => setTimeout(() => c.child.exit(2), 5));
    const { killTree } = createFakeKillTree();
    expect(await createOneShotRunner({ spawn, killTree, resolveBin: async () => null })("claude", "p")).toMatchObject({ code: "not_installed" });
    expect(await createOneShotRunner({ spawn, killTree, resolveBin: bin })("claude", "p")).toMatchObject({ ok: false, code: "failed" });
  });
});

describe("healer prompt + reply parsing", () => {
  const req = {
    key: "codeModeButton",
    goal: "find code toggle",
    expectTerm: "code",
    expectTerms: ["code"],
    kind: "click" as const,
    failedSelectors: ["a"],
    rejectedProposals: [],
    outline: { elements: [{ tag: "button", ariaLabel: "Code view" }], truncated: false, fingerprint: "f" },
    attempt: 1,
  };
  it("prompt carries goal, outline, failed selectors, JSON demand", () => {
    const p = buildHealPrompt(req);
    expect(p).toContain("find code toggle");
    expect(p).toContain("Code view");
    expect(p).toContain('["a"]');
    expect(p).toContain('"selectors"');
  });
  it("parses fenced / prose-wrapped replies and rejects junk", () => {
    expect(parseHealReply('```json\n{"selectors":["a","b"],"reason":"r"}\n```')).toEqual({ selectors: ["a", "b"], reason: "r" });
    expect(parseHealReply('Sure! {"selectors":["x{y"]} done')?.selectors).toEqual(["x{y"]);
    expect(parseHealReply("no json")).toBeNull();
    expect(parseHealReply('{"selectors":"nope"}')).toBeNull();
    expect(parseHealReply('{"selectors":[1]}')).toBeNull();
  });
  it("createHealer returns null without an agent or on failure", async () => {
    const calls: string[] = [];
    const run = async (_a: string, p: string) => {
      calls.push(p);
      return { ok: true as const, text: '{"selectors":["text=Code"]}' };
    };
    expect(await createHealer({ runOneShot: run, getAgentId: () => null })(req)).toBeNull();
    expect(calls).toHaveLength(0);
    expect((await createHealer({ runOneShot: run, getAgentId: () => "claude" })(req))?.selectors).toEqual(["text=Code"]);
    const fail = async () => ({ ok: false as const, code: "failed" as const, message: "x" });
    expect(await createHealer({ runOneShot: fail, getAgentId: () => "claude" })(req)).toBeNull();
  });
});

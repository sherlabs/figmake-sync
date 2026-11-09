import { describe, expect, it } from "vitest";

import { createClaudeAdapter, CLAUDE_ALLOWED_TOOLS } from "../src/harness/agents/claude.js";
import { createCodexAdapter } from "../src/harness/agents/codex.js";
import type { AgentEvent } from "../src/harness/agents/types.js";
import { runAgent } from "../src/harness/runner.js";
import { createFakeKillTree, createFakeSpawn } from "./support/fakeChild.js";

const EVIL = "fix it $(rm -rf /) `id` \"quoted\" 'single'; echo pwned && -p --dangerously-skip-permissions";

// Lines recorded from `claude -p --output-format stream-json --verbose` (v2.1.x), trimmed.
const CLAUDE_SAMPLE = [
  '{"type":"system","subtype":"hook_started","hook_id":"x","session_id":"sid-1"}',
  '{"type":"system","subtype":"init","cwd":"/p","session_id":"sid-1","tools":["Read","Write"]}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"/p/a.txt","content":"hi\\n"}}]},"session_id":"sid-1"}',
  '{"type":"rate_limit_event","rate_limit_info":{}}',
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]},"session_id":"sid-1"}',
  'not json at all',
  '{"duration_api_ms":3603,"total_cost_usd":0.117,"session_id":"sid-1","is_error":false,"subtype":"success","result":"Done.","type":"result","duration_ms":3816}',
];

describe("claude adapter", () => {
  const adapter = createClaudeAdapter();

  it("never puts the prompt in argv and uses safe permission flags", () => {
    const inv = adapter.buildInvocation({ prompt: EVIL, cwd: "/p" });
    expect(inv.stdin).toBe(EVIL);
    expect(inv.args.join("\n")).not.toContain("rm -rf");
    expect(inv.args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--verbose"]));
    expect(inv.args[inv.args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(inv.args.join(" ")).not.toMatch(/bypass|dangerously|skip-permissions/i);
    for (const tool of CLAUDE_ALLOWED_TOOLS) expect(inv.args).toContain(tool);
    expect(inv.args).toContain("Bash(npm run build)");
    expect(inv.args).not.toContain("Bash");
    expect(inv.args).not.toContain("--resume");
  });

  it("never allows arbitrary-code interpreters and drops malformed session ids", () => {
    expect(CLAUDE_ALLOWED_TOOLS.join(" ")).not.toMatch(/node|npx|git diff|Bash\(npm:\*\)/);
    const inv = adapter.buildInvocation({ prompt: "x", cwd: "/p", sessionId: "--dangerously-skip-permissions" });
    expect(inv.args).not.toContain("--resume");
    const codex = createCodexAdapter().buildInvocation({ prompt: "x", cwd: "/p", sessionId: "--dangerously-bypass-approvals-and-sandbox" });
    expect(codex.args).not.toContain("resume");
  });

  it("resumes by session id", () => {
    const inv = adapter.buildInvocation({ prompt: "x", cwd: "/p", sessionId: "abc12345" });
    expect(inv.args.slice(-2)).toEqual(["--resume", "abc12345"]);
  });

  it("parses recorded stream-json", () => {
    const parse = adapter.createLineParser();
    const events: AgentEvent[] = CLAUDE_SAMPLE.flatMap((l) => parse(l));
    expect(events.map((e) => e.type)).toEqual(["session", "tool", "file_edit", "text", "result"]);
    expect(events[2]).toEqual({ type: "file_edit", path: "/p/a.txt", tool: "Write" });
    expect(events[4]).toMatchObject({ success: true, text: "Done.", sessionId: "sid-1", costUsd: 0.117 });
  });

  it("marks error results as failures", () => {
    const parse = adapter.createLineParser();
    const [e] = parse('{"type":"result","subtype":"error_max_turns","is_error":true,"result":"","session_id":"s"}');
    expect(e).toMatchObject({ type: "result", success: false });
  });

  it("parses auth status without exposing account fields", () => {
    expect(adapter.parseAuth('{"loggedIn":true,"email":"a@b.c"}', 0)).toBe(true);
    expect(adapter.parseAuth('{"loggedIn":false}', 1)).toBe(false);
    expect(adapter.parseVersion("2.1.319 (Claude Code)")).toBe("2.1.319");
  });
});

describe("codex adapter (untested against a real binary)", () => {
  const adapter = createCodexAdapter();

  it("builds documented exec args with prompt on stdin", () => {
    const inv = adapter.buildInvocation({ prompt: EVIL, cwd: "/my proj" });
    expect(inv.args).toEqual([
      "exec", "--json", "--sandbox", "workspace-write", "--cd", "/my proj", "--skip-git-repo-check", "-",
    ]);
    expect(inv.stdin).toBe(EVIL);
    expect(inv.args.join(" ")).not.toMatch(/danger|bypass|full-access/i);
  });

  it("builds resume args", () => {
    const inv = adapter.buildInvocation({ prompt: "x", cwd: "/p", sessionId: "thr_12345" });
    expect(inv.args.slice(-4)).toEqual(["resume", "--", "thr_12345", "-"]);
  });

  it("parses JSONL events", () => {
    const parse = adapter.createLineParser();
    const lines = [
      '{"type":"thread.started","thread_id":"thr_12345"}',
      '{"type":"item.started","item":{"type":"command_execution","command":"ls"}}',
      '{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"src/a.ts","kind":"update"}]}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"All set"}}',
      '{"type":"turn.completed","usage":{}}',
    ];
    const events = lines.flatMap((l) => parse(l));
    expect(events.map((e) => e.type)).toEqual(["session", "tool", "file_edit", "text", "result"]);
    expect(events[4]).toMatchObject({ success: true, text: "All set", sessionId: "thr_12345" });
    expect(parse('{"type":"turn.failed","error":{"message":"boom"}}')).toEqual([
      { type: "error", message: "boom" },
      { type: "result", success: false, text: "boom", sessionId: "thr_12345" },
    ]);
  });
});

describe("runAgent", () => {
  it("spawns without a shell, feeds the prompt on stdin, streams events and reports the session", async () => {
    const { spawn, calls } = createFakeSpawn(({ child }) => {
      queueMicrotask(() => {
        for (const l of CLAUDE_SAMPLE) child.out(`${l}\n`);
        child.exit(0);
      });
    });
    const events: AgentEvent[] = [];
    const result = await runAgent({
      adapter: createClaudeAdapter(), command: "/bin/claude", cwd: "/proj", prompt: EVIL,
      onEvent: (e) => events.push(e), spawn, env: { PATH: "/usr/bin" },
    });
    const call = calls[0]!;
    expect(call.command).toBe("/bin/claude");
    expect(call.options.shell).toBe(false);
    expect(call.options.cwd).toBe("/proj");
    expect(call.child.stdinData).toBe(EVIL);
    expect(call.child.stdinEnded).toBe(true);
    expect(result).toMatchObject({ success: true, sessionId: "sid-1", resultText: "Done." });
    expect(events.some((e) => e.type === "file_edit")).toBe(true);
  });

  it("handles output split across chunks", async () => {
    const { spawn } = createFakeSpawn(({ child }) => {
      queueMicrotask(() => {
        const line = CLAUDE_SAMPLE[7]!;
        child.out(line.slice(0, 30));
        child.out(`${line.slice(30)}\n`);
        child.exit(0);
      });
    });
    const result = await runAgent({
      adapter: createClaudeAdapter(), command: "claude", cwd: "/p", prompt: "x", onEvent: () => undefined, spawn,
    });
    expect(result.success).toBe(true);
  });

  it("cancel kills the process tree and reports cancelled", async () => {
    const { spawn, calls } = createFakeSpawn();
    const { killTree, kills } = createFakeKillTree();
    const controller = new AbortController();
    const p = runAgent({
      adapter: createClaudeAdapter(), command: "claude", cwd: "/p", prompt: "x",
      signal: controller.signal, onEvent: () => undefined, spawn, killTree, killGraceMs: 10,
    });
    expect(calls).toHaveLength(1);
    controller.abort();
    const result = await p;
    expect(kills[0]).toEqual({ pid: 4242, signal: "SIGTERM" });
    expect(result).toMatchObject({ success: false, cancelled: true });
  });

  it("reports nonzero exit without a result as failure with stderr", async () => {
    const { spawn } = createFakeSpawn(({ child }) => {
      queueMicrotask(() => {
        child.err("not logged in");
        child.exit(1);
      });
    });
    const result = await runAgent({
      adapter: createClaudeAdapter(), command: "claude", cwd: "/p", prompt: "x", onEvent: () => undefined, spawn,
    });
    expect(result).toMatchObject({ success: false, error: "not logged in" });
  });
});

describe("process helpers", () => {
  it("LineBuffer keeps multibyte characters split across chunks", async () => {
    const { LineBuffer, agentEnv } = await import("../src/harness/process.js");
    const bytes = Buffer.from("héllo €\n", "utf8");
    const euro = bytes.indexOf(0xe2);
    const buf = new LineBuffer();
    const lines = [...buf.push(bytes.subarray(0, euro + 1)), ...buf.push(bytes.subarray(euro + 1))];
    expect(lines).toEqual(["héllo €"]);
    expect(agentEnv({ PATH: "/x", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", GITHUB_TOKEN: "t", HOME: "/h" })).toEqual({ PATH: "/x", HOME: "/h" });
  });
});

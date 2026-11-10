import { describe, expect, it } from "vitest";

import { activityFor, applyAgentEvent, emptyAssistant, finishLive, nowFor } from "../src/app/chat.js";
import type { ChatMessage } from "../src/electron/contracts.js";
import { createClaudeAdapter } from "../src/harness/agents/claude.js";
import { createCodexAdapter } from "../src/harness/agents/codex.js";
import type { AgentEvent } from "../src/harness/agents/types.js";

const run = (parser: () => (l: string) => AgentEvent[], lines: unknown[]): AgentEvent[] => {
  const parse = parser();
  return lines.flatMap((l) => parse(JSON.stringify(l)));
};
const claude = (lines: unknown[]) => run(() => createClaudeAdapter().createLineParser(), lines);
const codex = (lines: unknown[]) => run(() => createCodexAdapter().createLineParser(), lines);
const asst = (...content: unknown[]) => ({ type: "assistant", message: { id: "m1", content } });

describe("claude progress events", () => {
  it("emits thinking from streamed and whole thinking blocks", () => {
    expect(claude([{ type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } }])).toEqual([{ type: "thinking" }]);
    expect(claude([asst({ type: "thinking", thinking: "secret chain of thought" })])).toEqual([{ type: "thinking" }]);
  });

  it("turns Task/Agent into a helper event using its description", () => {
    expect(claude([asst({ type: "tool_use", name: "Task", input: { description: "Check the cart page", subagent_type: "Explore", prompt: "long" } })])).toEqual([{ type: "helper", description: "Check the cart page" }]);
    expect(claude([asst({ type: "tool_use", name: "Agent", input: { subagent_type: "Explore" } })])).toEqual([{ type: "helper", description: "Explore" }]);
  });

  it("turns TodoWrite into plan steps (active uses activeForm)", () => {
    const events = claude([asst({ type: "tool_use", name: "TodoWrite", input: { todos: [
      { content: "Read header", status: "completed", activeForm: "Reading header" },
      { content: "Make it sticky", status: "in_progress", activeForm: "Making it sticky" },
      { content: "Build", status: "pending", activeForm: "Building" },
    ] } })]);
    expect(events).toEqual([{ type: "plan", steps: [{ text: "Read header", state: "done" }, { text: "Making it sticky", state: "active" }, { text: "Build", state: "pending" }] }]);
  });

  it("keeps other tools as tool events, including web and MCP", () => {
    const events = claude([asst({ type: "tool_use", name: "WebFetch", input: { url: "https://x.dev" } }, { type: "tool_use", name: "mcp__figma__get_node", input: {} })]);
    expect(events.map((e) => e.type === "tool" && e.name)).toEqual(["WebFetch", "mcp__figma__get_node"]);
  });
});

describe("codex progress events", () => {
  it("handles reasoning, turn start, todo lists, mcp and web search", () => {
    const events = codex([
      { type: "turn.started" },
      { type: "item.completed", item: { type: "reasoning", text: "Planning" } },
      { type: "item.started", item: { type: "todo_list", items: [{ text: "A", completed: true }, { text: "B", completed: false }, { text: "C", completed: false }] } },
      { type: "item.updated", item: { type: "todo_list", items: [{ text: "A", completed: true }, { text: "B", completed: true }, { text: "C", completed: false }] } },
      { type: "item.started", item: { type: "mcp_tool_call", server: "figma", tool: "get_node" } },
      { type: "item.started", item: { type: "web_search", query: "css sticky" } },
      { type: "item.started", item: { type: "command_execution", command: "/bin/zsh -lc 'npm run build'", status: "in_progress" } },
      { type: "item.completed", item: { type: "command_execution", command: "x", exit_code: 0 } },
      { type: "item.completed", item: { type: "file_change", changes: [{ path: "/p/src/A.tsx", kind: "update" }] } },
    ]);
    expect(events).toEqual([
      { type: "thinking" },
      { type: "thinking" },
      { type: "plan", steps: [{ text: "A", state: "done" }, { text: "B", state: "active" }, { text: "C", state: "pending" }] },
      { type: "plan", steps: [{ text: "A", state: "done" }, { text: "B", state: "done" }, { text: "C", state: "active" }] },
      { type: "tool", name: "mcp__figma__get_node", summary: "mcp figma get_node" },
      { type: "tool", name: "WebSearch", summary: "WebSearch css sticky" },
      { type: "tool", name: "shell", summary: "shell /bin/zsh -lc 'npm run build'" },
      { type: "file_edit", path: "/p/src/A.tsx", tool: "apply_patch" },
    ]);
  });
});

describe("chat reducer: live line, plan and clock", () => {
  const fresh = (): ChatMessage => emptyAssistant("2026-01-01T00:00:00Z", 1000);

  it("starts thinking with a clock", () => {
    const m = fresh();
    expect(m.now).toBe("Thinking…");
    expect(m.startedAt).toBe(1000);
  });

  it("updates the live line in plain words and never leaks paths or commands", () => {
    const say = (e: AgentEvent, existed?: boolean): string | undefined => applyAgentEvent(fresh(), e, existed === undefined ? {} : { existed }).now;
    expect(say({ type: "tool", name: "Read", summary: "Read /Users/me/proj/src/Button.tsx" })).toBe("Reading Button.tsx");
    expect(say({ type: "tool", name: "Edit", summary: "Edit /Users/me/proj/src/Header.tsx" })).toBe("Editing Header.tsx");
    expect(say({ type: "file_edit", path: "/p/src/New.tsx", tool: "Write" }, false)).toBe("Adding New.tsx");
    expect(say({ type: "file_edit", path: "/p/src/Old.tsx", tool: "Edit" })).toBe("Editing Old.tsx");
    expect(say({ type: "tool", name: "Grep", summary: "Grep secret-token" })).toBe("Searching the project");
    expect(say({ type: "tool", name: "Bash", summary: "Bash curl http://x" })).toBe("Running a check");
    expect(say({ type: "tool", name: "shell", summary: "shell /bin/zsh -lc 'npm run build'" })).toBe("Building the app");
    expect(say({ type: "tool", name: "WebSearch", summary: "WebSearch q" })).toBe("Looking something up online");
    expect(say({ type: "tool", name: "mcp__a__b", summary: "mcp a b" })).toBe("Using a connected tool");
    expect(say({ type: "text", text: "hi" })).toBe("Writing the reply");
    expect(say({ type: "thinking" })).toBe("Thinking…");
    expect(say({ type: "helper", description: "Check /Users/me/proj/src/cart.tsx" })).toBe("Helper: Check cart.tsx");
  });

  it("records helpers as activity and replaces the plan on every update", () => {
    expect(activityFor({ type: "helper", description: "Check the cart" })).toEqual({ kind: "helper", label: "Helper: Check the cart" });
    expect(activityFor({ type: "tool", name: "WebFetch", summary: "WebFetch https://x" })?.label).toBe("Looked something up online");
    let m = applyAgentEvent(fresh(), { type: "plan", steps: [{ text: "One", state: "active" }, { text: "Two", state: "pending" }] });
    expect(m.now).toBe("One");
    m = applyAgentEvent(m, { type: "plan", steps: [{ text: "One", state: "done" }, { text: "Two", state: "active" }] });
    expect(m.plan).toEqual([{ text: "One", state: "done" }, { text: "Two", state: "active" }]);
  });

  it("clears the live fields when the turn finishes, and ignores events after", () => {
    const m = applyAgentEvent(fresh(), { type: "plan", steps: [{ text: "One", state: "active" }] });
    const done = finishLive({ ...m, status: "done" });
    expect(done.now).toBeUndefined();
    expect(done.startedAt).toBeUndefined();
    expect(done.plan).toBeUndefined();
    expect(applyAgentEvent(done, { type: "thinking" }).now).toBeUndefined();
  });

  it("nowFor leaves the line alone for events without one", () => {
    expect(nowFor({ type: "session", sessionId: "abcdefgh1" })).toBeNull();
  });
});

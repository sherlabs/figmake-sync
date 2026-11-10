import { describe, expect, it } from "vitest";

import { MAX_MESSAGES, activityFor, activitySummary, applyAgentEvent, baseName, capMessages, dropSummaryRepeat, emptyAssistant, userMessage } from "../src/app/chat.js";
import type { ChatMessage } from "../src/electron/contracts.js";
import type { AgentEvent } from "../src/harness/agents/types.js";

const tool = (name: string, summary: string): AgentEvent => ({ type: "tool", name, summary });
const edit = (p: string, t = "Edit"): AgentEvent => ({ type: "file_edit", path: p, tool: t });

describe("chat: event -> friendly activity", () => {
  it("maps reads and searches without paths", () => {
    expect(activityFor(tool("Read", "Read /Users/me/proj/src/components/Button.tsx"))).toEqual({ kind: "look", label: "Looked at Button.tsx", file: "Button.tsx" });
    expect(activityFor(tool("Read", "Read C:\\Users\\me\\proj\\src\\Card.tsx"))).toEqual({ kind: "look", label: "Looked at Card.tsx", file: "Card.tsx" });
    expect(activityFor(tool("Grep", "Grep useCart"))?.label).toBe("Searched the project");
    expect(activityFor(tool("Glob", "Glob src/**/*.tsx"))?.label).toBe("Searched the project");
  });

  it("maps edits from file_edit only; the matching tool call shows nothing", () => {
    expect(activityFor(tool("Edit", "Edit /p/src/App.tsx"))).toBeNull();
    expect(activityFor(tool("Write", "Write /p/src/new.css"))).toBeNull();
    expect(activityFor(tool("shell", "shell apply_patch"))?.kind).not.toBe("edit");
    expect(activityFor(edit("/p/src/App.tsx"))).toEqual({ kind: "edit", label: "Edited App.tsx", file: "App.tsx" });
    expect(activityFor(edit("/p/src/button.css", "Write"), false)).toEqual({ kind: "add", label: "Added button.css", file: "button.css" });
    expect(activityFor(edit("/p/src/button.css", "Write"), true)?.label).toBe("Edited button.css");
    expect(activityFor(edit("src/a.tsx", "apply_patch"))?.label).toBe("Edited a.tsx");
  });

  it("maps shell commands to friendly checks and never shows the command", () => {
    expect(activityFor(tool("Bash", "Bash npm run build"))?.label).toBe("Checked the app builds");
    expect(activityFor(tool("Bash", "Bash npm run test"))?.label).toBe("Ran the tests");
    expect(activityFor(tool("Bash", "Bash npm run lint"))?.label).toBe("Checked the code");
    expect(activityFor(tool("Bash", "Bash npm install"))?.label).toBe("Installed what the project needs");
    expect(activityFor(tool("Bash", "Bash git status"))).toBeNull();
    expect(activityFor(tool("shell", "shell rm -rf / --token=abc"))?.label).toBe("Worked on the project");
    expect(activityFor(tool("WeirdTool", "WeirdTool /secret/path"))?.label).toBe("Worked on the project");
    for (const ev of [tool("Bash", "Bash npm run build"), tool("Read", "Read /a/b/c.ts"), tool("Mystery", "Mystery /x/y")]) {
      expect(JSON.stringify(activityFor(ev))).not.toMatch(/\/a\/b|\/x\/y|Bash|npm/u);
    }
  });

  it("baseName handles both separators and trailing slashes", () => {
    expect(baseName("/a/b/c.ts")).toBe("c.ts");
    expect(baseName("C:\\a\\b\\c.ts")).toBe("c.ts");
    expect(baseName("c.ts")).toBe("c.ts");
    expect(baseName("/a/b/")).toBe("b");
  });

  it("summarises a group in one short line", () => {
    const items = [
      { kind: "look" as const, label: "Looked at A.tsx", file: "A.tsx" },
      { kind: "look" as const, label: "Searched the project" },
      { kind: "edit" as const, label: "Edited A.tsx", file: "A.tsx" },
      { kind: "add" as const, label: "Added b.css", file: "b.css" },
      { kind: "check" as const, label: "Checked the app builds" },
    ];
    expect(activitySummary(items)).toBe("Looked around, edited A.tsx, added b.css and checked the app builds");
    expect(activitySummary([items[0] as (typeof items)[number]])).toBe("Looked at A.tsx");
    expect(activitySummary(items.filter((i) => i.kind === "edit").concat({ kind: "edit", label: "Edited B.tsx", file: "B.tsx" }))).toBe("Edited 2 files");
  });
});

describe("chat: streaming reducer", () => {
  const start = (): ChatMessage => emptyAssistant("2026-01-01T00:00:00.000Z");

  it("builds interleaved text and activity in order", () => {
    let m = start();
    m = applyAgentEvent(m, { type: "text", text: "Let me look." });
    m = applyAgentEvent(m, tool("Read", "Read /p/src/A.tsx"));
    m = applyAgentEvent(m, tool("Grep", "Grep x"));
    m = applyAgentEvent(m, edit("/p/src/A.tsx"));
    m = applyAgentEvent(m, { type: "text", text: "All set." });
    expect(m.parts.map((p) => p.type)).toEqual(["text", "activity", "text"]);
    const group = m.parts[1];
    expect(group?.type === "activity" && group.items.map((i) => i.label)).toEqual(["Looked at A.tsx", "Searched the project", "Edited A.tsx"]);
    expect(m.status).toBe("streaming");
  });

  it("joins partial deltas into one growing text part", () => {
    let m = start();
    for (const t of ["Hel", "lo ", "there"]) m = applyAgentEvent(m, { type: "text", text: t, delta: true });
    expect(m.parts).toEqual([{ type: "text", text: "Hello there" }]);
  });

  it("starts a new paragraph for each whole text block", () => {
    let m = start();
    m = applyAgentEvent(m, { type: "text", text: "One." });
    m = applyAgentEvent(m, { type: "text", text: "Two." });
    expect(m.parts).toEqual([{ type: "text", text: "One.\n\nTwo." }]);
  });

  it("does not repeat the same step and never mutates its input", () => {
    const m0 = start();
    const m1 = applyAgentEvent(m0, tool("Read", "Read /p/A.tsx"));
    const m2 = applyAgentEvent(m1, tool("Read", "Read /p/A.tsx"));
    expect(m2.parts).toEqual(m1.parts);
    expect(m0.parts).toEqual([]);
  });

  it("ignores session, result and error events (those are handled by the turn, not the transcript)", () => {
    let m = start();
    for (const ev of [{ type: "session", sessionId: "s-12345678" }, { type: "result", success: true, text: "x" }, { type: "error", message: "boom: /secret" }] as AgentEvent[]) m = applyAgentEvent(m, ev);
    expect(m.parts).toEqual([]);
  });

  it("keeps partial text when the run is cut off", () => {
    let m = start();
    m = applyAgentEvent(m, { type: "text", text: "I'll start by", delta: true });
    const stopped = { ...m, status: "stopped" as const };
    expect(stopped.parts).toEqual([{ type: "text", text: "I'll start by" }]);
  });

  it("drops a closing sentence that only repeats the change summary", () => {
    const parts = [{ type: "text" as const, text: "Made the button blue." }];
    expect(dropSummaryRepeat(parts, "Made the button blue")).toEqual([]);
    expect(dropSummaryRepeat([{ type: "text", text: "Made the button blue. Want more?" }], "Made the button blue")).toHaveLength(1);
  });

  it("caps a transcript at the newest 500 messages", () => {
    const list = Array.from({ length: MAX_MESSAGES + 25 }, (_, i) => userMessage(String(i)));
    const capped = capMessages(list);
    expect(capped).toHaveLength(MAX_MESSAGES);
    expect(capped[0]?.text).toBe("25");
  });
});

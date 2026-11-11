import type { ChatActivity, ChatMessage, ChatPart } from "../electron/contracts.js";
import type { AgentEvent } from "../harness/agents/types.js";
import { IMAGE_NAME } from "./attachmentKinds.js";
import { sanitizeText } from "./report.js";

export { activitySummary } from "./activitySummary.js";

/* The conversation model: pure functions that turn the agent's raw event stream into friendly chat content.
   Nothing here ever keeps a command, a tool name or a folder path. */

export const MAX_MESSAGES = 500;
const MAX_ITEMS_PER_GROUP = 60;
const MAX_TEXT = 40_000;

export const newId = (): string => globalThis.crypto.randomUUID();

/** File name of a Windows or POSIX path. */
export function baseName(p: string): string {
  const trimmed = p.trim().replace(/[\\/]+$/u, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

const READ_TOOLS = new Set(["Read", "NotebookRead", "View"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "LS", "Search", "ListDir"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);

/** What follows the tool name in a harness summary ("Read /a/b.tsx" -> "/a/b.tsx"). */
const target = (name: string, summary: string): string => (summary.startsWith(name) ? summary.slice(name.length) : summary).trim();

/** `/bin/zsh -lc 'npm run build'` (how Codex runs things) -> `npm run build`. */
function unwrapShell(command: string): string {
  const m = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(.*)$/su.exec(command.trim());
  return (m?.[1] ?? command).trim().replace(/^(['"])(.*)\1$/su, "$2");
}

function commandActivity(command: string): ChatActivity | null {
  const c = unwrapShell(command).replace(/\s+/gu, " ");
  if (/\b(npm|pnpm|yarn|bun)\b.*\bbuild\b/iu.test(c) || /\btsc\b|\bvite build\b/iu.test(c)) return { kind: "check", label: "Checked the app builds" };
  if (/\b(test|vitest|jest)\b/iu.test(c)) return { kind: "check", label: "Ran the tests" };
  if (/\blint\b|eslint|prettier/iu.test(c)) return { kind: "check", label: "Checked the code" };
  if (/\b(npm|pnpm|yarn|bun)\b.*\b(install|add|ci)\b/iu.test(c)) return { kind: "check", label: "Installed what the project needs" };
  if (/^git\b/iu.test(c)) return null;
  if (/^(ls|cat|head|tail|find|grep|rg|sed|pwd|tree)\b/iu.test(c)) return { kind: "look", label: "Looked around the project" };
  return { kind: "other", label: "Worked on the project" };
}

/**
 * The friendly line for one agent event, or null when it deserves no line.
 * Edits come from `file_edit` events only, so an Edit tool call never shows twice.
 * `existed` tells an overwritten file ("Edited") from a new one ("Added").
 */
export function activityFor(event: AgentEvent, existed = true): ChatActivity | null {
  if (event.type === "file_edit") {
    const file = baseName(event.path);
    if (!file) return null;
    const added = event.tool === "Write" && !existed;
    return { kind: added ? "add" : "edit", label: `${added ? "Added" : "Edited"} ${file}`, file };
  }
  if (event.type === "helper") return { kind: "helper", label: helperLabel(event.description) };
  if (event.type !== "tool") return null;
  if (EDIT_TOOLS.has(event.name)) return null;
  const rest = target(event.name, event.summary);
  if (READ_TOOLS.has(event.name)) {
    const file = baseName(rest);
    if (IMAGE_NAME.test(file)) return { kind: "look", label: "Looked at your screenshot" };
    return file ? { kind: "look", label: `Looked at ${file}`, file } : { kind: "look", label: "Looked at a file" };
  }
  if (SEARCH_TOOLS.has(event.name)) return { kind: "look", label: "Searched the project" };
  if (event.name === "Bash" || event.name === "shell") return commandActivity(rest);
  if (event.name === "WebFetch" || event.name === "WebSearch") return { kind: "look", label: "Looked something up online" };
  if (event.name.startsWith("mcp__")) return { kind: "other", label: "Used a connected tool" };
  return { kind: "other", label: "Worked on the project" };
}

/** A short, safe phrase from text the AI wrote: no markdown, no paths, no tokens. */
function plainPhrase(raw: string, max = 70): string {
  const t = sanitizeText(raw.replace(/\S*[\\/]\S*/gu, (w) => baseName(w.replace(/[.,;:!?)]+$/u, "")) || ""))
    .replace(/[`*_#>]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const helperLabel = (description: string): string => {
  const d = plainPhrase(description, 60);
  return d ? `Helper: ${d}` : "Started a helper";
};

/** "What is happening right now", in plain words, for one event. null = leave the current line alone. */
export function nowFor(event: AgentEvent, ctx: { existed?: boolean } = {}): string | null {
  switch (event.type) {
    case "thinking":
      return "Thinking…";
    case "text":
      return "Writing the reply";
    case "helper":
      return helperLabel(event.description);
    case "plan": {
      const active = event.steps.find((s) => s.state === "active");
      const text = active ? plainPhrase(active.text, 60) : "";
      return text || "Updating the plan";
    }
    case "file_edit": {
      const file = baseName(event.path);
      if (!file) return null;
      return `${event.tool === "Write" && ctx.existed === false ? "Adding" : "Editing"} ${file}`;
    }
    case "tool": {
      const rest = target(event.name, event.summary);
      if (READ_TOOLS.has(event.name)) {
        const file = baseName(rest);
        if (IMAGE_NAME.test(file)) return "Looking at your screenshot";
        return file ? `Reading ${file}` : "Reading a file";
      }
      if (EDIT_TOOLS.has(event.name)) {
        const file = baseName(rest);
        return file ? `Editing ${file}` : "Editing a file";
      }
      if (SEARCH_TOOLS.has(event.name)) return "Searching the project";
      if (event.name === "WebFetch" || event.name === "WebSearch") return "Looking something up online";
      if (event.name.startsWith("mcp__")) return "Using a connected tool";
      if (event.name === "Bash" || event.name === "shell") {
        const c = unwrapShell(rest);
        if (/\b(npm|pnpm|yarn|bun)\b.*\b(install|add|ci)\b/iu.test(c)) return "Installing what the project needs";
        if (/\b(npm|pnpm|yarn|bun)\b.*\bbuild\b|\btsc\b|\bvite build\b/iu.test(c)) return "Building the app";
        if (/\b(test|vitest|jest)\b/iu.test(c)) return "Running the tests";
        if (/\blint\b|eslint|prettier/iu.test(c)) return "Checking the code";
        if (/^(ls|cat|head|tail|find|grep|rg|sed|pwd|tree)\b/iu.test(c)) return "Looking around the project";
        return "Running a check";
      }
      return "Working on the project";
    }
    default:
      return null;
  }
}

export function emptyAssistant(at = new Date().toISOString(), now = Date.now()): ChatMessage {
  return { id: newId(), role: "assistant", at, text: "", parts: [], status: "streaming", now: "Thinking…", startedAt: now };
}

/** Drops the live-only fields once a turn is over. */
export function finishLive(message: ChatMessage): ChatMessage {
  const rest = { ...message };
  delete rest.now;
  delete rest.startedAt;
  delete rest.plan;
  return rest;
}

export function userMessage(text: string, at = new Date().toISOString()): ChatMessage {
  return { id: newId(), role: "user", at, text, parts: [], status: "done" };
}

/** Applies one agent event to an assistant message, returning the updated message (the input is not changed). */
export function applyAgentEvent(message: ChatMessage, event: AgentEvent, ctx: { existed?: boolean } = {}): ChatMessage {
  const next = applyEvent(message, event, ctx);
  if (message.status !== "streaming") return next;
  const now = nowFor(event, ctx);
  return now && now !== next.now ? { ...next, now } : next;
}

function applyEvent(message: ChatMessage, event: AgentEvent, ctx: { existed?: boolean }): ChatMessage {
  if (event.type === "plan") {
    const plan = event.steps.map((s) => ({ text: plainPhrase(s.text, 100), state: s.state })).filter((s) => s.text);
    return { ...message, plan: plan.slice(0, 40) };
  }
  if (event.type === "text") {
    const parts = message.parts.slice();
    const last = parts.at(-1);
    if (last?.type === "text") {
      // A delta continues the sentence; a whole block starts a new paragraph.
      const joined = event.delta ? last.text + event.text : `${last.text}\n\n${event.text}`;
      parts[parts.length - 1] = { type: "text", text: joined.slice(0, MAX_TEXT) };
    } else {
      const text = event.text.replace(/^\s+/u, "");
      if (!text) return message;
      parts.push({ type: "text", text: text.slice(0, MAX_TEXT) });
    }
    return { ...message, parts };
  }
  const activity = activityFor(event, ctx.existed);
  if (!activity) return message;
  const parts = message.parts.slice();
  const last = parts.at(-1);
  if (last?.type === "activity") {
    if (last.items.some((i) => i.label === activity.label) || last.items.length >= MAX_ITEMS_PER_GROUP) return message;
    parts[parts.length - 1] = { type: "activity", items: [...last.items, activity] };
  } else {
    parts.push({ type: "activity", items: [activity] });
  }
  return { ...message, parts };
}

const norm = (s: string): string => s.replace(/[`*_#>]/gu, "").replace(/[\s.!?]+$/u, "").replace(/\s+/gu, " ").trim().toLowerCase();

/** Drops the closing text segment when it only repeats the one-sentence summary the change card already shows. */
export function dropSummaryRepeat(parts: ChatPart[], summary: string): ChatPart[] {
  const last = parts.at(-1);
  if (last?.type === "text" && norm(last.text) === norm(summary)) return parts.slice(0, -1);
  return parts;
}

/** The messages to keep: the newest MAX_MESSAGES. */
export function capMessages<T>(messages: readonly T[]): T[] {
  return messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages.slice();
}

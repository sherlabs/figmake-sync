import type { ActivityKind, ChatActivity, ChatMessage, ChatPart } from "../electron/contracts.js";
import type { AgentEvent } from "../harness/agents/types.js";

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

function commandActivity(command: string): ChatActivity | null {
  const c = command.trim().replace(/\s+/gu, " ");
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
  if (event.type !== "tool") return null;
  if (EDIT_TOOLS.has(event.name)) return null;
  const rest = target(event.name, event.summary);
  if (READ_TOOLS.has(event.name)) {
    const file = baseName(rest);
    return file ? { kind: "look", label: `Looked at ${file}`, file } : { kind: "look", label: "Looked at a file" };
  }
  if (SEARCH_TOOLS.has(event.name)) return { kind: "look", label: "Searched the project" };
  if (event.name === "Bash" || event.name === "shell") return commandActivity(rest);
  return { kind: "other", label: "Worked on the project" };
}

export function emptyAssistant(at = new Date().toISOString()): ChatMessage {
  return { id: newId(), role: "assistant", at, text: "", parts: [], status: "streaming" };
}

export function userMessage(text: string, at = new Date().toISOString()): ChatMessage {
  return { id: newId(), role: "user", at, text, parts: [], status: "done" };
}

/** Applies one agent event to an assistant message, returning the updated message (the input is not changed). */
export function applyAgentEvent(message: ChatMessage, event: AgentEvent, ctx: { existed?: boolean } = {}): ChatMessage {
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

/** One short line for a collapsed activity group: "Looked around, edited Button.tsx and checked the app builds". */
export function activitySummary(items: readonly ChatActivity[]): string {
  const of = (kind: ActivityKind): ChatActivity[] => items.filter((i) => i.kind === kind);
  const clauses: string[] = [];
  const looked = of("look");
  const edited = of("edit");
  const added = of("add");
  if (looked.length === 1) clauses.push(looked[0]?.label ?? "Looked at a file");
  else if (looked.length > 1) clauses.push("Looked around");
  if (edited.length === 1) clauses.push(edited[0]?.label ?? "Edited a file");
  else if (edited.length > 1) clauses.push(`Edited ${edited.length} files`);
  if (added.length === 1) clauses.push(added[0]?.label ?? "Added a file");
  else if (added.length > 1) clauses.push(`Added ${added.length} files`);
  const check = of("check")[0];
  if (check) clauses.push(check.label);
  if (clauses.length === 0) clauses.push(items[0]?.label ?? "Worked on it");
  const lowered = clauses.map((c, i) => (i === 0 ? c : c.charAt(0).toLowerCase() + c.slice(1)));
  return lowered.length > 1 ? `${lowered.slice(0, -1).join(", ")} and ${lowered.at(-1) ?? ""}` : (lowered[0] ?? "");
}

/** The messages to keep: the newest MAX_MESSAGES. */
export function capMessages<T>(messages: readonly T[]): T[] {
  return messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages.slice();
}

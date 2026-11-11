import { validSessionId } from "./types.js";
import type {
  AgentAdapter,
  AgentEvent,
  AgentInvocation,
  AgentInvocationInput,
  PlanStep,
} from "./types.js";

/**
 * OpenAI Codex CLI connector.
 *
 * UNTESTED ON THIS MACHINE: the codex binary is not installed here. Arg
 * building follows the documented `codex exec` interface (--json,
 * --sandbox workspace-write, -C/--cd, --skip-git-repo-check; prompt "-" reads
 * stdin; `codex exec resume <id>`) and event parsing follows the documented
 * JSONL item events. Verify against a real install before relying on it.
 */
/** `todo_list` item -> plan steps. The first unfinished step is the active one. */
function todoSteps(items: unknown): PlanStep[] {
  if (!Array.isArray(items)) return [];
  const steps: PlanStep[] = [];
  let activeSet = false;
  for (const raw of items.slice(0, 40)) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const text = typeof entry["text"] === "string" ? entry["text"].trim() : "";
    if (!text) continue;
    const done = entry["completed"] === true;
    const state = done ? "done" : activeSet ? "pending" : "active";
    if (!done) activeSet = true;
    steps.push({ text: text.slice(0, 160), state });
  }
  return steps;
}

export function createCodexAdapter(): AgentAdapter {
  return {
    id: "codex",
    displayName: "OpenAI Codex CLI",
    binary: "codex",
    experimental: true,
    npmPackage: "@openai/codex",
    manualLogin: "codex login",
    // UNTESTED here: `codex login` per the Codex docs; never run on this machine.
    loginArgs: () => ["login"],
    installHint:
      "Install the Codex CLI (`npm install -g @openai/codex`), then run `codex login` to sign in.",
    loginHint: "Not signed in. Run `codex login` in a terminal.",
    versionArgs: () => ["--version"],
    parseVersion: (stdout) => /(\d+\.\d+\.\d+[^\s]*)/.exec(stdout)?.[1] ?? null,
    authArgs: () => ["login", "status"],
    // Verified against codex-cli 0.167: `login status` exits 0 when signed in and 1 with "Not logged in" (on stderr) when
    // not. Any other exit code (e.g. 2 = the CLI has no such subcommand) stays "unknown" so it is never hard-blocked.
    parseAuth: (_stdout, exitCode) => (exitCode === 0 ? true : exitCode === 1 ? false : null),
    buildInvocation(input: AgentInvocationInput): AgentInvocation {
      // Codex takes pictures with the repeatable -i/--image flag. They come first, right after `exec`, so the
      // flag's list of values ends at the next option and never swallows the prompt marker "-" at the end.
      const sessionId = validSessionId(input.sessionId);
      const images = (input.images ?? []).flatMap((p) => ["--image", p]);
      const args = [
        "exec",
        // A resumed session takes its pictures on `resume` itself (its own --image option), not on `exec`.
        ...(sessionId ? [] : images),
        "--json",
        "--sandbox",
        "workspace-write",
        "--cd",
        input.cwd,
        "--skip-git-repo-check",
      ];
      if (sessionId) {
        args.push("resume", ...images, "--", sessionId);
      }
      args.push("-"); // prompt from stdin
      return { command: "codex", args, stdin: input.prompt };
    },
    createLineParser() {
      let sessionId: string | undefined;
      let lastMessage = "";
      return (line: string): AgentEvent[] => {
        let msg: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object") return [];
          msg = parsed as Record<string, unknown>;
        } catch {
          return [];
        }
        const events: AgentEvent[] = [];
        const type = msg["type"];

        if (type === "thread.started" && typeof msg["thread_id"] === "string") {
          sessionId = msg["thread_id"];
          events.push({ type: "session", sessionId });
        } else if (type === "turn.started") {
          events.push({ type: "thinking" });
        } else if (type === "item.completed" || type === "item.started" || type === "item.updated") {
          const item = (msg["item"] ?? {}) as Record<string, unknown>;
          const itemType = item["type"];
          if (itemType === "todo_list") {
            const steps = todoSteps(item["items"]);
            if (steps.length > 0) events.push({ type: "plan", steps });
          } else if (itemType === "reasoning") {
            events.push({ type: "thinking" });
          } else if (type === "item.started" && itemType === "mcp_tool_call") {
            const server = typeof item["server"] === "string" ? item["server"] : "server";
            const name = typeof item["tool"] === "string" ? item["tool"] : "tool";
            events.push({ type: "tool", name: `mcp__${server}__${name}`, summary: `mcp ${server} ${name}`.slice(0, 200) });
          } else if (type === "item.started" && itemType === "web_search") {
            const query = typeof item["query"] === "string" ? item["query"] : "";
            events.push({ type: "tool", name: "WebSearch", summary: `WebSearch ${query}`.slice(0, 200) });
          } else if (type === "item.completed" && itemType === "agent_message" && typeof item["text"] === "string") {
            lastMessage = item["text"];
            events.push({ type: "text", text: item["text"] });
          } else if (type === "item.started" && itemType === "command_execution") {
            const command = typeof item["command"] === "string" ? item["command"] : "";
            events.push({ type: "tool", name: "shell", summary: `shell ${command}`.slice(0, 200) });
          } else if (type === "item.completed" && itemType === "file_change") {
            const changes = Array.isArray(item["changes"]) ? (item["changes"] as Array<Record<string, unknown>>) : [];
            for (const change of changes) {
              if (typeof change["path"] === "string") {
                events.push({ type: "file_edit", path: change["path"], tool: "apply_patch" });
              }
            }
          }
        } else if (type === "turn.completed") {
          events.push({ type: "result", success: true, text: lastMessage, ...(sessionId ? { sessionId } : {}) });
        } else if (type === "turn.failed" || type === "error") {
          const err = msg["error"] as { message?: unknown } | undefined;
          const message =
            (typeof err?.message === "string" && err.message) ||
            (typeof msg["message"] === "string" && msg["message"]) ||
            "Codex run failed";
          events.push({ type: "error", message });
          if (type === "turn.failed") {
            events.push({ type: "result", success: false, text: message, ...(sessionId ? { sessionId } : {}) });
          }
        }
        return events;
      };
    },
  };
}

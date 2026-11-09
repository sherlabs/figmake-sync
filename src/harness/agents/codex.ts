import { validSessionId } from "./types.js";
import type {
  AgentAdapter,
  AgentEvent,
  AgentInvocation,
  AgentInvocationInput,
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
    // Unverified: exit 0 means signed in; anything else is "unknown" so a CLI without this subcommand is never hard-blocked.
    parseAuth: (_stdout, exitCode) => (exitCode === 0 ? true : null),
    buildInvocation(input: AgentInvocationInput): AgentInvocation {
      const args = [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--cd",
        input.cwd,
        "--skip-git-repo-check",
      ];
      const sessionId = validSessionId(input.sessionId);
      if (sessionId) {
        args.push("resume", "--", sessionId);
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
        } else if (type === "item.completed" || type === "item.started") {
          const item = (msg["item"] ?? {}) as Record<string, unknown>;
          const itemType = item["type"];
          if (type === "item.completed" && itemType === "agent_message" && typeof item["text"] === "string") {
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

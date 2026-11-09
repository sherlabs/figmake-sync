import { validSessionId } from "./types.js";
import type {
  AgentAdapter,
  AgentEvent,
  AgentInvocation,
  AgentInvocationInput,
} from "./types.js";

/**
 * Tool allowlist for non-interactive runs. In `-p` mode anything not allowed is
 * denied (there is nobody to prompt). Bash is limited to exact npm scripts and
 * `git status`; interpreters (node, npx) are deliberately absent because they
 * run arbitrary code. Note that npm scripts still run project-defined code, and
 * Edit/Write rely on Claude's own cwd handling. We never pass any
 * bypass-permissions flag.
 */
export const CLAUDE_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash(npm install)",
  "Bash(npm run build)",
  "Bash(npm run test)",
  "Bash(npm run lint)",
  "Bash(git status:*)",
] as const;

/** Explicitly denied even if a user-level setting would allow them. */
export const CLAUDE_DISALLOWED_TOOLS = [
  "Bash(curl:*)",
  "Bash(wget:*)",
  "Bash(ssh:*)",
  "Bash(scp:*)",
  "Bash(git push:*)",
  "Bash(git diff:*)",
  "Bash(node:*)",
  "Bash(npx:*)",
] as const;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function summarizeTool(name: string, input: Record<string, unknown>): string {
  const target =
    str(input["file_path"]) ??
    str(input["path"]) ??
    str(input["command"]) ??
    str(input["pattern"]);
  const text = target ? `${name} ${target}` : name;
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

export function createClaudeAdapter(): AgentAdapter {
  return {
    id: "claude",
    displayName: "Claude Code",
    binary: "claude",
    installHint: "Install Claude Code (`npm install -g @anthropic-ai/claude-code`), then run `claude auth login` to sign in.",
    loginHint: "Not signed in. Run `claude auth login` in a terminal.",
    versionArgs: () => ["--version"],
    parseVersion: (stdout) => /(\d+\.\d+\.\d+[^\s]*)/.exec(stdout)?.[1] ?? null,
    authArgs: () => ["auth", "status"],
    parseAuth(stdout, exitCode) {
      try {
        const parsed = JSON.parse(stdout) as { loggedIn?: unknown };
        if (typeof parsed.loggedIn === "boolean") return parsed.loggedIn;
      } catch {
        // fall through
      }
      return exitCode === 0 ? null : false;
    },
    buildInvocation(input: AgentInvocationInput): AgentInvocation {
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        ...CLAUDE_ALLOWED_TOOLS,
        "--disallowedTools",
        ...CLAUDE_DISALLOWED_TOOLS,
      ];
      const sessionId = validSessionId(input.sessionId);
      if (sessionId) {
        args.push("--resume", sessionId);
      }
      return { command: "claude", args, stdin: input.prompt };
    },
    createLineParser() {
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

        if (type === "system" && msg["subtype"] === "init") {
          const sid = str(msg["session_id"]);
          if (sid) events.push({ type: "session", sessionId: sid });
        } else if (type === "assistant") {
          const content = (msg["message"] as { content?: unknown } | undefined)?.content;
          if (Array.isArray(content)) {
            for (const block of content as Array<Record<string, unknown>>) {
              if (block["type"] === "text" && str(block["text"])) {
                events.push({ type: "text", text: str(block["text"]) as string });
              } else if (block["type"] === "tool_use") {
                const name = str(block["name"]) ?? "tool";
                const input = (block["input"] ?? {}) as Record<string, unknown>;
                events.push({ type: "tool", name, summary: summarizeTool(name, input) });
                const filePath = str(input["file_path"]) ?? str(input["notebook_path"]);
                if (EDIT_TOOLS.has(name) && filePath) {
                  events.push({ type: "file_edit", path: filePath, tool: name });
                }
              }
            }
          }
        } else if (type === "result") {
          const isError = msg["is_error"] === true || msg["subtype"] !== "success";
          const sid = str(msg["session_id"]);
          const cost = msg["total_cost_usd"];
          const dur = msg["duration_ms"];
          events.push({
            type: "result",
            success: !isError,
            text: str(msg["result"]) ?? "",
            ...(sid ? { sessionId: sid } : {}),
            ...(typeof cost === "number" ? { costUsd: cost } : {}),
            ...(typeof dur === "number" ? { durationMs: dur } : {}),
          });
        }
        return events;
      };
    },
  };
}

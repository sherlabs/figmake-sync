import type { ErrorCode } from "../electron/contracts.js";
import { pushLines } from "./activity.js";

/** What went wrong in an AI run, in the four ways the person can act on. */
export type AgentFailureCode = Extract<ErrorCode, "agent_signin_required" | "agent_limit" | "agent_unreachable" | "agent_failed">;

const AUTH = /\b401\b|not (?:logged|signed) in|\blog in\b|\bsign in\b|login required|token (?:has )?expired|expired token|refresh token|unauthori[sz]ed|invalid api key/iu;
const LIMIT = /usage limit|rate limit|\b429\b|quota/iu;
const NETWORK = /ENOTFOUND|ECONN|EAI_AGAIN|network/iu;
const SOCKET = /websocket/iu;

/**
 * Sorts a failed run by the text it left behind. `signedIn` is the result of the cheap sign-in probe (true, false, or
 * null when it couldn't tell): a signed-out Codex exits 0 with only "failed to connect to Responses WebSocket", so a
 * socket error counts as the network only when the probe says the person is signed in.
 */
export function classifyAgentFailure(raw: string, signedIn: boolean | null): AgentFailureCode {
  if (AUTH.test(raw)) return "agent_signin_required";
  if (LIMIT.test(raw)) return "agent_limit";
  if (signedIn === false) return "agent_signin_required";
  if (NETWORK.test(raw)) return "agent_unreachable";
  if (SOCKET.test(raw) && signedIn === true) return "agent_unreachable";
  return "agent_failed";
}

/** One plain sentence per failure; no raw text. */
export function agentFailureSentence(code: AgentFailureCode, name: string): string {
  switch (code) {
    case "agent_signin_required":
      return `${name} isn't signed in.`;
    case "agent_limit":
      return `${name}'s usage limit was reached. Try again later.`;
    case "agent_unreachable":
      return `Couldn't reach ${name}. Check your connection.`;
    default:
      return `${name} stopped with a problem.`;
  }
}

const MAX_DETAIL_LINES = 20;

/** The last lines of the AI's output, through the same cleaner as the progress feed (paths shortened, secrets and noise dropped). */
export function agentDetails(raw: string, home?: string): string[] {
  return [...pushLines([], raw.split(/\n/u).slice(-MAX_DETAIL_LINES * 2).join("\n"), MAX_DETAIL_LINES, home)];
}

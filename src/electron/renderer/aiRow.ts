import type { AgentChoice, Phase } from "../contracts.js";

/* The AI helper row in Settings: which buttons it offers for each state. Pure, so tests can check every state. */

export type AiAction =
  | { kind: "connect"; agent: AgentChoice; label: string; primary: boolean; disabled: boolean }
  | { kind: "signin"; label: string; primary: boolean; disabled: boolean }
  | { kind: "switch"; agent: AgentChoice; label: string; primary: boolean; disabled: boolean }
  | { kind: "signout"; label: string; primary: boolean; disabled: boolean };

const WORKING: readonly Phase[] = ["connecting", "preparing", "working", "sending", "conflict", "syncing", "resolving"];

export function aiRowActions(s: { agent: AgentChoice | null; agentConnected: boolean; phase: Phase }, agents: readonly { id: AgentChoice; name: string }[]): AiAction[] {
  const disabled = WORKING.includes(s.phase);
  if (!s.agent) return agents.map((a) => ({ kind: "connect", agent: a.id, label: `Connect ${a.name}`, primary: false, disabled }));
  const other = agents.find((a) => a.id !== s.agent);
  const out: AiAction[] = [{ kind: "signin", label: s.agentConnected ? "Sign in again" : "Sign in", primary: !s.agentConnected, disabled }];
  if (other) out.push({ kind: "switch", agent: other.id, label: `Switch to ${other.name}`, primary: false, disabled });
  out.push({ kind: "signout", label: "Sign out", primary: false, disabled });
  return out;
}

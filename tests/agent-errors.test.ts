import { describe, expect, it } from "vitest";

import { agentDetails, agentFailureSentence, classifyAgentFailure } from "../src/app/agentErrors.js";
import { ERROR_CODES } from "../src/electron/contracts.js";
import { createClaudeAdapter } from "../src/harness/agents/claude.js";
import { createCodexAdapter } from "../src/harness/agents/codex.js";
import { aiRowActions } from "../src/electron/renderer/aiRow.js";
import { issueTitle } from "../src/app/report.js";

describe("parseAuth", () => {
  it("Codex: exit 0 signed in, 1 signed out (stderr 'Not logged in'), anything else unknown", () => {
    const a = createCodexAdapter();
    expect(a.parseAuth("Logged in using ChatGPT", 0)).toBe(true);
    expect(a.parseAuth("", 1)).toBe(false);
    expect(a.parseAuth("", 2)).toBeNull();
    expect(a.parseAuth("", null)).toBeNull();
  });
  it("Claude: the JSON wins; without JSON a failing exit means signed out and a clean one is unknown", () => {
    const a = createClaudeAdapter();
    expect(a.parseAuth('{"loggedIn":true}', 0)).toBe(true);
    expect(a.parseAuth('{"loggedIn":false}', 0)).toBe(false);
    expect(a.parseAuth("", 1)).toBe(false);
    expect(a.parseAuth("not json", 0)).toBeNull();
  });
  it("both adapters know how to sign out", () => {
    expect(createCodexAdapter().logoutArgs?.()).toEqual(["logout"]);
    expect(createClaudeAdapter().logoutArgs?.()).toEqual(["auth", "logout"]);
  });
});

describe("classifyAgentFailure", () => {
  it.each([
    ["HTTP 401 from server", null, "agent_signin_required"],
    ["Error: not logged in", true, "agent_signin_required"],
    ["Please log in again", null, "agent_signin_required"],
    ["please sign in to continue", null, "agent_signin_required"],
    ["Token expired", null, "agent_signin_required"],
    ["could not refresh token", null, "agent_signin_required"],
    ["Unauthorized", null, "agent_signin_required"],
    ["Invalid API key", null, "agent_signin_required"],
    ["You've hit your usage limit", true, "agent_limit"],
    ["rate limit reached", null, "agent_limit"],
    ["status 429", null, "agent_limit"],
    ["There's an issue with the selected model (x). It may not exist or you may not have access to it. Run --model to pick a different model.", true, "agent_model_unavailable"],
    ["The 'x' model is not supported when using Codex with a ChatGPT account.", true, "agent_model_unavailable"],
    ["model_not_found", null, "agent_model_unavailable"],
    ["The model `gpt-9` does not exist", true, "agent_model_unavailable"],
    ["invalid model: x", null, "agent_model_unavailable"],
    ["Model is not available for your plan", null, "agent_model_unavailable"],
    ["rate limit on this model", null, "agent_limit"],
    ["401 unauthorized: model", true, "agent_signin_required"],
    ["quota exceeded", null, "agent_limit"],
    ["getaddrinfo ENOTFOUND api.openai.com", true, "agent_unreachable"],
    ["connect ECONNREFUSED 1.2.3.4:443", null, "agent_unreachable"],
    ["network is unreachable", null, "agent_unreachable"],
    ["failed to connect to Responses WebSocket", true, "agent_unreachable"],
    ["failed to connect to Responses WebSocket", false, "agent_signin_required"],
    ["failed to connect to Responses WebSocket", null, "agent_failed"],
    ["something odd", true, "agent_failed"],
    ["something odd", false, "agent_signin_required"],
    ["port 4010 is busy", null, "agent_failed"],
    ["", null, "agent_failed"],
  ])("%j (signed in: %s) -> %s", (raw, signedIn, code) => {
    expect(classifyAgentFailure(raw, signedIn)).toBe(code);
  });

  it("every code has a stable name, a report title and one plain sentence", () => {
    for (const c of ["agent_signin_required", "agent_limit", "agent_unreachable", "agent_failed", "agent_model_unavailable"] as const) {
      expect(ERROR_CODES).toContain(c);
      expect(issueTitle(c)).toMatch(new RegExp(`^\\[${c}\\] `, "u"));
      expect(agentFailureSentence(c, "ChatGPT")).toMatch(/^[^\n]+\.$/u);
    }
    expect(agentFailureSentence("agent_signin_required", "ChatGPT")).toBe("ChatGPT isn't signed in.");
    expect(agentFailureSentence("agent_limit", "ChatGPT")).toBe("ChatGPT's usage limit was reached. Try again later.");
    expect(agentFailureSentence("agent_unreachable", "ChatGPT")).toBe("Couldn't reach ChatGPT. Check your connection.");
    expect(agentFailureSentence("agent_model_unavailable", "ChatGPT")).toBe("That model isn't available on your account. Pick another.");
    expect(agentFailureSentence("agent_failed", "ChatGPT")).toBe("ChatGPT stopped with a problem.");
  });

  it("details keep the last 20 cleaned lines and hide the home folder and tokens", () => {
    const raw = Array.from({ length: 80 }, (_, i) => `row ${i} /Users/me/secret sk-ant-api03-abcdefghijklmnopqrstuvwxyz`).join("\n");
    const d = agentDetails(raw, "/Users/me");
    expect(d).toHaveLength(20);
    expect(d.at(-1)).toContain("row 79");
    expect(d.join("\n")).not.toMatch(/\/Users\/me|sk-ant-api03-abcdef/u);
  });
});

describe("Settings AI helper row", () => {
  const AGENTS = [{ id: "claude" as const, name: "Claude" }, { id: "codex" as const, name: "ChatGPT" }];
  const labels = (s: Parameters<typeof aiRowActions>[0]): string[] => aiRowActions(s, AGENTS).map((a) => a.label);
  it("no AI yet: connect either", () => {
    expect(labels({ agent: null, agentConnected: false, phase: "start" })).toEqual(["Connect Claude", "Connect ChatGPT"]);
  });
  it("not signed in: Sign in is the main button, with Switch and Sign out", () => {
    const a = aiRowActions({ agent: "codex", agentConnected: false, phase: "ready" }, AGENTS);
    expect(a.map((x) => x.label)).toEqual(["Sign in", "Switch to Claude", "Sign out"]);
    expect(a[0]?.primary).toBe(true);
  });
  it("connected: still offers Sign in again, Switch and Sign out", () => {
    expect(labels({ agent: "claude", agentConnected: true, phase: "ready" })).toEqual(["Sign in again", "Switch to ChatGPT", "Sign out"]);
  });
  it("is disabled while the app is working", () => {
    expect(aiRowActions({ agent: "claude", agentConnected: true, phase: "working" }, AGENTS).every((a) => a.disabled)).toBe(true);
    expect(aiRowActions({ agent: "claude", agentConnected: true, phase: "ready" }, AGENTS).some((a) => a.disabled)).toBe(false);
  });
});

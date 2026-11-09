/**
 * Silent self-healing for Figma UI breakage. No UI, no labels: a non-technical designer never sees any of this.
 *
 * SELECTORS ARE DATA. The Figma selector table is src/figma/selectors.default.json (per key: ordered selectors,
 * goal, kind, healable, expectTerms), validated with zod (figma/selectors.ts) and bundled into dist. Layering:
 * learned overrides (selector-overrides.json, written by this pipeline) > optional <userData>/selectors.local.json
 * hotfix (same schema, only `selectors` honoured, every selector grammar-checked) > JSON defaults.
 *
 * HOW IT WORKS
 *  - The adapter tries learned overrides first, then the local hotfix, then the JSON selectors.
 *  - If a HEALABLE key (healable: true in the JSON; see healable.ts) finds nothing at the point where its flow
 *    would otherwise fail (code switch, file-actions menu, Download code, Upload, Create file, Rename, prompt box,
 *    Send, Stop, Save, quick-open), the adapter builds a SANITISED outline of the page (interactive elements only,
 *    no editor/file contents, no typed values, redacted) and asks the user's OWN connected AI CLI (Claude Code /
 *    Codex, one-shot, tool-less, read-only) for selectors.
 *  - The AI reply is untrusted. Each selector must pass a strict grammar, resolve to exactly one visible, enabled
 *    element whose own label contains an expected term, and be of the right shape for the key (menu items must be
 *    inside an open menu; inputs must be editable). The adapter's normal action for that key must then succeed
 *    (its post-condition: editor visible, menu opens, download starts, file chooser opens, name input appears,
 *    text retained, prompt accepted...). "indicator" keys (Stop) are only observed, never clicked. Only then is the
 *    override persisted. Destructive keys (delete, confirm delete) are never healable (schema-enforced).
 *    Overrides expire after 30 days or 3 consecutive misses. Max 2 AI calls per key per session, 1h cooldown after
 *    a failed heal. The AI never receives a page handle and never executes anything.
 *
 * WIRING (facade author; nothing here touches main.ts/contracts/renderer)
 *   import { createHealContext } from "../heal/index.js";
 *   import { createOneShotRunner } from "../harness/oneshot.js";
 *   import { createPlaywrightAdapter } from "../figma/adapter.js";
 *
 *   const runOneShot = createOneShotRunner();                       // once, in the main process
 *   const heal = createHealContext({
 *     userDataDir: app.getPath("userData"),                          // store: <userData>/selector-overrides.json
 *                                                                    // hotfix: <userData>/selectors.local.json (optional)
 *     artifactsDir: <the same artifacts dir used by ProjectStatePaths>,   // optional, outline diagnostics
 *     runOneShot,
 *     getAgentId: () => settings.agent ?? null,                      // the agent chosen in onboarding ("claude" | "codex")
 *   });
 *   await heal.store.load();                                         // optional; the adapter also loads it lazily
 *   // Pass it through the existing adapterFactory hook of the service dependencies:
 *   new FigmakeService({ adapterFactory: (ctx) => createPlaywrightAdapter({ ...ctx, heal }) });
 *
 * Pass no `heal` (or no agent) and behaviour is exactly the JSON-defaults one. Healing is skipped silently when
 * no agent is connected or signed in.
 */
import path from "node:path";

import type { AgentId } from "../harness/agents/types.js";
import type { RunOneShot } from "../harness/oneshot.js";
import { SelectorOverrideStore } from "./overrideStore.js";
import { buildHealPrompt, parseHealReply } from "./prompt.js";
import type { HealContext, Healer } from "./types.js";

export { HEALABLE, containsAnyTerm, containsTerm, isHealable } from "./healable.js";
export { gateSelector } from "./gate.js";
export { HealSession, MAX_HEAL_ATTEMPTS_PER_KEY } from "./heal.js";
export { collectOutline, redact, sanitizeOutline, type OutlineElement, type PageOutline } from "./outline.js";
export { SelectorOverrideStore, OVERRIDE_TTL_MS, OVERRIDE_MAX_CONSECUTIVE_MISSES } from "./overrideStore.js";
export { buildHealPrompt, parseHealReply } from "./prompt.js";
export { filterSelectors, validateSelectorGrammar } from "./selectorGrammar.js";
export type { HealContext, HealProposal, HealRequest, Healer } from "./types.js";

export interface CreateHealerOptions {
  runOneShot: RunOneShot;
  /** The user's chosen agent; null/undefined when none is connected (healer then returns null silently). */
  getAgentId: () => AgentId | null | undefined;
}

export function createHealer(opts: CreateHealerOptions): Healer {
  return async (request, signal) => {
    const agent = opts.getAgentId();
    if (!agent) return null;
    const res = await opts.runOneShot(agent, buildHealPrompt(request), signal);
    if (!res.ok) return null;
    return parseHealReply(res.text);
  };
}

export interface CreateHealContextOptions extends CreateHealerOptions {
  userDataDir: string;
  artifactsDir?: string | undefined;
  /** Override the store path (default <userDataDir>/selector-overrides.json). */
  storePath?: string | undefined;
  /** Override the hotfix file path (default <userDataDir>/selectors.local.json). */
  localSelectorsPath?: string | undefined;
}

export function createHealContext(opts: CreateHealContextOptions): HealContext {
  return {
    store: new SelectorOverrideStore({ filePath: opts.storePath ?? path.join(opts.userDataDir, "selector-overrides.json") }),
    healer: createHealer(opts),
    artifactsDir: opts.artifactsDir,
    localSelectorsPath: opts.localSelectorsPath ?? path.join(opts.userDataDir, "selectors.local.json"),
  };
}

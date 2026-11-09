import path from "node:path";

import fs from "fs-extra";
import type { Locator, Page } from "playwright";

import { gateSelector } from "./gate.js";
import { HEALABLE } from "./healable.js";
import { collectOutline } from "./outline.js";
import { filterSelectors } from "./selectorGrammar.js";
import type { HealContext } from "./types.js";

export const MAX_HEAL_ATTEMPTS_PER_KEY = 2;

export interface TryHealArgs {
  page: Page;
  key: string;
  failedSelectors: readonly string[];
  /**
   * Performs the adapter's own action on the gated locator and checks its post-condition (e.g. click the Code
   * toggle, then wait for the editor). Resolve true only if the post-condition holds. Must NOT throw for an
   * ordinary failure; abort errors may propagate.
   */
  act: (locator: Locator) => Promise<boolean>;
  signal?: AbortSignal | undefined;
  log?: ((msg: string, extra?: Record<string, unknown>) => void) | undefined;
}

/**
 * Per-session healing coordinator. Rate limit: at most MAX_HEAL_ATTEMPTS_PER_KEY healer calls per key per
 * session, plus a persisted cooldown after a failed heal. The persisted override is written ONLY after the
 * adapter action's post-condition passed.
 */
export class HealSession {
  private readonly attempts = new Map<string, number>();
  private readonly rejected = new Map<string, string[]>();
  private inflight = new Map<string, Promise<Locator | null>>();

  constructor(private readonly ctx: HealContext) {}

  get enabled(): boolean {
    return this.ctx.healer !== undefined;
  }

  tryHeal(args: TryHealArgs): Promise<Locator | null> {
    const existing = this.inflight.get(args.key);
    if (existing) return existing;
    const p = this.run(args).finally(() => this.inflight.delete(args.key));
    this.inflight.set(args.key, p);
    return p;
  }

  private async run(args: TryHealArgs): Promise<Locator | null> {
    const { key, page } = args;
    const spec = HEALABLE[key];
    const healer = this.ctx.healer;
    if (!spec || !healer) return null;
    const used = this.attempts.get(key) ?? 0;
    if (used >= MAX_HEAL_ATTEMPTS_PER_KEY) return null;
    if (used === 0 && this.ctx.store.inCooldown(key)) {
      args.log?.("heal skipped: recent failed attempt", { key });
      return null;
    }
    this.attempts.set(key, used + 1);

    const outline = await collectOutline(page);
    const rejectedSoFar = this.rejected.get(key) ?? [];
    const notes: Array<{ selector: string; verdict: string }> = [];
    let reason: string | undefined;

    try {
      const proposal = await healer(
        {
          key,
          goal: spec.goal,
          expectTerm: spec.expectTerm,
          expectTerms: [...spec.expectTerms],
          kind: spec.kind,
          failedSelectors: [...args.failedSelectors],
          rejectedProposals: rejectedSoFar,
          outline,
          attempt: used + 1,
        },
        args.signal,
      );
      reason = proposal?.reason;
      const { accepted, rejected } = filterSelectors(proposal?.selectors ?? [], 3);
      for (const r of rejected) notes.push({ selector: r.selector, verdict: `grammar: ${r.reason}` });

      for (const selector of accepted) {
        const gated = await gateSelector(page, selector, spec.expectTerms, spec.kind);
        if (!gated.ok) {
          notes.push({ selector, verdict: gated.reason });
          continue;
        }
        const worked = await args.act(gated.locator);
        if (!worked) {
          notes.push({ selector, verdict: "post-condition failed" });
          continue;
        }
        await this.ctx.store.set(key, [selector], outline.fingerprint);
        args.log?.("healed selector", { key, selector });
        return gated.locator;
      }
    } catch (e) {
      if (e instanceof Error && (e.name === "AutomationAbortedError" || e.name === "AbortError")) throw e;
      notes.push({ selector: "", verdict: `healer error: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}` });
    }

    this.rejected.set(key, [...rejectedSoFar, ...notes.map((n) => n.selector).filter(Boolean)].slice(-6));
    if (used + 1 >= MAX_HEAL_ATTEMPTS_PER_KEY) {
      this.ctx.store.recordHealFailure(key);
      await this.ctx.store.flush();
    }
    await this.saveOutlineDiagnostic(key, outline, { reason, notes, failedSelectors: [...args.failedSelectors] });
    args.log?.("heal failed", { key, notes });
    return null;
  }

  private async saveOutlineDiagnostic(key: string, outline: unknown, extra: Record<string, unknown>): Promise<void> {
    const dir = this.ctx.artifactsDir;
    if (!dir) return;
    try {
      await fs.ensureDir(dir);
      const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
      await fs.writeJson(path.join(dir, `${stamp}-heal-${key}.outline.json`), { key, ...extra, outline }, { spaces: 2 });
    } catch {
      // diagnostics are best-effort
    }
  }
}

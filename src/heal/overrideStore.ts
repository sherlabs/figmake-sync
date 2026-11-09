import path from "node:path";

import fs from "fs-extra";
import { z } from "zod";

import { validateSelectorGrammar } from "./selectorGrammar.js";

export const OVERRIDE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const OVERRIDE_MAX_CONSECUTIVE_MISSES = 3;
/** After a failed heal for a key, do not ask the AI again for this long (keeps a broken Figma from burning AI usage on every sync). */
export const HEAL_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

const entrySchema = z.object({
  selectors: z.array(z.string().max(200)).min(1).max(3),
  learnedAt: z.string(),
  figmaUiFingerprint: z.string().max(64),
  hits: z.number().int().nonnegative(),
  /** Consecutive misses (reset by a hit). */
  misses: z.number().int().nonnegative(),
});

const fileSchema = z.object({
  version: z.literal(1),
  overrides: z.record(entrySchema),
  failedHealAt: z.record(z.string()).default({}),
});

export type OverrideEntry = z.infer<typeof entrySchema>;
type FileData = z.infer<typeof fileSchema>;

export interface OverrideStoreOptions {
  filePath: string;
  now?: () => number;
  ttlMs?: number;
  maxMisses?: number;
}

/**
 * Learned selector overrides, one JSON file. In-memory reads (call load() once), atomic writes (tmp + rename),
 * schema-validated on load (a corrupt/tampered file is ignored, never thrown), and every stored selector is
 * re-checked against the selector grammar. Overrides expire after 30 days or after N consecutive misses.
 */
export class SelectorOverrideStore {
  private data: FileData = { version: 1, overrides: {}, failedHealAt: {} };
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxMisses: number;

  constructor(private readonly opts: OverrideStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? OVERRIDE_TTL_MS;
    this.maxMisses = opts.maxMisses ?? OVERRIDE_MAX_CONSECUTIVE_MISSES;
  }

  get filePath(): string {
    return this.opts.filePath;
  }

  async load(): Promise<void> {
    let raw: unknown;
    try {
      raw = await fs.readJson(this.opts.filePath);
    } catch {
      return;
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) return;
    const overrides: FileData["overrides"] = {};
    for (const [key, entry] of Object.entries(parsed.data.overrides)) {
      if (!entry.selectors.every((s) => validateSelectorGrammar(s).ok)) continue;
      if (this.expired(entry)) continue;
      overrides[key] = entry;
    }
    this.data = { version: 1, overrides, failedHealAt: parsed.data.failedHealAt };
    if (Object.keys(overrides).length !== Object.keys(parsed.data.overrides).length) this.dirty = true;
  }

  private expired(entry: OverrideEntry): boolean {
    const learned = Date.parse(entry.learnedAt);
    if (!Number.isFinite(learned) || this.now() - learned > this.ttlMs) return true;
    return entry.misses >= this.maxMisses;
  }

  /** Selectors to try before the built-in defaults; [] when none or expired. */
  get(key: string): string[] {
    const e = this.data.overrides[key];
    if (!e) return [];
    if (this.expired(e)) {
      delete this.data.overrides[key];
      this.dirty = true;
      return [];
    }
    return [...e.selectors];
  }

  entry(key: string): OverrideEntry | undefined {
    return this.data.overrides[key];
  }

  async set(key: string, selectors: string[], figmaUiFingerprint: string): Promise<void> {
    const ok = selectors.filter((s) => validateSelectorGrammar(s).ok).slice(0, 3);
    if (ok.length === 0) return;
    this.data.overrides[key] = {
      selectors: ok,
      learnedAt: new Date(this.now()).toISOString(),
      figmaUiFingerprint,
      hits: 0,
      misses: 0,
    };
    delete this.data.failedHealAt[key];
    this.dirty = true;
    await this.flush();
  }

  /** In-memory; persisted by the next flush(). */
  recordHit(key: string): void {
    const e = this.data.overrides[key];
    if (!e) return;
    e.hits += 1;
    e.misses = 0;
    this.dirty = true;
  }

  /** The override did not match while a built-in selector did. Drops it once the miss budget is spent. */
  async recordMiss(key: string): Promise<void> {
    const e = this.data.overrides[key];
    if (!e) return;
    e.misses += 1;
    if (e.misses >= this.maxMisses) delete this.data.overrides[key];
    this.dirty = true;
    await this.flush();
  }

  async remove(key: string): Promise<void> {
    if (!this.data.overrides[key]) return;
    delete this.data.overrides[key];
    this.dirty = true;
    await this.flush();
  }

  recordHealFailure(key: string): void {
    this.data.failedHealAt[key] = new Date(this.now()).toISOString();
    this.dirty = true;
  }

  inCooldown(key: string): boolean {
    const at = this.data.failedHealAt[key];
    const t = at ? Date.parse(at) : NaN;
    return Number.isFinite(t) && this.now() - t < HEAL_FAILURE_COOLDOWN_MS;
  }

  /** Atomic write (tmp file + rename). Serialised; never throws (a failed write only loses the cache). */
  flush(): Promise<void> {
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.then(async () => {
      const tmp = `${this.opts.filePath}.${process.pid}.${this.now()}.tmp`;
      try {
        await fs.ensureDir(path.dirname(this.opts.filePath));
        await fs.writeFile(tmp, snapshot, { mode: 0o600 });
        await fs.rename(tmp, this.opts.filePath);
      } catch {
        await fs.remove(tmp).catch(() => undefined);
      }
    });
    return this.writing;
  }
}

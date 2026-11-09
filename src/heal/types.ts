import type { SelectorKind } from "../figma/selectors.js";
import type { PageOutline } from "./outline.js";
import type { SelectorOverrideStore } from "./overrideStore.js";

/** What the adapter asks the healer. Contains only sanitised evidence, never a page handle. */
export interface HealRequest {
  key: string;
  goal: string;
  expectTerm: string;
  /** Any of these (whole word, case-insensitive) must appear in the element's own label. */
  expectTerms: string[];
  kind: SelectorKind;
  /** Selectors that were tried and found nothing. */
  failedSelectors: string[];
  /** Earlier proposals this session that were rejected (so the AI does not repeat them). */
  rejectedProposals: string[];
  outline: PageOutline;
  attempt: number;
}

export interface HealProposal {
  selectors: string[];
  reason?: string | undefined;
}

/** Returns UNTRUSTED proposals (or null). The adapter validates every selector before using it. */
export type Healer = (request: HealRequest, signal?: AbortSignal) => Promise<HealProposal | null>;

/** Injected into AdapterContext.heal. Absent => adapter behaves exactly as before. */
export interface HealContext {
  store: SelectorOverrideStore;
  /** Optional: with only a store, learned overrides are still applied, nothing new is learned. */
  healer?: Healer | undefined;
  /** Where to drop the sanitised outline diagnostic when healing fails (the existing artifacts dir). */
  artifactsDir?: string | undefined;
  /** Optional hotfix file (same schema as selectors.default.json; only `selectors` honoured). Default: none. */
  localSelectorsPath?: string | undefined;
}

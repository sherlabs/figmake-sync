/* Pure, browser-safe description of which AI models can be chosen (the window imports this too). */

/** A model id goes to the AI's command line as one argument, so it is a plain token: no spaces and never a leading dash. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-/[\]]{0,63}$/u;

export type ModelAgent = "claude" | "codex";

export const MSG_BAD_MODEL = "Use letters, numbers and . _ : - / only, up to 64 characters, with no spaces.";

/** Returns the id when it is acceptable, otherwise null. */
export function validModel(model: unknown): string | null {
  return typeof model === "string" && MODEL_ID.test(model) ? model : null;
}

export interface ModelOption {
  /** null = "Default": no model flag at all, so the AI uses its own setting. */
  id: string | null;
  label: string;
}

/**
 * Aliases only, never dated model ids that go stale.
 * Claude: `claude --help` documents the aliases 'fable', 'opus' and 'sonnet'; `haiku` was checked with a real run.
 * Codex: model names differ per account and change often, so only the CLI's own default plus a typed name.
 */
export const MODEL_OPTIONS: Record<ModelAgent, readonly ModelOption[]> = {
  claude: [
    { id: null, label: "Default" },
    { id: "fable", label: "Fable" },
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ],
  codex: [{ id: null, label: "Default" }],
};

/** The words shown for a choice: "Default", "Sonnet", or the typed name as it is. */
export function modelLabel(agent: ModelAgent, model: string | null): string {
  if (model === null) return "Default";
  return MODEL_OPTIONS[agent].find((o) => o.id === model)?.label ?? model;
}

/** Why a typed model name can't be used, or null when it can. */
export function modelProblem(text: string): string | null {
  const t = text.trim();
  if (!t) return "Type a model name.";
  return MODEL_ID.test(t) ? null : MSG_BAD_MODEL;
}

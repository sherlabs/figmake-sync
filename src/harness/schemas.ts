import { z } from "zod";

/** Validated IPC inputs (main process parses every renderer payload with these). */
const rootDir = z.string().min(1).refine((v) => !v.includes("\0"), "invalid path");

export const rootDirInputSchema = z.object({ rootDir });

export const updateSettingsInputSchema = z.object({
  rootDir,
  patch: z
    .object({
      preferredAgent: z.enum(["claude", "codex"]).optional(),
      autoPush: z.boolean().optional(),
    })
    .strict(),
});

export const runAgentInputSchema = z.object({
  rootDir,
  prompt: z.string().trim().min(1).max(50_000),
  agent: z.enum(["claude", "codex"]).optional(),
  /** true = ignore the stored session and start a fresh conversation. */
  newSession: z.boolean().optional(),
});

export type RunAgentInput = z.infer<typeof runAgentInputSchema>;

import { randomUUID } from "node:crypto";
import path from "node:path";

import { z } from "zod";

export const DEFAULT_IGNORE_PATTERNS = [
  ".figmake-sync/**",
  ".git/**",
  "node_modules/**",
  "dist/**",
  ".gitignore",
  ".DS_Store",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
] as const;

export const DEFAULT_POST_UPLOAD_PROMPT_TEMPLATE =
  "I added the following files.\n{{files}}\nEnsure imports and references are wired correctly without changing unrelated functionality.";

const selectorOverridesSchema = z
  .record(z.string(), z.array(z.string()).min(1))
  .default({});

export const projectConfigSchema = z.object({
  version: z.literal(1),
  projectId: z.string().min(8),
  figmaMakeUrl: z.string().url(),
  localRoot: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  adapter: z
    .object({
      profileDir: z.string().default(".figmake-sync/browser-profile"),
      browserChannel: z.string().optional(),
      headless: z.boolean().optional(),
      headlessAuth: z.boolean().default(false),
      headlessAutomation: z.boolean().default(true),
      slowMoMs: z.number().int().min(0).default(0),
      actionTimeoutMs: z.number().int().positive().default(45_000),
      navigationTimeoutMs: z.number().int().positive().default(120_000),
      downloadTimeoutMs: z.number().int().positive().default(180_000),
      verifyEditorWrites: z.boolean().default(false),
      selectorOverrides: selectorOverridesSchema,
      promptAfterUpload: z.boolean().default(false),
      postUploadPromptTemplate: z.string().optional(),
    })
    .default({}),
  sync: z
    .object({
      ignore: z.array(z.string()).default([...DEFAULT_IGNORE_PATTERNS]),
      safePullStrategy: z.enum(["backup", "merge", "abort"]).default("backup"),
      backupRetention: z.number().int().min(1).max(100).default(20),
    })
    .default({}),
  logging: z
    .object({
      level: z.enum(["silent", "info", "debug"]).default("info"),
    })
    .default({}),
});

export type ProjectConfig = z.output<typeof projectConfigSchema>;
export type PullStrategy = ProjectConfig["sync"]["safePullStrategy"];
export type LogLevel = ProjectConfig["logging"]["level"];

export interface CommandRuntimeOptions {
  cwd?: string;
  projectRoot?: string;
  verbose?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  prompt?: boolean;
  strategy?: PullStrategy;
  progress?: (message: string) => void;
  confirm?: (message: string, defaultValue?: boolean) => Promise<boolean>;
  waitForManualAction?: (message: string) => Promise<void>;
}

export function createProjectConfig(
  figmaMakeUrl: string,
  localRoot: string,
): ProjectConfig {
  const now = new Date().toISOString();

  return projectConfigSchema.parse({
    version: 1,
    projectId: randomUUID(),
    figmaMakeUrl,
    localRoot: path.resolve(localRoot),
    createdAt: now,
    updatedAt: now,
  });
}

export function parseProjectConfig(value: unknown): ProjectConfig {
  return projectConfigSchema.parse(value);
}

export function updateProjectConfig(
  config: ProjectConfig,
  patch: Partial<ProjectConfig>,
): ProjectConfig {
  return projectConfigSchema.parse({
    ...config,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

export function renderPostUploadPrompt(
  template: string | undefined,
  relativePaths: readonly string[],
): string {
  const fileBlock = relativePaths
    .map((relativePath) => `- ${relativePath}`)
    .join("\n");
  const source = template ?? DEFAULT_POST_UPLOAD_PROMPT_TEMPLATE;

  return source.replaceAll("{{files}}", fileBlock);
}

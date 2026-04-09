#!/usr/bin/env node

import { Command } from "commander";

import { FigmakeSyncService } from "../core/service.js";
import {
  type ManifestDiff,
  type ManifestDiffSummary,
} from "../diff/manifest.js";
import type { CommandRuntimeOptions, PullStrategy } from "../types/config.js";

const service = new FigmakeSyncService();

function collectRuntimeOptions(command: Command): CommandRuntimeOptions {
  const options = command.optsWithGlobals<{
    project?: string;
    dryRun?: boolean;
    verbose?: boolean;
    yes?: boolean;
    prompt?: boolean;
  }>();

  return {
    ...(options.project ? { projectRoot: options.project } : {}),
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
    ...(options.yes !== undefined ? { yes: options.yes } : {}),
    ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
    progress: (message: string) => {
      console.log(message);
    },
  };
}

function printSummary(label: string, summary: ManifestDiffSummary): void {
  console.log(label);
  console.log(`added: ${summary.added}`);
  console.log(`modified: ${summary.modified}`);
  console.log(`deleted: ${summary.deleted}`);
  console.log(`renamed: ${summary.renamed}`);
}

function printDiffDetails(diff: ManifestDiff): void {
  if (diff.added.length > 0) {
    console.log("added files:");
    for (const entry of diff.added) {
      console.log(`  + ${entry.path}`);
    }
  }

  if (diff.modified.length > 0) {
    console.log("modified files:");
    for (const entry of diff.modified) {
      console.log(`  ~ ${entry.current.path}`);
    }
  }

  if (diff.deleted.length > 0) {
    console.log("deleted files:");
    for (const entry of diff.deleted) {
      console.log(`  - ${entry.path}`);
    }
  }

  if (diff.renamed.length > 0) {
    console.log("renamed files:");
    for (const entry of diff.renamed) {
      console.log(`  r ${entry.from} -> ${entry.to}`);
    }
  }
}

async function main(): Promise<void> {
  const program = new Command();
  const getCommand = (args: unknown[]): Command => args.at(-1) as Command;

  program
    .name("figmake-sync")
    .description(
      "Local-first sync agent for Figma Make projects using your own authenticated browser session.",
    )
    .option("-C, --project <path>", "project root containing .figmake-sync")
    .option(
      "--dry-run",
      "show intended actions without mutating local or remote state",
    )
    .option("--verbose", "enable debug logging")
    .option("-y, --yes", "auto-confirm destructive prompts");

  program
    .command("init")
    .description("Initialize a local folder and link it to a Figma Make URL.")
    .argument("<figma-make-url>", "linked Figma Make URL")
    .argument("[local-folder]", "local project folder")
    .action(
      async (
        figmaMakeUrl: string,
        localFolder: string | undefined,
        command: Command,
      ) => {
        const result = await service.init(
          figmaMakeUrl,
          localFolder,
          collectRuntimeOptions(command),
        );

        console.log(`linked ${result.rootDir}`);
        console.log(`state directory: ${result.stateDir}`);
        console.log(`config: ${result.configPath}`);
      },
    );

  program
    .command("auth")
    .description(
      "Launch a persistent Playwright browser context so you can authenticate manually.",
    )
    .action(async (...args: unknown[]) => {
      const command = getCommand(args);
      await service.auth(collectRuntimeOptions(command));
      console.log("browser session saved locally");
    });

  program
    .command("pull")
    .description(
      "Download the latest code snapshot from Figma Make into the linked local folder.",
    )
    .option(
      "--strategy <strategy>",
      "conflict handling strategy: backup, merge, or abort",
      "backup",
    )
    .action(async (...args: unknown[]) => {
      const command = getCommand(args);
      const options = collectRuntimeOptions(command);
      const strategy = command.opts<{
        strategy: PullStrategy;
      }>().strategy;
      const result = await service.pull({
        ...options,
        strategy,
      });

      console.log(`downloaded and extracted ${result.extractedFiles} files`);
      printSummary(
        "remote changes since the last synced snapshot:",
        result.remoteSummary,
      );

      if (result.backupDir) {
        console.log(`backup saved: ${result.backupDir}`);
      }

      if (result.conflicts.length > 0) {
        console.log(
          `merge conflicts preserved locally: ${result.conflicts.length}`,
        );
        for (const relativePath of result.conflicts) {
          console.log(`  ! ${relativePath}`);
        }
      }
    });

  program
    .command("sync-from-figma")
    .description(
      "Safe pull alias that warns about local changes and supports backup or merge strategies.",
    )
    .option(
      "--strategy <strategy>",
      "conflict handling strategy: backup, merge, or abort",
      "backup",
    )
    .action(async (...args: unknown[]) => {
      const command = getCommand(args);
      const options = collectRuntimeOptions(command);
      const strategy = command.opts<{
        strategy: PullStrategy;
      }>().strategy;
      const result = await service.syncFromFigma({
        ...options,
        strategy,
      });

      console.log(`downloaded and extracted ${result.extractedFiles} files`);
      printSummary(
        "remote changes since the last synced snapshot:",
        result.remoteSummary,
      );
    });

  program
    .command("status")
    .description("Show local changes relative to the last synced snapshot.")
    .action(async (...args: unknown[]) => {
      const command = getCommand(args);
      const result = await service.status(collectRuntimeOptions(command));

      if (!result.hasBaseline) {
        console.log("no baseline snapshot yet; run figmake-sync pull first");
        return;
      }

      printSummary(
        "local changes since the last synced snapshot:",
        result.summary,
      );

      if (result.diff) {
        printDiffDetails(result.diff);
      }
    });

  program
    .command("push")
    .description(
      "Apply local changes into Figma Make using the authenticated browser session.",
    )
    .option(
      "--prompt",
      "send the configured contextual prompt after adding new files",
    )
    .action(async (...args: unknown[]) => {
      const command = getCommand(args);
      const result = await service.push(collectRuntimeOptions(command));

      printSummary("pushed local changes:", result.summary);

      if (result.unresolved.length > 0) {
        console.log("unresolved items:");
        for (const entry of result.unresolved) {
          console.log(`  ! ${entry.path}: ${entry.reason}`);
        }
      }
    });

  program
    .command("verify")
    .description(
      "Re-download the remote project and compare it against the local workspace.",
    )
    .action(async (...args: unknown[]) => {
      const command = getCommand(args);
      const result = await service.verify(collectRuntimeOptions(command));

      printSummary("remote drift results:", result.drift.summary);

      if (result.drift.diff) {
        printDiffDetails(result.drift.diff);
      }

      if (result.preview) {
        console.log("sample drift preview:");
        console.log(result.preview);
      }

      if (result.drift.summary.total > 0) {
        process.exitCode = 1;
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error(message);
  process.exitCode = 1;
});

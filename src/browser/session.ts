import path from "node:path";

import fs from "fs-extra";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Logger } from "pino";

import { waitForEnter } from "../utils/prompt.js";

export interface BrowserSessionOptions {
  userDataDir: string;
  artifactsDir: string;
  headless: boolean;
  slowMoMs: number;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
  browserChannel: string | undefined;
  logger: Logger;
}

export interface AuthenticateBrowserSessionOptions {
  waitForCompletion?: (message: string) => Promise<void>;
  headless?: boolean;
}

export interface BrowserLaunchOverrides {
  headless?: boolean;
  slowMoMs?: number;
}

export interface PersistentBrowserHandle {
  context: BrowserContext;
  page: Page;
  tracePath: string;
  runStep<T>(stepName: string, operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function artifactName(prefix: string, extension: string): string {
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");

  return `${stamp}-${prefix}.${extension}`;
}

export class BrowserSessionManager {
  constructor(private readonly options: BrowserSessionOptions) {}

  async authenticate(
    manualUrl: string,
    options: AuthenticateBrowserSessionOptions = {},
  ): Promise<void> {
    const handle = await this.openHandle("auth", manualUrl, {
      headless: options.headless ?? false,
    });

    try {
      const waitForCompletion =
        options.waitForCompletion ??
        ((message: string) =>
          waitForEnter(`${message}\nPress Enter here once you're done.`));

      await waitForCompletion(
        "Browser session is ready for manual authentication. Log in to Figma Make in the opened browser, complete MFA or captcha if prompted, then confirm here to save the local session.",
      );
    } finally {
      await handle.close();
    }
  }

  async openHandle(
    purpose: string,
    targetUrl?: string,
    launchOverrides: BrowserLaunchOverrides = {},
  ): Promise<PersistentBrowserHandle> {
    await Promise.all([
      fs.ensureDir(this.options.userDataDir),
      fs.ensureDir(this.options.artifactsDir),
    ]);

    const context = await chromium.launchPersistentContext(
      this.options.userDataDir,
      {
        acceptDownloads: true,
        ...(this.options.browserChannel
          ? { channel: this.options.browserChannel }
          : {}),
        headless: launchOverrides.headless ?? this.options.headless,
        slowMo: launchOverrides.slowMoMs ?? this.options.slowMoMs,
        viewport: { width: 1440, height: 960 },
      },
    );

    context.setDefaultTimeout(this.options.actionTimeoutMs);
    context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);

    const page = context.pages()[0] ?? (await context.newPage());
    const tracePath = path.join(
      this.options.artifactsDir,
      artifactName(`${purpose}-trace`, "zip"),
    );

    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });

    if (targetUrl) {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    }

    return {
      context,
      page,
      tracePath,
      runStep: async <T>(
        stepName: string,
        operation: () => Promise<T>,
      ): Promise<T> => {
        try {
          return await operation();
        } catch (error) {
          const screenshotPath = path.join(
            this.options.artifactsDir,
            artifactName(`${purpose}-${stepName}`, "png"),
          );

          this.options.logger.error(
            {
              purpose,
              stepName,
              screenshotPath,
            },
            "browser step failed",
          );

          try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
          } catch (screenshotError) {
            this.options.logger.warn(
              { error: screenshotError, purpose, stepName },
              "failed to capture screenshot after browser error",
            );
          }

          throw error;
        }
      },
      close: async (): Promise<void> => {
        try {
          await context.tracing.stop({ path: tracePath });
        } catch (traceError) {
          this.options.logger.warn(
            { error: traceError, purpose },
            "failed to stop trace cleanly",
          );
        }

        await context.close();
      },
    };
  }
}

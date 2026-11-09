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
  skipLoginCheck?: boolean;
}

export interface PersistentBrowserHandle {
  context: BrowserContext;
  page: Page;
  tracePath: string;
  runStep<T>(stepName: string, operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class AuthRequiredError extends Error {
  constructor(
    message = "Figma session is not authenticated or has expired. Run `figmake-sync auth` (or re-authenticate in the app) and try again.",
  ) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export class ProfileInUseError extends Error {
  constructor(userDataDir: string, cause?: unknown) {
    super(
      `Another figmake browser is already using this profile (${userDataDir}). Close it (or wait for the running sync to finish) and try again.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "ProfileInUseError";
  }
}

const LOGIN_PATH = /^\/(login|signup|sso|saml|oauth|auth)(\/|$)/u;
const FIGMA_HOME = "https://www.figma.com/files";
const CLOSE_TIMEOUT_MS = 15_000;
const ARTIFACT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const ARTIFACT_MAX_FILES = 40;

export function isLoginUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)figma\.com$/u.test(parsed.hostname)) {
      return false;
    }
    return LOGIN_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isProfileInUseMessage(message: string): boolean {
  return /ProcessSingleton|SingletonLock|profile appears to be in use|already in use|Opening in existing browser session/iu.test(
    message,
  );
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockPid(userDataDir: string): Promise<number | undefined> {
  try {
    const target = await fs.readlink(path.join(userDataDir, "SingletonLock"));
    const match = /-(\d+)$/u.exec(target);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** Remove Chromium Singleton* files left by a crashed process. */
async function clearStaleProfileLock(userDataDir: string): Promise<void> {
  const pid = await readLockPid(userDataDir);
  if (pid === undefined || pidAlive(pid)) {
    return;
  }
  await Promise.all(
    ["SingletonLock", "SingletonCookie", "SingletonSocket"].map((name) =>
      fs.remove(path.join(userDataDir, name)).catch(() => undefined),
    ),
  );
}

async function pruneArtifacts(dir: string): Promise<void> {
  try {
    const names = await fs.readdir(dir);
    const entries = (
      await Promise.all(
        names.map(async (name) => {
          const full = path.join(dir, name);
          const stat = await fs.stat(full).catch(() => undefined);
          return stat?.isFile() ? { full, mtime: stat.mtimeMs } : undefined;
        }),
      )
    )
      .filter((entry) => entry !== undefined)
      .sort((a, b) => b.mtime - a.mtime);
    const cutoff = Date.now() - ARTIFACT_MAX_AGE_MS;
    await Promise.all(
      entries
        .filter(
          (entry, index) => index >= ARTIFACT_MAX_FILES || entry.mtime < cutoff,
        )
        .map((entry) => fs.remove(entry.full).catch(() => undefined)),
    );
  } catch {
    // best effort
  }
}

async function looksLoggedOut(page: Page): Promise<boolean> {
  if (isLoginUrl(page.url())) {
    return true;
  }
  try {
    return (
      (await page
        .locator('input[type="password"], form[action*="login"]')
        .count()) > 0
    );
  } catch {
    return false;
  }
}

/**
 * Check whether the profile holds a live Figma session. authenticated=null
 * means undetermined (profile busy, browser missing, offline).
 */
export async function probeLoginState(
  profileDir: string,
): Promise<{ authenticated: boolean | null; reason?: string }> {
  if (!(await fs.pathExists(profileDir))) {
    return { authenticated: false, reason: "no browser profile yet" };
  }
  const pid = await readLockPid(profileDir);
  if (pid !== undefined && pidAlive(pid)) {
    return {
      authenticated: null,
      reason: "profile in use by a running browser",
    };
  }
  await clearStaleProfileLock(profileDir);

  let context: BrowserContext | undefined;
  try {
    // Same context options as openHandle (viewport); only headless differs.
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 1440, height: 960 },
    });
    const cookies = await context.cookies("https://www.figma.com");
    if (cookies.length === 0) {
      return { authenticated: false, reason: "no Figma cookies" };
    }
    const page = context.pages()[0] ?? (await context.newPage());
    // Headless Chromium advertises "HeadlessChrome" in its UA, which Figma may
    // treat as a bot; send the normal Chrome UA like the headed sessions do.
    try {
      const ua = await page.evaluate(() => navigator.userAgent);
      if (ua.includes("HeadlessChrome")) {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.setUserAgentOverride", {
          userAgent: ua.replace("HeadlessChrome", "Chrome"),
        });
      }
    } catch {
      // best effort; probe is advisory
    }
    await page.goto(FIGMA_HOME, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await page.waitForTimeout(1_000);
    if (await looksLoggedOut(page)) {
      return { authenticated: false, reason: "redirected to login" };
    }
    return { authenticated: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { authenticated: null, reason: message.split("\n")[0] ?? message };
  } finally {
    if (context) {
      await Promise.race([
        context.close().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
      ]);
    }
  }
}

const activeHandles = new Set<PersistentBrowserHandle>();

/** Close every open browser handle (for SIGINT/SIGTERM/before-quit). */
export async function closeAllBrowserHandles(): Promise<void> {
  await Promise.allSettled([...activeHandles].map((handle) => handle.close()));
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
      skipLoginCheck: true,
    });

    try {
      const waitForCompletion =
        options.waitForCompletion ??
        ((message: string) =>
          waitForEnter(`${message}\nPress Enter here once you're done.`));

      await waitForCompletion(
        "Browser session is ready for manual authentication. Log in to Figma Make in the opened browser, complete MFA or captcha if prompted, then confirm here to save the local session.",
      );

      await this.verifyLoggedIn(handle);
    } finally {
      await handle.close();
    }
  }

  private async verifyLoggedIn(handle: PersistentBrowserHandle): Promise<void> {
    try {
      let page = handle.page;
      if (page.isClosed()) {
        page = await handle.context.newPage();
      }
      if (!isLoginUrl(page.url()) && !page.isClosed()) {
        const cookies = await handle.context.cookies("https://www.figma.com");
        if (cookies.length > 0 && !(await looksLoggedOut(page))) {
          return;
        }
      }
      await page.goto(FIGMA_HOME, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1_000);
      if (await looksLoggedOut(page)) {
        throw new AuthRequiredError(
          "Login was not completed: the browser is still on the Figma login page. Run auth again and finish signing in before confirming.",
        );
      }
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        throw error;
      }
      throw new AuthRequiredError(
        `Could not verify the Figma login (the browser window may have been closed): ${
          error instanceof Error ? error.message.split("\n")[0] : String(error)
        }`,
      );
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

    await clearStaleProfileLock(this.options.userDataDir);
    void pruneArtifacts(this.options.artifactsDir);

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isProfileInUseMessage(message)) {
        throw new ProfileInUseError(this.options.userDataDir, error);
      }
      throw error;
    }

    let page: Page;
    let tracePath: string;
    try {
      context.setDefaultTimeout(this.options.actionTimeoutMs);
      context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);

      page = context.pages()[0] ?? (await context.newPage());
      tracePath = path.join(
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
        if (!launchOverrides.skipLoginCheck) {
          await page.waitForTimeout(1_000);
          if (await looksLoggedOut(page)) {
            throw new AuthRequiredError();
          }
        }
      }
    } catch (error) {
      await this.hardClose(context);
      throw error;
    }

    let closePromise: Promise<void> | undefined;
    const handle: PersistentBrowserHandle = {
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
      close: (): Promise<void> => {
        closePromise ??= (async () => {
          activeHandles.delete(handle);
          try {
            await Promise.race([
              context.tracing.stop({ path: tracePath }),
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error("trace stop timed out")),
                  CLOSE_TIMEOUT_MS,
                ),
              ),
            ]);
          } catch (traceError) {
            this.options.logger.warn(
              { error: traceError, purpose },
              "failed to stop trace cleanly",
            );
          }

          await this.hardClose(context);
        })();
        return closePromise;
      },
    };

    activeHandles.add(handle);
    return handle;
  }

  /** Close with a timeout; kill the profile's browser process if it hangs. Never throws. */
  private async hardClose(context: BrowserContext): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      context.close().then(
        () => false,
        (error: unknown) => {
          this.options.logger.warn({ error }, "browser context close failed");
          return false;
        },
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), CLOSE_TIMEOUT_MS);
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
    if (timedOut) {
      this.options.logger.warn("browser close timed out; killing process");
      const pid = await readLockPid(this.options.userDataDir);
      if (pid !== undefined && pid !== process.pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }
}

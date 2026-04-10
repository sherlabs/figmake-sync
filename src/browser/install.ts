import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);

export interface InstallPlaywrightBrowserOptions {
  browser?: "chromium";
  progress?: (event: BrowserInstallProgressEvent) => void;
}

export interface BrowserInstallResult {
  browser: "chromium";
  status: "installed" | "already-installed";
}

export interface BrowserInstallProgressEvent {
  message: string;
  percent?: number;
  phase: "starting" | "downloading" | "installing" | "complete" | "log";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

interface PlaywrightPackageJson {
  bin?: string | Record<string, string>;
}

const ansiPattern =
  /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu;

function normalizeProgressLine(rawLine: string): string {
  return rawLine.replace(ansiPattern, "").replace(/\s+/gu, " ").trim();
}

function buildInstallEnv(): NodeJS.ProcessEnv {
  const existingDebug = process.env.DEBUG?.trim();
  const debugChannels = new Set(
    existingDebug ? existingDebug.split(",").map((value) => value.trim()) : [],
  );

  debugChannels.add("pw:install");

  return {
    ...process.env,
    DEBUG: [...debugChannels].join(","),
    DEBUG_COLORS: "0",
    ELECTRON_RUN_AS_NODE: "1",
  };
}

export function parseInstallProgressLine(
  rawLine: string,
): BrowserInstallProgressEvent | null {
  const line = normalizeProgressLine(rawLine);

  if (!line) {
    return null;
  }

  if (/installed successfully/i.test(line)) {
    return {
      message: line,
      percent: 100,
      phase: "complete",
    };
  }

  const percentMatch = line.match(/(?:^|\s)(\d{1,3})%(?=\s|\||$)/u);

  if (percentMatch) {
    const percent = Math.min(100, Math.max(0, Number(percentMatch[1])));
    const transferDetails = line.includes("|")
      ? line.split("|").slice(1).join("|").trim()
      : undefined;

    return {
      message: transferDetails
        ? `Downloading browser runtime (${transferDetails})`
        : `Downloading browser runtime (${percent}%)`,
      percent,
      phase: "downloading",
    };
  }

  if (/installing playwright/i.test(line)) {
    return {
      message: line,
      phase: "starting",
    };
  }

  if (/downloading|downloaded|chrome for testing|chromium/i.test(line)) {
    return {
      message: line,
      phase: "downloading",
    };
  }

  if (/extract|validat|install/i.test(line)) {
    return {
      message: line,
      phase: "installing",
    };
  }

  return {
    message: line,
    phase: "log",
  };
}

function createProgressParser(
  emit: (event: BrowserInstallProgressEvent) => void,
): {
  flush(): void;
  push(chunk: Buffer): void;
} {
  let pending = "";

  const emitLine = (rawLine: string): void => {
    const event = parseInstallProgressLine(rawLine);

    if (event) {
      emit(event);
    }
  };

  return {
    push(chunk: Buffer): void {
      pending += chunk.toString("utf8");
      const segments = pending.split(/[\r\n]+/u);

      pending = segments.pop() ?? "";

      for (const segment of segments) {
        emitLine(segment);
      }
    },
    flush(): void {
      if (pending) {
        emitLine(pending);
        pending = "";
      }
    },
  };
}

export function resolvePlaywrightCliPath(): string {
  const packageJsonPath = require.resolve("playwright/package.json");
  const packageJson =
    require("playwright/package.json") as PlaywrightPackageJson;
  const cliEntry =
    typeof packageJson.bin === "string"
      ? packageJson.bin
      : packageJson.bin?.playwright;

  if (!cliEntry) {
    throw new Error(
      "Unable to locate the Playwright CLI entrypoint from playwright/package.json.",
    );
  }

  return path.join(path.dirname(packageJsonPath), cliEntry);
}

export async function isBrowserInstalled(): Promise<boolean> {
  try {
    const pw = await import("playwright");
    const executablePath = pw.chromium.executablePath();
    if (!executablePath) return false;
    const fsModule = await import("fs-extra");
    return fsModule.pathExists(executablePath);
  } catch {
    return false;
  }
}

export function isPlaywrightBrowserMissingError(error: unknown): boolean {
  const message = getErrorMessage(error);

  return (
    message.includes("Executable doesn't exist") ||
    message.includes(
      "Please run the following command to download new browsers",
    ) ||
    message.includes("browserType.launchPersistentContext")
  );
}

export async function installPlaywrightBrowser(
  options: InstallPlaywrightBrowserOptions = {},
): Promise<BrowserInstallResult> {
  const browser = options.browser ?? "chromium";
  const cliPath = resolvePlaywrightCliPath();

  options.progress?.({
    message: `installing Playwright ${browser}`,
    phase: "starting",
  });

  return new Promise<BrowserInstallResult>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "install", browser], {
      env: buildInstallEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let combinedOutput = "";
    const stdoutParser = createProgressParser((event) => {
      options.progress?.(event);
    });
    const stderrParser = createProgressParser((event) => {
      options.progress?.(event);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      combinedOutput += chunk.toString("utf8");
      stdoutParser.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      combinedOutput += chunk.toString("utf8");
      stderrParser.push(chunk);
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", (code) => {
      stdoutParser.flush();
      stderrParser.flush();

      if (code === 0) {
        const alreadyInstalled =
          combinedOutput.includes("is already downloaded") ||
          combinedOutput.includes("already downloaded");

        options.progress?.({
          message: alreadyInstalled
            ? `Playwright ${browser} is already installed`
            : `Playwright ${browser} installed successfully`,
          percent: 100,
          phase: "complete",
        });
        resolve({
          browser,
          status: alreadyInstalled ? "already-installed" : "installed",
        });
        return;
      }

      reject(
        new Error(
          `Playwright ${browser} install failed with exit code ${code ?? "unknown"}.\n${combinedOutput.trim()}`,
        ),
      );
    });
  });
}

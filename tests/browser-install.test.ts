import { describe, expect, it } from "vitest";

import {
  isPlaywrightBrowserMissingError,
  parseInstallProgressLine,
  resolvePlaywrightCliPath,
} from "../src/browser/install.js";

describe("isPlaywrightBrowserMissingError", () => {
  it("detects missing executable guidance from Playwright", () => {
    const error = new Error(
      "browserType.launchPersistentContext: Executable doesn't exist at /tmp/chrome\nPlease run the following command to download new browsers:\n npx playwright install",
    );

    expect(isPlaywrightBrowserMissingError(error)).toBe(true);
  });

  it("does not classify unrelated errors as missing browser errors", () => {
    const error = new Error("Navigation timed out after 30000ms");

    expect(isPlaywrightBrowserMissingError(error)).toBe(false);
  });

  it("resolves the installed Playwright CLI from package metadata", () => {
    expect(resolvePlaywrightCliPath()).toMatch(/playwright[\\/]+cli\.js$/u);
  });

  it("parses carriage-return style percentage progress output", () => {
    const event = parseInstallProgressLine(
      "\u001b[1G    [==============================] 100% | chrome-mac-arm64.zip\u001b[0K",
    );

    expect(event).toEqual({
      message: "Downloading browser runtime (chrome-mac-arm64.zip)",
      percent: 100,
      phase: "downloading",
    });
  });
});

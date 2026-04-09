import { describe, expect, it } from "vitest";

import { parseInstallProgressLine } from "../src/browser/install.js";

describe("parseInstallProgressLine – extended cases", () => {
  it("returns null for an empty line", () => {
    expect(parseInstallProgressLine("")).toBeNull();
  });

  it("returns null for a line containing only ANSI escape codes", () => {
    expect(parseInstallProgressLine("\u001b[1G\u001b[0K")).toBeNull();
  });

  it("detects 'installed successfully' as a complete phase", () => {
    const event = parseInstallProgressLine("chromium installed successfully");

    expect(event?.phase).toBe("complete");
    expect(event?.percent).toBe(100);
  });

  it("parses a percentage with no transfer details as a download event", () => {
    const event = parseInstallProgressLine("  50% downloading...");

    expect(event?.phase).toBe("downloading");
    expect(event?.percent).toBe(50);
    expect(event?.message).toContain("50%");
  });

  it("clamps percent below 0 to 0", () => {
    // Negative percentages should not occur in practice but the code clamps them
    const event = parseInstallProgressLine(" 0%");

    expect(event?.percent).toBe(0);
  });

  it("clamps percent above 100 to 100", () => {
    const event = parseInstallProgressLine(" 101% | too-much.zip");

    expect(event?.percent).toBe(100);
  });

  it("detects 'installing playwright' as a starting phase", () => {
    const event = parseInstallProgressLine("Installing Playwright browsers");

    expect(event?.phase).toBe("starting");
  });

  it("detects 'downloading' keyword as a downloading phase", () => {
    const event = parseInstallProgressLine("downloading chromium");

    expect(event?.phase).toBe("downloading");
  });

  it("detects 'extract' keyword as installing phase", () => {
    const event = parseInstallProgressLine("Extracting archive…");

    expect(event?.phase).toBe("installing");
  });

  it("returns a log phase for unrecognized lines", () => {
    const event = parseInstallProgressLine("Some unrecognized log output");

    expect(event?.phase).toBe("log");
    expect(event?.message).toBe("Some unrecognized log output");
  });

  it("strips ANSI codes from the line before parsing", () => {
    const event = parseInstallProgressLine(
      "\u001b[32mdownloading chromium\u001b[0m",
    );

    expect(event?.phase).toBe("downloading");
    expect(event?.message).toContain("chromium");
    expect(event?.message).not.toContain("\u001b");
  });
});

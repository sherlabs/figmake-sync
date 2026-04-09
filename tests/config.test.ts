import { describe, expect, it } from "vitest";

import {
  createProjectConfig,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_POST_UPLOAD_PROMPT_TEMPLATE,
  parseProjectConfig,
  renderPostUploadPrompt,
  updateProjectConfig,
} from "../src/types/config.js";

describe("createProjectConfig", () => {
  it("creates a valid config with the expected shape", () => {
    const config = createProjectConfig(
      "https://www.figma.com/make/test-project",
      "/tmp/project",
    );

    expect(config.version).toBe(1);
    expect(config.figmaMakeUrl).toBe("https://www.figma.com/make/test-project");
    expect(config.projectId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(config.createdAt).toBeTruthy();
    expect(config.updatedAt).toBeTruthy();
  });

  it("applies default sync ignore patterns", () => {
    const config = createProjectConfig(
      "https://www.figma.com/make/proj",
      "/tmp/proj",
    );

    expect(config.sync.ignore).toEqual(expect.arrayContaining([...DEFAULT_IGNORE_PATTERNS]));
  });

  it("applies default adapter settings", () => {
    const config = createProjectConfig(
      "https://www.figma.com/make/proj",
      "/tmp/proj",
    );

    expect(config.adapter.headlessAutomation).toBe(true);
    expect(config.adapter.headlessAuth).toBe(false);
    expect(config.adapter.actionTimeoutMs).toBeGreaterThan(0);
  });
});

describe("parseProjectConfig", () => {
  it("parses a complete valid config object", () => {
    const raw = createProjectConfig(
      "https://www.figma.com/make/test",
      "/tmp/test",
    );
    const parsed = parseProjectConfig(raw);

    expect(parsed.version).toBe(1);
    expect(parsed.figmaMakeUrl).toBe("https://www.figma.com/make/test");
  });

  it("throws on an invalid config object", () => {
    expect(() => parseProjectConfig({ version: 2 })).toThrow();
  });

  it("throws when required fields are missing", () => {
    expect(() => parseProjectConfig({})).toThrow();
  });
});

describe("updateProjectConfig", () => {
  it("applies a partial patch and updates updatedAt", async () => {
    const original = createProjectConfig(
      "https://www.figma.com/make/test",
      "/tmp/test",
    );

    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = updateProjectConfig(original, {
      figmaMakeUrl: "https://www.figma.com/make/updated",
    });

    expect(updated.figmaMakeUrl).toBe("https://www.figma.com/make/updated");
    expect(updated.updatedAt).not.toBe(original.updatedAt);
    expect(updated.projectId).toBe(original.projectId);
    expect(updated.createdAt).toBe(original.createdAt);
  });
});

describe("renderPostUploadPrompt", () => {
  it("renders the default template with provided file paths", () => {
    const output = renderPostUploadPrompt(undefined, [
      "src/app.ts",
      "src/utils.ts",
    ]);

    expect(output).toContain("- src/app.ts");
    expect(output).toContain("- src/utils.ts");
    expect(output).toContain(
      DEFAULT_POST_UPLOAD_PROMPT_TEMPLATE.split("{{files}}")[0],
    );
  });

  it("uses a custom template when provided", () => {
    const output = renderPostUploadPrompt(
      "Updated files:\n{{files}}\nDone.",
      ["src/index.ts"],
    );

    expect(output).toBe("Updated files:\n- src/index.ts\nDone.");
  });

  it("renders an empty file list correctly", () => {
    const output = renderPostUploadPrompt(undefined, []);

    expect(output).not.toContain("{{files}}");
  });

  it("renders a single file correctly", () => {
    const output = renderPostUploadPrompt("Files: {{files}}", ["only.ts"]);

    expect(output).toBe("Files: - only.ts");
  });
});

describe("DEFAULT_IGNORE_PATTERNS", () => {
  it("includes the state directory pattern", () => {
    expect(DEFAULT_IGNORE_PATTERNS).toContain(".figmake-sync/**");
  });

  it("includes node_modules and .git", () => {
    expect(DEFAULT_IGNORE_PATTERNS).toContain("node_modules/**");
    expect(DEFAULT_IGNORE_PATTERNS).toContain(".git/**");
  });
});

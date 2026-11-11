import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { describe, expect, it } from "vitest";

import { MODEL_ID, MODEL_OPTIONS, modelLabel, modelProblem, validModel } from "../src/app/modelIds.js";
import { DesktopAppStateStore } from "../src/electron/appState.js";
import { modelArg } from "../src/electron/ipc.js";
import { createClaudeAdapter } from "../src/harness/agents/claude.js";
import { createCodexAdapter } from "../src/harness/agents/codex.js";

const BAD = ["--oss", "-m", "x; rm -rf /", "a b", "", " opus", "opus\n", "$(id)", "`id`", "a|b", "../x", "x".repeat(65), "-opus", "\u0000", "opus\u202e"];
const GOOD = ["opus", "sonnet", "haiku", "gpt-6.1-sol", "claude-opus-4-5", "o3", "ns/model:tag.v2", "x[1m]"];
const SID = "abcdefgh-1234";

describe("model ids", () => {
  it("accept plain tokens only; nothing that could be parsed as a flag or a shell fragment", () => {
    for (const g of GOOD) expect(MODEL_ID.test(g), g).toBe(true);
    for (const b of BAD) {
      expect(MODEL_ID.test(b), JSON.stringify(b)).toBe(false);
      expect(validModel(b)).toBeNull();
      expect(modelArg.safeParse(b).success).toBe(false);
    }
    expect(modelArg.safeParse(null).success).toBe(true);
    expect(validModel(5)).toBeNull();
  });

  it("offers aliases only for Claude and just Default for Codex; labels and messages are plain", () => {
    expect(MODEL_OPTIONS.claude.map((o) => o.id)).toEqual([null, "fable", "opus", "sonnet", "haiku"]);
    expect(MODEL_OPTIONS.codex.map((o) => o.id)).toEqual([null]);
    expect(MODEL_OPTIONS.claude.every((o) => o.id === null || !/\d{4}/u.test(o.id))).toBe(true);
    expect(modelLabel("claude", null)).toBe("Default");
    expect(modelLabel("claude", "sonnet")).toBe("Sonnet");
    expect(modelLabel("codex", "gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(modelProblem("")).toMatch(/Type a model name/u);
    expect(modelProblem("a b")).toMatch(/no spaces/u);
    expect(modelProblem(" opus ")).toBeNull();
  });
});

describe("claude: --model", () => {
  const a = createClaudeAdapter();
  it("passes no model flag by default, so Claude uses its own default", () => {
    expect(a.buildInvocation({ prompt: "x", cwd: "/p" }).args).not.toContain("--model");
    expect(a.buildInvocation({ prompt: "x", cwd: "/p", model: undefined }).args).not.toContain("--model");
  });
  it("passes the chosen model as its own argument, also on a resumed session", () => {
    const fresh = a.buildInvocation({ prompt: "x", cwd: "/p", model: "sonnet" }).args;
    expect(fresh[fresh.indexOf("--model") + 1]).toBe("sonnet");
    const resumed = a.buildInvocation({ prompt: "x", cwd: "/p", model: "opus", sessionId: SID }).args;
    expect(resumed[resumed.indexOf("--model") + 1]).toBe("opus");
    expect(resumed.slice(-2)).toEqual(["--resume", SID]);
  });
  it("stops the run on an unsafe name instead of passing it on", () => {
    for (const b of BAD) expect(() => a.buildInvocation({ prompt: "x", cwd: "/p", model: b }), JSON.stringify(b)).toThrow(/isn't valid/u);
    expect(a.buildInvocation({ prompt: "x", cwd: "/p", model: "x" }).args.filter((v) => v === "--model")).toHaveLength(1);
  });
});

describe("codex: -m on exec", () => {
  const a = createCodexAdapter();
  const IMAGES = ["/p/.a/one.png"];
  it("passes no model flag by default, so Codex uses config.toml", () => {
    const args = a.buildInvocation({ prompt: "x", cwd: "/p" }).args;
    expect(args).not.toContain("--model");
    expect(args).not.toContain("-m");
  });
  it("puts --model on exec itself, before resume, so new and resumed sessions both get it", () => {
    const fresh = a.buildInvocation({ prompt: "x", cwd: "/p", model: "gpt-6.1-sol" }).args;
    expect(fresh.slice(0, 3)).toEqual(["exec", "--model", "gpt-6.1-sol"]);
    expect(fresh.at(-1)).toBe("-");
    const resumed = a.buildInvocation({ prompt: "x", cwd: "/p", model: "gpt-6.1-sol", sessionId: SID }).args;
    expect(resumed.slice(0, 3)).toEqual(["exec", "--model", "gpt-6.1-sol"]);
    expect(resumed.indexOf("--model")).toBeLessThan(resumed.indexOf("resume"));
    expect(resumed.slice(resumed.indexOf("resume"))).toEqual(["resume", "--", SID, "-"]);
  });
  it("works together with pictures, new or resumed", () => {
    const fresh = a.buildInvocation({ prompt: "x", cwd: "/p", model: "o3", images: IMAGES }).args;
    expect(fresh.slice(0, 5)).toEqual(["exec", "--model", "o3", "--image", IMAGES[0]]);
    const resumed = a.buildInvocation({ prompt: "x", cwd: "/p", model: "o3", images: IMAGES, sessionId: SID }).args;
    expect(resumed.slice(resumed.indexOf("resume"))).toEqual(["resume", "--image", IMAGES[0], "--", SID, "-"]);
    expect(resumed.slice(0, 3)).toEqual(["exec", "--model", "o3"]);
  });
  it("stops the run on --oss, shell fragments and leading dashes", () => {
    for (const b of BAD) expect(() => a.buildInvocation({ prompt: "x", cwd: "/p", model: b }), JSON.stringify(b)).toThrow(/isn't valid/u);
  });
});

describe("app state: models", () => {
  const tmp = async (): Promise<{ file: string; dir: string }> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "models-"));
    return { dir, file: path.join(dir, "app-state.json") };
  };
  it("defaults to no model for both, and persists a choice per AI", async () => {
    const { dir, file } = await tmp();
    const store = new DesktopAppStateStore(file);
    expect((await store.load()).models).toEqual({ claude: null, codex: null });
    await store.update({ models: { claude: "sonnet", codex: "gpt-6.1-sol" } });
    expect((await new DesktopAppStateStore(file).load()).models).toEqual({ claude: "sonnet", codex: "gpt-6.1-sol" });
    await store.update({ agent: "codex" });
    expect((await store.load()).models.claude).toBe("sonnet");
    await fs.remove(dir);
  });
  it("an unsafe or malformed saved value falls back to Default for that AI alone", async () => {
    const { dir, file } = await tmp();
    await fs.writeJson(file, { agent: "claude", models: { claude: "--oss", codex: "o3" } });
    expect((await new DesktopAppStateStore(file).load()).models).toEqual({ claude: null, codex: "o3" });
    await fs.writeJson(file, { agent: "claude", models: "nope" });
    expect((await new DesktopAppStateStore(file).load()).models).toEqual({ claude: null, codex: null });
    await fs.writeJson(file, { agent: "claude", models: { claude: "x; rm -rf /" } });
    expect((await new DesktopAppStateStore(file).load()).models.claude).toBeNull();
    await fs.remove(dir);
  });
});

import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterAll, describe, expect, it } from "vitest";

import { HarnessService, type HarnessEvent } from "../src/harness/index.js";
import { agentBinDirFor, setManagedRuntimeRoot } from "../src/runtime/managed.js";

/** Real npm + network: set FIGMAKE_E2E=1 to run. Installs @openai/codex into a temp prefix, never globally, never signs in. */
const run = process.env["FIGMAKE_E2E"] === "1" ? describe : describe.skip;
const root = path.join(os.tmpdir(), `figmake-e2e-${process.pid}`, "runtime");

run("real agent CLI install (codex)", () => {
  afterAll(async () => {
    setManagedRuntimeRoot(null);
    await fs.remove(path.dirname(root));
  });
  it("installs privately, is detected, and reports its version", async () => {
    setManagedRuntimeRoot(root);
    const events: HarnessEvent[] = [];
    const h = new HarnessService({ sync: {} as never, emit: (e) => events.push(e), runtimeRoot: () => root });
    const before = await h.detectAgent("codex");
    const res = await h.installAgentCli("codex");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(await fs.pathExists(path.join(agentBinDirFor(root), "codex"))) .toBe(true);
    const after = await h.detectAgent("codex");
    console.log("e2e", { beforeInstalled: before.installed, version: res.version, detected: after.version, signedIn: after.signedIn });
    expect(after.installed).toBe(true);
    expect(after.version).toBeTruthy();
    expect(events.some((e) => e.kind === "agent-install-log")).toBe(true);
  }, 300_000);
});

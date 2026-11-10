import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { DevServer, detectDevScript, findFreePort, reapStaleDevServer, isSafeLocalUrl, parseDevUrl } from "../src/harness/devserver.js";
import type { DevStatus } from "../src/harness/types.js";
import { createFakeKillTree, createFakeSpawn } from "./support/fakeChild.js";

const dirs: string[] = [];
async function project(scripts: Record<string, string>): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dev-"));
  dirs.push(d);
  await fs.outputJson(path.join(d, "package.json"), { name: "x", scripts });
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.remove(d)));
});

describe("parseDevUrl", () => {
  it.each([
    ["  \u001B[32m➜\u001B[39m  \u001B[1mLocal\u001B[22m:   \u001B[36mhttp://localhost:\u001B[1m5173\u001B[22m/\u001B[39m", "http://localhost:5173/"],
    ["  ➜  Local:   http://localhost:5173/", "http://localhost:5173/"],
    ["   - Local:        http://localhost:3000", "http://localhost:3000/"],
    ["  Local:            http://localhost:3000", "http://localhost:3000/"],
    ["Server at http://127.0.0.1:8080/app", "http://127.0.0.1:8080/app"],
    ["listening on http://0.0.0.0:4000", "http://localhost:4000/"],
  ])("%j", (line, expected) => {
    expect(parseDevUrl(line)).toBe(expected);
  });

  it("ignores network and remote URLs", () => {
    expect(parseDevUrl("  ➜  Network: http://192.168.1.5:5173/")).toBeNull();
    expect(parseDevUrl("see https://example.com:443/")).toBeNull();
    expect(parseDevUrl("ready in 300 ms")).toBeNull();
  });

  it("isSafeLocalUrl only allows localhost/127.0.0.1 http(s)", () => {
    expect(isSafeLocalUrl("http://localhost:5173/")).toBe(true);
    expect(isSafeLocalUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isSafeLocalUrl("http://localhost.evil.com:80/")).toBe(false);
    expect(isSafeLocalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeLocalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeLocalUrl(null)).toBe(false);
  });
});

describe("detectDevScript", () => {
  it("prefers dev > start > serve", async () => {
    expect(await detectDevScript(await project({ serve: "a", start: "b", dev: "c" }))).toBe("dev");
    expect(await detectDevScript(await project({ serve: "a", start: "b" }))).toBe("start");
    expect(await detectDevScript(await project({ serve: "a" }))).toBe("serve");
    expect(await detectDevScript(await project({ build: "a" }))).toBeNull();
  });
});

describe("dev server port and orphans", () => {
  it("gives every start its own free PORT bound to loopback", async () => {
    const root = await project({ dev: "vite" });
    const { spawn, calls } = createFakeSpawn();
    const ports = [51111, 51112];
    const server = new DevServer(root, { spawn, killTree: createFakeKillTree().killTree, pickPort: () => Promise.resolve(ports.shift()!) });
    await server.start();
    expect(calls[0]!.options.env?.["PORT"]).toBe("51111");
    expect(calls[0]!.options.env?.["FIGMA_DEV_SERVER_HOST"]).toBe("127.0.0.1");
  });

  it("findFreePort returns a usable port", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(1023);
  });

  it("reapStaleDevServer clears a pid file for a dead process and reports nothing to kill", async () => {
    const root = await project({ dev: "vite" });
    await fs.outputFile(path.join(root, ".figmake-sync", "dev.pid"), "2147483000");
    expect(await reapStaleDevServer(root)).toBe(false);
    expect(await fs.pathExists(path.join(root, ".figmake-sync", "dev.pid"))).toBe(false);
    expect(await reapStaleDevServer(root)).toBe(false);
  });
});

describe("DevServer", () => {
  it("goes starting -> running with url, then stop kills the process group", async () => {
    const root = await project({ dev: "vite" });
    const { spawn, calls } = createFakeSpawn();
    const { killTree, kills } = createFakeKillTree();
    const seen: DevStatus["state"][] = [];
    const server = new DevServer(root, { spawn, killTree, env: { PATH: "/usr/bin" }, onChange: (s) => seen.push(s.state) });

    const starting = await server.start();
    expect(starting.state).toBe("starting");
    expect(calls[0]!.args).toEqual(["run", "dev"]);
    expect(calls[0]!.options.shell).toBe(process.platform === "win32");
    expect(calls[0]!.options.cwd).toBe(root);
    expect(calls[0]!.options.env?.["BROWSER"]).toBe("none");

    calls[0]!.child.out("\n  VITE v5  ready in 200 ms\n\n  \u001B[32m➜\u001B[39m  Local:   http://local");
    expect(server.status().state).toBe("starting");
    calls[0]!.child.out("host:5173/\n");
    expect(server.status()).toMatchObject({ state: "running", url: "http://localhost:5173/" });
    expect(server.status().logTail.at(-1)).toContain("http://localhost:5173/");

    const stopped = await server.stop();
    expect(kills[0]).toEqual({ pid: 4242, signal: "SIGTERM" });
    expect(stopped).toMatchObject({ state: "stopped", url: null });
    expect(seen).toEqual(["starting", "running", "stopped"]);
  });

  it("reports crashed when the process exits on its own", async () => {
    const root = await project({ start: "x" });
    const { spawn, calls } = createFakeSpawn();
    const server = new DevServer(root, { spawn });
    await server.start();
    calls[0]!.child.err("Error: port in use\n");
    calls[0]!.child.exit(1);
    expect(server.status()).toMatchObject({ state: "crashed", exitCode: 1 });
    expect(server.status().logTail).toContain("Error: port in use");
  });

  it("concurrent start spawns once; stop during start prevents any spawn", async () => {
    const root = await project({ dev: "vite" });
    const { spawn, calls } = createFakeSpawn();
    const server = new DevServer(root, { spawn, killTree: createFakeKillTree().killTree });
    await Promise.all([server.start(), server.start()]);
    expect(calls).toHaveLength(1);
    await server.stop();

    const second = createFakeSpawn();
    const s2 = new DevServer(root, { spawn: second.spawn, killTree: createFakeKillTree().killTree });
    const starting = s2.start();
    await s2.stop();
    await starting;
    expect(second.calls).toHaveLength(0);
    expect(s2.status().state).toBe("stopped");
  });

  it("stop after a crash clears the url and notifies", async () => {
    const root = await project({ dev: "vite" });
    const { spawn, calls } = createFakeSpawn();
    const seen: DevStatus["state"][] = [];
    const server = new DevServer(root, { spawn, onChange: (s) => seen.push(s.state) });
    await server.start();
    calls[0]!.child.out("http://localhost:5173/\n");
    calls[0]!.child.exit(1);
    expect(server.status()).toMatchObject({ state: "crashed", url: null });
    await server.stop();
    expect(seen.at(-1)).toBe("stopped");
  });

  it("errors when there is no dev script", async () => {
    const root = await project({ build: "x" });
    await expect(new DevServer(root, { spawn: createFakeSpawn().spawn }).start()).rejects.toThrow(/No dev script/);
  });
});

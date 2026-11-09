/* eslint-disable @typescript-eslint/require-await -- mock fetch/run implementations must be async to match their types */
import os from "node:os";
import path from "node:path";

import AdmZip from "adm-zip";
import fs from "fs-extra";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildEnv, systemEnv } from "../src/harness/process.js";
import {
  COMPLETE_MARKER,
  FALLBACK_NODE_VERSION,
  RuntimeInstallError,
  assertTreeContained,
  binDirsFor,
  detectRuntime,
  findManagedInstall,
  installManagedRuntime,
  nodeAssetFor,
  parseShasums,
  pickLtsVersion,
  removeManagedRuntime,
  resolveNodeVersion,
  setManagedRuntimeRoot,
  validateArchiveEntries,
  withManagedPath,
  type FetchFn,
  type RunFn,
} from "../src/runtime/managed.js";

const VERSION = "v22.5.0";
const ASSET = `node-${VERSION}-win-x64`;
let tmp: string;
let root: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rt-managed-"));
  root = path.join(tmp, "runtime");
});
afterEach(async () => {
  setManagedRuntimeRoot(null);
  await fs.remove(tmp);
});

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

function makeZip(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  const names = Object.keys(entries);
  names.forEach((name, i) => zip.addFile(`placeholder-${i}`, Buffer.from(entries[name]!)));
  // adm-zip sanitises names on add; force the (possibly hostile) names afterwards.
  zip.getEntries().forEach((e, i) => {
    e.entryName = names[i]!;
  });
  return zip.toBuffer();
}

const index = [
  { version: "v23.0.0", lts: false },
  { version: "v22.5.0", lts: "Jod" },
  { version: "v22.4.0", lts: "Jod" },
  { version: "v20.9.0", lts: "Iron" },
];

function mockFetch(zip: Buffer, opts: { shasum?: string; stall?: boolean; calls?: string[] } = {}): FetchFn {
  return async (url, init) => {
    opts.calls?.push(url);
    if (url.endsWith("index.json")) return new Response(JSON.stringify(index));
    if (url.endsWith("SHASUMS256.txt")) return new Response(`${opts.shasum ?? sha(zip)}  ${ASSET}.zip\n`);
    if (opts.stall) {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(zip.subarray(0, 10));
          init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
        },
      });
      return new Response(stream, { headers: { "content-length": String(zip.length) } });
    }
    return new Response(new Uint8Array(zip), { headers: { "content-length": String(zip.length) } });
  };
}

const goodZip = (): Buffer => makeZip({ [`${ASSET}/node.exe`]: "x", [`${ASSET}/npm.cmd`]: "x" });

/** Fake process runner: node/npm report versions; `npm install` creates the pnpm shim. */
const fakeRun: RunFn & { calls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv | undefined }> } = Object.assign(
  async (cmd: string, args: string[], o: { env?: NodeJS.ProcessEnv | undefined }) => {
    fakeRun.calls.push({ cmd, args, env: o.env });
    const base = path.basename(cmd);
    if (base === "node.exe") return { code: 0, stdout: `${VERSION}\n`, stderr: "" };
    if (base === "npm.cmd" && args[0] === "install") {
      const prefix = args[args.indexOf("--prefix") + 1]!;
      await fs.outputFile(path.join(prefix, "node_modules", ".bin", "pnpm.cmd"), "x");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (base === "npm.cmd") return { code: 0, stdout: "10.8.1\n", stderr: "" };
    if (base === "pnpm.cmd") return { code: 0, stdout: "9.12.0\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "nope" };
  },
  { calls: [] as Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv | undefined }> },
);
beforeEach(() => {
  fakeRun.calls.length = 0;
});

const install = (fetchFn: FetchFn, extra: Partial<Parameters<typeof installManagedRuntime>[0]> = {}) =>
  installManagedRuntime({ runtimeRoot: root, platform: "win32", arch: "x64", fetchFn, run: fakeRun, ...extra });

describe("version + asset selection", () => {
  it("picks the newest entry with a truthy lts", () => {
    expect(pickLtsVersion(index)).toBe("v22.5.0");
    expect(pickLtsVersion([{ version: "v23.0.0", lts: false }])).toBeNull();
    expect(pickLtsVersion("junk")).toBeNull();
  });
  it("falls back to the pinned version when the index cannot be fetched", async () => {
    const bad: FetchFn = async () => {
      throw new Error("offline");
    };
    expect(await resolveNodeVersion(bad)).toEqual({ version: FALLBACK_NODE_VERSION, fallback: true });
    expect((await resolveNodeVersion(async () => new Response(JSON.stringify(index)))).version).toBe("v22.5.0");
  });
  it("maps platform/arch to the right asset", () => {
    expect(nodeAssetFor("v22.5.0", "darwin", "arm64")).toMatchObject({ fileName: "node-v22.5.0-darwin-arm64.tar.gz", kind: "tar" });
    expect(nodeAssetFor("v22.5.0", "darwin", "x64")?.fileName).toBe("node-v22.5.0-darwin-x64.tar.gz");
    expect(nodeAssetFor("v22.5.0", "win32", "x64")).toMatchObject({ fileName: "node-v22.5.0-win-x64.zip", kind: "zip" });
    expect(nodeAssetFor("v22.5.0", "linux", "x64")?.fileName).toBe("node-v22.5.0-linux-x64.tar.xz");
    expect(nodeAssetFor("v22.5.0", "linux", "ia32")).toBeNull();
    expect(nodeAssetFor("v22.5.0", "freebsd", "x64")).toBeNull();
  });
  it("parses SHASUMS256", () => {
    const h = "a".repeat(64);
    expect(parseShasums(`${h}  node-v1.0.0.zip\n${"b".repeat(64)}  other.zip`, "node-v1.0.0.zip")).toBe(h);
    expect(parseShasums("", "x")).toBeNull();
  });
});

describe("safe extraction", () => {
  it("rejects hostile archive entry names", () => {
    for (const bad of ["../evil", "a/../../evil", "/etc/passwd", "C:\\x", "a\\..\\b"]) {
      expect(() => validateArchiveEntries([bad])).toThrow(/Unsafe path/);
    }
    expect(() => validateArchiveEntries(["node-v1/bin/node", "node-v1/lib/"])).not.toThrow();
  });

  it.skipIf(process.platform === "win32")("rejects symlinks that escape the tree", async () => {
    const d = path.join(tmp, "tree");
    await fs.ensureDir(path.join(d, "bin"));
    await fs.symlink("../lib/ok", path.join(d, "bin", "ok-link")); // dangling but inside
    await expect(assertTreeContained(d)).resolves.toBeUndefined();
    await fs.symlink("../../outside", path.join(d, "bin", "bad"));
    await expect(assertTreeContained(d)).rejects.toThrow(/escapes/);
    await fs.remove(path.join(d, "bin", "bad"));
    await fs.symlink("/etc/passwd", path.join(d, "abs"));
    await expect(assertTreeContained(d)).rejects.toThrow(/escapes/);
  });

  it("zip-slip: a ../ entry aborts the install and writes nothing outside", async () => {
    const evil = makeZip({ [`${ASSET}/node.exe`]: "x", "../../evil.txt": "pwned" });
    await expect(install(mockFetch(evil))).rejects.toBeInstanceOf(Error);
    expect(await fs.pathExists(path.join(tmp, "evil.txt"))).toBe(false);
    expect(await fs.pathExists(path.join(root, "..", "..", "evil.txt"))).toBe(false);
    expect(findManagedInstall(root)).toBeNull();
    const left = (await fs.readdir(root).catch(() => [] as string[])).filter((n) => n.startsWith("node-") || n.startsWith(".staging"));
    expect(left).toEqual([]);
  });
});

describe("install flow", () => {
  it("installs node + pnpm into runtime/node-v<ver>, writes .complete last, emits phases", async () => {
    const phases: string[] = [];
    const calls: string[] = [];
    const res = await install(mockFetch(goodZip(), { calls }), { onProgress: (p) => phases.push(p.phase) });
    expect(res.version).toBe(VERSION);
    expect(res.pnpmVersion).toBe("9.12.0");
    expect(res.nodeVersion).toBe("22.5.0");
    const dir = path.join(root, `node-${VERSION}`);
    expect(res.dir).toBe(dir);
    expect(await fs.pathExists(path.join(dir, COMPLETE_MARKER))).toBe(true);
    expect(phases[0]).toBe("resolving");
    expect(phases).toEqual(expect.arrayContaining(["downloading", "verifying", "extracting", "installing-pnpm", "done"]));
    expect(phases.indexOf("verifying")).toBeGreaterThan(phases.indexOf("downloading"));
    // checksums are fetched from the same pinned version
    expect(calls).toContain(`https://nodejs.org/dist/${VERSION}/SHASUMS256.txt`);
    // pnpm goes into the managed prefix with a private cache (nothing in ~/.npm or a global prefix)
    const npmInstall = fakeRun.calls.find((c) => c.args[0] === "install")!;
    expect(npmInstall.args).toEqual(expect.arrayContaining(["--prefix", path.join(dir, "tools"), "--cache", path.join(dir, ".npm-cache")]));
    expect(npmInstall.args).not.toContain("-g");
    // nothing was created outside runtimeRoot except the root itself
    expect(await fs.readdir(tmp)).toEqual(["runtime"]);
    // temp download + staging cleaned
    expect((await fs.readdir(root)).sort()).toEqual([`node-${VERSION}`, ".downloads"].sort());
    expect(await fs.readdir(path.join(root, ".downloads"))).toEqual([]);
  });

  it("is idempotent: a second run skips download", async () => {
    await install(mockFetch(goodZip()));
    const calls: string[] = [];
    const res = await install(mockFetch(goodZip(), { calls }));
    expect(res.alreadyInstalled).toBe(true);
    expect(calls.some((u) => u.endsWith(".zip"))).toBe(false);
  });

  it("checksum mismatch aborts, installs nothing and cleans temp files", async () => {
    const err = await install(mockFetch(goodZip(), { shasum: "0".repeat(64) })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuntimeInstallError);
    expect((err as RuntimeInstallError).code).toBe("checksum");
    expect(findManagedInstall(root)).toBeNull();
    expect(await fs.pathExists(path.join(root, `node-${VERSION}`))).toBe(false);
    expect(await fs.readdir(path.join(root, ".downloads"))).toEqual([]);
    expect(fakeRun.calls).toHaveLength(0); // nothing was ever executed
  });

  it("offline gives an actionable message", async () => {
    const f: FetchFn = async (url) => {
      if (url.endsWith("index.json")) throw new Error("fetch failed");
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
    };
    const err = (await install(f).catch((e: unknown) => e)) as RuntimeInstallError;
    expect(err.code).toBe("offline");
    expect(err.message).toMatch(/internet connection|proxy/);
  });

  it("cancel mid-download rejects as cancelled and removes the temp file", async () => {
    const ac = new AbortController();
    const p = install(mockFetch(goodZip(), { stall: true }), {
      signal: ac.signal,
      onProgress: (e) => {
        if (e.phase === "downloading") setTimeout(() => ac.abort(), 20);
      },
    });
    const err = (await p.catch((e: unknown) => e)) as RuntimeInstallError;
    expect(err.code).toBe("cancelled");
    expect(findManagedInstall(root)).toBeNull();
    expect(await fs.readdir(path.join(root, ".downloads"))).toEqual([]);
    expect((await fs.readdir(root)).filter((n) => n.startsWith(".staging") || n.startsWith("node-"))).toEqual([]);
  });
});

describe(".complete marker semantics", () => {
  it("a dir without the marker is never treated as installed, and is replaced on install", async () => {
    const half = path.join(root, `node-${VERSION}`);
    await fs.outputFile(path.join(half, "node.exe"), "half");
    expect(findManagedInstall(root)).toBeNull();
    const res = await install(mockFetch(goodZip()));
    expect(res.alreadyInstalled).toBe(false);
    expect(findManagedInstall(root)?.version).toBe(VERSION);
  });
  it("prefers the highest complete version", async () => {
    for (const v of ["v20.1.0", "v22.5.0", "v22.10.0"]) await fs.outputFile(path.join(root, `node-${v}`, COMPLETE_MARKER), "");
    await fs.ensureDir(path.join(root, "node-v24.0.0")); // incomplete
    expect(findManagedInstall(root)?.version).toBe("v22.10.0");
  });
});

describe("resolution order and PATH injection", () => {
  const sysEnv = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;

  it("system tool wins; managed is used only when the system one is missing", async () => {
    await fs.outputFile(path.join(root, `node-${VERSION}`, COMPLETE_MARKER), "");
    const runMixed: RunFn = async (cmd) => {
      const b = path.basename(cmd);
      if (cmd === "node") return { code: 0, stdout: "v18.0.0", stderr: "" }; // system node works
      if (cmd === "npm" || cmd === "pnpm") throw new Error("ENOENT");
      if (cmd.startsWith(root)) return { code: 0, stdout: b === "pnpm" ? "9.0.0" : b === "npm" ? "10.0.0" : "v22.5.0", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const r = await detectRuntime({ runtimeRoot: root, systemEnv: sysEnv, run: runMixed, platform: "linux" });
    expect(r.node).toEqual({ source: "system", version: "18.0.0" });
    expect(r.npm).toEqual({ source: "managed", version: "10.0.0" });
    expect(r.pnpm).toEqual({ source: "managed", version: "9.0.0" });
    expect(r.managed.installed).toBe(true);
  });

  it("reports missing when neither works", async () => {
    const r = await detectRuntime({ runtimeRoot: root, systemEnv: sysEnv, run: async () => ({ code: 1, stdout: "", stderr: "" }), platform: "linux" });
    expect(r.node.source).toBe("missing");
    expect(r.managed.installed).toBe(false);
  });

  it("managed dirs are appended after system PATH, only on the child env copy", async () => {
    await fs.outputFile(path.join(root, `node-${VERSION}`, COMPLETE_MARKER), "");
    setManagedRuntimeRoot(root);
    const before = process.env["PATH"];
    const child = buildEnv({ PATH: "/usr/bin" });
    const parts = child["PATH"]!.split(path.delimiter);
    const managedDirs = binDirsFor(path.join(root, `node-${VERSION}`));
    expect(parts.indexOf(managedDirs[0]!)).toBeGreaterThan(parts.indexOf("/usr/bin"));
    expect(parts).toEqual(expect.arrayContaining(managedDirs));
    expect(systemEnv({ PATH: "/usr/bin" })["PATH"]).not.toContain(root);
    expect(process.env["PATH"]).toBe(before);
    expect(withManagedPath({ PATH: "/a" }, ["/m"])["PATH"]).toBe(["/a", "/m"].join(path.delimiter));
  });

  it("adds nothing when no runtime is installed", () => {
    setManagedRuntimeRoot(root);
    expect(buildEnv({ PATH: "/usr/bin" })["PATH"]).not.toContain(root);
  });
});

describe("removal", () => {
  it("deletes the runtime dir but refuses other names", async () => {
    await fs.outputFile(path.join(root, "x"), "1");
    expect(await removeManagedRuntime(root)).toBe(true);
    expect(await fs.pathExists(root)).toBe(false);
    await expect(removeManagedRuntime(tmp)).rejects.toThrow(/runtime/);
  });
});

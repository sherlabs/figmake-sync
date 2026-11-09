import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string): string => fs.readFileSync(path.join(root, p), "utf8");

const SITE = "/Users/nilesh93/Projects/personal/sherlab-website/src/lib/figmakeRelease.ts";
// The site matches /mac.*\.dmg$/i and /windows.*\.exe$/i against asset names.
const siteRegexes = (): RegExp[] => {
  if (fs.existsSync(SITE)) {
    const src = fs.readFileSync(SITE, "utf8");
    const found = [...src.matchAll(/\(n\) => (\/[^/]+\/i)\.test\(n\)/g)].map((m) => m[1]!);
    if (found.length >= 2) return found.map((f) => new RegExp(f.slice(1, -2), "i"));
  }
  return [/mac.*\.dmg$/i, /windows.*\.exe$/i];
};

describe("release config guard", () => {
  const builder = read("electron-builder.yml");
  const workflow = read(".github/workflows/release.yml");

  it("keeps artifact names the website download buttons rely on", () => {
    const [mac, win] = siteRegexes() as [RegExp, RegExp];
    const names = [...builder.matchAll(/artifactName:\s*(.+)/g)].map((m) => m[1]!.trim());
    expect(names).toContain("${productName}-${version}-mac-${arch}.${ext}");
    expect(names).toContain("${productName}-${version}-windows-${arch}-installer.${ext}");
    expect(mac.test("figmake-sync-0.1.12-mac-universal.dmg")).toBe(true);
    expect(win.test("figmake-sync-0.1.12-windows-x64-installer.exe")).toBe(true);
    // updater metadata and blockmaps must not be mistaken for installers
    expect(mac.test("latest-mac.yml")).toBe(false);
    expect(win.test("latest.yml")).toBe(false);
  });

  it("generates update metadata via a github provider on the public repo, no token", () => {
    expect(builder).toMatch(/publish:\s*\n\s*- provider: github\s*\n\s*owner: sherlabs\s*\n\s*repo: figmake-sync/);
    expect(builder).not.toMatch(/token/i);
    expect(builder).toMatch(/target: zip/);
  });

  it("uploads latest*.yml and blockmaps in both build and publish jobs", () => {
    expect(workflow.match(/release\/latest\*\.yml/g)).toHaveLength(1);
    expect(workflow.match(/release-artifacts\/latest\*\.yml/g)).toHaveLength(1);
    expect(workflow.match(/\*\.blockmap/g)!.length).toBeGreaterThanOrEqual(2);
    expect(workflow).toMatch(/release-artifacts\/\*\.zip/);
  });

  it("builder never publishes itself", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; dependencies: Record<string, string> };
    for (const k of ["dist:mac", "dist:mac:signed", "dist:win", "dist:all"]) expect(pkg.scripts[k]).toContain("--publish never");
    expect(pkg.dependencies["electron-updater"]).toBeDefined();
  });
});

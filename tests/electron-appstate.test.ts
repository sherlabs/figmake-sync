import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { describe, expect, it } from "vitest";

import { isAuthRequiredError } from "../src/electron/authState.js";
import { DesktopAppStateStore } from "../src/electron/appState.js";
import { AuthRequiredError as SessionAuthError } from "../src/browser/session.js";
import { AuthRequiredError as AutomationAuthError } from "../src/figma/adapter.js";

const DEFAULTS = { lastLink: null, agent: null, workspace: null, projects: {}, links: {}, updates: { enabled: true } };

describe("DesktopAppStateStore", () => {
  it("recovers from corrupt JSON and writes atomically", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "appstate-"));
    const file = path.join(dir, "app-state.json");
    await fs.writeFile(file, '{"lastLin');
    const store = new DesktopAppStateStore(file);
    expect(await store.load()).toEqual(DEFAULTS);
    await Promise.all([store.update({ agent: "claude" }), store.update({ agent: "codex" })]);
    expect((await store.load()).agent).toBe("codex");
    const names = await fs.readdir(dir);
    expect(names.some((n) => n.includes(".corrupt-"))).toBe(true);
    expect(names.some((n) => n.endsWith(".tmp"))).toBe(false);
    await fs.remove(dir);
  });

  it("keeps an absolute path per project and the last link", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "appstate-"));
    const store = new DesktopAppStateStore(path.join(dir, "app-state.json"));
    await store.update({ lastLink: "https://www.figma.com/make/abc/x", projects: { abc: "/w/x" }, workspace: "/w" });
    expect(await store.load()).toEqual({ lastLink: "https://www.figma.com/make/abc/x", agent: null, workspace: "/w", projects: { abc: "/w/x" }, links: {}, updates: { enabled: true } });
    await fs.remove(dir);
  });
});

describe("DesktopAppStateStore links", () => {
  it("defaults to no links and round-trips them atomically", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "appstate-"));
    const file = path.join(dir, "app-state.json");
    const store = new DesktopAppStateStore(file);
    expect((await store.load()).links).toEqual({});
    await Promise.all([store.update({ links: { a: "https://www.figma.com/make/a/x" } }), store.update({ agent: "claude" })]);
    expect(await store.load()).toMatchObject({ agent: "claude", links: { a: "https://www.figma.com/make/a/x" } });
    expect((await fs.readdir(dir)).some((n) => n.endsWith(".tmp"))).toBe(false);
    await fs.remove(dir);
  });

  it("drops malformed links without discarding the other fields", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "appstate-"));
    const file = path.join(dir, "app-state.json");
    await fs.writeJson(file, { agent: "codex", projects: { a: "/w/a" }, links: { a: 5 } });
    const loaded = await new DesktopAppStateStore(file).load();
    expect(loaded).toMatchObject({ agent: "codex", projects: { a: "/w/a" }, links: {} });
    expect((await fs.readdir(dir)).some((n) => n.includes(".corrupt-"))).toBe(false);
    await fs.remove(dir);
  });
});

describe("isAuthRequiredError", () => {
  it("recognises the typed errors from both layers only", () => {
    expect(isAuthRequiredError(new AutomationAuthError("x"))).toBe(true);
    expect(isAuthRequiredError(new SessionAuthError())).toBe(true);
    expect(isAuthRequiredError(new Error("boom"))).toBe(false);
    expect(isAuthRequiredError(null)).toBe(false);
  });
});

describe("updates.enabled", () => {
  it("defaults to true, persists false, and falls back to true when malformed without losing other state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "appstate-"));
    const file = path.join(dir, "app-state.json");
    const store = new DesktopAppStateStore(file);
    expect((await store.load()).updates).toEqual({ enabled: true });
    await store.update({ updates: { enabled: false } });
    expect((await store.load()).updates).toEqual({ enabled: false });
    await fs.writeJson(file, { agent: "claude", updates: { enabled: "no" } });
    expect(await store.load()).toMatchObject({ agent: "claude", updates: { enabled: true } });
    await fs.writeJson(file, { agent: "codex", updates: 7 });
    expect(await store.load()).toMatchObject({ agent: "codex", updates: { enabled: true } });
    await fs.remove(dir);
  });
});

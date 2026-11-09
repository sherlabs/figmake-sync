import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { describe, expect, it } from "vitest";

import { DesktopAppStateStore } from "../src/electron/appState.js";
import {
  AUTH_OK_MAX_AGE_MS,
  applyAuthProbe,
  isAuthRequiredError,
  resolveAuthCheck,
} from "../src/electron/authState.js";
import { AuthRequiredError as AutomationAuthError } from "../src/figma/adapter.js";
import { AuthRequiredError as SessionAuthError } from "../src/browser/session.js";

const now = Date.parse("2026-11-09T12:00:00Z");
const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

describe("resolveAuthCheck", () => {
  it("probe false + recent success => unknown/unconfirmed, not signed out", () => {
    const r = resolveAuthCheck(
      { authenticated: false, reason: "redirected to login" },
      daysAgo(2),
      now,
    );
    expect(r.authenticated).toBeNull();
    expect(r.unknown).toBe(true);
    expect(r.unconfirmed).toBe(true);
    expect(r.reason).toContain("Couldn't confirm your Figma session");
  });

  it("probe false + no history => false", () => {
    const r = resolveAuthCheck({ authenticated: false, reason: "redirected to login" }, null, now);
    expect(r).toEqual({ authenticated: false, reason: "redirected to login" });
    expect(resolveAuthCheck({ authenticated: false }, undefined, now).authenticated).toBe(false);
  });

  it("probe false + stale success (>14 days) => false", () => {
    expect(
      resolveAuthCheck({ authenticated: false }, daysAgo(15), now).authenticated,
    ).toBe(false);
    expect(AUTH_OK_MAX_AGE_MS).toBe(14 * 86_400_000);
  });

  it("probe true => true; probe null stays unknown without the soft flag", () => {
    expect(resolveAuthCheck({ authenticated: true }, null, now)).toEqual({ authenticated: true });
    const r = resolveAuthCheck({ authenticated: null, reason: "profile busy" }, daysAgo(1), now);
    expect(r.authenticated).toBeNull();
    expect(r.unconfirmed).toBeUndefined();
  });

  it("recognises both AuthRequiredError classes", () => {
    expect(isAuthRequiredError(new AutomationAuthError("x"))).toBe(true);
    expect(isAuthRequiredError(new SessionAuthError())).toBe(true);
    expect(isAuthRequiredError(new Error("boom"))).toBe(false);
    expect(isAuthRequiredError(null)).toBe(false);
  });
});

describe("lastAuthOkAt persistence", () => {
  it("is stored atomically, and cleared by AuthRequiredError => probe false is false", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "authstate-"));
    const store = new DesktopAppStateStore(path.join(dir, "app-state.json"));
    const okAt = new Date().toISOString();
    await store.update({ lastAuthOkAt: okAt });
    let state = await store.load();
    expect(state.lastAuthOkAt).toBe(okAt);
    expect(resolveAuthCheck({ authenticated: false }, state.lastAuthOkAt).unconfirmed).toBe(true);

    await store.update({ lastAuthOkAt: null });
    state = await store.load();
    expect(resolveAuthCheck({ authenticated: false }, state.lastAuthOkAt).authenticated).toBe(false);
    expect((await fs.readdir(dir)).some((n) => n.endsWith(".tmp"))).toBe(false);
    await fs.remove(dir);
  });

  it("probe true => true and refreshes lastAuthOkAt", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "authstate-"));
    const store = new DesktopAppStateStore(path.join(dir, "app-state.json"));
    const r = await applyAuthProbe(store, { authenticated: true }, now);
    expect(r.authenticated).toBe(true);
    expect((await store.load()).lastAuthOkAt).toBe(new Date(now).toISOString());
    const neg = await applyAuthProbe(store, { authenticated: false }, now + 1000);
    expect(neg.unconfirmed).toBe(true);
    await fs.remove(dir);
  });
});

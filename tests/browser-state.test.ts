import { describe, expect, it } from "vitest";

import { browserReducer, emptyBrowser, isLocalUrl, normalizeAddress, tabLabel, type BrowserState } from "../src/app/browser.js";

describe("normalizeAddress", () => {
  it("accepts local addresses in short forms", () => {
    expect(normalizeAddress("3000")).toBe("http://localhost:3000/");
    expect(normalizeAddress("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeAddress("  127.0.0.1:5173/about?x=1 ")).toBe("http://127.0.0.1:5173/about?x=1");
    expect(normalizeAddress("http://[::1]:8080")).toBe("http://[::1]:8080/");
    expect(normalizeAddress("https://localhost")).toBe("https://localhost/");
    expect(normalizeAddress("localhost")).toBe("http://localhost/");
  });

  it("rejects everything that is not local", () => {
    for (const bad of ["", "   ", "example.com", "https://example.com", "localhost.evil.com", "http://localhost@evil.com", "http://user:pw@localhost/", "file:///etc/passwd", "javascript:alert(1)", "ftp://localhost/", "about:blank", "local host", "999999", "http://10.0.0.1/", "evil.com/localhost"]) {
      expect(normalizeAddress(bad), bad).toBeNull();
    }
  });

  it("isLocalUrl only passes http(s) loopback", () => {
    expect(isLocalUrl("http://localhost:1/")).toBe(true);
    expect(isLocalUrl("ws://localhost/")).toBe(false);
    expect(isLocalUrl(42)).toBe(false);
  });
});

describe("browserReducer", () => {
  const home = browserReducer(emptyBrowser(), { type: "reset", url: "http://localhost:5173/" });

  it("starts with the project tab, and nothing without a project", () => {
    expect(home.tabs.map((t) => t.id)).toEqual([1]);
    expect(browserReducer(home, { type: "reset", url: null }).tabs).toEqual([]);
  });

  it("opens, switches and closes tabs; tab 1 cannot be closed", () => {
    let s: BrowserState = browserReducer(home, { type: "open", id: 2, url: "http://localhost:5173/" });
    s = browserReducer(s, { type: "open", id: 3, url: "http://127.0.0.1:3000/" });
    expect(s.activeId).toBe(3);
    expect(browserReducer(s, { type: "close", id: 1 })).toBe(s);
    s = browserReducer(s, { type: "close", id: 3 });
    expect(s.tabs.map((t) => t.id)).toEqual([1, 2]);
    expect(s.activeId).toBe(2);
    s = browserReducer(s, { type: "switch", id: 1 });
    s = browserReducer(s, { type: "close", id: 2 });
    expect(s.activeId).toBe(1);
    expect(browserReducer(s, { type: "switch", id: 99 })).toBe(s);
  });

  it("refuses non-local tabs, duplicates, and too many tabs", () => {
    expect(browserReducer(home, { type: "open", id: 2, url: "https://example.com/" })).toBe(home);
    expect(browserReducer(home, { type: "open", id: 1, url: "http://localhost/" })).toBe(home);
    let s = home;
    for (let id = 2; id < 20; id++) s = browserReducer(s, { type: "open", id, url: "http://localhost/" });
    expect(s.tabs.length).toBe(8);
  });

  it("updates one tab and ignores unknown ids", () => {
    const s = browserReducer(home, { type: "update", id: 1, patch: { loading: true, title: "Shop" } });
    expect(s.tabs[0]).toMatchObject({ loading: true, title: "Shop" });
    expect(browserReducer(s, { type: "update", id: 7, patch: { loading: false } })).toBe(s);
    expect(tabLabel(s.tabs[0]!)).toBe("Shop");
    expect(tabLabel({ title: "", url: "http://localhost:5173/x" })).toBe("localhost:5173/x");
  });
});

import { computeViewport, parseViewport, VIEWPORT_MODES } from "../src/app/browser.js";
import { clampSide, initials, readSide, sizeForKey, sizeForPointer } from "../src/app/sidebar.js";

describe("preview viewport", () => {
  it("parses stored values and falls back to Fit", () => {
    for (const m of VIEWPORT_MODES) expect(parseViewport(m)).toBe(m);
    for (const bad of [null, undefined, "", "wide", 3, {}]) expect(parseViewport(bad)).toBe("fit");
  });

  it("Fit lays out at 1280 and scales down in a narrow pane, uses the real width in a wide one (never upscaled)", () => {
    expect(computeViewport("fit", 640, 500)).toEqual({ offsetX: 0, width: 640, height: 500, cssWidth: 1280, cssHeight: 1000, scale: 0.5 });
    expect(computeViewport("fit", 1280, 700)?.scale).toBe(1);
    expect(computeViewport("fit", 1920, 900)).toMatchObject({ cssWidth: 1920, cssHeight: 900, scale: 1, offsetX: 0, width: 1920 });
  });

  it("Desktop is the same with a 1440 minimum", () => {
    expect(computeViewport("desktop", 720, 400)).toMatchObject({ cssWidth: 1440, scale: 0.5, cssHeight: 800 });
    expect(computeViewport("desktop", 1500, 400)).toMatchObject({ cssWidth: 1500, scale: 1 });
  });

  it("Tablet and Phone keep their width, centered, and scale down only when the pane is narrower", () => {
    expect(computeViewport("phone", 900, 600)).toMatchObject({ cssWidth: 390, scale: 1, width: 390, offsetX: 255, cssHeight: 600 });
    expect(computeViewport("tablet", 1000, 600)).toMatchObject({ cssWidth: 768, scale: 1, width: 768, offsetX: 116 });
    const narrow = computeViewport("tablet", 384, 600);
    expect(narrow).toMatchObject({ cssWidth: 768, scale: 0.5, width: 384, offsetX: 0, cssHeight: 1200 });
  });

  it("the scaled page always covers the pane exactly (css size x scale == view size)", () => {
    for (const mode of VIEWPORT_MODES) {
      for (const w of [200, 390, 641, 777, 1280, 1441, 2560]) {
        const l = computeViewport(mode, w, 733)!;
        expect(Math.abs(l.cssWidth * l.scale - l.width)).toBeLessThan(1);
        expect(Math.abs(l.cssHeight * l.scale - l.height)).toBeLessThan(1);
        expect(l.scale).toBeLessThanOrEqual(1);
        expect(l.offsetX + l.width).toBeLessThanOrEqual(w);
      }
    }
  });

  it("an empty pane has no layout", () => {
    expect(computeViewport("fit", 0, 500)).toBeNull();
    expect(computeViewport("phone", 500, 0)).toBeNull();
  });
});

describe("sidebar sizing", () => {
  it("clamps the width and collapses below the threshold", () => {
    expect(clampSide(100)).toBe(200);
    expect(clampSide(999)).toBe(360);
    expect(sizeForPointer(139)).toEqual({ rail: true });
    expect(sizeForPointer(150)).toEqual({ rail: false, width: 200 });
    expect(sizeForPointer(290)).toEqual({ rail: false, width: 290 });
    expect(sizeForPointer(2000)).toEqual({ rail: false, width: 360 });
    expect(sizeForPointer(2000, 300)).toEqual({ rail: false, width: 300 });
  });

  it("keyboard: arrows step by 16, collapse past the minimum, Home is the rail, End the widest", () => {
    expect(sizeForKey("ArrowRight", { rail: false, width: 228 }, 228)).toEqual({ rail: false, width: 244 });
    expect(sizeForKey("ArrowLeft", { rail: false, width: 228 }, 228)).toEqual({ rail: false, width: 212 });
    expect(sizeForKey("ArrowLeft", { rail: false, width: 205 }, 205)).toEqual({ rail: true });
    expect(sizeForKey("ArrowRight", { rail: true }, 300)).toEqual({ rail: false, width: 300 });
    expect(sizeForKey("ArrowLeft", { rail: true }, 300)).toEqual({ rail: true });
    expect(sizeForKey("Home", { rail: false, width: 300 }, 300)).toEqual({ rail: true });
    expect(sizeForKey("End", { rail: true }, 300)).toEqual({ rail: false, width: 360 });
    expect(sizeForKey("a", { rail: true }, 300)).toBeNull();
  });

  it("reads stored values, treating the old hidden state as the rail", () => {
    expect(readSide(null, null, null)).toEqual({ width: 228, rail: false });
    expect(readSide("300", "1", null)).toEqual({ width: 300, rail: true });
    expect(readSide("5000", null, "0")).toEqual({ width: 360, rail: true });
    expect(readSide("junk", "0", "0")).toEqual({ width: 228, rail: false });
  });

  it("makes initials", () => {
    expect(initials("Checkout Flow")).toBe("CF");
    expect(initials("dashboard")).toBe("DA");
    expect(initials("  ")).toBe("?");
  });
});

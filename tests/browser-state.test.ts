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

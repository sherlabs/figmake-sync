import { describe, expect, it } from "vitest";

import { isExternalLinkAllowed, isPreviewNavigationAllowed, previewOrigin } from "../src/app/preview.js";

describe("preview origin restriction", () => {
  const origin = previewOrigin("http://localhost:5173/");

  it("only a local dev server can be previewed", () => {
    expect(origin).toBe("http://localhost:5173");
    expect(previewOrigin("http://127.0.0.1:3000/x")).toBe("http://127.0.0.1:3000");
    expect(previewOrigin("https://example.com")).toBeNull();
    expect(previewOrigin("http://localhost.evil.com:80")).toBeNull();
    expect(previewOrigin("file:///etc/passwd")).toBeNull();
    expect(previewOrigin(null)).toBeNull();
  });

  it("blocks navigation to any other origin, port, scheme or garbage", () => {
    expect(isPreviewNavigationAllowed("http://localhost:5173/about?x=1", origin)).toBe(true);
    expect(isPreviewNavigationAllowed("http://localhost:5174/", origin)).toBe(false);
    expect(isPreviewNavigationAllowed("https://localhost:5173/", origin)).toBe(false);
    expect(isPreviewNavigationAllowed("http://127.0.0.1:5173/", origin)).toBe(false);
    expect(isPreviewNavigationAllowed("https://figma.com/", origin)).toBe(false);
    expect(isPreviewNavigationAllowed("javascript:alert(1)", origin)).toBe(false);
    expect(isPreviewNavigationAllowed("not a url", origin)).toBe(false);
    expect(isPreviewNavigationAllowed("http://localhost:5173/", null)).toBe(false);
  });

  it("window.open only leaves the app for https links", () => {
    expect(isExternalLinkAllowed("https://example.com/docs")).toBe(true);
    expect(isExternalLinkAllowed("http://example.com")).toBe(false);
    expect(isExternalLinkAllowed("file:///Applications")).toBe(false);
    expect(isExternalLinkAllowed("javascript:1")).toBe(false);
  });
});

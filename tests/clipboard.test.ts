import { describe, expect, it, vi } from "vitest";

import { copyToClipboard } from "../src/electron/renderer/clipboard.js";

describe("copyToClipboard fallback chain", () => {
  it("uses IPC first and stops", async () => {
    const ipcWrite = vi.fn().mockResolvedValue(true);
    const webWrite = vi.fn();
    expect(await copyToClipboard("x", { ipcWrite, webWrite })).toBe(true);
    expect(ipcWrite).toHaveBeenCalledWith("x");
    expect(webWrite).not.toHaveBeenCalled();
  });
  it("falls back to the web API when IPC rejects", async () => {
    const webWrite = vi.fn().mockResolvedValue(undefined);
    expect(await copyToClipboard("x", { ipcWrite: () => Promise.reject(new Error("no")), webWrite })).toBe(true);
    expect(webWrite).toHaveBeenCalledWith("x");
  });
  it("falls back to selection when IPC and the web API fail", async () => {
    const selectCopy = vi.fn().mockReturnValue(true);
    const ok = await copyToClipboard("x", {
      ipcWrite: () => Promise.resolve(false),
      webWrite: () => Promise.reject(new Error("blocked")),
      selectCopy,
    });
    expect(ok).toBe(true);
    expect(selectCopy).toHaveBeenCalledWith("x");
  });
  it("reports failure when everything fails", async () => {
    expect(await copyToClipboard("x", { webWrite: () => Promise.reject(new Error("b")), selectCopy: () => false })).toBe(false);
    expect(await copyToClipboard("x", {})).toBe(false);
  });
});

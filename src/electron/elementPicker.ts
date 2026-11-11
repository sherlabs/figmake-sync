import { nativeImage, type WebContents } from "electron";

import { MSG_PICK_FAILED, type ElementInfo } from "../app/elementKinds.js";
import { PICK_FUNCTION, parseElementInfo, withSource } from "../app/elementPick.js";

/* "Select element" for one preview page, using Chrome's own inspect overlay through the DevTools protocol on the page's
   `webContents.debugger`. Chrome draws the highlight and swallows the click, so the page's own handlers and links never see it.
   The session only reads: the one function that runs in the page is fixed text (PICK_FUNCTION), and nothing the page or the person
   wrote is ever sent as code. The debugger is attached only while the mode is on and is always detached again. */

export interface PickResult {
  info: ElementInfo;
  /** The cropped picture of the element (PNG), or null when it could not be taken. */
  png: Buffer | null;
}

export type PickEnd = "done" | "cancelled" | "error" | "detached";

export interface PickerHooks {
  /** The project folder, to find the file of the picked component. */
  root(): string | null;
  onPick(result: PickResult): void;
  /** The mode is over (after a pick, Esc, an error, or the page going away). `message` is a plain sentence for the person. */
  onEnd(reason: PickEnd, message?: string): void;
}

const COMMAND_MS = 5000;
const SHOT_PAD = 6;
const SHOT_MAX_SIDE = 1200;
const SHOT_MAX_CSS = 6000;

const HIGHLIGHT = {
  showInfo: true,
  showStyles: false,
  showAccessibilityInfo: false,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
};

interface Quad {
  border?: number[];
}

export class ElementPicker {
  private on = false;
  private busy = false;
  private readonly onMessage = (_e: unknown, method: string, params: { backendNodeId?: number }): void => {
    if (method === "Overlay.inspectNodeRequested" && typeof params?.backendNodeId === "number") void this.pick(params.backendNodeId);
  };
  private readonly onDetach = (): void => {
    if (this.on) void this.finish("detached", "The page stopped sharing.");
  };
  private readonly onKey = (event: { preventDefault(): void }, input: { type: string; key: string }): void => {
    if (this.on && input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault();
      void this.finish("cancelled");
    }
  };

  constructor(
    private readonly wc: WebContents,
    private readonly hooks: PickerHooks,
  ) {}

  get active(): boolean {
    return this.on;
  }

  /** Attaches the debugger and turns Chrome's inspect mode on. Returns false (and attaches nothing) when that is not possible. */
  async start(): Promise<boolean> {
    if (this.on) return true;
    const dbg = this.wc.debugger;
    try {
      // Something else (for example the page's own DevTools) may have it already: take it over for the moment of the pick.
      if (dbg.isAttached()) dbg.detach();
      dbg.attach("1.3");
    } catch {
      return false;
    }
    this.on = true;
    dbg.on("message", this.onMessage);
    dbg.on("detach", this.onDetach);
    this.wc.on("before-input-event", this.onKey);
    try {
      await this.send("DOM.enable");
      await this.send("Overlay.enable");
      await this.send("Overlay.setInspectMode", { mode: "searchForNode", highlightConfig: HIGHLIGHT });
      return true;
    } catch {
      await this.finish("error", "Couldn't start picking on this page.");
      return false;
    }
  }

  /** Ends the mode without picking. */
  stop(): Promise<void> {
    return this.on ? this.finish("cancelled") : Promise.resolve();
  }

  private send<T = unknown>(method: string, params: object = {}): Promise<T> {
    if (this.wc.isDestroyed()) return Promise.reject(new Error("closed"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} timed out`)), COMMAND_MS);
    });
    return Promise.race([this.wc.debugger.sendCommand(method, params) as Promise<T>, timeout]).finally(() => clearTimeout(timer));
  }

  private async pick(backendNodeId: number): Promise<void> {
    if (!this.on || this.busy) return;
    this.busy = true;
    let objectId: string | undefined;
    try {
      const resolved = await this.send<{ object?: { objectId?: string } }>("DOM.resolveNode", { backendNodeId });
      objectId = resolved.object?.objectId;
      if (!objectId) throw new Error("no node");
      const called = await this.send<{ result?: { value?: unknown } }>("Runtime.callFunctionOn", { objectId, functionDeclaration: PICK_FUNCTION, returnByValue: true, silent: true });
      const raw = called.result?.value as { rect?: { x: number; y: number; width: number; height: number } | null; scroll?: { x: number; y: number } | null } | undefined;
      const parsed = parseElementInfo(raw);
      if (!parsed || !raw) throw new Error("no details");
      // Chrome's own measure of the element (CSS pixels, however the preview is scaled); the page's measure is the fallback.
      const quad = await this.send<{ model?: Quad }>("DOM.getBoxModel", { backendNodeId }).then((r) => r.model?.border, () => undefined);
      const box = quad && quad.length >= 8 ? boxOf(quad) : null;
      const info = await withSource({ ...parsed, box: box ?? parsed.box }, this.hooks.root());
      const png = await this.shoot(box ?? parsed.box, raw.scroll ?? { x: 0, y: 0 });
      this.hooks.onPick({ info, png });
      await this.finish("done");
    } catch {
      await this.finish("error", MSG_PICK_FAILED);
    } finally {
      this.busy = false;
      if (objectId && this.on && !this.wc.isDestroyed()) void this.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  }

  /** The element's own pixels, a few pixels of padding around them, at most ~1200 px on the long side. Null when it cannot be taken. */
  private async shoot(box: { x: number; y: number; width: number; height: number }, scroll: { x: number; y: number }): Promise<Buffer | null> {
    if (box.width < 1 || box.height < 1) return null;
    try {
      const x = Math.max(0, box.x + scroll.x - SHOT_PAD);
      const y = Math.max(0, box.y + scroll.y - SHOT_PAD);
      const width = Math.min(SHOT_MAX_CSS, box.width + SHOT_PAD * 2 + Math.min(0, box.x + scroll.x - SHOT_PAD));
      const height = Math.min(SHOT_MAX_CSS, box.height + SHOT_PAD * 2 + Math.min(0, box.y + scroll.y - SHOT_PAD));
      const scale = Math.min(1, SHOT_MAX_SIDE / Math.max(width, height));
      // The overlay's highlight must not be in the picture: switch it off for the moment of the capture.
      await this.send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} });
      await this.send("Overlay.hideHighlight").catch(() => undefined);
      const shot = await this.send<{ data?: string }>("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true, clip: { x, y, width, height, scale } });
      if (!shot.data) return null;
      let image = nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
      const size = image.getSize();
      const long = Math.max(size.width, size.height);
      if (long === 0) return null;
      if (long > SHOT_MAX_SIDE) image = image.resize({ width: Math.round((size.width * SHOT_MAX_SIDE) / long), height: Math.round((size.height * SHOT_MAX_SIDE) / long) });
      return image.toPNG();
    } catch {
      return null;
    }
  }

  private async finish(reason: PickEnd, message?: string): Promise<void> {
    if (!this.on) return;
    this.on = false;
    const wc = this.wc;
    const dbg = wc.debugger;
    wc.removeListener("before-input-event", this.onKey);
    dbg.removeListener("message", this.onMessage);
    dbg.removeListener("detach", this.onDetach);
    if (!wc.isDestroyed() && dbg.isAttached()) {
      const quiet = (method: string, params: object = {}): Promise<unknown> => (dbg.sendCommand(method, params) as Promise<unknown>).catch(() => undefined);
      await Promise.race([
        (async () => {
          await quiet("Overlay.setInspectMode", { mode: "none", highlightConfig: {} });
          await quiet("Overlay.disable");
          await quiet("DOM.disable");
        })(),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      try {
        dbg.detach();
      } catch {
        /* already gone */
      }
    }
    this.hooks.onEnd(reason, message);
  }
}

/** The smallest rectangle around a quad (x1,y1 ... x4,y4). */
function boxOf(q: number[]): { x: number; y: number; width: number; height: number } {
  const xs = [q[0], q[2], q[4], q[6]].map((n) => n ?? 0);
  const ys = [q[1], q[3], q[5], q[7]].map((n) => n ?? 0);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

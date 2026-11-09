import { shell, WebContentsView, type BrowserWindow } from "electron";

import { isExternalLinkAllowed, isPreviewNavigationAllowed, previewOrigin } from "../app/preview.js";
import type { PreviewRect } from "./contracts.js";

/**
 * The running app, shown inside the window. A sandboxed, isolated-partition view that can only
 * ever display the project's own dev server: no node, no preload, no navigation elsewhere.
 */
export class PreviewView {
  private view: WebContentsView | null = null;
  private url: string | null = null;
  private rect: PreviewRect | null = null;

  constructor(private readonly window: BrowserWindow) {}

  setUrl(url: string | null): void {
    if (url === this.url) return;
    this.url = url;
    this.destroy();
    const origin = previewOrigin(url);
    if (!url || !origin) return;

    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        partition: "figmake-preview",
      },
    });
    const wc = view.webContents;
    const guard = (event: { preventDefault(): void }, target: string): void => {
      if (!isPreviewNavigationAllowed(target, origin)) event.preventDefault();
    };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", guard);
    wc.setWindowOpenHandler(({ url: target }) => {
      if (isExternalLinkAllowed(target)) void shell.openExternal(target);
      return { action: "deny" };
    });
    wc.session.setPermissionRequestHandler((_wc, _permission, done) => done(false));
    view.setBackgroundColor("#ffffff");
    this.window.contentView.addChildView(view);
    this.view = view;
    this.layout();
    void wc.loadURL(url).catch(() => undefined);
  }

  setRect(rect: PreviewRect | null): void {
    this.rect = rect;
    this.layout();
  }

  reload(): void {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.reloadIgnoringCache();
  }

  private layout(): void {
    if (!this.view) return;
    const r = this.rect;
    this.view.setVisible(Boolean(r));
    if (r) {
      this.view.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)) });
    }
  }

  private destroy(): void {
    if (!this.view) return;
    this.window.contentView.removeChildView(this.view);
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
  }
}

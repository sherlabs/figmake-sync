import { shell, WebContentsView, type BrowserWindow } from "electron";

import { browserReducer, emptyBrowser, HOME_TAB, isLocalUrl, normalizeAddress, type BrowserAction, type BrowserState } from "../app/browser.js";
import type { BrowserCommand, PreviewRect } from "./contracts.js";

const RETRY_MS = 1500;
const MAX_RETRIES = 60;
/** The first failures stay quiet (the dev server is often still starting); after this many the pane says so. */
const QUIET_FAILURES = 3;

interface Tab {
  view: WebContentsView;
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The running app, shown inside the window. Every tab is a sandboxed, isolated-partition view that can only
 * ever display pages served from this computer: no node, no preload, no navigation elsewhere.
 * Tab 1 is the project's own preview; the other tabs are opened by the person or by the page itself.
 */
export class PreviewView {
  private tabs = new Map<number, Tab>();
  private state: BrowserState = emptyBrowser();
  private url: string | null = null;
  private rect: PreviewRect | null = null;
  private nextId = HOME_TAB + 1;

  constructor(
    private readonly window: BrowserWindow,
    private readonly onChange: (state: BrowserState) => void = () => undefined,
  ) {}

  getState(): BrowserState {
    return this.state;
  }

  setUrl(url: string | null): void {
    if (url === this.url) return;
    this.url = url;
    this.destroyAll();
    this.nextId = HOME_TAB + 1;
    if (!url || !isLocalUrl(url)) {
      this.apply({ type: "reset", url: null });
      return;
    }
    this.apply({ type: "reset", url });
    this.create(HOME_TAB, url);
    this.layout();
  }

  setRect(rect: PreviewRect | null): void {
    this.rect = rect;
    this.layout();
  }

  /** The AI changed files: refresh every page (a page that never loaded is tried again). */
  reload(): void {
    for (const [id, tab] of this.tabs) {
      const wc = tab.view.webContents;
      if (wc.isDestroyed()) continue;
      if (this.tabState(id)?.failed) this.retry(id);
      else wc.reloadIgnoringCache();
    }
  }

  go(address: string): boolean {
    const href = normalizeAddress(address);
    const tab = this.tabs.get(this.state.activeId);
    if (!href || !tab) return false;
    this.load(this.state.activeId, href);
    return true;
  }

  command(action: BrowserCommand): void {
    const id = this.state.activeId;
    const wc = this.tabs.get(id)?.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    switch (action) {
      case "back":
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        break;
      case "forward":
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        break;
      case "reload":
        if (this.tabState(id)?.failed) this.retry(id);
        else wc.reloadIgnoringCache();
        break;
      case "stop":
        wc.stop();
        this.patch(id, { loading: false });
        break;
      case "retry":
        this.retry(id);
        break;
      case "external": {
        const url = this.tabState(id)?.url;
        if (isLocalUrl(url)) void shell.openExternal(url);
        break;
      }
    }
  }

  newTab(): void {
    this.open(this.tabState(this.state.activeId)?.url ?? this.url ?? "");
  }

  switchTo(id: number): void {
    this.apply({ type: "switch", id });
    this.layout();
  }

  close(id: number): void {
    if (id === HOME_TAB) return;
    this.destroyTab(id);
    this.apply({ type: "close", id });
    this.layout();
  }

  private open(url: string): void {
    if (!isLocalUrl(url)) return;
    const id = this.nextId;
    const before = this.state.tabs.length;
    this.apply({ type: "open", id, url });
    if (this.state.tabs.length === before) return; // too many tabs
    this.nextId += 1;
    this.create(id, url);
    this.layout();
  }

  private tabState(id: number) {
    return this.state.tabs.find((t) => t.id === id);
  }

  private apply(action: BrowserAction): void {
    const next = browserReducer(this.state, action);
    if (next === this.state) return;
    this.state = next;
    this.onChange(next);
  }

  private patch(id: number, patch: Extract<BrowserAction, { type: "update" }>["patch"]): void {
    this.apply({ type: "update", id, patch });
    if ("failed" in patch) this.layout();
  }

  private load(id: number, url: string): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.view.webContents.isDestroyed()) return;
    if (tab.timer) clearTimeout(tab.timer);
    tab.timer = null;
    tab.retries = 0;
    this.patch(id, { failed: false, url });
    void tab.view.webContents.loadURL(url).catch(() => undefined);
  }

  private retry(id: number): void {
    const url = this.tabState(id)?.url;
    if (url && isLocalUrl(url)) this.load(id, url);
  }

  private create(id: number, url: string): void {
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
    const tab: Tab = { view, retries: 0, timer: null };
    this.tabs.set(id, tab);

    const guard = (event: { preventDefault(): void }, target: string): void => {
      if (!isLocalUrl(target)) event.preventDefault();
    };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", guard);
    wc.setWindowOpenHandler(({ url: target }) => {
      if (isLocalUrl(target)) this.open(target);
      return { action: "deny" };
    });
    wc.session.setPermissionRequestHandler((_wc, _permission, done) => done(false));
    view.setBackgroundColor("#ffffff");
    this.window.contentView.addChildView(view);

    const sync = (): void => {
      if (wc.isDestroyed()) return;
      const current = wc.getURL();
      this.patch(id, {
        ...(isLocalUrl(current) ? { url: current } : {}),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      });
    };
    wc.on("did-start-loading", () => this.patch(id, { loading: true }));
    wc.on("did-stop-loading", () => {
      this.patch(id, { loading: false });
      sync();
    });
    wc.on("did-navigate", sync);
    wc.on("did-navigate-in-page", sync);
    wc.on("page-title-updated", (_event, title) => this.patch(id, { title }));
    wc.on("did-finish-load", () => {
      tab.retries = 0;
      this.patch(id, { failed: false });
      sync();
    });
    // The dev server can accept connections a moment before it can serve the page: retry quietly, never leave a blank view.
    wc.on("did-fail-load", (_event, code, _desc, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3 || this.tabs.get(id) !== tab) return; // -3 = aborted by a newer navigation
      tab.retries += 1;
      this.patch(id, { loading: false, ...(isLocalUrl(failedUrl) ? { url: failedUrl } : {}), ...(tab.retries >= QUIET_FAILURES ? { failed: true } : {}) });
      if (tab.retries >= MAX_RETRIES) return;
      const target = failedUrl && isLocalUrl(failedUrl) ? failedUrl : url;
      tab.timer = setTimeout(() => {
        tab.timer = null;
        if (this.tabs.get(id) === tab && !wc.isDestroyed()) void wc.loadURL(target).catch(() => undefined);
      }, RETRY_MS);
    });
    void wc.loadURL(url).catch(() => undefined);
  }

  private layout(): void {
    const r = this.rect;
    const active = this.state.activeId;
    for (const [id, tab] of this.tabs) {
      const failed = this.tabState(id)?.failed ?? false;
      tab.view.setVisible(Boolean(r) && id === active && !failed);
      if (r) tab.view.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)) });
    }
  }

  private destroyTab(id: number): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.tabs.delete(id);
    if (tab.timer) clearTimeout(tab.timer);
    this.window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }

  private destroyAll(): void {
    for (const id of [...this.tabs.keys()]) this.destroyTab(id);
  }
}

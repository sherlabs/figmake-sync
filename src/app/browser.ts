/* Pure logic behind the preview's browser bar: which addresses are allowed, and the tab list. */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True for http(s) pages served from this computer: localhost, 127.0.0.1 or [::1]. */
export function isLocalUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && LOCAL_HOSTS.has(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * Turns what was typed into an address: "3000" and "localhost:3000/x" become http://localhost:... URLs.
 * Returns null for anything that is not a local page.
 */
export function normalizeAddress(input: string): string | null {
  const text = input.trim();
  if (!text || text.length > 2048 || /\s/u.test(text)) return null;
  let candidate = text;
  if (/^\d{1,5}$/u.test(text)) candidate = `http://localhost:${text}/`;
  else if (!/^https?:\/\//iu.test(text)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) return null; // another scheme (file://, ftp://…)
    candidate = `http://${text}`;
  }
  try {
    const href = new URL(candidate).href;
    return isLocalUrl(href) ? href : null;
  } catch {
    return null;
  }
}

export interface BrowserTab {
  id: number;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The page could not be loaded (after the quiet retries). */
  failed: boolean;
}

export interface BrowserState {
  tabs: BrowserTab[];
  activeId: number;
}

/** Tab 1 is the project's own preview: it is always there and cannot be closed. */
export const HOME_TAB = 1;
export const MAX_TABS = 8;

const blank = (id: number, url: string): BrowserTab => ({ id, title: "", url, loading: false, canGoBack: false, canGoForward: false, failed: false });

export const emptyBrowser = (): BrowserState => ({ tabs: [], activeId: HOME_TAB });

export type BrowserAction =
  | { type: "reset"; url: string | null }
  | { type: "open"; id: number; url: string }
  | { type: "close"; id: number }
  | { type: "switch"; id: number }
  | { type: "update"; id: number; patch: Partial<Omit<BrowserTab, "id">> };

export function browserReducer(state: BrowserState, action: BrowserAction): BrowserState {
  switch (action.type) {
    case "reset":
      return action.url ? { tabs: [blank(HOME_TAB, action.url)], activeId: HOME_TAB } : emptyBrowser();
    case "open": {
      if (state.tabs.length === 0 || state.tabs.length >= MAX_TABS || state.tabs.some((t) => t.id === action.id) || !isLocalUrl(action.url)) return state;
      return { tabs: [...state.tabs, blank(action.id, action.url)], activeId: action.id };
    }
    case "close": {
      const index = state.tabs.findIndex((t) => t.id === action.id);
      if (action.id === HOME_TAB || index < 0) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      const activeId = state.activeId === action.id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? HOME_TAB) : state.activeId;
      return { tabs, activeId };
    }
    case "switch":
      return state.tabs.some((t) => t.id === action.id) ? { ...state, activeId: action.id } : state;
    case "update":
      return state.tabs.some((t) => t.id === action.id) ? { ...state, tabs: state.tabs.map((t) => (t.id === action.id ? { ...t, ...action.patch } : t)) } : state;
  }
}

/** What a tab is called in the strip: the page title, else the address without the scheme. */
export function tabLabel(tab: Pick<BrowserTab, "title" | "url">): string {
  if (tab.title.trim()) return tab.title.trim();
  try {
    const u = new URL(tab.url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return "New tab";
  }
}

/* ---- Preview viewport: every page lays out at a fixed CSS width and is scaled to fit the pane ---- */

export const VIEWPORT_MODES = ["fit", "desktop", "tablet", "phone"] as const;
export type ViewportMode = (typeof VIEWPORT_MODES)[number];
export const DEFAULT_VIEWPORT: ViewportMode = "fit";

/**
 * Width (CSS px) a page is laid out at.
 * `fill` modes (Fit, Desktop) use at least this width and the whole pane; on a wider pane they use the pane's real width (never upscaled).
 * Device modes (Tablet, Phone) always use exactly this width and sit centered in the pane.
 */
export const VIEWPORT_WIDTH: Record<ViewportMode, { width: number; fill: boolean; label: string }> = {
  fit: { width: 1280, fill: true, label: "Fit" },
  desktop: { width: 1440, fill: true, label: "Desktop 1440" },
  tablet: { width: 768, fill: false, label: "Tablet 768" },
  phone: { width: 390, fill: false, label: "Phone 390" },
};

/** Anything stored or received that is not a known mode becomes the default. */
export function parseViewport(raw: unknown): ViewportMode {
  return typeof raw === "string" && (VIEWPORT_MODES as readonly string[]).includes(raw) ? (raw as ViewportMode) : DEFAULT_VIEWPORT;
}

export interface ViewportLayout {
  /** Where the native view sits inside the pane, in pane pixels (centered for device modes). */
  offsetX: number;
  width: number;
  height: number;
  /** The CSS size the page lays out at, and the factor it is drawn at (<= 1). */
  cssWidth: number;
  cssHeight: number;
  scale: number;
}

const MIN_SCALE = 0.1;

/** Pure scale math behind the preview's device emulation. Returns null when the pane has no size. */
export function computeViewport(mode: ViewportMode, paneWidth: number, paneHeight: number): ViewportLayout | null {
  const paneW = Math.floor(paneWidth);
  const paneH = Math.floor(paneHeight);
  if (!(paneW > 0) || !(paneH > 0)) return null;
  const spec = VIEWPORT_WIDTH[mode];
  if (spec.fill) {
    const cssWidth = Math.max(spec.width, paneW);
    const scale = Math.max(MIN_SCALE, paneW / cssWidth);
    return { offsetX: 0, width: paneW, height: paneH, cssWidth, cssHeight: Math.round(paneH / scale), scale };
  }
  const scale = Math.max(MIN_SCALE, Math.min(1, paneW / spec.width));
  const width = Math.min(paneW, Math.round(spec.width * scale));
  return { offsetX: Math.floor((paneW - width) / 2), width, height: paneH, cssWidth: spec.width, cssHeight: Math.round(paneH / scale), scale };
}

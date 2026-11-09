/** Copy helper: main-process clipboard first (works under Electron's renderer restrictions), then the web API, then a hidden-selection execCommand. */
export interface ClipboardDeps {
  ipcWrite?: ((text: string) => Promise<unknown>) | undefined;
  webWrite?: ((text: string) => Promise<void>) | undefined;
  /** Last resort: select the text in a temporary element and run execCommand("copy"). */
  selectCopy?: ((text: string) => boolean) | undefined;
}

export async function copyToClipboard(text: string, deps: ClipboardDeps): Promise<boolean> {
  if (deps.ipcWrite) {
    try {
      if ((await deps.ipcWrite(text)) !== false) return true;
    } catch {
      /* fall through */
    }
  }
  if (deps.webWrite) {
    try {
      await deps.webWrite(text);
      return true;
    } catch {
      /* fall through */
    }
  }
  if (deps.selectCopy) {
    try {
      return deps.selectCopy(text);
    } catch {
      return false;
    }
  }
  return false;
}

/** DOM-backed selection fallback. */
export function selectCopyInDocument(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.appendChild(ta);
  const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    ta.remove();
    prev?.focus();
  }
  return ok;
}

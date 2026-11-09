/** The preview may only ever show the project's own local dev server. */
export function previewOrigin(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return (u.protocol === "http:" || u.protocol === "https:") && local ? u.origin : null;
  } catch {
    return null;
  }
}

export function isPreviewNavigationAllowed(target: string, origin: string | null): boolean {
  if (!origin) return false;
  try {
    return new URL(target).origin === origin;
  } catch {
    return false;
  }
}

/** window.open from the preview: only plain https links leave the app (in the system browser). */
export function isExternalLinkAllowed(target: string): boolean {
  try {
    return new URL(target).protocol === "https:";
  } catch {
    return false;
  }
}

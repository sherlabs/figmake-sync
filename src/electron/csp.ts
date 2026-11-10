/* The window's content security policy. Monaco (the code viewer) needs inline styles (it sets style attributes and
   injects <style>) and workers started from blob: URLs; nothing else is loosened and no remote origin is allowed.
   index.html carries the same text in its meta tag; a test keeps the two identical. */
export const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src blob:; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

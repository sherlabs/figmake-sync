/** True for the typed "login required" errors thrown by the browser/automation layers. */
export function isAuthRequiredError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: unknown; code?: unknown };
  return e.name === "AuthRequiredError" || e.code === "AUTH_REQUIRED";
}

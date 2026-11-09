export const AUTH_OK_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface AuthProbeResult {
  authenticated: boolean | null;
  reason?: string;
}

export interface AuthCheckResponse {
  authenticated: boolean | null;
  unknown?: boolean;
  /** Probe said signed out but a recent real operation succeeded: show a soft notice. */
  unconfirmed?: boolean;
  reason?: string;
}

export const UNCONFIRMED_REASON =
  "Couldn't confirm your Figma session from a background check";

/** True for the typed "login required" errors thrown by the browser/automation layers. */
export function isAuthRequiredError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: unknown; code?: unknown };
  return e.name === "AuthRequiredError" || e.code === "AUTH_REQUIRED";
}

/**
 * The background probe is advisory: headless Chromium can be bounced to the
 * login page even with valid cookies. A real pull/push/verify is authoritative,
 * so a recent success (cleared by any AuthRequiredError) overrides a negative probe.
 */
export function resolveAuthCheck(
  probe: AuthProbeResult,
  lastAuthOkAt: string | null | undefined,
  now: number = Date.now(),
): AuthCheckResponse {
  if (probe.authenticated === true) return { authenticated: true };
  if (probe.authenticated === null) {
    return {
      authenticated: null,
      unknown: true,
      ...(probe.reason ? { reason: probe.reason } : {}),
    };
  }
  const okAt = lastAuthOkAt ? Date.parse(lastAuthOkAt) : Number.NaN;
  if (Number.isFinite(okAt) && now - okAt >= 0 && now - okAt <= AUTH_OK_MAX_AGE_MS) {
    return {
      authenticated: null,
      unknown: true,
      unconfirmed: true,
      reason: UNCONFIRMED_REASON,
    };
  }
  return {
    authenticated: false,
    ...(probe.reason ? { reason: probe.reason } : {}),
  };
}

export interface AuthStateStorage {
  load(): Promise<{ lastAuthOkAt?: string | null | undefined }>;
  update(patch: { lastAuthOkAt: string | null }): Promise<unknown>;
}

/** Resolve a probe against persisted history; a positive probe refreshes lastAuthOkAt. */
export async function applyAuthProbe(
  store: AuthStateStorage,
  probe: AuthProbeResult,
  now: number = Date.now(),
): Promise<AuthCheckResponse> {
  const okAt = (await store.load().catch(() => null))?.lastAuthOkAt;
  const resolved = resolveAuthCheck(probe, okAt, now);
  if (resolved.authenticated === true) {
    await store.update({ lastAuthOkAt: new Date(now).toISOString() }).catch(() => undefined);
  }
  return resolved;
}

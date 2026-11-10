export const UPDATE_STATE_CHANNEL = "figmake:update-state";
export const UPDATE_INSTALL_CHANNEL = "figmake:update-install";
export const UPDATE_CHECK_CHANNEL = "figmake:update-check";
export const UPDATE_GET_CHANNEL = "figmake:update-get";

export type UpdatePhase = "idle" | "checking" | "downloading" | "ready";

export interface UpdateState {
  phase: UpdatePhase;
  /** The version being downloaded or waiting to be installed. */
  version?: string;
  /** The version running right now. */
  currentVersion: string;
  /** False when this build can't update itself (dev builds, some Linux installs). */
  supported: boolean;
  /** True after a check found nothing newer. Cleared when a new update shows up. */
  upToDate: boolean;
  /** ISO time of the last finished check. */
  lastCheckedAt?: string;
  /** One plain sentence when the last check failed. */
  error?: string;
}

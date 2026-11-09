export const UPDATE_STATE_CHANNEL = "figmake:update-state";
export const UPDATE_INSTALL_CHANNEL = "figmake:update-install";

export type UpdatePhase = "idle" | "downloading" | "ready";

export interface UpdateState {
  phase: UpdatePhase;
  version?: string;
}

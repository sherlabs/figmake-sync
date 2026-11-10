import type { Phase, ProcessInfo } from "../electron/contracts.js";
import type { DevStatus } from "../harness/types.js";

/* The short list of things figmake-sync keeps running for the open project, in plain words. */

export interface ProcessInputs {
  hasProject: boolean;
  phase: Phase;
  previewUrl: string | null;
  /** Latest state of the project's preview server, or null when nothing has been reported yet. */
  dev: Pick<DevStatus, "state"> | null;
  /** The project's files are being installed (npm install). */
  installing: boolean;
  /** The AI helper is answering a message. */
  agentWorking: boolean;
  agentName: string;
  /** Recent cleaned output of the preview server and of project setup. */
  devLines?: readonly string[];
  setupLines?: readonly string[];
}

const TAIL = 40;
const BUSY: readonly Phase[] = ["connecting", "preparing", "working", "sending", "conflict"];

export function buildProcesses(i: ProcessInputs): ProcessInfo[] {
  if (!i.hasProject) return [];
  const calm = !BUSY.includes(i.phase);
  const out: ProcessInfo[] = [];

  let state: ProcessInfo["state"];
  if (i.dev) state = i.dev.state === "crashed" ? "failed" : i.dev.state === "running" ? "running" : i.dev.state;
  else if (i.previewUrl) state = "running";
  else state = i.phase === "connecting" || i.phase === "preparing" ? "starting" : "stopped";
  const note = state === "failed" ? "The preview stopped unexpectedly." : undefined;
  out.push({
    id: "preview",
    name: "Preview",
    state,
    ...(note ? { note } : {}),
    // Only while nothing else is going on, so a restart never collides with a pull, a send or an AI turn.
    canStop: calm && (state === "running" || state === "starting"),
    canRestart: calm && state !== "starting",
    output: [...(i.devLines ?? [])].slice(-TAIL),
  });

  if (i.installing) out.push({ id: "install", name: "Setting up project files", state: "running", canStop: true, canRestart: false, output: [...(i.setupLines ?? [])].slice(-TAIL) });
  if (i.agentWorking) out.push({ id: "agent", name: `${i.agentName} (AI helper)`, state: "running", canStop: true, canRestart: false, output: [] });
  return out;
}

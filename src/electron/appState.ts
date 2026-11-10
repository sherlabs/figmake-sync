import path from "node:path";

import fs from "fs-extra";
import { z } from "zod";

import type { DesktopAppState } from "./contracts.js";

const desktopAppStateSchema = z.object({
  lastLink: z.string().nullable().default(null),
  agent: z.enum(["claude", "codex"]).nullable().default(null),
  workspace: z.string().nullable().default(null),
  /** Figma Make file key -> absolute project folder (existing projects keep their path). */
  projects: z.record(z.string(), z.string()).default({}),
  /** Figma Make file key -> the link it was added with. A malformed value is dropped alone. */
  links: z.record(z.string(), z.string()).catch({}).default({}),
  /** A malformed value falls back to "on" instead of discarding the rest of the saved state. */
  updates: z.object({ enabled: z.boolean().catch(true) }).catch({ enabled: true }).default({ enabled: true }),
});

export class DesktopAppStateStore {
  constructor(private readonly statePath: string) {}

  async load(): Promise<DesktopAppState> {
    if (!(await fs.pathExists(this.statePath))) {
      return desktopAppStateSchema.parse({});
    }

    try {
      const rawState: unknown = await fs.readJson(this.statePath);
      return desktopAppStateSchema.parse(rawState);
    } catch {
      // Corrupt or truncated state: keep a backup and start from defaults.
      await fs
        .move(this.statePath, `${this.statePath}.corrupt-${Date.now()}`, {
          overwrite: true,
        })
        .catch(() => undefined);
      return desktopAppStateSchema.parse({});
    }
  }

  async save(state: DesktopAppState): Promise<DesktopAppState> {
    const nextState = desktopAppStateSchema.parse(state);

    await fs.ensureDir(path.dirname(this.statePath));
    const tmpPath = `${this.statePath}.${process.pid}.tmp`;
    await fs.writeJson(tmpPath, nextState, { spaces: 2 });
    await fs.move(tmpPath, this.statePath, { overwrite: true });

    return nextState;
  }

  private queue: Promise<unknown> = Promise.resolve();

  update(patch: Partial<DesktopAppState>): Promise<DesktopAppState> {
    const run = this.queue.then(async () => {
      const currentState = await this.load();
      return this.save({ ...currentState, ...patch });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

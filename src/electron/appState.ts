import path from "node:path";

import fs from "fs-extra";
import { z } from "zod";

import type { DesktopAppState } from "./contracts.js";

const desktopAppStateSchema = z.object({
  lastProjectRoot: z.string().nullable().default(null),
});

export class DesktopAppStateStore {
  constructor(private readonly statePath: string) {}

  async load(): Promise<DesktopAppState> {
    if (!(await fs.pathExists(this.statePath))) {
      return desktopAppStateSchema.parse({});
    }

    const rawState: unknown = await fs.readJson(this.statePath);
    return desktopAppStateSchema.parse(rawState);
  }

  async save(state: DesktopAppState): Promise<DesktopAppState> {
    const nextState = desktopAppStateSchema.parse(state);

    await fs.ensureDir(path.dirname(this.statePath));
    await fs.writeJson(this.statePath, nextState, { spaces: 2 });

    return nextState;
  }

  async update(patch: Partial<DesktopAppState>): Promise<DesktopAppState> {
    const currentState = await this.load();

    return this.save({
      ...currentState,
      ...patch,
    });
  }
}

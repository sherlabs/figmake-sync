import { EventEmitter } from "node:events";

import type { ChildLike, KillTreeFn, SpawnFn } from "../../src/harness/process.js";

export class FakeChild extends EventEmitter implements ChildLike {
  pid = 4242;
  stdout = new EventEmitter() as unknown as ChildLike["stdout"];
  stderr = new EventEmitter() as unknown as ChildLike["stderr"];
  stdinData = "";
  stdinEnded = false;
  stdin = {
    write: (d: string) => {
      this.stdinData += d;
    },
    end: () => {
      this.stdinEnded = true;
    },
  };
  signals: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
  out(text: string): void {
    (this.stdout as unknown as EventEmitter).emit("data", Buffer.from(text));
  }
  err(text: string): void {
    (this.stderr as unknown as EventEmitter).emit("data", Buffer.from(text));
  }
  exit(code: number | null = 0): void {
    this.emit("close", code, null);
  }
}

export interface SpawnCall {
  command: string;
  args: readonly string[];
  options: { cwd?: unknown; shell?: unknown; detached?: unknown; env?: NodeJS.ProcessEnv };
  child: FakeChild;
}

/** Spawn fake: records calls, hands each new FakeChild to `onSpawn`. */
export function createFakeSpawn(onSpawn?: (call: SpawnCall) => void): { spawn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild();
    const call = { command, args, options: options as SpawnCall["options"], child };
    calls.push(call);
    onSpawn?.(call);
    return child;
  };
  return { spawn, calls };
}

/** killTree fake: records signals; SIGTERM makes the child close like a real process would. */
export function createFakeKillTree(): { killTree: KillTreeFn; kills: Array<{ pid: number | undefined; signal: string }> } {
  const kills: Array<{ pid: number | undefined; signal: string }> = [];
  const killTree: KillTreeFn = (child, signal) => {
    kills.push({ pid: child.pid, signal });
    (child as FakeChild).signals.push(signal);
    queueMicrotask(() => (child as FakeChild).exit(null));
  };
  return { killTree, kills };
}

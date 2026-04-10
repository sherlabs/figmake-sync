import path from "node:path";

import fs from "fs-extra";
import pino, { type Logger } from "pino";
import pretty from "pino-pretty";

import type { LogLevel } from "../types/config.js";

function resolveLogLevel(
  level: LogLevel,
  verbose: boolean,
): pino.LevelWithSilent {
  if (level === "silent") {
    return "silent";
  }

  if (verbose || level === "debug") {
    return "debug";
  }

  return "info";
}

export async function createProjectLogger(options: {
  logFilePath: string;
  level: LogLevel;
  verbose?: boolean;
  onLog?: (message: string) => void;
}): Promise<Logger> {
  await fs.ensureDir(path.dirname(options.logFilePath));

  const consoleStream = process.stdout.isTTY
    ? pretty({
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
        singleLine: true,
      })
    : pino.destination(1);
  const fileStream = pino.destination({
    dest: options.logFilePath,
    mkdir: true,
    sync: false,
  });

  const streams: pino.StreamEntry[] = [
    { stream: consoleStream },
    { stream: fileStream },
  ];

  // Forward log messages to the UI when verbose and callback provided
  if (options.onLog) {
    const onLog = options.onLog;
    const callbackStream = new (await import("node:stream")).Writable({
      write(chunk: Buffer, _encoding, callback) {
        try {
          const parsed = JSON.parse(chunk.toString()) as { msg?: string; message?: string };
          const msg = parsed.msg || parsed.message;
          if (msg) onLog(msg);
        } catch {
          // Not JSON, forward raw
          onLog(chunk.toString().trim());
        }
        callback();
      },
    });
    streams.push({ stream: callbackStream });
  }

  return pino(
    {
      level: resolveLogLevel(options.level, options.verbose ?? false),
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams),
  );
}

export async function flushLogger(logger: Logger): Promise<void> {
  logger.flush?.();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

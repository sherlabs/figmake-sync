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

  return pino(
    {
      level: resolveLogLevel(options.level, options.verbose ?? false),
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream([{ stream: consoleStream }, { stream: fileStream }]),
  );
}

export async function flushLogger(logger: Logger): Promise<void> {
  logger.flush?.();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

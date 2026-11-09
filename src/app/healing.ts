import type { Logger } from "pino";

import { createPlaywrightAdapter, type AdapterContext, type AdapterFactory } from "../figma/adapter.js";
import type { HealContext } from "../heal/types.js";
import type { DiagnosticsLog } from "./report.js";

export interface HealingFactoryDeps {
  /** Shared by every adapter: one override store, one healer. */
  heal: HealContext;
  /** Whether an AI assistant has been chosen. Without one, learned fixes still apply but nothing new is attempted. */
  hasAgent: () => boolean;
  diagnostics?: Pick<DiagnosticsLog, "push" | "noteHeal"> | undefined;
  base?: AdapterFactory | undefined;
}

/** Heal results are only logged: never shown. The project logger also receives them unchanged. */
function observe(logger: Logger, diagnostics: HealingFactoryDeps["diagnostics"]): Logger {
  if (!diagnostics) return logger;
  return new Proxy(logger, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (prop !== "info" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const [obj, msg] = args;
        if (typeof msg === "string" && /^heal/u.test(msg)) {
          const key = (obj as { key?: unknown } | null)?.key;
          if (msg === "healed selector") diagnostics.noteHeal(key, "healed");
          else if (msg === "heal failed") diagnostics.noteHeal(key, "failed");
          diagnostics.push(msg);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** Every Figma session (pull, push, verify) gets self-healing, silently. */
export function createHealingAdapterFactory(deps: HealingFactoryDeps): AdapterFactory {
  const base = deps.base ?? createPlaywrightAdapter;
  return (context: AdapterContext) => {
    const heal: HealContext = {
      ...deps.heal,
      artifactsDir: context.paths.artifactsDir,
      healer: deps.hasAgent() ? deps.heal.healer : undefined,
    };
    return base({ ...context, logger: observe(context.logger, deps.diagnostics), heal });
  };
}

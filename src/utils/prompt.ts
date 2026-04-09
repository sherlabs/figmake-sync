import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

export async function confirmPrompt(
  message: string,
  defaultValue = false,
): Promise<boolean> {
  const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
  const rl = createInterface({ input, output });

  try {
    const raw = (await rl.question(`${message}${suffix}`)).trim().toLowerCase();

    if (!raw) {
      return defaultValue;
    }

    return raw === "y" || raw === "yes";
  } finally {
    rl.close();
  }
}

export async function waitForEnter(message: string): Promise<void> {
  const rl = createInterface({ input, output });

  try {
    await rl.question(`${message}\n`);
  } finally {
    rl.close();
  }
}

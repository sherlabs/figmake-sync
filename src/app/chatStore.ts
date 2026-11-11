import path from "node:path";

import fs from "fs-extra";
import { z } from "zod";

import type { ChatMessage } from "../electron/contracts.js";
import { ERROR_CODES } from "../electron/contracts.js";
import { IMAGE_NAME, MAX_IMAGES } from "./attachmentKinds.js";
import { capMessages } from "./chat.js";
import { redactSecrets } from "./report.js";

const activity = z.object({
  kind: z.enum(["look", "edit", "add", "check", "helper", "other"]),
  label: z.string().max(300),
  file: z.string().max(300).optional(),
});

const part = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("activity"), items: z.array(activity).max(200) }),
]);

/** One entry per kind; a new kind of attachment adds its member here. Unknown or malformed entries are dropped. */
const attachment = z.discriminatedUnion("kind", [z.object({ kind: z.literal("image"), name: z.string().regex(IMAGE_NAME) })]);

const message = z.object({
  id: z.string().min(1).max(100),
  role: z.enum(["user", "assistant"]),
  at: z.string().max(40),
  text: z.string().default(""),
  attachments: z
    .array(z.unknown())
    .max(MAX_IMAGES * 2)
    .transform((items) => items.flatMap((item) => {
      const parsed = attachment.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }))
    .optional(),
  parts: z.array(part).default([]),
  status: z.enum(["done", "streaming", "stopped", "error"]).default("done"),
  change: z
    .object({
      turnId: z.string().max(100),
      summary: z.string().max(400),
      files: z.array(z.object({ name: z.string().max(300), status: z.enum(["edited", "added", "removed"]) })).max(200),
      previewUpdated: z.boolean().default(false),
      fate: z.enum(["active", "undone", "sent"]).default("active"),
    })
    .optional(),
  error: z.object({ message: z.string().max(500), code: z.enum(ERROR_CODES).catch("unknown") }).optional(),
});

const chatFileSchema = z.object({
  version: z.literal(1),
  /** The next message starts a new AI conversation instead of resuming the old one. */
  fresh: z.boolean().catch(false).default(false),
  updatedAt: z.string().default(""),
  /** One bad message is dropped on its own; the rest of the conversation survives. */
  messages: z
    .array(z.unknown())
    .default([])
    .transform((items) => items.flatMap((item) => {
      const parsed = message.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    })),
});

export interface StoredChat {
  messages: ChatMessage[];
  fresh: boolean;
}

/** Keys are Figma file keys; only a conservative charset ever reaches a file name. */
export function chatFileName(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 80);
  return safe || "project";
}

/** Secrets never reach disk: tokens and key=value credentials are masked in everything that is written. */
export function redactMessage(m: ChatMessage): ChatMessage {
  const parts = m.parts.map((p) => (p.type === "text" ? { ...p, text: redactSecrets(p.text) } : p));
  return { ...m, text: redactSecrets(m.text), parts };
}

/**
 * One transcript per project under `<userData>/chats/<project>.json`. Written atomically (temp file, then
 * move), validated on read, capped at 500 messages. `archive` keeps only the newest previous conversation.
 */
export class ChatStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private file(key: string, archive = false): string {
    return path.join(this.dir, `${chatFileName(key)}${archive ? ".archive" : ""}.json`);
  }

  async load(key: string): Promise<StoredChat> {
    const file = this.file(key);
    try {
      if (!(await fs.pathExists(file))) return { messages: [], fresh: false };
      const raw: unknown = await fs.readJson(file);
      const parsed = chatFileSchema.parse(raw);
      // A turn that never finished (the app closed mid-answer) is shown as stopped.
      const messages = parsed.messages.map((m) => (m.status === "streaming" ? { ...m, status: "stopped" as const } : m));
      return { messages: capMessages(messages) as ChatMessage[], fresh: parsed.fresh };
    } catch {
      await fs.move(file, `${file}.corrupt-${Date.now()}`, { overwrite: true }).catch(() => undefined);
      return { messages: [], fresh: false };
    }
  }

  save(key: string, chat: StoredChat): Promise<void> {
    return this.enqueue(async () => {
      const body = { version: 1 as const, fresh: chat.fresh, updatedAt: new Date().toISOString(), messages: capMessages(chat.messages).map(redactMessage) };
      const file = this.file(key);
      await fs.ensureDir(this.dir);
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeJson(tmp, chatFileSchema.parse(body), { spaces: 1 });
      await fs.move(tmp, file, { overwrite: true });
    });
  }

  /** Names of every picture the saved transcript and its archive refer to. */
  async attachmentNames(key: string): Promise<Set<string>> {
    const names = new Set<string>();
    for (const file of [this.file(key), this.file(key, true)]) {
      try {
        const parsed = chatFileSchema.parse(await fs.readJson(file));
        for (const m of parsed.messages) for (const a of m.attachments ?? []) if (a.kind === "image") names.add(a.name);
      } catch {
        // missing or unreadable: it refers to nothing
      }
    }
    return names;
  }

  /** Moves the current transcript aside (replacing any older archive). */
  archive(key: string): Promise<void> {
    return this.enqueue(async () => {
      const file = this.file(key);
      if (!(await fs.pathExists(file))) return;
      await fs.move(file, this.file(key, true), { overwrite: true });
    });
  }

  remove(key: string): Promise<void> {
    return this.enqueue(async () => {
      await Promise.all([fs.remove(this.file(key)), fs.remove(this.file(key, true))]);
    });
  }

  private enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

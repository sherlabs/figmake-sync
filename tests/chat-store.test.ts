import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_MESSAGES, emptyAssistant, userMessage } from "../src/app/chat.js";
import { ChatStore, chatFileName } from "../src/app/chatStore.js";
import type { ChatMessage } from "../src/electron/contracts.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.remove(d)));
});
async function tmp(): Promise<{ store: ChatStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chats-"));
  dirs.push(dir);
  return { store: new ChatStore(dir), dir };
}
const done = (text: string): ChatMessage => ({ ...emptyAssistant(), parts: [{ type: "text", text }], status: "done" });

describe("chat store", () => {
  it("persists and restores a transcript", async () => {
    const { store } = await tmp();
    const msgs = [userMessage("make it blue"), { ...done("Done."), change: { turnId: "t1", summary: "Made it blue", files: [{ name: "A.tsx", status: "edited" as const }], previewUpdated: true, fate: "active" as const } }];
    await store.save("AbC123", { messages: msgs, fresh: false });
    const back = await store.load("AbC123");
    expect(back.messages).toEqual(msgs);
    expect(back.fresh).toBe(false);
    expect(await store.load("other")).toEqual({ messages: [], fresh: false });
  });

  it("caps at the newest 500 messages", async () => {
    const { store } = await tmp();
    await store.save("k", { messages: Array.from({ length: MAX_MESSAGES + 40 }, (_, i) => userMessage(`m${i}`)), fresh: false });
    const back = await store.load("k");
    expect(back.messages).toHaveLength(MAX_MESSAGES);
    expect(back.messages[0]?.text).toBe("m40");
  });

  it("writes atomically: no temp files left, and a crash-torn file is set aside", async () => {
    const { store, dir } = await tmp();
    await store.save("k", { messages: [userMessage("hi")], fresh: true });
    await Promise.all([1, 2, 3].map((n) => store.save("k", { messages: [userMessage(`v${n}`)], fresh: false })));
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    await fs.writeFile(path.join(dir, "k.json"), '{"version":1,"messages":[{"id":');
    expect(await store.load("k")).toEqual({ messages: [], fresh: false });
    expect((await fs.readdir(dir)).some((f) => f.startsWith("k.json.corrupt-"))).toBe(true);
  });

  it("validates with zod: bad messages are dropped alone, odd values fall back", async () => {
    const { store, dir } = await tmp();
    await fs.writeJson(path.join(dir, "k.json"), {
      version: 1,
      fresh: "nope",
      messages: [{ id: "u1", role: "user", at: "2026-01-01", text: "ok" }, { role: "robot" }, 42, { id: "a1", role: "assistant", at: "x", parts: [{ type: "weird" }] }, { id: "a2", role: "assistant", at: "x", parts: [{ type: "text", text: "kept" }], status: "streaming", error: { message: "m", code: "not-a-code" } }],
    });
    const back = await store.load("k");
    expect(back.fresh).toBe(false);
    expect(back.messages.map((m) => m.id)).toEqual(["u1", "a2"]);
    // A turn left "streaming" by a crash is shown as stopped; unknown error codes become "unknown".
    expect(back.messages[1]).toMatchObject({ status: "stopped", error: { code: "unknown" } });
    await fs.writeJson(path.join(dir, "v.json"), { version: 2, messages: [] });
    expect(await store.load("v")).toEqual({ messages: [], fresh: false });
  });

  it("never writes secrets to disk", async () => {
    const { store, dir } = await tmp();
    const secret = "sk-ant-api03-abcdefghijklmnop";
    await store.save("k", { messages: [userMessage(`use api_key=hunter2hunter2 and ${secret}`), done(`Bearer abc.def.ghi and ghp_${"a".repeat(30)}`)], fresh: false });
    const raw = await fs.readFile(path.join(dir, "k.json"), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("hunter2hunter2");
    expect(raw).not.toContain("ghp_aaaa");
    expect(raw).toContain("<token>");
    // Ordinary text and names are left alone: transcripts are local.
    await store.save("k2", { messages: [userMessage("Change Checkout Flow in src/App.tsx")], fresh: false });
    expect(await fs.readFile(path.join(dir, "k2.json"), "utf8")).toContain("Checkout Flow in src/App.tsx");
  });

  it("archive keeps only the newest previous conversation; remove deletes both", async () => {
    const { store, dir } = await tmp();
    await store.save("k", { messages: [userMessage("first")], fresh: false });
    await store.archive("k");
    expect(await fs.pathExists(path.join(dir, "k.json"))).toBe(false);
    await store.save("k", { messages: [userMessage("second")], fresh: false });
    await store.archive("k");
    const archived = (await fs.readJson(path.join(dir, "k.archive.json"))) as { messages: { text: string }[] };
    expect(archived.messages[0]?.text).toBe("second");
    await store.archive("missing");
    await store.save("k", { messages: [], fresh: true });
    await store.remove("k");
    expect((await fs.readdir(dir)).filter((f) => f.startsWith("k"))).toEqual([]);
  });

  it("keeps file names safe", () => {
    expect(chatFileName("../../etc/passwd")).toBe("______etc_passwd");
    expect(chatFileName("AbC-123_x")).toBe("AbC-123_x");
    expect(chatFileName("")).toBe("project");
  });
});

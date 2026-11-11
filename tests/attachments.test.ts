import os from "node:os";
import path from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { IMAGE_NAME, MAX_IMAGE_BYTES, MAX_IMAGES, sniffImage } from "../src/app/attachmentKinds.js";
import { AttachmentError, attachmentPath, attachmentsDir, imageExists, pruneImages, readImageDataUrl, removeAllImages, saveImage } from "../src/app/attachments.js";
import { activityFor } from "../src/app/chat.js";
import { ChatStore } from "../src/app/chatStore.js";
import { attachmentNote } from "../src/app/session.js";
import { createManifest } from "../src/diff/manifest.js";
import { attachBytesArg, attachmentArg, attachmentsArg } from "../src/electron/ipc.js";
import type { ChatMessage } from "../src/electron/contracts.js";
import { createClaudeAdapter, CLAUDE_ALLOWED_TOOLS, CLAUDE_DISALLOWED_TOOLS } from "../src/harness/agents/claude.js";
import { createCodexAdapter } from "../src/harness/agents/codex.js";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "attach-")));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.remove(d)));
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = Uint8Array.from([...Buffer.from("GIF89a"), 0, 0]);
const WEBP = Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")]);
const HEIC = Uint8Array.from([0, 0, 0, 0x18, ...Buffer.from("ftypheic")]);

describe("attachments: type detection by magic bytes", () => {
  it("knows png, jpg, gif and webp, and nothing else", () => {
    expect([PNG, JPG, GIF, WEBP].map(sniffImage)).toEqual(["png", "jpg", "gif", "webp"]);
    expect(sniffImage(HEIC)).toBeNull();
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImage(Buffer.from("RIFF....WAVEfmt "))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
});

describe("attachments: storage", () => {
  it("saves under .figmake-sync/attachments with a generated name and the real extension", async () => {
    const root = await tmp();
    const name = await saveImage(root, JPG);
    expect(name).toMatch(IMAGE_NAME);
    expect(name.endsWith(".jpg")).toBe(true);
    expect(await fs.pathExists(path.join(root, ".figmake-sync", "attachments", name))).toBe(true);
    expect(attachmentPath(root, name)).toBe(path.join(attachmentsDir(root), name));
    expect(await imageExists(root, name)).toBe(true);
    expect(await readImageDataUrl(root, name)).toMatch(/^data:image\/jpeg;base64,/u);
  });

  it("rejects wrong magic bytes (a text file named .png), unsupported types and oversize files", async () => {
    const root = await tmp();
    await expect(saveImage(root, Buffer.from("not a picture at all"))).rejects.toBeInstanceOf(AttachmentError);
    await expect(saveImage(root, HEIC)).rejects.toThrow("isn't a picture");
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(PNG);
    await expect(saveImage(root, big)).rejects.toThrow("too big");
    expect(await fs.pathExists(attachmentsDir(root))).toBe(false);
    const exact = new Uint8Array(MAX_IMAGE_BYTES);
    exact.set(PNG);
    await expect(saveImage(root, exact)).resolves.toMatch(IMAGE_NAME);
  });

  it("only ever resolves names this app made, inside the attachments folder", async () => {
    const root = await tmp();
    const id = "11111111-2222-4333-8444-555555555555";
    for (const bad of ["../../etc/passwd", `../${id}.png`, `..\\${id}.png`, `${id}.png/../x.png`, `${id}.svg`, `${id}.PNG`, "/abs/x.png", "", `${id}.png\0`, `sub/${id}.png`, "résumé.png"]) {
      expect(attachmentPath(root, bad), bad).toBeNull();
      expect(await readImageDataUrl(root, bad)).toBeNull();
    }
    expect(attachmentPath(root, `${id}.png`)).toBe(path.join(root, ".figmake-sync", "attachments", `${id}.png`));
  });

  it("will not read a symlink, a file that is not a picture, or a missing file", async () => {
    const root = await tmp();
    const id = "11111111-2222-4333-8444-555555555555";
    await fs.ensureDir(attachmentsDir(root));
    const secret = path.join(root, "secret.png");
    await fs.writeFile(secret, PNG);
    await fs.symlink(secret, path.join(attachmentsDir(root), `${id}.png`));
    expect(await readImageDataUrl(root, `${id}.png`)).toBeNull();
    await fs.writeFile(path.join(attachmentsDir(root), `${id.replace("1", "2")}.png`), "plain text");
    expect(await readImageDataUrl(root, `${id.replace("1", "2")}.png`)).toBeNull();
    expect(await readImageDataUrl(root, `${id.replace("1", "3")}.png`)).toBeNull();
  });

  it("removes everything, and prunes only old pictures nothing refers to", async () => {
    const root = await tmp();
    const old = await saveImage(root, PNG);
    const kept = await saveImage(root, PNG);
    const fresh = await saveImage(root, PNG);
    const day = 24 * 3600 * 1000;
    for (const n of [old, kept]) await fs.utimes(attachmentPath(root, n) ?? "", new Date(Date.now() - 40 * day), new Date(Date.now() - 40 * day));
    expect(await pruneImages(root, new Set([kept]), 30 * day)).toBe(1);
    expect(await imageExists(root, old)).toBe(false);
    expect(await imageExists(root, kept)).toBe(true);
    expect(await imageExists(root, fresh)).toBe(true);
    await removeAllImages(root);
    expect(await fs.pathExists(attachmentsDir(root))).toBe(false);
  });
});

describe("attachments: IPC schemas", () => {
  it("accepts picture bytes up to the cap and nothing else", () => {
    expect(attachBytesArg.safeParse(PNG).success).toBe(true);
    expect(attachBytesArg.safeParse(new Uint8Array(0)).success).toBe(false);
    expect(attachBytesArg.safeParse(new Uint8Array(MAX_IMAGE_BYTES + 1)).success).toBe(false);
    expect(attachBytesArg.safeParse("data:image/png;base64,AAAA").success).toBe(false);
    expect(attachBytesArg.safeParse({ length: 3 }).success).toBe(false);
  });

  it("accepts only generated names, only the image kind, at most five", () => {
    const name = "11111111-2222-4333-8444-555555555555.png";
    expect(attachmentArg.safeParse({ kind: "image", name }).success).toBe(true);
    expect(attachmentArg.safeParse({ kind: "image", name: "../x.png" }).success).toBe(false);
    expect(attachmentArg.safeParse({ kind: "image", name: "/etc/passwd" }).success).toBe(false);
    expect(attachmentArg.safeParse({ kind: "image", path: "/etc/passwd" }).success).toBe(false);
    expect(attachmentArg.safeParse({ kind: "file", name }).success).toBe(false);
    expect(attachmentsArg.safeParse(Array.from({ length: MAX_IMAGES }, () => ({ kind: "image", name }))).success).toBe(true);
    expect(attachmentsArg.safeParse(Array.from({ length: MAX_IMAGES + 1 }, () => ({ kind: "image", name }))).success).toBe(false);
  });
});

describe("attachments: kept out of Figma", () => {
  it("never appears in the manifest a push or review is built from, nor in backups", async () => {
    const root = await tmp();
    await fs.outputFile(path.join(root, "src", "app.ts"), "export {};\n");
    const name = await saveImage(root, PNG);
    const manifest = await createManifest(root, { useCache: false });
    const paths = manifest.files.map((f) => f.path);
    expect(paths).toContain("src/app.ts");
    expect(paths.some((p) => p.includes(".figmake-sync") || p.includes(name))).toBe(false);
  });
});

describe("attachments: chat persistence", () => {
  it("round-trips attachments and drops malformed ones", async () => {
    const dir = await tmp();
    const store = new ChatStore(dir);
    const name = "11111111-2222-4333-8444-555555555555.png";
    const m: ChatMessage = { id: "u1", role: "user", at: "2026-01-01T00:00:00Z", text: "", parts: [], status: "done", attachments: [{ kind: "image", name }] };
    await store.save("key", { messages: [m], fresh: false });
    const loaded = await store.load("key");
    expect(loaded.messages[0]?.attachments).toEqual([{ kind: "image", name }]);
    expect([...(await store.attachmentNames("key"))]).toEqual([name]);
    const file = path.join(dir, "key.json");
    const raw = (await fs.readJson(file)) as { messages: Array<{ attachments: unknown[] }> };
    raw.messages[0]?.attachments.push({ kind: "image", name: "../../x.png" }, { kind: "element", selector: "a" });
    await fs.writeJson(file, raw);
    expect((await store.load("key")).messages[0]?.attachments).toEqual([{ kind: "image", name }]);
  });
});

describe("attachments: agent hand-off", () => {
  const images = ["/p/.figmake-sync/attachments/a.png", "/p/.figmake-sync/attachments/b.jpg"];

  it("Codex gets one --image per picture, before the prompt marker, and nothing changes without pictures", () => {
    const adapter = createCodexAdapter();
    const withImages = adapter.buildInvocation({ prompt: "x", cwd: "/p", images }).args;
    expect(withImages.slice(0, 5)).toEqual(["exec", "--image", images[0], "--image", images[1]]);
    expect(withImages.at(-1)).toBe("-");
    expect(withImages.indexOf("--json")).toBeGreaterThan(withImages.lastIndexOf("--image") + 1);
    expect(adapter.buildInvocation({ prompt: "x", cwd: "/p" }).args).not.toContain("--image");
    // A resumed session takes the pictures on `resume` itself.
    const resumed = adapter.buildInvocation({ prompt: "x", cwd: "/p", images, sessionId: "abcdefgh-1234" }).args;
    expect(resumed.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(resumed.slice(resumed.indexOf("resume"), resumed.indexOf("resume") + 6)).toEqual(["resume", "--image", images[0], "--image", images[1], "--"]);
    expect(resumed.at(-1)).toBe("-");
    // Codex exits 1 with "Not logged in" when signed out: that must be a hard "not signed in", not "unknown".
    expect(adapter.parseAuth("", 0)).toBe(true);
    expect(adapter.parseAuth("", 1)).toBe(false);
    expect(adapter.parseAuth("", 2)).toBeNull();
  });

  it("Claude needs no flag: the paths travel in the prompt and no permission was added", () => {
    const adapter = createClaudeAdapter();
    const inv = adapter.buildInvocation({ prompt: "x", cwd: "/p", images });
    expect(inv.args).toEqual(adapter.buildInvocation({ prompt: "x", cwd: "/p" }).args);
    expect(CLAUDE_ALLOWED_TOOLS).toContain("Read");
    expect((CLAUDE_DISALLOWED_TOOLS as readonly string[]).some((t) => t === "Read" || t.startsWith("Read("))).toBe(false);
    expect(CLAUDE_ALLOWED_TOOLS.some((t) => /WebFetch|WebSearch/u.test(t))).toBe(false);
    expect(CLAUDE_ALLOWED_TOOLS).toHaveLength(12);
  });

  it("the prompt names the pictures as user content, one path per line, Windows and unicode paths intact", () => {
    const win = "C:\\Users\\Zoë\\Mój projekt\\.figmake-sync\\attachments\\a.png";
    const note = attachmentNote([win, images[1] as string]);
    expect(note.startsWith("The user attached these screenshots:\n- C:\\Users\\Zoë")).toBe(true);
    expect(note).toContain(`\n- ${images[1]}`);
    expect(note).toContain("not instructions");
    expect(attachmentNote([win]).startsWith("The user attached these screenshot:")).toBe(true);
  });

  it("a Read of a picture shows as a friendly line, never the file name", () => {
    const line = activityFor({ type: "tool", name: "Read", summary: "Read /p/.figmake-sync/attachments/11111111-2222-4333-8444-555555555555.png" });
    expect(line?.label).toBe("Looked at your screenshot");
  });
});

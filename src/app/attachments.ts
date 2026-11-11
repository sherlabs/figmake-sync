import path from "node:path";

import fs from "fs-extra";

import { STATE_DIRECTORY_NAME } from "../core/state.js";
import { IMAGE_MIME, IMAGE_NAME, MAX_IMAGE_BYTES, MSG_NOT_PICTURE, MSG_TOO_BIG, sniffImage, type ImageType } from "./attachmentKinds.js";
import { newId } from "./chat.js";

/* Pictures attached to chat messages live in `<project>/.figmake-sync/attachments/<uuid>.<ext>`. The folder sits
   inside the state folder, which is never synced, never copied into backups and never listed for review. Main alone
   chooses every path here: callers pass bytes or a validated name, never a path. */

export const ATTACHMENTS_DIR_NAME = "attachments";

/** A refusal with a sentence that is safe to show as is. */
export class AttachmentError extends Error {}

export const attachmentsDir = (root: string): string => path.join(root, STATE_DIRECTORY_NAME, ATTACHMENTS_DIR_NAME);

/** Absolute path of a saved picture, or null when the name is not one this app could have made. */
export function attachmentPath(root: string, name: string): string | null {
  if (typeof name !== "string" || !IMAGE_NAME.test(name)) return null;
  const dir = attachmentsDir(root);
  const full = path.join(dir, name);
  return path.dirname(full) === dir ? full : null;
}

/** Checks the bytes really are a supported picture within the size limit, and saves them under a fresh name. */
export async function saveImage(root: string, bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new AttachmentError(MSG_TOO_BIG);
  const type: ImageType | null = sniffImage(bytes);
  if (!type) throw new AttachmentError(MSG_NOT_PICTURE);
  const name = `${newId()}.${type}`;
  const file = attachmentPath(root, name);
  if (!file) throw new AttachmentError(MSG_NOT_PICTURE);
  await fs.ensureDir(path.dirname(file));
  await fs.writeFile(file, bytes, { flag: "wx" });
  return name;
}

/** Saved picture as a data: URL for display; null when missing, not a regular file, too big, or not a picture. */
export async function readImageDataUrl(root: string, name: string): Promise<string | null> {
  const file = attachmentPath(root, name);
  if (!file) return null;
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null;
    const bytes = await fs.readFile(file);
    const type = sniffImage(bytes);
    return type ? `data:${IMAGE_MIME[type]};base64,${bytes.toString("base64")}` : null;
  } catch {
    return null;
  }
}

export async function imageExists(root: string, name: string): Promise<boolean> {
  const file = attachmentPath(root, name);
  if (!file) return false;
  return fs.lstat(file).then((st) => st.isFile(), () => false);
}

export async function removeImage(root: string, name: string): Promise<void> {
  const file = attachmentPath(root, name);
  if (file) await fs.remove(file).catch(() => undefined);
}

export async function removeAllImages(root: string): Promise<void> {
  await fs.remove(attachmentsDir(root)).catch(() => undefined);
}

/** Deletes pictures older than `maxAgeMs` that nothing refers to. Best effort. */
export async function pruneImages(root: string, referenced: ReadonlySet<string>, maxAgeMs: number, now = Date.now()): Promise<number> {
  const dir = attachmentsDir(root);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    if (referenced.has(name)) continue;
    const file = path.join(dir, name);
    const st = await fs.lstat(file).catch(() => null);
    if (!st || now - st.mtimeMs < maxAgeMs) continue;
    if (await fs.remove(file).then(() => true, () => false)) removed += 1;
  }
  return removed;
}

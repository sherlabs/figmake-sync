/* Pure, browser-safe description of what can be attached to a chat message (the window imports this too). */

export const MAX_IMAGES = 5;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type ImageType = "png" | "jpg" | "webp" | "gif";

export const IMAGE_MIME: Record<ImageType, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** Used when a message has pictures but no words. */
export const DEFAULT_IMAGE_PROMPT = "Look at this screenshot and fix or match what it shows.";

export const MSG_NOT_PICTURE = "That file isn't a picture we can use.";
export const MSG_TOO_BIG = "That picture is too big. Pictures can be up to 10 MB.";
export const MSG_TOO_MANY = "You can add up to 5 pictures to one message.";

/** Saved names are "<uuid>.<ext>"; nothing else is ever accepted as an attachment name. */
export const IMAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/u;

const startsWith = (b: Uint8Array, at: number, sig: readonly number[]): boolean => sig.every((v, i) => b[at + i] === v);

/** What the bytes really are, by their first bytes (never by file name or declared type). */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(bytes, 0, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "gif";
  if (startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return "webp";
  return null;
}

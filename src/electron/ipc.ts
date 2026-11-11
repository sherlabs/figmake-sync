import { MAX_IMAGES, MAX_IMAGE_BYTES, IMAGE_NAME } from "../app/attachmentKinds.js";
import { VIEWPORT_MODES } from "../app/browser.js";
import { MODEL_ID } from "../app/modelIds.js";
import { z } from "zod";

/* Arguments the window may send for the Files panel. Anything that does not parse is ignored by main. */

export const projectPathArg = z.string().max(1024);
export const ignoreFileArgs = z.tuple([z.string().min(1).max(1024), z.boolean()]);
export const processIdArg = z.enum(["preview", "agent", "install"]);
export const cleanupActionArg = z.enum(["fix-preview", "start-over", "reset-app"]);

export type CleanupAction = z.infer<typeof cleanupActionArg>;
export type ProjectPathArg = z.infer<typeof projectPathArg>;

export const browserAddressArg = z.string().max(2048);
export const browserCommandArg = z.enum(["back", "forward", "reload", "stop", "retry", "external"]);
export const browserViewportArg = z.enum(VIEWPORT_MODES);
export const browserTabIdArg = z.number().int().min(1).max(1_000_000);

export const projectNameArg = z.string().trim().min(1).max(80);
export const projectKeyArg = z.string().min(1).max(256);

export const syncModeArg = z.enum(["merge", "replace"]);
export const mergeChoicesArg = z.array(z.object({ path: z.string().min(1).max(1024), choice: z.enum(["mine", "figma"]) })).max(2000);

/* Pictures: bytes in (size-capped), names out. A name is only ever "<uuid>.<ext>"; main picks every path. */
export const attachBytesArg = z.custom<Uint8Array>((v) => v instanceof Uint8Array && v.byteLength > 0 && v.byteLength <= MAX_IMAGE_BYTES);
export const attachmentNameArg = z.string().regex(IMAGE_NAME);
/** Everything a message may carry besides text; one member per kind. */
export const attachmentArg = z.discriminatedUnion("kind", [z.object({ kind: z.literal("image"), name: attachmentNameArg })]);
export const attachmentsArg = z.array(attachmentArg).max(MAX_IMAGES);

/** A model name, or null for the AI's own default. The same rule is checked again in the session and in the adapters. */
export const modelArg = z.string().regex(MODEL_ID).nullable();

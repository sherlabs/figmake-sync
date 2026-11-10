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
export const browserTabIdArg = z.number().int().min(1).max(1_000_000);

export const projectNameArg = z.string().trim().min(1).max(80);
export const projectKeyArg = z.string().min(1).max(256);

export const syncModeArg = z.enum(["merge", "replace"]);
export const mergeChoicesArg = z.array(z.object({ path: z.string().min(1).max(1024), choice: z.enum(["mine", "figma"]) })).max(2000);

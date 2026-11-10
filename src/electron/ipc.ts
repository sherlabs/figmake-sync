import { z } from "zod";

/* Arguments the window may send for the Files panel. Anything that does not parse is ignored by main. */

export const projectPathArg = z.string().max(1024);
export const processIdArg = z.enum(["preview", "agent", "install"]);

export type ProjectPathArg = z.infer<typeof projectPathArg>;

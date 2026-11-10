import type { ActivityKind, ChatActivity } from "../electron/contracts.js";

/* Kept free of runtime imports (the window loads it directly, without a bundler). */

/** One short line for a collapsed activity group: "Looked around, edited Button.tsx and checked the app builds". */
export function activitySummary(items: readonly ChatActivity[]): string {
  const of = (kind: ActivityKind): ChatActivity[] => items.filter((i) => i.kind === kind);
  const clauses: string[] = [];
  const looked = of("look");
  const edited = of("edit");
  const added = of("add");
  if (looked.length === 1) clauses.push(looked[0]?.label ?? "Looked at a file");
  else if (looked.length > 1) clauses.push("Looked around");
  if (edited.length === 1) clauses.push(edited[0]?.label ?? "Edited a file");
  else if (edited.length > 1) clauses.push(`Edited ${edited.length} files`);
  if (added.length === 1) clauses.push(added[0]?.label ?? "Added a file");
  else if (added.length > 1) clauses.push(`Added ${added.length} files`);
  const helpers = of("helper");
  if (helpers.length === 1) clauses.push("Started a helper");
  else if (helpers.length > 1) clauses.push(`Started ${helpers.length} helpers`);
  const check = of("check")[0];
  if (check) clauses.push(check.label);
  if (clauses.length === 0) clauses.push(items[0]?.label ?? "Worked on it");
  const lowered = clauses.map((c, i) => (i === 0 ? c : c.charAt(0).toLowerCase() + c.slice(1)));
  return lowered.length > 1 ? `${lowered.slice(0, -1).join(", ")} and ${lowered.at(-1) ?? ""}` : (lowered[0] ?? "");
}

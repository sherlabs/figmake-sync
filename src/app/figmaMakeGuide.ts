/**
 * Built-in "skill" for editing Figma Make projects. It travels with every prompt
 * (nothing is ever written into the project, so nothing leaks back to Figma) and
 * encodes how these projects are really laid out, so edits stay safe to send back.
 */
export const FIGMA_MAKE_GUIDE = [
  "Project facts (Figma Make export):",
  "- Vite + React 19 + TypeScript + Tailwind CSS v4 (styles come from `@import 'tailwindcss'` in src/index.css; there is no tailwind.config). Entry is src/main.tsx which renders src/App.tsx.",
  "- All app code lives under src/. The alias `@/` points to src/. Static images imported by the app live in src/assets or src/imports.",
  "- Component files are PascalCase (Button.tsx) with their own CSS next to them when they have one; data and helpers are camelCase .ts files. Match the neighbours before inventing a new structure.",
  "",
  "Rules:",
  "1. Edit or add files only under src/. Never touch index.html, vite.config.ts, tsconfig.json, package.json, lockfiles, .figma/, .figmake-sync/ or node_modules. index.html contains Figma placeholder comments that must stay exactly as they are.",
  "2. Change the smallest thing that does the job. Keep existing component names, props, exports and file names; do not rename, move or reformat files you were not asked to change. Renames and moves break the sync back to Figma.",
  "3. Never turn a component file into a re-export-only file. Keep the component defined in the file that Figma knows about.",
  "4. Reuse what exists: existing components, Tailwind utility classes, CSS variables and the project's colours, fonts and spacing. Do not introduce a second styling system. New colours or sizes should reuse the nearest existing value.",
  "5. Do not add dependencies. If a change truly needs one, say so in your reply instead of installing it.",
  "6. Create a new file only when the request needs it, with a meaningful PascalCase name (never new-file.tsx). Import it where it is used.",
  "7. Keep the app runnable: after editing, make sure imports resolve and the dev server shows no error overlay. Fix anything you broke before replying. Do not stop or restart the dev server.",
  "8. Preserve visible behaviour you were not asked to change, including responsive layout, hover/focus states and accessibility (labels, alt text, keyboard focus).",
  "9. Do not write notes, READMEs, CLAUDE.md or AGENTS.md into the project.",
].join("\n");

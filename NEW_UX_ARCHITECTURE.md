> Superseded by the minimal redesign (Start, Project, Settings). Kept for history only.

# Desktop UX architecture

Source of truth for the Electron renderer in `src/electron/renderer/` (`index.html`, `styles.css`, `app.ts`). It supersedes `UX_REDESIGN.md`.

## Structure

- **Title bar**: brand, Figma sign-in chip (connected, not signed in, unknown), global busy chip. On macOS the bar is a drag region with room for the traffic lights (`html.is-mac`).
- **Banners**: browser install onboarding, missing runtime tools, and a transient "waiting for sign-in" banner with Stop.
- **Home**: grid of project cards (name, folder, state, last pull and push). First run shows an empty state with a three-step checklist (install browser, sign in, create project).
- **Project detail**: header (back, name, folder, linked badge, Open in menu) and four tabs.
  - **Sync**: status hero, four actions (Pull, Push, Check status, Verify), live progress, last result.
  - **Changes**: file list with status tags, ignore list, line diff, copy, reset baseline.
  - **Activity**: timestamped log, raw JSON output behind a disclosure, failure screenshot.
  - **Settings**: workspace, link form, account, sync options, delete project.

Project views are built once per project in `buildProjectView`. State changes patch only what moved (`renderHero`, `renderLive`, `renderResult`, `renderChanges`) so keyboard focus is not lost during progress events.

## Sync-state model

`deriveHero` picks the hero from the run state and project metadata, in priority order:

| State | Tone | Primary action |
| --- | --- | --- |
| Running | busy | Stop (calls `cancelOperation`) |
| Error | bad | Try again, or Sign in when the error looks like auth |
| Stopped by user | warn | Check status |
| Finished with conflicts, skipped or drift | warn | Review changes |
| Offline (`navigator.onLine`) | bad | Check status |
| Not signed in | warn | Sign in to Figma |
| Never synced | idle | Pull from Figma |
| Local changes | idle | Review changes |
| Otherwise | ok | Sync from Figma |

Results are summarized by `summarize` into tiles (pulled, pushed, skipped, conflicts, added, modified, deleted) and a per-file list. Push reports skipped files with reasons and offers Retry push. Raw JSON stays in Activity.

## Safety

- Push confirms before uploading unless Dry run is on. Reset baseline confirms. Delete project and Clear app data use the native confirmation owned by the main process.
- Destructive dialogs focus Cancel first.
- Stopping a run warns that files may be partly updated.
- Busy locks controls with `disabled` and a title explaining why. Stop is never locked.

## Tokens

All colors are CSS custom properties on `:root`, redefined under `prefers-color-scheme: dark`.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` / `--surface` | `#f3f4f7` / `#ffffff` | `#0f1013` / `#17191d` | page, cards |
| `--text` / `--text-2` / `--text-3` | `#14171c` / `#444b57` / `#5f6775` | `#eceef2` / `#b6bcc7` / `#939baa` | primary, secondary, tertiary text |
| `--accent` | `#3550d6` | `#93a7ff` | actions, focus, progress |
| `--ok` / `--warn` / `--bad` | `#0b6b45` / `#85470a` / `#b0281c` | `#62d6a2` / `#f3b75f` / `#ff9187` | status text and glyphs |

Status text tokens are at least 4.5:1 on their soft backgrounds. Status is never color alone: each state has an icon and a headline.

Type uses the system stack (`-apple-system`, Segoe UI, system-ui) and a system monospace for paths and diffs. No network fonts.

## Accessibility requirements

- Visible `:focus-visible` ring on every interactive element; skip link to main content.
- Tabs follow the ARIA tabs pattern (arrow keys, Home, End). Menus support arrows and Escape.
- Progress bar has `role="progressbar"`; milestones (started, finished, failed, stopped) go to a polite live region. Toasts are in a polite live region.
- `prefers-reduced-motion` removes the spinner and replaces the moving indeterminate bar with a static striped fill.
- No `transition: all`. No `innerHTML`: all dynamic text goes through `textContent` via the `h()` helper.
- Layout holds down to about 520px wide.

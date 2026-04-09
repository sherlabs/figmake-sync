# figmake-sync

![figmake-sync icon](src/electron/renderer/assets/icon-512.png)

`figmake-sync` is a local-first desktop sync agent for Figma Make projects.

It exists for one very specific gap: Figma Make is great at generating and editing prototype code, but it does not give teams a reliable official two-way sync between a local codebase and the Make editor. In practice, that means designers and prototypers end up stuck in a brittle loop of downloading ZIPs, dragging files by hand, and hoping nothing drifted.

`figmake-sync` turns that manual loop into a safer local workflow.

- Your local folder becomes the source of truth.
- The app uses your own authenticated browser session.
- It automates pull, status, push, and verify flows.
- It keeps state, manifests, backups, and logs on your machine.
- It never stores your Figma password or tries to bypass login, MFA, captcha, or security prompts.

## The Problem

Teams using Figma Make often hit the same friction:

- A designer or prototyper downloads generated code as a ZIP.
- They make local edits in VS Code or hand files to an engineer.
- They want those edits reflected back in Make so the prototype stays usable.
- They also want to pull new Make output back down without losing local work.

Today, that process is mostly manual.

- Downloading is manual.
- Uploading new files is manual.
- Updating existing files is manual.
- Checking drift between local and remote is manual.
- Deletions and renames are risky.

That slows iteration down and creates uncertainty:

- Which version is the latest one?
- Did Make and local code drift?
- If I upload these files, what else changed?
- Can I safely hand this off to engineering?

## Why We Built It

We built `figmake-sync` to give Figma Make users a practical local-first workflow without pretending an official write API exists when it does not.

The goal is not to replace Figma Make.

The goal is to make Figma Make usable inside a real design-to-code workflow:

- designers can keep using Make as a fast prototyping surface
- engineers can work from a normal local project folder
- teams can track exactly what changed
- nobody has to juggle ZIP files and drag-drop uploads by memory

This is especially useful when a prototype starts crossing the line from “generated demo” into “something the team actually needs to maintain.”

## Why This Helps UX Designers

UX designers are often the first people to feel this pain because they sit right at the boundary between concept, prototype, and implementation.

`figmake-sync` helps by making that boundary less fragile:

- Designers can keep working in Figma Make without losing the benefits of a local code workspace.
- Visual tweaks and code fixes no longer require a messy re-import ritual every time.
- The desktop app makes common sync actions accessible without asking designers to live in the terminal.
- Local status and verification make it easier to know whether the prototype still matches what is in Make.
- Safer backups and confirmations reduce the fear of “one wrong click broke the prototype.”
- Teams get a cleaner handoff path from designer-owned prototype to engineer-owned codebase.

In short: it reduces prototype drift, lowers coordination overhead, and lets UX designers stay closer to the real implementation without taking on unnecessary tooling pain.

## How It Works

`figmake-sync` is local-first.

That means the working project is a normal local folder on your machine, and the app keeps hidden sync state in `.figmake-sync/`.

### Local State

The app stores:

- linked Figma Make URL
- project config
- last pulled snapshot manifest
- file hashes
- sync metadata
- logs
- downloaded ZIPs
- backups
- browser session profile

Everything stays local to your machine.

### Authentication

`figmake-sync` does not log in on your behalf.

Instead:

1. It launches a persistent local browser context with Playwright.
2. You log in manually to Figma Make.
3. Your session is reused locally on your machine for later sync actions.

This keeps the tool aligned with normal authentication and security boundaries.

### Pull

When you pull from Figma Make, the tool:

1. Opens the linked Make URL.
2. Navigates to the code area.
3. Downloads the latest code ZIP.
4. Extracts it into a temp workspace.
5. Compares it with local state.
6. Applies a safe strategy such as backup, merge, or abort.
7. Updates the local manifest and snapshot baseline.

### Status

When you check status, the tool compares your current local folder against the last pulled snapshot and reports:

- added files
- modified files
- deleted files
- renamed files when they can be detected conservatively

### Push

When you push local changes back to Figma Make, the tool:

- replaces contents of modified files through editor automation
- uploads new files or folders through the UI where possible
- optionally posts a contextual prompt after upload
- treats renames as add plus delete unless a safer path exists
- asks for confirmation before destructive actions
- leaves ambiguous deletions unresolved instead of guessing

### Verify

Verification is intentionally separate from push.

The tool re-downloads the remote code to a temporary directory and compares it against local files so you can answer a simple but important question:

“Does Figma Make still match what I think it matches?”

## Desktop App

The project includes a small Electron app so you do not need to run CLI commands for normal use.

From the desktop app you can:

- choose a local folder
- link it to a Figma Make URL
- authenticate with your own browser session
- pull from Figma Make
- run a safe sync from Figma
- inspect local status
- push changes back to Make
- verify drift

The app also remembers the last selected project folder.

## CLI

The CLI still exists for scripting, debugging, and power users.

Available commands:

- `figmake-sync init <figma-make-url> [local-folder]`
- `figmake-sync auth`
- `figmake-sync pull`
- `figmake-sync status`
- `figmake-sync push`
- `figmake-sync verify`
- `figmake-sync sync-from-figma`

## Safety Principles

This project is intentionally conservative.

- Only operates on a Figma Make URL explicitly linked by the user.
- Only uses your own authenticated local browser session.
- Never stores your Figma password.
- Never attempts MFA bypass, captcha bypass, or credential scraping.
- Never operates on unrelated tabs.
- Never exfiltrates code, cookies, or session data.
- Everything runs locally.
- Supports dry-run mode.
- Uses bounded retries and backoff.
- Captures screenshots and traces on browser failures.
- Prompts before destructive actions.
- Fails safely when the UI is ambiguous.

## Installation

### Requirements

- macOS first
- Node.js 20+
- npm

### Setup

```bash
npm install
npx playwright install chromium
npm run build
```

### Launch The Desktop App

```bash
npm run app
```

## Releasing Installers

The repository includes a tag-driven GitHub Actions workflow at
[.github/workflows/release.yml](./.github/workflows/release.yml).

When you push a tag like `v0.1.0`, the workflow will:

- verify the tag matches the version in `package.json`
- build a macOS universal `.dmg` and `.zip`
- build a Windows x64 `.exe` installer with NSIS
- attach those artifacts to the matching GitHub Release

Packaging is defined in
[electron-builder.yml](./electron-builder.yml).

Example release flow:

```bash
npm version patch
git push origin main --follow-tags
```

If you prefer tagging manually:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Important notes:

- The workflow builds unsigned installers by default so releases work without Apple or Windows signing secrets.
- macOS installers can still be downloaded from GitHub Releases, but Gatekeeper may warn until code signing and notarization are added.
- If you want signed production releases later, this workflow is the right place to add signing and notarization secrets.

## Quick Start

### Desktop Workflow

1. Launch the app with `npm run app`.
2. Choose a local folder for the project.
3. Paste the Figma Make URL and click `Link Folder`.
4. Click `Authenticate`.
5. Complete the login flow in the opened browser window.
6. Use `Pull` to bring code local.
7. Make changes locally in your editor.
8. Use `Status`, `Push`, and `Verify` as needed.

### CLI Workflow

```bash
figmake-sync init https://www.figma.com/make/your-project /path/to/project
figmake-sync auth --project /path/to/project
figmake-sync pull --project /path/to/project
figmake-sync status --project /path/to/project
figmake-sync push --project /path/to/project
figmake-sync verify --project /path/to/project
```

## Local State Layout

```text
.figmake-sync/
├── artifacts/
├── backups/
├── browser-profile/
├── config.json
├── downloads/
├── file-hashes.json
├── last-pull-manifest.json
├── logs/
├── metadata.json
├── snapshots/
│   └── last-pull/
└── tmp/
```

## Architecture

The code is split so browser automation is replaceable later if Figma exposes an official write API.

- [src/core/service.ts](./src/core/service.ts): shared orchestration for init, auth, pull, status, push, verify, and safe sync
- [src/core/state.ts](./src/core/state.ts): local state store, backups, metadata, snapshots, and temp workspaces
- [src/diff/manifest.ts](./src/diff/manifest.ts): manifests, hashes, rename detection, and merge foundations
- [src/browser/session.ts](./src/browser/session.ts): Playwright persistent browser session lifecycle
- [src/figma/adapter.ts](./src/figma/adapter.ts): `FigmaMakeAdapter` interface and isolated selector-driven Playwright adapter
- [src/electron/main.ts](./src/electron/main.ts): desktop shell
- [src/electron/renderer/app.ts](./src/electron/renderer/app.ts): desktop UI
- [src/cli/index.ts](./src/cli/index.ts): optional CLI

## Notes On Selectors

Figma Make does not expose a stable public automation contract for these interactions.

Because of that:

- selectors are isolated inside [src/figma/adapter.ts](./src/figma/adapter.ts)
- selector overrides are supported in config
- browser automation is designed to fail conservatively when the UI changes

## Testing

```bash
npm test
npm run smoke
```

Current automated coverage includes:

- manifest and diff logic
- desktop app state persistence
- an end-to-end smoke flow using a fixture adapter instead of live Figma

## Project Structure

```text
.
├── README.md
├── examples/
├── scripts/
├── src/
│   ├── browser/
│   ├── cli/
│   ├── core/
│   ├── diff/
│   ├── electron/
│   ├── figma/
│   ├── logging/
│   ├── types/
│   └── utils/
└── tests/
```

## Status

This is a macOS-first local desktop tool intended to make Figma Make workflows less manual and less fragile. It is not an official Figma integration, and the browser automation layer may need selector updates as the Figma Make UI changes.

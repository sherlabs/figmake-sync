# Launch reel

Vertical 9:16 reel for figmake-sync (1080x1920, 30 fps, about 21.4 s), built with HyperFrames. It opens on the hook "Figma Make eats your AI credits." (captions and cards sit inside the story safe zone, 250px top / 350px bottom), then: it's your code, pull it local, your own subscription (Claude or ChatGPT), describe a change, see it change, send it back. The app moments are live HTML/CSS reproductions of the final native app (add-project sheet, AI helper choice, chat panel with streaming reply, live preview, change card, Send to Figma, Sent toast), built from real renderer DOM snapshots in `../shared/`.

- `index.html` is generated: edit `tools/index.tpl.html` + `tools/scenes.js`, then run `python3 tools/build.py` (needs `../shared/app_ui.py`). `tools/index.orig.html` is the pre-rebuild backup. `fonts/` holds Inter and JetBrains Mono.
- `index.html` is the composition. `assets/` holds logos and audio.
- `figmake-sync-reel.mp4` is the render. `figmake-sync-reel-poster.jpg` is the poster. `brag-plan.md`, `composition-brief.md` and `share-copy.txt` are the plan, brief and post copy.

Captions, in order (start time):

1. 0.0 Every tweak costs credits.
2. 2.5 It's your code.
3. 4.6 Edit it by hand. / Or spend credits.
4. 7.4 Pull it local. (paste link, Open)
5. 9.3 Your own subscription. / Not Figma's credits. (Claude, ChatGPT)
6. 12.0 Just ask. / It edits the code. (type "Make the button blue", the agent works: Working dots, activity row opens and lists Looked at Button.tsx, Edited Button.tsx, Added button.css, Checked the app builds; the preview below turns blue and rounded with Before / After tags; the change card lands) - one scene, 12.0 to 16.9
7. 16.9 Send it back. (Send to Figma, "Sent to Figma")
8. 19.1 figmake-sync, Free for Mac & Windows, by Sherlabs, sherlabs.com, "Unofficial. Not affiliated with Figma."

Logos: the Figma mark is the official 5-shape mark, used only to refer to Figma. The Sherlabs wordmark comes unmodified from `sherlab-website/public/brand/`, and the figmake-sync icon is identical to `sherlab-website/public/logos/figmake.svg` and the app's `icon.svg`.

Audio: "Happy Beats / Business Moves Vol. 10" by Sascha Ende, ende.app (CC BY 4.0), plus CC0 Kenney and keyboard SFX.

Render again after editing the composition:

```sh
npx hyperframes render --quality high -o r.mp4 && ffmpeg -i r.mp4 -c:v libx264 -preset slow -b:v 1500k -c:a aac -movflags +faststart figmake-sync-reel.mp4
```

The UI is rebuilt in HTML/CSS from the renderer's styles (`src/electron/renderer/styles.css`); update the composition when the UI changes.


v2 notes: previous render kept as `figmake-sync-reel-v1.mp4` / `figmake-sync-reel-poster-v1.jpg`. End card now says "Free to download." (no OS claims). Frame 0 is the poster. The old caption timing list above is approximate; scene starts are unchanged (0, 2.46, 4.64, 7.35, 9.29, 12.02, 16.93, 19.1) and the end card is trimmed to 2.3 s.

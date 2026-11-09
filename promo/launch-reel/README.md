# Launch reel

Vertical 9:16 reel for figmake-sync (1080x1920, 30 fps, 28.6 s, about 8.2 MB), built with HyperFrames. It tells the story: Figma Make wants tokens for every edit, the code is right there, so pull it down and edit it with your own Claude Code or Codex subscription, then push it back.

- `index.html` is the composition. `assets/` holds the screenshots, product icon, Sherlabs logo and sound effects it uses.
- `figmake-sync-reel.mp4` is the rendered video. `figmake-sync-reel-poster.jpg` is the poster frame.

Captions, in order:

1. Figma Make wants tokens for every edit.
2. The code is right there. / Edit it by hand / or with Figma's AI credits
3. Pull it to a local folder.
4. Use YOUR Claude or ChatGPT subscription. (Claude Code, Codex)
5. Install it. Run it. Locally.
6. Just ask for the change.
7. See what it changed.
8. Push it back to Figma Make. (Nothing is sent until you push)
9. figmake-sync. Free for Mac and Windows. sherlabs.com

Render again after editing the composition:

```sh
npx hyperframes render -o figmake-sync-reel.mp4
```

The screenshots are captures of the built renderer with a stubbed backend (`checkout-flow` sample project). Regenerate them whenever the UI changes. `assets/sfx.wav` is a set of transition whooshes aligned to the scene cuts; update it if you change scene timings.

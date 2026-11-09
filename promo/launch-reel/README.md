# Launch reel

Vertical 9:16 reel for figmake-sync (1080x1920, 30 fps, 22.4 s, about 3.5 MB), built with HyperFrames. It opens on the problem: the code in Figma Make is right there, but you can only edit it by hand or by spending Figma's AI tokens. Then: pull it local, use your own Claude Code or Codex subscription, npm install and run locally, type a prompt, push it back.

- `index.html` is the composition. `assets/` holds the real app screenshots, logos and audio.
- `figmake-sync-reel.mp4` is the render (poster baked as frame 0). `figmake-sync-reel-poster.jpg` is the poster. `brag-plan.md`, `composition-brief.md` and `share-copy.txt` are the plan, brief and post copy.

Captions, in order (start time):

1. 0.0 Every tweak costs tokens.
2. 2.5 It's your code. (Figma Make builds a real React app)
3. 4.6 Edit it by hand. / Or spend tokens.
4. 7.4 Pull it local.
5. 9.3 Your own subscription. / Not Figma's tokens. (Claude Code, Codex)
6. 12.0 npm install. Runs locally.
7. 14.2 Type the change.
8. 16.9 Push it back to Figma Make. (Nothing is sent until you push)
9. 19.1 figmake-sync, Free for Mac & Windows, by Sherlabs, sherlabs.com, "Unofficial. Not affiliated with Figma."

Logos: the Figma mark is the official 5-shape mark, used only to refer to Figma. The Sherlabs wordmark comes unmodified from `sherlab-website/public/brand/`, and the figmake-sync icon is identical to `sherlab-website/public/logos/figmake.svg` and the app's `icon.svg`.

Audio: "Happy Beats / Business Moves Vol. 10" by Sascha Ende, ende.app (CC BY 4.0), plus CC0 Kenney and keyboard SFX.

Render again after editing the composition:

```sh
npx hyperframes render -o figmake-sync-reel.mp4
```

The screenshots are captures of the built renderer with a stubbed backend (`checkout-flow` sample project). Regenerate them whenever the UI changes.

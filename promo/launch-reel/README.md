# Launch reel

Vertical 9:16 reel for figmake-sync (1080x1920, 30 fps, 22.4 s, about 3.9 MB), built with HyperFrames. It opens on the problem (every tweak costs Figma AI tokens), then: it's your code, pull it local, your own subscription (Claude or ChatGPT), describe a change, see it change, send it back. The app moments are live HTML/CSS reproductions of the new minimal app (start screen, AI choice, prompt bar, preview with the change line and Undo, Send to Figma, Sent).

- `index.html` is the composition. `assets/` holds logos and audio.
- `figmake-sync-reel.mp4` is the render. `figmake-sync-reel-poster.jpg` is the poster. `brag-plan.md`, `composition-brief.md` and `share-copy.txt` are the plan, brief and post copy.

Captions, in order (start time):

1. 0.0 Every tweak costs tokens.
2. 2.5 It's your code.
3. 4.6 Edit it by hand. / Or spend tokens.
4. 7.4 Pull it local. (paste link, Open)
5. 9.3 Your own subscription. / Not Figma's tokens. (Claude, ChatGPT)
6. 12.0 Describe a change. ("Make the button blue")
7. 14.2 See it change. (button turns blue, "Made the button blue", Undo)
8. 16.9 Send it back. (Send to Figma, "Sent to Figma")
9. 19.1 figmake-sync, Free for Mac & Windows, by Sherlabs, sherlabs.com, "Unofficial. Not affiliated with Figma."

Logos: the Figma mark is the official 5-shape mark, used only to refer to Figma. The Sherlabs wordmark comes unmodified from `sherlab-website/public/brand/`, and the figmake-sync icon is identical to `sherlab-website/public/logos/figmake.svg` and the app's `icon.svg`.

Audio: "Happy Beats / Business Moves Vol. 10" by Sascha Ende, ende.app (CC BY 4.0), plus CC0 Kenney and keyboard SFX.

Render again after editing the composition:

```sh
npx hyperframes render --quality high -o r.mp4 && ffmpeg -i r.mp4 -c copy -movflags +faststart figmake-sync-reel.mp4
```

The UI is rebuilt in HTML/CSS from the renderer's styles (`src/electron/renderer/styles.css`); update the composition when the UI changes.

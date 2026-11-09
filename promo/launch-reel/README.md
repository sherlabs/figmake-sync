# Launch reel

Vertical 9:16 launch video for figmake-sync (1080x1920, 30 fps, about 30 s), built with HyperFrames.

- `index.html` is the composition. `assets/` holds the screenshots, logo and sound effects it uses.
- `figmake-sync-reel.mp4` is the rendered video. `figmake-sync-reel-poster.jpg` is the poster frame.

Render again after editing the composition:

```sh
npx hyperframes render -o figmake-sync-reel.mp4
```

The screenshots are captures of the built renderer with a stubbed backend. Regenerate them whenever the UI changes.

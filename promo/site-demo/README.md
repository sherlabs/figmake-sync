# Site demo

Landscape 16:9 demo (1920x1080, 30 fps, 41.1 s, about 4.0 MB) for the figmake-sync product page, built with HyperFrames. The app is the final native UI (tinted project sidebar, toolbar with status chip and one Send to Figma, live preview, Claude-style chat panel). It is not redrawn: `../shared/dom/*.html` are DOM snapshots of the real renderer (dumped with `../shared/dump_dom.mjs`, stubbed API) styled by the real `src/electron/renderer/styles.css`, rendered with Inter, and animated by the GSAP timeline.

Captions (agent-based editing loop): 0:00 Paste your Figma Make link. / 0:07 You ask. / 0:10 The agent works. / 0:16 You see it. / 0:21 It remembers. / 0:28 Undo anytime. / 0:33 Send it back. / 0:37 end card (icon, "Edit Figma Make with your own AI.", by Sherlabs, Figma mark, "Unofficial. Not affiliated with Figma.").

Rebuild: `python3 tools/build.py` (writes index.html and tools/cues.json from tools/index.tpl.html and ../shared/app_ui.py), `python3 tools/gen_audio.py assets` (soft clicks, keys, chimes, pad), `npx hyperframes check`, then
`npx hyperframes render --quality high -o r.mp4 && ffmpeg -i r.mp4 -c:v libx264 -preset slow -b:v 900k -maxrate 1400k -bufsize 2800k -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart demo.mp4`.
Copy `demo.mp4` and `demo-poster.jpg` to `sherlab-website/public/products/figmake-sync/`. Website stills: `../shared/site_assets.py` + `site_assets.mjs`.

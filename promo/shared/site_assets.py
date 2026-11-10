"""Static page with the real-UI reproductions, used by site_assets.mjs to export the website screenshots."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import app_ui as ui

W, H = 1200, 780
OUT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path("site_assets.html")
fonts = (pathlib.Path(__file__).parent / "fonts" / "inter-latin-wght-normal.woff2").as_uri()
mono = (pathlib.Path(__file__).parent.parent / "site-demo" / "fonts" / "jetbrains-mono-latin-400-normal.woff2").as_uri()
icon = (pathlib.Path(__file__).parent.parent / "site-demo" / "assets" / "icon-256.png").as_uri()
html = f"""<!doctype html><html class="is-mac"><head><meta charset="utf-8"><style>
@font-face{{font-family:Inter;src:url({fonts});font-weight:100 900}}
@font-face{{font-family:"JetBrains Mono";src:url({mono});font-weight:400}}
{ui.css()}
html,body{{margin:0;background:#fff}}
.shot{{position:relative;width:{W}px;height:{H}px;overflow:hidden;transform:translateZ(0)}}
.layer{{width:{W}px!important;height:{H}px!important}}
</style></head><body>{ui.sprite()}
<div class="shot" id="shot">{ui.ready("r_", with_cursor=False).replace("assets/icon-256.png", icon)}</div>
<div id="spare" style="display:none">{ui.start_layer("s_").replace("assets/icon-256.png", icon)}</div>
</body></html>"""
OUT.write_text(html)

"""Builds the reel index.html: tools/index.tpl.html + real-app UI pieces (../shared)."""
import sys, pathlib
HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT.parent / "shared"))
import app_ui as ui

C = ui.parts("c_"); V = ui.parts("v_"); W = ui.parts("w_"); X = ui.parts("x_")
W["card1"] = W["card1"].replace('class="cdiff"', 'class="cdiff" style="display:none"')
CUR = lambda p: f'<svg class="hfcur" id="{p}cur" viewBox="0 0 24 24" style="width:24px;height:24px"><path d="M4 2.5v17l4.6-4.2 3 6.7 3-1.4-3-6.6h6.2z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg><div class="rip" id="{p}rip"></div>'
LINE = lambda a, b: f'<span class="ln"><span class="w">{a[0]}</span>' + "".join(f'<span class="w">{x}</span>' for x in a[1:]) + "</span>"

row4 = '<div id="row4" style="position:absolute;left:0;width:1080px;top:1300px;height:240px;display:flex;align-items:center;justify-content:center;gap:50px"><img id="fg4" src="assets/figma-logo.svg" style="height:200px;width:auto"/><svg id="ar4" width="130" height="100" viewBox="0 0 120 90"><path d="M8 45H100M68 12L104 45L68 78" fill="none" stroke="#14171c" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/></svg><img id="ic4" src="assets/figmake-sync-icon.svg" style="width:220px;height:220px;border-radius:50px;box-shadow:0 20px 60px rgba(0,0,0,.3)"/></div>'

scenes = f'''
<section id="s4" class="scene orange clip" data-start="7.35" data-duration="1.94"><div class="grid"></div><div class="cap" style="font-size:250px;top:262px"><span class="ln"><span class="w">Pull</span><span class="w">it</span></span><span class="ln"><span class="w hl">local.</span></span></div>
<div class="ucard" id="c4" style="top:830px;height:442px;background:#c9cbd1"><div class="hfapp wrap" data-layout-ignore id="w4" style="width:520px;height:230px;transform:scale(1.923)"><div id="s4m" style="position:absolute;inset:0">{ui.add_sheet("s4_")}</div>{CUR("a4")}</div></div>{row4}</section>
<section id="s5" class="scene ink clip" data-start="9.29" data-duration="2.73"><div class="grid"></div><div class="glow"></div><div class="cap" style="font-size:140px;top:262px"><span class="ln"><span class="w">Your</span><span class="w">own</span></span><span class="ln"><span class="w hl">subscription.</span></span></div>
<div class="ucard" id="c5" style="top:590px;height:560px;background:#c9cbd1"><div class="hfapp wrap" data-layout-ignore id="w5" style="width:520px;height:300px;transform:scale(1.923)">{ui.choice_sheet()}</div></div>
<div class="strip" id="st5" style="top:1180px">Not <u>Figma's</u> credits.</div><div class="meter" id="m5" style="top:1390px"><div class="mlab">AI CREDITS</div><div class="mtrack"><div class="mfill" style="width:100%"></div></div></div></section>
<section id="s6" class="scene paper clip" data-start="12.02" data-duration="4.91"><div class="grid"></div><div class="cap" style="top:262px"><span class="ln" style="font-size:130px"><span class="w">Just</span><span class="w hl">ask.</span></span><span class="ln" style="font-size:105px"><span class="w">It</span><span class="w">edits</span></span><span class="ln" style="font-size:105px"><span class="w">the</span><span class="w hl">code.</span></span></div>
<div class="ucard" id="c6" style="top:640px;height:640px;background:#fff"><div class="hfapp wrap" data-layout-ignore id="w6" style="width:526px;height:337px;transform:scale(1.9)"><div style="display:flex;width:526px;height:337px;border-top:0">{C["chat"]}</div>{CUR("a6")}</div></div>
<div class="ucard" id="c7" style="top:1310px;height:250px"><div class="hfapp wrap" data-layout-ignore id="w7" style="width:588px;height:345px;transform:translate(0,-305px) scale(1.7)">{V["preview"]}</div></div></section>
<section id="s8" class="scene paper clip" data-start="16.93" data-duration="2.17"><div class="grid"></div><div class="kick" id="k8" style="top:830px"><img class="fg" src="assets/figma-logo.svg"/>Figma Make</div><div class="cap" style="font-size:250px;top:262px"><span class="ln"><span class="w">Send</span><span class="w">it</span></span><span class="ln"><span class="w hl">back.</span></span></div>
<div id="cam8" style="position:absolute;left:0;top:0;width:1080px;height:1920px;transform-origin:822px 1110px"><div class="ucard" id="c8k" style="top:1000px;height:150px"><div class="hfapp wrap" data-layout-ignore id="w8" style="left:0;top:23px;width:500px;height:52px;transform:scale(2)"><div class="main" style="display:block;width:500px">{X["toolbar"]}</div></div></div><div class="ring" id="r8"></div><div class="rip" id="p8" style="margin:-45px 0 0 -45px;width:90px;height:90px;border-width:7px;border-color:var(--acc)"></div><svg class="cur" id="c8" viewBox="0 0 24 24" style="width:54px;height:54px;position:absolute;left:0;top:0;opacity:0;z-index:6"><path d="M3 2l7 19 3-8 8-3z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
<div class="hfapp wrap" data-layout-ignore id="l8" style="left:300px;top:1380px;width:150px;height:44px;transform:scale(3.2)">{X["toast"].replace('style="opacity:0"','')}</div></section>
'''
css = ui.scoped_css() + """
.ucard{position:absolute;left:40px;width:1000px;border-radius:34px;box-shadow:0 30px 90px rgba(0,0,0,.28),0 0 0 3px rgba(130,135,145,.35);overflow:hidden;background:#fff}
.hfapp.wrap{position:absolute;left:0;top:0;transform-origin:0 0}
#l7.hfapp,#l8.hfapp{background:transparent}
#l8 .toast{opacity:1!important;box-shadow:0 0 0 1px rgba(0,0,0,.08),0 12px 30px rgba(0,0,0,.25)}
.hfapp #v_pv .pvtag{top:226px}#w6 .chat-h{display:none}#w6 .chint{display:none}#w6 #c_m1 p{min-height:44px}#w8 .ttl h1{display:none}#w8 .toolbar{padding-left:0}#c_empty p{display:none}#c_empty{padding:0 6px 8px}#c_empty .av{display:none}#c_empty .chips{flex:none}
@font-face{font-family:"Inter";src:url(fonts/inter-latin-wght-normal.woff2) format("woff2");font-weight:100 900}
@font-face{font-family:"JetBrains Mono";src:url(fonts/jetbrains-mono-latin-400-normal.woff2) format("woff2");font-weight:400}
"""
js = (HERE / "scenes.js").read_text()
t = (HERE / "index.tpl.html").read_text()
t = t.replace("%%CSS%%", css).replace("%%SCENES%%", scenes).replace("%%JS%%", js)
t = t.replace('<body>\n', '<body>\n' + ui.sprite() + '\n', 1)
(ROOT / "index.html").write_text(t)
print("built", len(t))

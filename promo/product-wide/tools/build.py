"""Builds index.html (+ cues.json for the audio generator) from the real app DOM snapshots."""
import json, sys, pathlib
HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT.parent / "shared"))
import app_ui as ui

LINK = "figma.com/make/Hk3xQp/Oak-and-Ember"
P1 = "Make the button blue and rounded"
P2 = "Now do the same for the cards"
OFF = 3.2
T = dict(
    dur=29.4, winOut=24.5, end=24.8,
    caps=[["Paste your <b>Figma Make</b> link.", 0.3, 6.7], ["<b>Ask</b> in plain words.", 7.1, 10.0], ["Your own AI. <b>No Figma credits.</b>", 10.1, 16.0],
          ["See <b>what changed</b>.", 16.2, 20.1], ["Send it <b>back</b>.", 20.3, 24.4]],
    cur0=0.7, addClick=1.5, sheetIn=1.65, inpClick=2.6, type1=[2.85, 34], link=LINK, openClick=4.5,
    prep0=4.8, prep1=5.3, prep2=5.85, prep3=6.35, prep4=6.85, ready=6.95,
    taClick1=7.9, p1=[8.2, 26], prompt1=P1, send1=9.75, w1=10.1, a1=10.5, steps1=[11.1, 12.0, 12.9, 13.8], pv1=12.2, text1=14.5, col1=16.7, card1=16.2,
    view0=16.8, viewClick=17.8, viewClose=20.0,
    sendCam=20.3, sendClick=21.6, sent=22.5, toastOut=24.3,
)
def sh(k, v):
    if k in ("link", "prompt1", "prompt2"): return v
    if k == "caps": return [[c[0], c[1] + OFF, c[2] + OFF] for c in v]
    if k in ("type1", "p1", "p2"): return [v[0] + OFF, v[1]]
    if isinstance(v, list): return [x + OFF for x in v]
    return v + OFF
T = {k: sh(k, v) for k, v in T.items()}
T["win0"] = OFF; T["two"] = False
# end-to-end story: the live run is cut open twice for the feature beats.
# A (after the project is pulled): chat inputs. B (after the preview changes): rail/Fit + step timeline.
GA, GB, tA, tB = 9.4, 5.9, 10.2, 19.3
def g(t): return t + (GA if t >= tA else 0) + (GB if t >= tB else 0)
for k, v in list(T.items()):
    if k in ("link", "prompt1", "prompt2", "two", "win0"): continue
    if k == "caps": T[k] = [[c[0], g(c[1]), g(c[2])] for c in v]
    elif k in ("type1", "p1", "p2"): T[k] = [g(v[0]), v[1]]
    elif isinstance(v, list): T[k] = [g(x) for x in v]
    else: T[k] = g(v)
# montage A at 10.25-19.6 (pre-shift live clock frozen), B at 28.75-34.6
T["nwA"] = [10.25, 19.5]
T["nwB"] = [28.75, 34.45]
T["beats"] = [[10.4, 14.8], [14.8, 17.2], [17.2, 19.6], [28.9, 31.7], [31.7, 34.5]]
T["ncaps"] = [["Paste a <b>screenshot</b>.", 10.45, 12.5], ["<b>Click</b> an element.", 12.6, 14.7], ["Pick your <b>model</b>.", 14.9, 17.1], ["Sign in <b>in the app</b>.", 17.3, 19.4],
              ["Fit the <b>preview</b>.", 28.95, 31.6], ["Follow every <b>step</b>.", 31.8, 34.4]]
T["end"] = round(T["winOut"] + 0.5, 2)
T["dur"] = round(T["end"] + 4.6, 2)
tpl = (HERE / "index.tpl.html").read_text()
html = (tpl.replace("%%CSS%%", ui.css()).replace("%%SPRITE%%", ui.sprite())
        .replace("%%START%%", ui.start_layer("s_"))
        .replace("%%PREP%%", ui.prep_layer("p_"))
        .replace("%%READY%%", ui.ready("r_", with_cursor=False))
        .replace("%%DUR%%", str(T["dur"])).replace("%%T%%", json.dumps(T)))
(ROOT / "index.html").write_text(html)

cues = dict(
    dur=T["dur"],
    clicks=[T[k] for k in ["addClick", "inpClick", "openClick", "taClick1", "send1", "viewClick", "viewClose", "sendClick"]],
    typing=[[T["type1"][0], LINK, T["type1"][1]], [T["p1"][0], P1, T["p1"][1]]],
    whoosh=[[OFF - .25, .35], [T["prep0"] - 0.15, .3], [T["send1"] + .3, .2], [T["caps"][4][1], .3], [T["end"], .35]] + [[x[0] - .2, .25] for x in T["beats"]],
    chimes=[[T["ready"], 660, .35]] + [[t, 880, .18] for t in T["steps1"]] + [[T["pv1"] + .1, 660, .6], [T["card1"], 784, .5], [T["card1"] + .12, 1175, .5],
            [T["sent"], 784, .6], [T["sent"] + .12, 1175, .6], [T["sent"] + .26, 1568, .5], [T["end"] + .4, 523, .5]] + [[T["beats"][i][0] + .5, 988, .3] for i in range(5)],
)
(HERE / "cues.json").write_text(json.dumps(cues, indent=1))
print("built", len(html))

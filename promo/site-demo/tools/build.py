"""Builds index.html (+ cues.json for the audio generator) from the real app DOM snapshots."""
import json, sys, pathlib
HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT.parent / "shared"))
import app_ui as ui

LINK = "figma.com/make/Hk3xQp/Oak-and-Ember"
P1 = "Make the button blue and rounded"
P2 = "Now do the same for the cards"
T = dict(
    dur=41.1, winOut=36.7, end=37.0,
    caps=[["Paste your <b>Figma Make</b> link.", 0.3, 6.7], ["You <b>ask</b>.", 7.1, 10.0], ["The agent <b>works</b>.", 10.1, 16.0],
          ["You <b>see it</b>.", 16.2, 20.4], ["It <b>remembers</b>.", 20.6, 28.0], ["<b>Undo</b> anytime.", 28.2, 32.4], ["Send it <b>back</b>.", 32.6, 36.7]],
    cur0=0.7, addClick=1.5, sheetIn=1.65, inpClick=2.6, type1=[2.85, 34], link=LINK, openClick=4.5,
    prep0=4.8, prep1=5.3, prep2=5.85, prep3=6.35, prep4=6.85, ready=6.95,
    taClick1=7.9, p1=[8.2, 26], prompt1=P1, send1=9.75, w1=10.1, a1=10.5, steps1=[11.1, 12.0, 12.9, 13.8], pv1=12.2, text1=14.5, col1=16.7, card1=16.2,
    view0=16.8, viewClick=17.8, viewClose=20.0,
    p2cam=20.5, taClick2=21.1, p2=[21.4, 26], prompt2=P2, send2=22.8, w2=23.15, a2=23.5, steps2=[24.0, 24.7, 25.4, 26.1], pv2=24.9, text2=26.8, col2=28.6, card2=28.1,
    undoCam=28.3, undoClick=29.5,
    sendCam=32.5, sendClick=33.8, sent=34.7, toastOut=36.5,
)
tpl = (HERE / "index.tpl.html").read_text()
html = (tpl.replace("%%CSS%%", ui.css()).replace("%%SPRITE%%", ui.sprite())
        .replace("%%START%%", ui.start_layer("s_"))
        .replace("%%PREP%%", ui.prep_layer("p_"))
        .replace("%%READY%%", ui.ready("r_", with_cursor=False))
        .replace("%%DUR%%", str(T["dur"])).replace("%%T%%", json.dumps(T)))
(ROOT / "index.html").write_text(html)

cues = dict(
    dur=T["dur"],
    clicks=[T[k] for k in ["addClick", "inpClick", "openClick", "taClick1", "send1", "viewClick", "viewClose", "taClick2", "send2", "undoClick", "sendClick"]],
    typing=[[T["type1"][0], LINK, T["type1"][1]], [T["p1"][0], P1, T["p1"][1]], [T["p2"][0], P2, T["p2"][1]]],
    whoosh=[[T["prep0"] - 0.15, .3], [T["send1"] + .3, .2], [T["send2"] + .3, .2], [T["caps"][6][1], .3], [T["end"], .35]],
    chimes=[[T["ready"], 660, .35]] + [[t, 880, .18] for t in T["steps1"] + T["steps2"]] + [[T["pv1"] + .1, 660, .6], [T["card1"], 784, .5], [T["card1"] + .12, 1175, .5],
            [T["pv2"] + .1, 523, .5], [T["card2"], 784, .5], [T["card2"] + .12, 1175, .5], [T["undoClick"] + .15, 440, .5],
            [T["sent"], 784, .6], [T["sent"] + .12, 1175, .6], [T["sent"] + .26, 1568, .5]],
)
(HERE / "cues.json").write_text(json.dumps(cues, indent=1))
print("built", len(html))

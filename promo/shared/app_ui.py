"""Shared builder for the figmake-sync promo compositions.

Takes DOM snapshots of the REAL renderer (dom/*.html, dumped by dump_dom.mjs from
src/electron/renderer with a stubbed API) and the real styles.css, and produces
seek-safe HTML fragments: stacked state variants that the GSAP timelines toggle.
"""
import re, pathlib

HERE = pathlib.Path(__file__).parent
RENDERER = HERE.parent.parent / "src" / "electron" / "renderer"
NAME = "Oak &amp; Ember"


def _app(name):
    t = (HERE / "dom" / f"{name}.html").read_text().split("\n@@@\n")[1]
    i = t.index('<div id="app"')
    t = re.sub(r"<script.*", "", t[i:], flags=re.S).strip()
    inner = t[len('<div id="app">'):]
    inner = inner[: inner.rindex("</div>")]
    inner = re.sub(r'<span class="sr-only">.*?</span>', "", inner)
    inner = inner.replace('id="projects-h" ', "").replace(' aria-labelledby="projects-h"', "")
    return inner.replace("Checkout Flow", NAME)


def balanced(h, start, tag="div"):
    o, c = f"<{tag}", f"</{tag}>"
    depth, i = 0, start
    while True:
        a, b = h.find(o, i), h.find(c, i)
        if a != -1 and a < b:
            depth += 1; i = a + len(o)
        else:
            depth -= 1; i = b + len(c)
            if depth == 0:
                return h[start:i]


def sprite():
    h = (RENDERER / "index.html").read_text()
    return re.search(r"<svg[^>]*class=\"sprite\".*?</svg>", h, re.S).group(0)


def css():
    c = (RENDERER / "styles.css").read_text()
    # drop the dark-scheme token block (promo renders the light UI)
    i = c.index("@media (prefers-color-scheme: dark)")
    j = c.index("/* macOS hiddenInset")
    c = c[:i] + c[j:]
    while True:
        k = c.find("@media (prefers-color-scheme: dark)")
        if k < 0:
            break
        d, j = 0, c.index("{", k)
        while True:
            d += 1 if c[j] == "{" else -1 if c[j] == "}" else 0
            j += 1
            if d == 0 and c[j - 1] == "}":
                break
        c = c[:k] + c[j:]
    c = re.sub(r"@keyframes [\w-]+ \{(?:[^{}]|\{[^{}]*\})*\}", "", c)
    c = c.replace('--font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", "Segoe UI Variable Text", "Segoe UI", system-ui, Helvetica, Arial, sans-serif;',
                  '--font: "Inter", system-ui, sans-serif;')
    c = c.replace('--mono: ui-monospace, "SF Mono", Menlo, Consolas, "Cascadia Mono", monospace;',
                  '--mono: "JetBrains Mono", ui-monospace, Menlo, monospace;')
    extra = """
*,*::before,*::after{animation:none!important;transition:none!important}
html,body{height:auto}
body{overflow:visible}
.stk{display:inline-grid}.stk>*{grid-area:1/1}
.stk.blk{display:grid}
.thread{overflow:hidden!important;display:flex;flex-direction:column}
.thread>.tin{flex:1 0 auto;display:flex;flex-direction:column;gap:12px}
.ta{position:relative;font-size:13.5px;letter-spacing:-.012em}.ta .ph{color:var(--text-3);position:absolute;left:0;top:0;white-space:nowrap}.ta{min-height:24px}.ta .caret{display:inline-block;width:1.5px;height:17px;background:var(--accent);vertical-align:-3px;margin-left:1px}
.ta .c,.fi .c{white-space:pre}
.fi{position:absolute;left:10px;top:0;height:100%;display:flex;align-items:center;font-size:12.5px;color:var(--text);pointer-events:none;white-space:pre}
.fi .caret{display:inline-block;width:1.5px;height:15px;background:var(--accent);margin-left:1px}
.fw{position:relative;display:block}
.fw .field{color:transparent}
.layer{position:absolute;left:0;top:0;width:1180px;height:760px;overflow:hidden;background:var(--win);color:var(--text);font:13px/1.4 var(--font);letter-spacing:-0.004em}
.scrim{position:absolute!important}
.sends-stk{justify-items:end}
.sheet,.toasts{position:absolute!important}
.pv{position:absolute;inset:0;background:#f7f4ee;font-family:Georgia,"Times New Roman",serif;color:#1b1b1b;overflow:hidden}
.pv .nav{display:flex;justify-content:space-between;padding:22px 36px;font-size:15px}
.pv .nav b{font-weight:700}.pv .nav span{color:#666}
.pv .hero{padding:30px 36px 0;max-width:560px}
.pv h1{font-weight:400;font-size:38px;line-height:1.1;letter-spacing:-.2px}
.pv .sub{margin:16px 0 22px;color:#555;font-size:16px}
.pv .btn2{display:inline-block;padding:12px 24px;background:#2b2824;color:#fff;border-radius:4px;font-family:var(--font);font-size:15px}
.pv .promo-w{height:0;overflow:hidden;margin:0 36px}
.pv .promo{height:44px;margin-top:22px;border-radius:10px;background:#efe3c8;color:#5a4630;display:flex;align-items:center;justify-content:center;font-family:var(--font);font-size:14px;font-weight:500;letter-spacing:-.005em}
.pv .pgrid{display:flex;gap:18px;padding:34px 36px}
.pv .pgrid .it{width:130px;font-size:13px;color:#555}.pv .pgrid .it i{display:block;width:130px;height:130px;border-radius:14px;margin-bottom:8px}
.pv .pgrid .it b{color:#1b1b1b;font-weight:400}
.pv .pgrid .it .ad{display:block;text-decoration:none;margin-top:8px;padding:7px 0;width:130px;text-align:center;background:#2563eb;color:#fff;border-radius:12px;font:500 12px var(--font)}
.pv .pvtag{position:absolute;right:16px;top:62px;padding:5px 12px;border-radius:99px;background:#17171a;color:#fff;font:600 13px var(--font);letter-spacing:0;opacity:0}
.acts .aw{overflow:hidden}
.hfcur{position:absolute;left:0;top:0;width:22px;height:22px;opacity:0;z-index:60;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))}
.rip{position:absolute;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid #0b66cc;opacity:0;z-index:59}
"""
    return c + extra


PREVIEW = """<div class="pv" id="%(p)spv"><div class="nav"><b>Oak &amp; Ember</b><span>Shop&nbsp;&nbsp;&nbsp; Journal&nbsp;&nbsp;&nbsp; Cart (2)</span></div>
<div class="hero"><h1>Hand-poured candles for slow evenings.</h1><div class="sub">Small batches. Soy wax. Burns for forty hours.</div><div class="btn2" id="%(p)spbtn">Shop the collection</div></div>
<div class="promo-w" id="%(p)sbanner"><div class="promo">Free shipping on orders over $50</div></div>
<div class="pgrid"><div class="it"><i style="background:#d9c7a8"></i><b>Cedar</b> $28<u class="ad">Add to cart</u></div><div class="it"><i style="background:#c9b08a"></i><b>Amber</b> $24<u class="ad">Add to cart</u></div><div class="it"><i style="background:#b89a74"></i><b>Fig</b> $26<u class="ad">Add to cart</u></div></div>
<div class="pvtag" id="%(p)stagb">Before</div><div class="pvtag" id="%(p)staga">After</div></div>"""

CURSOR = '<svg class="hfcur" id="%(p)scur" viewBox="0 0 24 24"><path d="M4 2.5v17l4.6-4.2 3 6.7 3-1.4-3-6.6h6.2z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg><div class="rip" id="%(p)srip"></div>'


def words(html):
    """wrap every word of text nodes in <span class="w">"""
    def sub(m):
        return re.sub(r"(\S+)", r'<span class="w">\1</span>', m.group(0))
    if "<" not in html:
        return sub(re.match(r".*", html, re.S))
    return re.sub(r"(?<=>)[^<>]+(?=<)", sub, html)


def chars(text, cls="c"):
    return "".join(f'<span class="{cls}">{c if c != " " else "&nbsp;"}</span>' for c in text)


STEP_ICON = {"look": "search", "edit": "pencil", "add": "plus", "check": "check"}


def act_list(p, n, steps):
    lis = "".join(f'<li id="{p}as{n}_{i}" class="{k}"><svg class="i s" aria-hidden="true"><use href="#i-{STEP_ICON[k]}"></use></svg>{lab}</li>' for i, (k, lab) in enumerate(steps))
    return f'<div class="aw" id="{p}aw{n}" style="height:0"><ul class="acts-list" id="{p}alist{n}">{lis}</ul></div>'


STEPS1 = [("look", "Looked at Button.tsx"), ("edit", "Edited Button.tsx"), ("add", "Added button.css"), ("check", "Checked the app builds")]
STEPS2 = [("look", "Looked at Card.tsx"), ("edit", "Edited Card.tsx"), ("edit", "Edited button.css"), ("check", "Checked the app builds")]


def ready(p="r_", with_cursor=True):
    """The ready app: preview left, chat right. Stacked variants, ids prefixed by p."""
    h = _app("two")
    empty = _app("empty")
    work = _app("working")
    # --- toolbar chip variants
    chg_chip = re.search(r'<span class="chip status chg".*?Changes waiting</span>', h).group(0)
    ok_chip = re.search(r'<span class="chip status ok".*?Up to date</span>', empty).group(0)
    busy_chip = '<span class="chip status busy" role="status"><span class="spin"></span>Working</span>'
    h = h.replace(chg_chip, f'<span class="stk" id="{p}chips"><span id="{p}chip_ok">{ok_chip}</span><span id="{p}chip_busy">{busy_chip}</span><span id="{p}chip_chg">{chg_chip}</span></span>')
    # --- sidebar tail
    tail = re.search(r'<span class="tail">.*?</span></span>', h).group(0)
    h = h.replace(tail, f'<span class="tail"><span class="stk" id="{p}tails"><span class="dot ok" id="{p}t_ok"></span><span class="spin s" id="{p}t_busy"></span><span class="dot chg" id="{p}t_chg"></span></span></span>')
    # --- send button
    send = re.search(r'<button type="button" class="btn primary send".*?</button>', h).group(0)
    dis = re.search(r'<button type="button" class="btn primary send".*?</button>', empty).group(0)
    badge2 = re.search(r'<span class="badge"[^>]*>2</span>', send).group(0)
    on = send.replace(badge2, f'<span class="stk"><span class="badge" id="{p}b1">1</span><span class="badge" id="{p}b2">2</span></span>')
    h = h.replace(send, f'<span class="stk sends-stk" id="{p}sends"><span id="{p}send_off">{dis}</span><span id="{p}send_on" style="opacity:0">{on}</span></span>')
    # --- preview
    h = h.replace('<div class="slot"></div>', '<div class="slot">' + PREVIEW % {"p": p} + "</div>")
    # --- thread
    th_i = h.index('<div class="thread"')
    th = balanced(h, th_i)
    arts = re.findall(r'<article class="msg .*?</article>', th, re.S)
    u1, a1, u2, a2 = arts
    u1 = u1.replace("Make the primary button blue and a bit rounder", "Make the button blue and rounded")
    u2 = u2.replace("Add a promo banner above the product grid", "Now do the same for the cards")
    # a1
    lab1 = re.search(r'<span class="acts-l">.*?</span>', a1).group(0)
    a1 = a1.replace(lab1, f'<span class="acts-l stk"><span id="{p}al1a">Making your change…</span><span id="{p}al1b">Looked around, edited Button.tsx, added button.css</span></span>')
    a1 = a1.replace('<button type="button" class="acts-t" data-fk="act-a1:0" aria-expanded="false"><svg class="i s"', f'<button type="button" class="acts-t" data-fk="act-a1:0" aria-expanded="false"><svg id="{p}ach1" class="i s"')
    a1 = a1.replace('</button></div><div class="md"', '</button>' + act_list(p, 1, STEPS1) + '</div><div class="md"', 1)
    a1 = re.sub(r'<div class="md">.*?</div>', '<div class="md" id="%sm1"><p>' % p + words("Done. The button is now a calm blue with rounded corners.") + "</p></div>", a1, count=1, flags=re.S)
    a1 = a1.replace("Made the main button blue with softer corners", "Made the button blue and rounded")
    a1 = a1.replace('<use href="#i-chev-d"></use></svg>View changes', '<use href="#i-chev-r"></use></svg>View changes')
    a1 = a1.replace('<svg class="i s" aria-hidden="true"><use href="#i-chev-r"></use></svg>View changes', f'<svg class="i s" id="{p}chev1" aria-hidden="true"><use href="#i-chev-r"></use></svg>View changes')
    a1 = a1.replace('<section class="chcard', f'<section id="{p}card1" class="chcard').replace('<div class="cdiff"', f'<div id="{p}diff1" class="cdiff"')
    a1 = a1.replace('<div class="acts">', f'<div class="acts" id="{p}acts1">')
    a1 = a1.replace('class="plain quiet" data-fk="view-t1"', f'id="{p}view1" class="plain quiet" data-fk="view-t1"')
    a1 = a1.replace("Preview updated", "Preview updated")
    # a2
    lab2 = re.search(r'<span class="acts-l">.*?</span>', a2).group(0)
    a2 = a2.replace(lab2, f'<span class="acts-l stk"><span id="{p}al2a">Making your change…</span><span id="{p}al2b">Looked around, edited Card.tsx and button.css</span></span>')
    a2 = a2.replace('<button type="button" class="acts-t" data-fk="act-a2:0" aria-expanded="false"><svg class="i s"', f'<button type="button" class="acts-t" data-fk="act-a2:0" aria-expanded="false"><svg id="{p}ach2" class="i s"')
    a2 = a2.replace('</button></div><div class="md"', '</button>' + act_list(p, 2, STEPS2) + '</div><div class="md"', 1)
    a2 = re.sub(r'<div class="md">.*?</div>', '<div class="md" id="%sm2"><p>' % p + words("Done. The cards now match the button.") + "</p></div>", a2, count=1, flags=re.S)
    a2 = a2.replace("Added a promo banner above the product grid", "Made the product cards blue and rounded too")
    a2 = a2.replace("App.tsx</span><span", "Card.tsx</span><span").replace('<span class="fchip added" title="added"><svg class="i s" aria-hidden="true"><use href="#i-plus"></use></svg>PromoBanner.tsx', '<span class="fchip edited" title="edited"><svg class="i s" aria-hidden="true"><use href="#i-pencil"></use></svg>button.css')
    cn = re.search(r'<span class="cnote">.*?</span>', a2).group(0)
    a2 = a2.replace(cn, f'<span class="stk" id="{p}cn2">{cn.replace("<span class=", f"<span id=\"{p}cn2a\" class=", 1)}<span id="{p}cn2b" class="cnote undone" style="opacity:0"><svg class="i s" aria-hidden="true"><use href="#i-undo"></use></svg>Undone</span></span>')
    a2 = a2.replace('<button type="button" class="plain quiet" data-fk="view-t2"', f'<button id="{p}view2" type="button" class="plain quiet" data-fk="view-t2"')
    a2 = a2.replace('<button type="button" class="plain quiet" aria-label="Undo: Made the product', f'<button id="{p}undo2" type="button" class="plain quiet" aria-label="Undo: Made the product')
    a2 = a2.replace('<section class="chcard', f'<section id="{p}card2" class="chcard')
    a2 = a2.replace('<div class="acts">', f'<div class="acts" id="{p}acts2">')
    # working row
    wk = balanced(work, work.index('<div class="msg assistant working"'))
    wk1 = wk.replace('class="msg assistant working"', f'id="{p}w1" class="msg assistant working"')
    wk2 = wk.replace('class="msg assistant working"', f'id="{p}w2" class="msg assistant working"')
    emp = balanced(empty, empty.index('<div class="empty">')).replace('<div class="empty">', f'<div class="empty" id="{p}empty">')
    chips = ''
    def idm(x, i):
        return x.replace('<article class="msg', f'<article id="{p}{i}" class="msg', 1)
    tin = f'<div class="tin" id="{p}tin">{emp}{idm(u1,"u1")}{idm(a1,"a1")}{wk1}{idm(u2,"u2")}{idm(a2,"a2")}{wk2}</div>'
    new_th = th[: th.index(">") + 1] + tin + "</div>"
    h = h.replace(th, new_th)
    # --- composer
    ta = re.search(r"<textarea.*?</textarea>", h).group(0)
    h = h.replace(ta, f'<div class="ta" id="{p}ta"><span class="ph" id="{p}ph1">Describe a change, like “make the buttons rounded”</span><span class="ph" id="{p}ph2" style="opacity:0">Working… you can type your next message</span><span id="{p}typed"></span><span id="{p}typed2"></span><i class="caret" id="{p}caret" style="opacity:0"></i></div>')
    sb = re.search(r'<button type="button" class="sendbtn" aria-label="Send".*?</button><button type="button" class="sendbtn stop".*?</button>', h, re.S).group(0)
    sb_on = '<button type="button" class="sendbtn" aria-label="Send"><svg class="i" aria-hidden="true"><use href="#i-up"></use></svg></button>'
    sb_off = '<button type="button" class="sendbtn" aria-label="Send" disabled=""><svg class="i" aria-hidden="true"><use href="#i-up"></use></svg></button>'
    sb_stop = '<button type="button" class="sendbtn stop" aria-label="Stop"><svg class="i" aria-hidden="true"><use href="#i-stop"></use></svg></button>'
    h = h.replace(sb, f'<span class="stk" id="{p}sbs"><span id="{p}sb_off">{sb_off}</span><span id="{p}sb_on" style="opacity:0">{sb_on}</span><span id="{p}sb_stop" style="opacity:0">{sb_stop}</span></span>')
    # --- status footer
    st = '<span role="status">Synced 2 min ago · Backup saved</span>'
    h = h.replace(st, f'<span role="status" class="stk"><span id="{p}st_a">Synced 2 min ago · Backup saved</span><span id="{p}st_b" style="opacity:0">Claude is making your change…</span><span id="{p}st_c" style="opacity:0">Sending to Figma…</span></span>')
    # --- toast
    h = h.replace('<div class="toasts" aria-live="polite"></div>', f'<div class="toasts"><div class="toast" id="{p}toast" style="opacity:0"><svg class="i" aria-hidden="true"><use href="#i-check"></use></svg>Sent to Figma</div></div>')
    h = h.replace('class="sbtn"', f'id="{p}addp" class="sbtn"')
    h = h.replace('class="btn icon gear"', f'id="{p}gear" class="btn icon gear"')
    cur = CURSOR % {"p": p} if with_cursor else ""
    return f'<div class="app-wrap" id="{p}app"><div class="layer" id="{p}layer">{h}{cur}</div></div>'


def start_layer(p="s_", with_cursor=False):
    h = _app("start")
    h = h.replace(balanced(h, h.index("<dialog"), "dialog"), "")
    sheet_src = _app("start-sheet")
    sh = balanced(sheet_src, sheet_src.index("<dialog"), "dialog")
    inp = re.search(r'<input class="field".*?>', sh).group(0)
    sh = sh.replace(inp, f'<span class="fw">{inp.replace("class=\"field\"", f"id=\"{p}inp\" class=\"field\"")}<span class="fi" id="{p}fi"><span id="{p}typed"></span><span id="{p}typed2"></span><i class="caret" id="{p}caret" style="opacity:0"></i></span></span>')
    opn = '<button type="button" class="btn lg primary">Open</button>'
    off = '<button type="button" class="btn lg primary" disabled="">Open</button>'
    sh = sh.replace(opn, f'<span class="stk"><span id="{p}open_off">{off}</span><span id="{p}open_on" style="opacity:0">{opn}</span></span>')
    sh = sh.replace("<dialog ", "<div ").replace("</dialog>", "</div>").replace(' open=""', "")
    sh = sh.replace('class="sheet"', 'class="sheet" style="top:0"')
    sheet = f'<div id="{p}sheetw" style="position:absolute;inset:0;z-index:30;opacity:0"><div class="scrim" id="{p}scrim" style="opacity:0"></div><div id="{p}sheetm" style="position:absolute;inset:0">{sh}</div></div>'
    h = h.replace('class="sbtn"', f'id="{p}addp" class="sbtn"')
    return f'<div class="layer" id="{p}layer">{h}{sheet}{(CURSOR % {"p": p}) if with_cursor else ""}</div>'


PREP_STEPS = ["Getting your project", "Setting up", "Starting preview", "Ready"]


def prep_layer(p="p_"):
    h = _app("prep")
    prep = balanced(h, h.index('<div class="card prep"'))
    cards = []
    for k in range(4):
        lis = ""
        for i, lab in enumerate(PREP_STEPS):
            if i < k:
                lis += f'<li class="done"><span class="mk"><svg class="i s" aria-hidden="true"><use href="#i-check-b"></use></svg></span><span>{lab}</span></li>'
            elif i == k:
                lis += f'<li class="cur"><span class="mk"><span class="spin"></span></span><span>{lab}</span></li>'
            else:
                lis += f'<li class=""><span class="mk">{i+1}</span><span>{lab}</span></li>'
        c = re.sub(r'<ul class="steps">.*?</ul>', f'<ul class="steps">{lis}</ul>', prep, flags=re.S)
        c = re.sub(r'<i style="width: [\d.]+%;"></i>', f'<i id="{p}bar{k}" style="width:0%"></i>', c)
        c = c.replace('<div class="card prep"', f'<div id="{p}c{k}" class="card prep"', 1)
        cards.append(c)
    stack = f'<div class="stk blk" style="position:absolute;inset:0;display:grid;place-items:center;pointer-events:none"><div style="grid-area:1/1;position:relative;width:100%;height:100%">' + "".join(cards) + "</div></div>"
    h = h.replace(prep, '<div class="stk blk prepstk">' + "".join(cards) + "</div>")
    return f'<div class="layer" id="{p}layer">{h}</div>'


def _scope(css_text, scope):
    out, i, n = [], 0, len(css_text)
    css_text = re.sub(r"/\*.*?\*/", "", css_text, flags=re.S)
    n = len(css_text)
    while i < n:
        j = css_text.find("{", i)
        if j < 0:
            break
        sel = css_text[i:j].strip()
        d, k = 0, j
        while True:
            d += 1 if css_text[k] == "{" else -1 if css_text[k] == "}" else 0
            k += 1
            if d == 0:
                break
        body = css_text[j + 1:k - 1]
        i = k
        if sel.startswith("@media"):
            out.append(sel + "{" + _scope(body, scope) + "}")
            continue
        if sel.startswith("@"):
            continue
        parts = []
        for s in sel.split(","):
            s = s.strip()
            s = re.sub(r"^html\.is-(mac|win)\s*", "", s)
            if s in ("html", "body", "html, body", ":root", ""):
                if s in ("body", ":root"):
                    parts.append(scope)
                continue
            if s.startswith(":root"):
                s = s[5:]
            parts.append(scope + " " + s if s != "*" else scope + " *")
        if parts:
            out.append(",".join(parts) + "{" + body + "}")
    return "\n".join(out)


def scoped_css(scope=".hfapp"):
    c = css()
    base = c[: c.index("*,*::before,*::after{animation:none")]
    extra = c[c.index("*,*::before,*::after{animation:none"):]
    extra = extra.replace("html,body{height:auto}", "").replace("body{overflow:visible}", "")
    extra = extra.replace("*,*::before,*::after{animation:none!important;transition:none!important}", "")
    return _scope(base, scope) + "\n" + scope + " *,"+scope+" *::before{animation:none!important;transition:none!important}\n" + _scope(extra, scope)


def parts(p):
    """Standalone pieces (chat panel, toolbar, preview, change card, toast, sheets) of the real UI, ids prefixed by p."""
    h = ready(p, with_cursor=False)
    chat = balanced(h, h.index('<aside class="chat"'), "aside")
    tb = balanced(h, h.index('<header class="toolbar"'), "header")
    pv = balanced(h, h.index('<div class="pv"'))
    card1 = balanced(h, h.index(f'<section id="{p}card1"'), "section")
    toast = balanced(h, h.index('<div class="toast"'))
    return dict(chat=chat, toolbar=tb, preview=pv, card1=card1, toast=toast)


def choice_sheet():
    c = _app("choice")
    return balanced(c, c.index("<dialog"), "dialog").replace("<dialog ", "<div ").replace("</dialog>", "</div>").replace(' open=""', "")


def add_sheet(p="s_"):
    sheet_src = _app("start-sheet")
    sh = balanced(sheet_src, sheet_src.index("<dialog"), "dialog")
    inp = re.search(r'<input class="field".*?>', sh).group(0)
    sh = sh.replace(inp, f'<span class="fw">{inp.replace("class=\"field\"", f"id=\"{p}inp\" class=\"field\"")}<span class="fi"><span id="{p}typed"></span><i class="caret" id="{p}caret" style="opacity:0"></i></span></span>')
    opn = '<button type="button" class="btn lg primary">Open</button>'
    off = '<button type="button" class="btn lg primary" disabled="">Open</button>'
    sh = sh.replace(opn, f'<span class="stk"><span id="{p}open_off">{off}</span><span id="{p}open_on" style="opacity:0">{opn}</span></span>')
    return sh.replace("<dialog ", "<div ").replace("</dialog>", "</div>").replace(' open=""', "")

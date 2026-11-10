/* ===== real-UI scenes (S4 to S8) ===== */
const $$=s=>document.querySelector(s);
const loc=(el,wrap,k)=>{const b=el.getBoundingClientRect(),w=wrap.getBoundingClientRect();return [(b.left-w.left+b.width/2)/k,(b.top-w.top+b.height/2)/k]};
const chars=(host,text,t0,cps)=>{const h=$$(host);[...text].forEach((c,i)=>{const s=document.createElement('span');s.style.opacity=0;s.style.whiteSpace='pre';s.textContent=c;h.appendChild(s);tl.set(s,{opacity:1},t0+i/cps)});return t0+text.length/cps};
const pclick=(cu,rp,t,x,y,s)=>{tl.to(cu,{scale:.82,duration:.07,transformOrigin:"4px 3px"},t).to(cu,{scale:1,duration:.12},t+.09);tl.set(rp,{x:x,y:y,scale:.3,opacity:.9},t);tl.to(rp,{scale:1.7,opacity:0,duration:.5,ease:"power2.out"},t+.001)};
const pmove=(cu,t0,t1,x,y)=>tl.to(cu,{x:x-4,y:y-3,duration:t1-t0,ease:"power2.inOut"},t0);
const RING="0 0 0 3px rgba(11,102,204,.35)";

// S4 pull local 7.35 -> 9.29
t0 = T[3];
lineIn("#s4 .cap .ln:nth-child(1)", t0 + .08); lineIn("#s4 .cap .ln:nth-child(2)", t0 + .18);
tl.from("#c4", { y: 220, opacity: 0, duration: .45, ease: "power3.out" }, t0 + .25);
tl.fromTo("#s4m", { y: -40, opacity: 0 }, { y: 0, opacity: 1, duration: .4, ease: "power3.out" }, t0 + .3);
gsap.set("#s4_open_on", { opacity: 0 });
tl.set("#s4_inp", { boxShadow: RING, borderColor: "transparent" }, t0 + .65);
tl.set("#s4_caret", { opacity: 1 }, t0 + .65);
tl.set("#s4_inp", { attr: { placeholder: "" } }, t0 + .69);
const e4 = chars("#s4_typed", "figma.com/make/Oak-and-Ember", 8.05, 40);
tl.set("#s4_open_off", { opacity: 0 }, 8.15); tl.set("#s4_open_on", { opacity: 1 }, 8.15);
const w4 = $$("#w4"), op4 = loc($$("#s4_open_on"), w4, 1.923);
gsap.set("#a4cur", { x: 330, y: 120, opacity: 0 });
tl.to("#a4cur", { opacity: 1, duration: .2 }, t0 + .55);
pmove("#a4cur", t0 + .6, 8.9, op4[0], op4[1]);
pclick("#a4cur", "#a4rip", 8.98, op4[0], op4[1]);
tl.set("#s4_caret", { opacity: 0 }, 8.98);
tl.to("#s4_open_on", { filter: "brightness(.88)", duration: .08 }, 8.98);
tl.from("#row4", { y: 120, opacity: 0, duration: .4, ease: "power3.out" }, t0 + .9);

// S5 own subscription 9.29 -> 12.02
t0 = T[4];
lineIn("#s5 .cap .ln:nth-child(1)", t0 + .08); lineIn("#s5 .cap .ln:nth-child(2)", t0 + .18);
tl.from("#c5", { y: 180, opacity: 0, duration: .45, ease: "power3.out" }, t0 + .4);
tl.set("#w5 .choice:nth-child(1)", { boxShadow: RING, borderColor: "transparent" }, t0 + .85);
tl.fromTo("#w5 .choice:nth-child(1)", { y: 0 }, { y: -4, duration: .2, yoyo: true, repeat: 1 }, t0 + .85);
tl.fromTo("#st5", { scale: 1.2, opacity: 0, y: 40 }, { scale: 1, opacity: 1, y: 0, duration: .35, ease: "back.out(2)" }, t0 + 1.4);
tl.from("#m5", { opacity: 0, y: 40, duration: .4, ease: "power3.out" }, t0 + 1.65);

// S6 just ask, it edits the code 12.02 -> 16.93
t0 = T[5];
lineIn("#s6 .cap .ln:nth-child(1)", t0 + .06); lineIn("#s6 .cap .ln:nth-child(2)", t0 + .16); lineIn("#s6 .cap .ln:nth-child(3)", t0 + .26);
tl.from("#c6", { y: 160, opacity: 0, duration: .4, ease: "power3.out" }, t0 + .22);
tl.from("#c7", { y: 160, opacity: 0, duration: .4, ease: "power3.out" }, t0 + .34);
["c_u2","c_a2","c_w2","c_u1","c_a1","c_w1","c_m1","c_card1","c_diff1"].forEach(id => $$("#" + id).style.display = "none");
gsap.set("#c_al1b", { opacity: 0 });
gsap.set("#c_alist1 li", { opacity: 0 });
gsap.set("#v_pbtn", { backgroundColor: "#2b2824", borderRadius: "4px" });
gsap.set("#v_pv .pvtag", { opacity: 0 });
gsap.set("#c_m1 .w", { opacity: 0 });
const sb6 = loc($$("#c_sb_on"), $$("#w6"), 1.9);
tl.set("#w6 .cbox", { boxShadow: RING, borderColor: "transparent" }, 12.55);
tl.set("#c_caret", { opacity: 1 }, 12.55);
tl.set("#c_ph1", { opacity: 0 }, 12.6);
tl.set("#c_sb_off", { opacity: 0 }, 12.66); tl.set("#c_sb_on", { opacity: 1 }, 12.66);
const e6 = chars("#c_typed", "Make the button blue", 12.62, 22);
gsap.set("#a6cur", { x: 150, y: 250, opacity: 0 });
tl.to("#a6cur", { opacity: 1, duration: .2 }, 12.9);
pmove("#a6cur", 12.95, 13.55, sb6[0], sb6[1]);
pclick("#a6cur", "#a6rip", 13.62, sb6[0], sb6[1]);
tl.set("#c_typed", { display: "none" }, 13.68); tl.set("#c_caret", { opacity: 0 }, 13.68);
tl.set("#w6 .cbox", { boxShadow: "0 1px 1px rgba(0,0,0,.06), 0 4px 14px rgba(0,0,0,.04)", borderColor: "rgba(0,0,0,.14)" }, 13.68);
tl.set("#c_ph2", { opacity: 1 }, 13.68); tl.set("#c_sb_on", { opacity: 0 }, 13.68); tl.set("#c_sb_stop", { opacity: 1 }, 13.68);
tl.to("#a6cur", { opacity: 0, duration: .2 }, 13.85);
// the thread: show/hide with build-time layout so the scroll stays right
const DD = { c_u1: "flex", c_a1: "flex", c_w1: "flex", c_m1: "block", c_card1: "block" };
Object.keys(DD).forEach(k => { $$("#" + k).style.display = ""; DD[k] = getComputedStyle($$("#" + k)).display; $$("#" + k).style.display = "none"; });
const sd = (id, on) => { $$("#" + id).style.display = on ? DD[id] : "none"; };
const sh = (id, t) => { sd(id, true); tl.set("#" + id, { display: DD[id] }, t); };
const hd = (id, t) => { sd(id, false); tl.set("#" + id, { display: "none" }, t); };
let tY = 0;
const need6 = () => Math.max(0, $$("#c_tin").offsetHeight - ($$("#w6 .thread").clientHeight - 28));
const scr6 = (t, d) => { const n = 0; if (n !== tY) { tl.to("#c_tin", { y: -n, duration: d || .35, ease: "power2.out" }, t); tY = n; } };
const rise6 = (sel, t, d) => tl.fromTo(sel, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: d || .3, ease: "power2.out" }, t);
const empt = $$("#c_empty"); const emptyD = getComputedStyle(empt).display;
tl.set("#c_empty", { display: "none" }, 13.7); empt.style.display = "none";
sh("c_u1", 13.7); rise6("#c_u1", 13.7); scr6(13.7, .3);
sh("c_w1", 13.86); rise6("#c_w1", 13.86); scr6(13.86, .3);
sh("c_a1", 14.0); rise6("#c_a1", 14.0); scr6(14.0, .3);
tl.to("#c_ach1", { rotation: 90, duration: .22 }, 14.08);
const AH6 = (() => { sd("c_a1", true); const w = $$("#c_aw1"); w.style.height = "auto"; const H = w.offsetHeight; w.style.height = "0px"; sd("c_a1", false); return H; })();
[14.12, 14.42, 14.72, 15.02].forEach((ts, i) => {
  const h = AH6 / 4; $$("#c_aw1").style.height = (h * (i + 1)) + "px";
  tl.fromTo("#c_aw1", { height: h * i }, { height: h * (i + 1), duration: .26, ease: "power2.out", immediateRender: false }, ts);
  tl.fromTo("#c_as1_" + i, { opacity: 0, y: 5 }, { opacity: 1, y: 0, duration: .25, immediateRender: false }, ts + .03);
  scr6(ts, .26);
});
// the preview changes while the steps run: before tag, highlight, after tag
tl.fromTo("#v_tagb", { opacity: 0, y: -6 }, { opacity: 1, y: 0, duration: .22, immediateRender: false }, 14.1);
tl.to("#v_tagb", { opacity: 0, duration: .2 }, 14.42);
tl.to("#v_pbtn", { backgroundColor: "#2563eb", borderRadius: "14px", duration: .45, ease: "power2.out" }, 14.46);
tl.fromTo("#v_pbtn", { boxShadow: "0 0 0 0 rgba(37,99,235,0)" }, { boxShadow: "0 0 0 8px rgba(37,99,235,.4)", duration: .3, yoyo: true, repeat: 3, ease: "sine.inOut", immediateRender: false }, 14.46);
tl.set("#v_pbtn", { boxShadow: "0 0 0 0 rgba(37,99,235,0)" }, 15.7);
tl.fromTo("#v_taga", { opacity: 0, y: -6 }, { opacity: 1, y: 0, duration: .22, immediateRender: false }, 14.75);
// card lands (the card title says it in plain words), thread scrolls the first bubble away
tl.to("#c_u1", { opacity: 0, duration: .2 }, 15.6);
hd("c_w1", 15.85); sh("c_card1", 15.88); rise6("#c_card1", 15.88, .35);
tl.to("#c_tin", { y: -66, duration: .4, ease: "power2.out" }, 15.88);
tl.set("#c_ph2", { opacity: 0 }, 15.88); tl.set("#c_sb_stop", { opacity: 0 }, 15.88); tl.set("#c_sb_off", { opacity: 1 }, 15.88); tl.set("#c_ph1", { opacity: 1 }, 15.88);
tl.to("#c_al1a", { opacity: 0, duration: .2 }, 15.9); tl.to("#c_al1b", { opacity: 1, duration: .2 }, 15.9);
["c_u1","c_a1","c_w1","c_m1","c_card1"].forEach(id => $$("#" + id).style.display = "none");
$$("#c_aw1").style.height = "0px"; $$("#c_tin").style.transform = ""; empt.style.display = emptyD;

// S8 push 16.93 -> 19.1
t0 = T[7];
kick("#k8", t0 + .05);
lineIn("#s8 .cap .ln:nth-child(1)", t0 + .08); lineIn("#s8 .cap .ln:nth-child(2)", t0 + .18);
tl.from("#c8k", { y: 200, opacity: 0, duration: .45, ease: "power3.out" }, t0 + .2);
gsap.set("#x_chip_ok,#x_chip_busy,#x_send_off,#x_b2", { opacity: 0 });
gsap.set("#x_send_on", { opacity: 1 });
const cb = $$("#cam8").getBoundingClientRect(), sbn = $$("#x_send_on").getBoundingClientRect();
const BX = sbn.left - cb.left + sbn.width / 2, BY = sbn.top - cb.top - 200 + sbn.height / 2;
gsap.set("#r8", { left: BX - sbn.width / 2 - 14, top: BY - sbn.height / 2 - 12, width: sbn.width + 28, height: sbn.height + 24, borderRadius: 14 });
gsap.set("#p8", { left: BX, top: BY });
$$("#cam8").style.transformOrigin = BX + "px " + BY + "px";
tl.to("#cam8", { scale: 1.45, duration: .65, ease: "power3.inOut" }, t0 + .75);
tl.fromTo("#c8", { opacity: 0, x: BX - 320, y: BY + 260 }, { opacity: 1, x: BX + 6, y: BY + 4, duration: .7, ease: "power3.inOut" }, t0 + .75);
ringIn("#r8", t0 + 1.45);
tl.to("#c8", { scale: .82, duration: .08, yoyo: true, repeat: 1, transformOrigin: "0 0" }, t0 + 1.6);
tl.fromTo("#p8", { opacity: .95, scale: .3 }, { opacity: 0, scale: 1.8, duration: .5, ease: "power2.out" }, t0 + 1.62);
tl.set("#x_send_on", { opacity: 0 }, t0 + 1.65); tl.set("#x_send_off", { opacity: 1 }, t0 + 1.65);
tl.set("#x_chip_chg", { opacity: 0 }, t0 + 1.65); tl.set("#x_chip_ok", { opacity: 1 }, t0 + 1.9);
tl.set("#x_chip_busy", { opacity: 1 }, t0 + 1.65); tl.set("#x_chip_busy", { opacity: 0 }, t0 + 1.9);
tl.to("#r8", { opacity: 0, duration: .2 }, t0 + 1.7);
tl.from("#l8", { y: 90, opacity: 0, scale: 2.8, duration: .4, ease: "back.out(1.8)", transformOrigin: "0 0" }, t0 + 1.75);
tl.to(".spin", { rotation: 360, duration: .8, repeat: 25, ease: "none", transformOrigin: "50% 50%" }, 0);
tl.fromTo(".dots i", { opacity: .3 }, { opacity: 1, duration: .4, stagger: .15, repeat: 40, yoyo: true, ease: "sine.inOut" }, 0);

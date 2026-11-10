import { chromium } from "/Users/nilesh93/Projects/personal/figmake/node_modules/playwright/index.mjs";
import fs from "node:fs";
const [,, htmlPath, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
const states = {
  hero: () => { common(); turn1(true); turn2(true); done(2); toast(false); scrollEnd(); },
  "step-send": () => { common(); turn1(true); turn2(true); done(2); toast(true); scrollEnd(); },
  "step-describe": () => { common(); btnBlue(); ["r_u2","r_a2","r_w2"].forEach(i=>$(i).style.display="none");
    $("r_al1a").style.opacity = 1; $("r_al1b").style.opacity = 0; expand(1); document.querySelectorAll("#r_pv .it i").forEach(e=>e.style.borderRadius="3px"); document.querySelectorAll("#r_pv .ad").forEach(e=>{e.style.background="#2b2824";e.style.borderRadius="3px"}); chipsSet("chg"); $("r_send_off").style.opacity=0; $("r_send_on").style.opacity=1; $("r_b1").style.opacity=1; $("r_b2").style.opacity=0; scrollEnd(); },
  "step-open": () => { common(); document.getElementById("r_empty").style.display = "flex";
    ["r_u1","r_a1","r_w1","r_u2","r_a2","r_w2"].forEach(i => $(i).style.display = "none");
    const sh = document.querySelector("#spare #s_sheetw"); sh.style.opacity = 1; sh.querySelector("#s_scrim").style.opacity = 1;
    sh.querySelector("#s_typed").textContent = "figma.com/make/Hk3xQp/Oak-and-Ember"; sh.querySelector("#s_inp").placeholder = ""; sh.querySelector("#s_inp").style.boxShadow = "0 0 0 3px rgba(11,102,204,.35)";
    sh.querySelector("#s_open_off").style.opacity = 0; sh.querySelector("#s_open_on").style.opacity = 1;
    $("r_layer").appendChild(sh); },
};
const helpers = `
const $=id=>document.getElementById(id);
function common(){ ["r_al1a","r_al2a"].forEach(i=>$(i).style.opacity=0); ["r_al1b","r_al2b"].forEach(i=>$(i).style.opacity=1);
  $("r_empty").style.display="none"; $("r_diff1").style.display="none"; ["r_w1","r_w2"].forEach(i=>$(i).style.display="none");
  ["r_u1","r_a1","r_u2","r_a2"].forEach(i=>$(i).style.display="flex"); }
function expand(n){ $("r_aw"+n).style.height="auto"; $("r_ach"+n).style.transform="rotate(90deg)"; }
function btnBlue(){ const b=$("r_pbtn"); b.style.background="#2563eb"; b.style.borderRadius="14px"; }
function turn1(){ btnBlue(); }
function turn2(on){}
function chipsSet(k){ ["ok","busy","chg"].forEach(x=>{$("r_chip_"+x).style.opacity=x===k?1:0;$("r_t_"+x).style.opacity=x===k?1:0}); }
function done(n){ chipsSet("chg"); $("r_send_off").style.opacity=0; $("r_send_on").style.opacity=1; $("r_b1").style.opacity=n===1?1:0; $("r_b2").style.opacity=n===2?1:0; }
function busy(){ chipsSet("busy"); $("r_st_a").style.opacity=0; $("r_st_b").style.opacity=1; $("r_ph1").style.opacity=0; $("r_ph2").style.opacity=1; $("r_sb_off").style.opacity=0; $("r_sb_stop").style.opacity=1; }
function toast(on){ $("r_toast").style.opacity=on?1:0; }
function scrollEnd(){ const th=document.querySelector("#r_layer .thread"), tin=$("r_tin"); const n=Math.max(0,tin.offsetHeight-(th.clientHeight-28)); tin.style.transform="translateY("+(-n)+"px)"; }
`;
const b = await chromium.launch({ channel: "chrome" });
for (const [name, fn] of Object.entries(states)) {
  const ctx = await b.newContext({ viewport: { width: 1200, height: 780 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto("file://" + htmlPath); await p.waitForTimeout(600);
  await p.evaluate(`(()=>{${helpers}; const states=${"{"}${Object.entries(states).map(([k, f]) => JSON.stringify(k) + ":" + f.toString()).join(",")}${"}"}; states[${JSON.stringify(name)}]();})()`);
  await p.waitForTimeout(300);
  await p.locator("#shot").screenshot({ path: `${outDir}/${name}.png` });
  await ctx.close();
}
await b.close();

// Renders privacy-safe screenshots of the REAL renderer UI with a stubbed window.figmake and fake data.
// Usage: node render.mjs <built-renderer-root> <out-dir>
//   built-renderer-root = tsc outDir (contains src/electron/renderer with assets + vendor/monaco copied in)
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { chromium } from "/Users/nilesh93/Projects/personal/figmake/node_modules/playwright/index.mjs";
const [, , root, out] = process.argv;
fs.mkdirSync(out, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json" };
const srv = http.createServer((q, r) => { const f = path.join(root, q.url.split("?")[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { "content-type": types[path.extname(f)] || "text/plain" }); r.end(d); }); }).listen(0);
await new Promise((r) => srv.on("listening", r));
const url = `http://127.0.0.1:${srv.address().port}/src/electron/renderer/index.html`;

const stub = (init) => {
  const iso = (m) => new Date(Date.now() - m * 60000).toISOString();
  const P = (k, name, status, m) => ({ key: k, name, status, syncedAt: m == null ? null : iso(m) });
  const base = { phase: "ready", projectName: "Oak & Ember", previewUrl: "http://localhost:5173/", changes: [], changeFiles: [], changeIds: [], canSend: false, canUndo: false, agent: "claude", agentConnected: true, workspace: "figmake-sync", workspacePath: "~/figmake-sync", workspaceSynced: false, projects: [P("a", "Oak & Ember", "synced", 2), P("b", "Studio Landing", "synced", 60 * 26)], activeKey: "a", syncedAt: iso(2), updatesEnabled: true, processes: [], activity: { lines: [], stepStartedAt: null, startedAt: null } };
  const U = (id, text, m) => ({ id, role: "user", at: iso(m), text, parts: [], status: "done" });
  const A = (id, m, parts, extra = {}) => ({ id, role: "assistant", at: iso(m), text: "", parts, status: "done", ...extra });
  const T = (text) => ({ type: "text", text });
  const AC = (...items) => ({ type: "activity", items: items.map(([kind, label, file]) => ({ kind, label, ...(file ? { file } : {}) })) });
  const F = (name, status = "edited") => ({ name, status });
  const CH = (turnId, summary, files) => ({ turnId, summary, files, previewUpdated: true, fate: "active" });
  const done = [
    U("u1", "Make the primary button blue and a bit rounder", 9),
    A("a1", 9, [AC(["look", "Looked at Button.tsx", "Button.tsx"], ["edit", "Edited Button.tsx", "Button.tsx"], ["add", "Added button.css", "button.css"], ["check", "Checked the app builds"]), T("Done. The main button is now a calm blue with softer corners.")], { change: CH("t1", "Made the main button blue with softer corners", [F("Button.tsx"), F("button.css", "added")]) }),
    U("u2", "Add a promo banner above the product grid", 5),
    A("a2", 5, [AC(["look", "Looked at App.tsx", "App.tsx"], ["edit", "Edited App.tsx", "App.tsx"], ["add", "Added PromoBanner.tsx", "PromoBanner.tsx"]), T("I added a slim banner at the top of the shop with the line **Free shipping over $50**. It sits above the product grid and uses your existing colours.")], { change: CH("t2", "Added a promo banner above the product grid", [F("App.tsx"), F("PromoBanner.tsx", "added")]) }),
  ];
  const svg = (w, h, body) => "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);
  const SHOT = svg(320, 200, '<rect width="320" height="200" fill="#f7f4ee"/><rect x="16" y="14" width="90" height="10" rx="4" fill="#1b1b1b"/><rect x="16" y="52" width="170" height="16" rx="4" fill="#1b1b1b"/><rect x="16" y="76" width="120" height="8" rx="4" fill="#999"/><rect x="16" y="104" width="96" height="30" rx="15" fill="#1d4ed8"/><rect x="16" y="150" width="60" height="36" rx="8" fill="#d9c7a8"/><rect x="84" y="150" width="60" height="36" rx="8" fill="#c9b08a"/><rect x="152" y="150" width="60" height="36" rx="8" fill="#b89a74"/>');
  const CROP = svg(160, 60, '<rect width="160" height="60" fill="#f7f4ee"/><rect x="12" y="12" width="136" height="36" rx="12" fill="#2563eb"/><text x="80" y="36" font-family="Helvetica,Arial" font-size="14" fill="#fff" text-anchor="middle">Shop the collection</text>');
  const ELEMENT = { kind: "element", id: "11111111-2222-3333-4444-555555555555", image: "crop1", info: { tag: "a", classes: ["btn", "btn-primary"], selector: "main > section.hero > a.btn", text: "Shop the collection", attrs: { href: "/shop" }, box: { x: 36, y: 232, width: 190, height: 44 }, styles: { "font-size": "15px", "background-color": "rgb(37, 99, 235)" }, page: "/", components: ["Hero", "Button"], source: { file: "src/components/Button.tsx", line: 4 } } };
  const SHOTATT = { kind: "image", name: "shot1" };
  const chatShot = [
    { id: "u1", role: "user", at: iso(4), text: "Make this button match the pill style in my screenshot", parts: [], status: "done", attachments: [SHOTATT, ELEMENT] },
    A("a1", 4, [AC(["look", "Looked at Hero.tsx", "Hero.tsx"], ["look", "Looked at Button.tsx", "Button.tsx"], ["edit", "Edited Button.tsx", "Button.tsx"], ["add", "Added button.css", "button.css"], ["check", "Checked the app builds"]), T("The button now has a fully rounded pill shape with a deeper blue, like the one in your screenshot. I only touched the Shop the collection button.")], { change: CH("t1", "Gave the Shop button a pill shape and deeper blue", [F("Button.tsx"), F("button.css", "added")]) }),
  ];
  const withChanges = { ...base, changes: ["Made the main button blue with softer corners", "Added a promo banner above the product grid"], changeFiles: [2, 2], changeIds: ["t1", "t2"], canSend: true, canUndo: true, projects: [P("a", "Oak & Ember", "changes", 2), P("b", "Studio Landing", "synced", 60 * 26)] };
  const startS = { ...base, phase: "start", projectName: null, previewUrl: null, activeKey: null, projects: [], syncedAt: null, agent: null, agentConnected: false };
  const tabs = (n) => ({ activeId: 1, tabs: [{ id: 1, title: "Oak & Ember", url: "http://localhost:5173/", loading: false, canGoBack: false, canGoForward: false, failed: false }, ...(n > 1 ? [{ id: 2, title: "Cart", url: "http://localhost:5173/cart", loading: false, canGoBack: true, canGoForward: false, failed: false }] : [])] });
  const S = {
    chat: [{ ...base, changes: ["Gave the Shop button a pill shape and deeper blue"], changeFiles: [2], changeIds: ["t1"], canSend: true, canUndo: true }, { projectKey: "a", messages: chatShot, active: false, fresh: false }, tabs(1)],
    composer: [{ ...base }, { projectKey: "a", messages: done.slice(0, 2), active: false, fresh: false }, tabs(1)],
    signin: [{ ...base, phase: "needs-ai-signin", agentConnected: false }, { projectKey: "a", messages: done.slice(0, 2), active: false, fresh: false }, tabs(1)],
    start: [startS, { projectKey: null, messages: [], active: false, fresh: false }, tabs(0)],
    ready: [withChanges, { projectKey: "a", messages: done, active: false, fresh: false }, tabs(2)],
    working: [{ ...base, phase: "working" }, { projectKey: "a", active: true, fresh: false, messages: [U("u1", "Add a promo banner above the product grid", 1), A("a1", 0, [AC(["look", "Looked at App.tsx", "App.tsx"], ["look", "Looked at the product grid", "ProductGrid.tsx"], ["helper", "A helper is checking how the pages are laid out"], ["add", "Adding PromoBanner.tsx", "PromoBanner.tsx"])], { status: "streaming", now: "Adding PromoBanner.tsx", startedAt: Date.now() - 38000, plan: [{ text: "Find where the product grid starts", state: "done" }, { text: "Write the banner", state: "active" }, { text: "Check the app still builds", state: "pending" }] })] }, tabs(1)],
    review: [withChanges, { projectKey: "a", messages: done, active: false, fresh: false }, tabs(1)],
    merge: [{ ...withChanges, phase: "resolving", mergeConflicts: ["src/components/Button.tsx", "src/styles/theme.css"] }, { projectKey: "a", messages: done, active: false, fresh: false }, tabs(1)],
    sending: [{ ...withChanges, phase: "sending", sendProgress: { phase: "sending", op: "replace", file: "src/components/PromoBanner.tsx", name: "PromoBanner.tsx", index: 3, total: 5, completed: 2, percent: 48, startedAt: Date.now() - 41000, done: [{ file: "src/components/Button.tsx", name: "Button.tsx", op: "replace", ok: true }, { file: "src/styles/button.css", name: "button.css", op: "create", ok: true }] } }, { projectKey: "a", messages: done, active: false, fresh: false }, tabs(1)],
    settings: [{ ...withChanges }, { projectKey: "a", messages: done, active: false, fresh: false }, tabs(1)],
  };
  const [s0, c0, b0] = S[init.name];
  let cur = s0, curChat = c0, curBr = b0; const cb = [], cc = [], cbr = [];
  const cell = (n, text, mark) => ({ n, text, mark });
  const reviewItems = [
    { path: "src/components/Button.tsx", status: "modified", added: 3, removed: 1, ignored: false },
    { path: "src/components/PromoBanner.tsx", status: "added", added: 18, removed: 0, ignored: false },
    { path: "src/App.tsx", status: "modified", added: 4, removed: 0, ignored: false },
    { path: "src/styles/button.css", status: "added", added: 9, removed: 0, ignored: false },
    { path: "package-lock.json", status: "modified", added: 120, removed: 96, ignored: true },
  ];
  const before = `export function Button({ label }: Props) {\n  return (\n    <button className="btn">\n      {label}\n    </button>\n  );\n}\n`;
  const after = `export function Button({ label }: Props) {\n  return (\n    <button className="btn btn-blue">\n      {label}\n    </button>\n  );\n}\n`;
  const noop = () => Promise.resolve();
  window.figmake = new Proxy({
    state: () => Promise.resolve(cur), onState: (f) => { cb.push(f); return () => {}; },
    chat: () => Promise.resolve(curChat), onChat: (f) => { cc.push(f); return () => {}; },
    browser: () => Promise.resolve(curBr), onBrowser: (f) => { cbr.push(f); return () => {}; },
    onElementPicked: (f) => { window.__picked = () => f(ELEMENT); return () => {}; },
    attachImage: () => Promise.resolve({ ok: true, attachment: SHOTATT }),
    readAttachment: (n) => Promise.resolve(n.startsWith("crop") ? CROP : SHOT),
    onCommand: () => () => {}, onUpdateState: () => () => {}, updateState: () => Promise.resolve({ phase: "idle" }),
    reviewChanges: () => Promise.resolve(reviewItems), ignoredFiles: () => Promise.resolve(["package-lock.json"]),
    reviewDiff: () => Promise.resolve({ kind: "text", before, after }), mergeDiff: () => Promise.resolve({ kind: "text", before, after }),
    localChangeCount: () => Promise.resolve(4), describeChange: () => Promise.resolve([]), listFolder: () => Promise.resolve({ path: "", entries: [], truncated: false }),
    previewRect: () => {},
  }, { get: (t, k) => (k in t ? t[k] : noop) });
};

const fake = () => {
  const slot = document.querySelector(".slot"); if (!slot || slot.querySelector(".fakepage")) return;
  const el = (t, st, txt) => { const e = document.createElement(t); Object.assign(e.style, st); if (txt) e.textContent = txt; return e; };
  const page = el("div", { position: "absolute", inset: "0", background: "#f7f4ee", fontFamily: "Georgia,serif", color: "#1b1b1b", overflow: "hidden" }); page.className = "fakepage";
  const nav = el("div", { display: "flex", justifyContent: "space-between", padding: "22px 36px", fontSize: "15px" });
  nav.append(el("b", {}, "Oak & Ember"), el("span", { color: "#666" }, "Shop    Journal    Cart (2)"));
  const hero = el("div", { padding: "30px 36px 0", maxWidth: "560px" });
  hero.append(el("div", { fontSize: "38px", lineHeight: "1.1" }, "Hand-poured candles for slow evenings."), el("div", { margin: "16px 0 22px", color: "#555", fontSize: "16px" }, "Small batches. Soy wax. Burns for forty hours."));
  hero.append(el("div", { display: "inline-block", padding: "12px 24px", background: "#2563eb", color: "#fff", borderRadius: "12px", fontFamily: "system-ui", fontSize: "15px" }, "Shop the collection"));
  const cards = el("div", { display: "flex", gap: "18px", padding: "34px 36px" });
  for (const c of ["#d9c7a8", "#c9b08a", "#b89a74"]) cards.append(el("div", { width: "130px", height: "130px", borderRadius: "14px", background: c }));
  page.append(nav, hero, cards); slot.append(page);
};

const shots = {
  start: async () => {},
  overview: null, // alias of ready, no sheet
  working: async () => {},
  review: async (p) => { await p.locator(".send").click(); await p.waitForTimeout(500); await p.locator(".rv-more").first().click(); await p.waitForTimeout(2500); },
  merge: async (p) => { await p.waitForTimeout(500); await p.locator(".sy-more").first().click(); await p.waitForTimeout(2500); },
  sending: async () => {},
  settings: async (p) => { await p.addStyleTag({ content: ".row.upd{display:none}" }); await p.locator(".gear").click(); await p.waitForTimeout(500); },
  chat: async (p) => { await p.locator(".acts-t").first().click(); await p.waitForTimeout(300); await p.evaluate(() => { for (const e of document.querySelectorAll("*")) if (e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY !== "visible" && e.closest(".chat")) e.scrollTop = 0; }); await p.waitForTimeout(300); },
  composer: async (p) => {
    await p.locator('input[type=file]').setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==", "base64") });
    await p.waitForTimeout(300); await p.evaluate(() => window.__picked()); await p.waitForTimeout(300);
    await p.locator("textarea.ta").fill("Make this button match the pill style in my screenshot"); await p.waitForTimeout(300);
  },
  models: async (p) => { await p.locator(".agent-chip").click(); await p.waitForTimeout(400); },
  rail: async () => {},
  signin: async () => {},
  sync: async (p) => { await p.locator(".sy-btn").click(); await p.waitForTimeout(300); },
};
const stateFor = { chat: "chat", composer: "composer", models: "ready", rail: "ready", signin: "signin", start: "start", overview: "ready", working: "working", review: "review", merge: "merge", sending: "sending", settings: "settings", sync: "ready" };
const only = process.env.ONLY ? process.env.ONLY.split(",") : Object.keys(shots);
const b = await chromium.launch({ channel: "chrome" });
for (const id of only) {
  const ctx = await b.newContext({ viewport: { width: 1200, height: 780 }, deviceScaleFactor: 2, colorScheme: "light", reducedMotion: "reduce" });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log(id, "pageerror", e.message));
  await p.addInitScript(stub, { name: stateFor[id] });
  if (id === "rail") await p.addInitScript(() => { try { localStorage.setItem("figmake.side.rail", "1"); } catch {} });
  await p.addInitScript(() => { Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }); });
  await p.goto(url); await p.waitForTimeout(500);
  // The real app has a class collision: .chcard also carries .tail (mono log style). Neutralise it so the card shows as designed.
  await p.addStyleTag({ content: '.jump{display:none!important}.chcard.tail{font-family:var(--font);font-size:inherit;line-height:inherit;min-height:0;color:inherit;overflow:visible}' });
  await p.evaluate(fake);
  if (shots[id]) await shots[id](p);
  await p.evaluate(fake); await p.waitForTimeout(200);
  await p.screenshot({ path: `${out}/${id}.png` });
  await ctx.close();
}
await b.close(); srv.close();

import { activitySummary } from "../../app/activitySummary.js";
import { parseMarkdown, type Inline } from "../../app/markdown.js";
import type { AgentChoice, ChangedFile, ChatChange, ChatMessage, ChatPart, ChatState, FigmakeApi, SessionState } from "../contracts.js";
import { createAttachStrip, messageThumbs } from "./attach.js";
import { diffPanel } from "./diff.js";
import { h, icon, nodes, type Child } from "./dom.js";
import { chipText, modelLocked } from "./modelMenu.js";

/* The conversation panel. Draws ChatState + SessionState; every action goes through window.figmake.
   All text is added as text nodes; the only tags ever created are the ones listed in `inline` and `blocks`. */

export interface ChatHost {
  api: FigmakeApi;
  mod: string;
  /** Confirms undoing an older change (and everything after it). */
  confirmUndo(index: number): void;
  openSettings(): void;
  /** Opens the model menu next to `anchor` (the AI chip, or the button on a model error). */
  openModelMenu(anchor: HTMLElement): void;
  report(): void;
  collapse(): void;
  toast(text: string): void;
}

const AGENTS: Record<AgentChoice, { name: string; glyph: string }> = { claude: { name: "Claude", glyph: "claude" }, codex: { name: "ChatGPT", glyph: "gpt" } };
const SUGGESTIONS = ["Make the buttons rounded", "Try a darker theme", "Fix any layout issues"];
const PINNED_SLACK = 56;

const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};
const fullTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

// ---- markdown -> DOM (text nodes and a fixed set of tags only) ----

function inline(list: Inline[]): Node[] {
  return list.map((n): Node => {
    if (n.t === "text") return document.createTextNode(n.v);
    if (n.t === "code") return h("code", {}, n.v);
    return h(n.t === "strong" ? "strong" : "em", {}, ...inline(n.v));
  });
}

export function renderMarkdown(text: string): HTMLElement {
  const root = h("div", { class: "md" });
  for (const b of parseMarkdown(text)) {
    if (b.t === "p") root.append(h("p", {}, ...inline(b.v)));
    else if (b.t === "pre") root.append(h("pre", {}, h("code", {}, b.v)));
    else if (b.t === "ul") root.append(h("ul", {}, ...b.v.map((item) => h("li", {}, ...inline(item)))));
    else root.append(h("ol", { start: b.start }, ...b.v.map((item) => h("li", {}, ...inline(item)))));
  }
  return root;
}

const textOf = (m: ChatMessage): string => (m.role === "user" ? m.text : m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n"));

export interface ChatPanel {
  el: HTMLElement;
  setChat(chat: ChatState): void;
  setSession(session: SessionState): void;
  focusComposer(): void;
  /** True when the composer has focus (so global shortcuts can leave typing alone). */
  composerFocused(): boolean;
}

export function createChatPanel(host: ChatHost): ChatPanel {
  const { api } = host;
  let chat: ChatState = { projectKey: null, messages: [], active: false, fresh: false };
  let sess: SessionState | null = null;
  const openActs = new Set<string>();
  const openDiffs = new Set<string>();
  const diffs = new Map<string, ChangedFile[] | "loading">();
  const cache = new Map<string, { el: HTMLElement; sig: string }>();
  let pinned = true;
  let recall = -1;
  let draft = "";
  let lastCount = 0;

  // ---- skeleton ----
  const newBtn = h("button", { type: "button", class: "btn icon quiet-icon", "aria-label": "New chat", title: "New chat", onclick: () => void api.newChat() }, icon("compose"));
  const hideBtn = h("button", { type: "button", class: "btn icon quiet-icon", "aria-label": "Hide chat", title: `Hide chat (${host.mod}J)`, onclick: () => host.collapse() }, icon("panel"));
  const head = h("header", { class: "chat-h" }, h("h2", {}, "Chat"), h("span", { class: "sp" }), newBtn, hideBtn);

  const thread = h("div", { class: "thread", role: "log", "aria-live": "polite", "aria-relevant": "additions", "aria-label": "Conversation", tabindex: "0" });
  const jump = h("button", { type: "button", class: "jump", hidden: true, onclick: () => scrollToEnd(true) }, icon("down", true), "Jump to latest");
  const wrap = h("div", { class: "thread-wrap" }, thread, jump);

  const ta = h("textarea", { class: "ta", rows: "1", "aria-label": "Message", spellcheck: "true", autocomplete: "off", placeholder: "Describe a change…" });
  const agentChip = h("button", { type: "button", class: "agent-chip", "aria-haspopup": "menu", onclick: () => (sess?.agent ? host.openModelMenu(agentChip) : host.openSettings()) });
  const kbd = h("span", { class: "kbd", "aria-hidden": "true", hidden: true }, "↵");
  const sendBtn = h("button", { type: "button", class: "sendbtn", "aria-label": "Send", title: "Send (Enter)", onclick: () => submit() }, icon("up"));
  const stopBtn = h("button", { type: "button", class: "sendbtn stop", "aria-label": "Stop", title: "Stop (Esc)", hidden: true, onclick: () => void api.cancel() }, icon("stop"));
  const strip = createAttachStrip(api, () => syncComposer());
  const cbox = h("div", { class: "cbox" }, strip.el, ta, h("div", { class: "crow" }, strip.button, agentChip, h("span", { class: "sp" }), kbd, sendBtn, stopBtn));
  const hint = h("p", { class: "chint", "aria-hidden": "true" }, "Enter to send · Shift Enter for a new line");
  const composer = h("footer", { class: "composer" }, cbox, hint);
  const el = h("aside", { class: "chat", "aria-label": "Chat with your AI helper" }, head, wrap, composer);
  strip.wire(ta, el, () => !ta.disabled);

  // ---- scrolling ----
  const atEnd = (): boolean => thread.scrollHeight - thread.scrollTop - thread.clientHeight <= PINNED_SLACK;
  function scrollToEnd(force = false): void {
    if (force) pinned = true;
    if (pinned) thread.scrollTop = thread.scrollHeight;
    jump.hidden = pinned;
  }
  // Only the person scrolling away un-pins the thread; growth of the content never does.
  let userAt = 0;
  for (const type of ["wheel", "touchmove", "keydown", "pointerdown"]) thread.addEventListener(type, () => (userAt = Date.now()), { passive: true });
  thread.addEventListener("scroll", () => {
    if (atEnd()) pinned = true;
    else if (Date.now() - userAt < 1000) pinned = false;
    jump.hidden = pinned;
  });
  new ResizeObserver(() => scrollToEnd()).observe(thread);

  // ---- composer ----
  const userPrompts = (): string[] => chat.messages.filter((m) => m.role === "user").map((m) => m.text).reverse();
  function grow(): void {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 184)}px`;
  }
  function submit(): void {
    const text = ta.value.trim();
    const attachments = strip.items();
    if ((!text && attachments.length === 0) || strip.busy() || !sess || ta.disabled || chat.active) return;
    ta.value = "";
    strip.clear();
    recall = -1;
    grow();
    pinned = true;
    void api.ask(text, attachments);
    syncComposer();
  }
  ta.addEventListener("input", () => {
    recall = -1;
    grow();
    syncComposer();
  });
  ta.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "ArrowUp" && (ta.value === "" || recall >= 0) && ta.selectionStart === 0) {
      const list = userPrompts();
      if (!list.length) return;
      e.preventDefault();
      if (recall < 0) draft = ta.value;
      recall = Math.min(recall + 1, list.length - 1);
      ta.value = list[recall] ?? "";
      grow();
      syncComposer();
    } else if (e.key === "ArrowDown" && recall >= 0 && ta.selectionEnd === ta.value.length) {
      e.preventDefault();
      recall -= 1;
      ta.value = recall < 0 ? draft : (userPrompts()[recall] ?? "");
      grow();
      syncComposer();
    }
  });

  function syncComposer(): void {
    const s = sess;
    if (!s) return;
    const turnError = s.phase === "error" && chat.messages.at(-1)?.status === "error";
    const setup = !chat.active && (s.phase === "connecting" || s.phase === "preparing" || s.phase === "sending");
    const blocked = !chat.active && !setup && s.phase !== "ready" && !turnError;
    const was = ta.disabled;
    ta.disabled = setup || blocked;
    ta.placeholder = setup ? (s.phase === "sending" ? "Sending to Figma…" : "Getting things ready…") : blocked ? "Finish the step in the window to keep going" : chat.active ? "Working… you can type your next message" : "Describe a change, like “make the buttons rounded”";
    if (was && !ta.disabled && document.activeElement === document.body) ta.focus();
    const agent = s.agent ? AGENTS[s.agent] : null;
    const model = s.model ?? null;
    const locked = modelLocked(s.phase, chat.active);
    agentChip.replaceChildren(icon(agent?.glyph ?? "sparkle", true), agent && s.agent ? chipText(agent.name, s.agent, model) : "Choose AI", icon("chev-d", true));
    agentChip.setAttribute("aria-label", agent && s.agent ? `AI helper: ${chipText(agent.name, s.agent, model)}. Change model or AI` : "AI helper: not chosen. Change in Settings");
    agentChip.title = locked && s.agent ? "Changes apply from your next message" : s.agent ? "Change model or AI helper" : "Change AI helper in Settings";
    agentChip.disabled = locked && Boolean(s.agent);
    sendBtn.hidden = chat.active;
    stopBtn.hidden = !chat.active;
    strip.setDisabled(ta.disabled);
    const ready = !ta.disabled && !chat.active && !strip.busy() && (ta.value.trim().length > 0 || strip.items().length > 0);
    sendBtn.disabled = !ready;
    kbd.hidden = !ready;
    cbox.classList.toggle("off", ta.disabled);
    newBtn.disabled = chat.active || chat.messages.length === 0 || s.phase !== "ready";
  }

  // ---- messages ----
  function copyButton(m: ChatMessage): HTMLElement {
    const b = h("button", { type: "button", class: "mact", "aria-label": "Copy message", title: "Copy", onclick: () => {
      void api.copyText(textOf(m));
      b.replaceChildren(icon("check", true));
      window.setTimeout(() => b.replaceChildren(icon("copy", true)), 1400);
    } }, icon("copy", true));
    return b;
  }

  const stamp = (m: ChatMessage): HTMLElement => h("time", { class: "stamp", datetime: m.at, title: fullTime(m.at) }, clock(m.at));
  const actions = (m: ChatMessage): HTMLElement => h("div", { class: "mactions" }, stamp(m), textOf(m) ? copyButton(m) : null);

  function actGroup(m: ChatMessage, i: number, items: Extract<ChatPart, { type: "activity" }>["items"]): HTMLElement {
    const key = `${m.id}:${i}`;
    // While the AI is still working, its newest group is open and read-only so progress is always visible.
    const livePart = m.status === "streaming" && m.parts.reduce((last, p, n) => (p.type === "activity" ? n : last), -1) === i;
    const open = livePart || openActs.has(key);
    const icn = (kind: string): ReturnType<typeof icon> => icon(kind === "look" ? "search" : kind === "edit" ? "pencil" : kind === "add" ? "plus" : kind === "check" ? "check" : "sparkle", true);
    if (livePart) {
      const shown = items.slice(-LIVE_ITEMS);
      return h("div", { class: "acts open lv-acts" }, h("div", { class: "lv-acts-h" }, activitySummary(items)), h("ul", { class: "acts-list lv-acts-list", "aria-label": "What the AI is doing" }, ...shown.map((it) => h("li", { class: it.kind }, icn(it.kind), it.label))));
    }
    const toggle = h("button", { type: "button", class: "acts-t", "data-fk": `act-${key}`, "aria-expanded": String(open), onclick: () => {
      if (openActs.has(key)) openActs.delete(key);
      else openActs.add(key);
      draw();
    } }, icon("chev-r", true), h("span", { class: "acts-l" }, activitySummary(items)));
    const list = open ? h("ul", { class: "acts-list" }, ...items.map((it) => h("li", { class: it.kind }, icn(it.kind), it.label))) : null;
    return h("div", { class: `acts${open ? " open" : ""}` }, toggle, list);
  }

  function changeIndex(c: ChatChange): number {
    return sess ? sess.changeIds.indexOf(c.turnId) : -1;
  }

  function diffKey(c: ChatChange): string {
    return `${c.turnId}|${sess?.changeIds.join(",") ?? ""}`;
  }

  function changeCard(c: ChatChange, tail: boolean): HTMLElement {
    const idx = changeIndex(c);
    const live = c.fate === "active" && idx >= 0;
    const open = openDiffs.has(c.turnId) && live;
    const idle = sess?.phase === "ready";
    const chips = c.files.slice(0, 4).map((f) => h("span", { class: `fchip ${f.status}`, title: f.status }, icon(f.status === "added" ? "plus" : f.status === "removed" ? "trash" : "pencil", true), f.name));
    if (c.files.length > 4) chips.push(h("span", { class: "fchip more" }, `+${c.files.length - 4} more`));
    const note = c.fate === "undone" ? h("span", { class: "cnote undone" }, icon("undo", true), "Undone") : c.fate === "sent" ? h("span", { class: "cnote sent" }, icon("check", true), "Sent to Figma") : c.previewUpdated ? h("span", { class: "cnote" }, icon("check", true), "Preview updated") : null;
    const view = live
      ? h("button", { type: "button", class: "plain quiet", "data-fk": `view-${c.turnId}`, "aria-expanded": String(open), onclick: () => {
          if (openDiffs.has(c.turnId)) openDiffs.delete(c.turnId);
          else {
            openDiffs.add(c.turnId);
            const key = diffKey(c);
            if (!diffs.has(key)) {
              diffs.set(key, "loading");
              void api.describeChange(idx).then((files) => diffs.set(key, files)).catch(() => diffs.set(key, [])).finally(draw);
            }
          }
          draw();
        } }, icon(open ? "chev-d" : "chev-r", true), "View changes")
      : null;
    const undo = live ? h("button", { type: "button", class: "plain quiet", disabled: !idle, "aria-label": `Undo: ${c.summary}`, onclick: () => (idx === (sess?.changeIds.length ?? 0) - 1 ? void api.undo() : host.confirmUndo(idx)) }, icon("undo", true), "Undo") : null;
    const body = open ? diffPanel((() => { const d = diffs.get(diffKey(c)); return Array.isArray(d) ? d : null; })()) : null;
    return h(
      "section",
      { class: `chcard ${c.fate}${tail ? " last" : ""}`, "aria-label": "Change made" },
      h("div", { class: "chcard-top" }, h("span", { class: "tick" }, icon(c.fate === "undone" ? "undo" : "pencil", true)), h("div", { class: "chcard-t" }, h("p", { class: "chcard-title" }, c.summary), chips.length ? h("div", { class: "fchips" }, ...chips) : null)),
      h("div", { class: "chcard-foot" }, note, h("span", { class: "sp" }), view, undo),
      body,
    );
  }

  const openErrs = new Set<string>();

  function assistant(m: ChatMessage, isLast: boolean): HTMLElement {
    const kids: Child[] = [];
    m.parts.forEach((p, i) => kids.push(p.type === "text" ? renderMarkdown(p.text) : actGroup(m, i, p.items)));
    if (m.change) kids.push(changeCard(m.change, m.parts.length > 0));
    if (m.status === "stopped") kids.push(h("p", { class: "snote" }, icon("stop", true), "Stopped. Nothing was changed."));
    if (m.status === "error") {
      const live = isLast && sess?.phase === "error";
      const lines = m.error?.details ?? [];
      const more = lines.length > 0 ? h("details", { class: "errdetails", open: openErrs.has(m.id) ? "" : null, ontoggle: (e: Event) => { if ((e.currentTarget as HTMLDetailsElement).open) openErrs.add(m.id); else openErrs.delete(m.id); } }, h("summary", {}, "Show details"), h("pre", { class: "errlog", tabindex: "0", "aria-label": "Recent output" }, lines.join("\n"))) : null;
      kids.push(
        h("div", { class: "errmsg", role: live ? "alert" : null }, icon("warn"), h("div", { class: "et" }, h("p", {}, m.error?.message ?? "Something went wrong."), more, live ? h("div", { class: "eacts" }, m.error?.code === "agent_model_unavailable" ? h("button", { type: "button", class: "btn primary sm", "aria-haspopup": "menu", onclick: (e: Event) => host.openModelMenu(e.currentTarget as HTMLElement) }, "Choose model") : h("button", { type: "button", class: "btn primary sm", onclick: () => void api.retry() }, m.error?.code === "agent_signin_required" ? "Sign in" : "Try again"), h("button", { type: "button", class: "btn sm", onclick: () => host.report() }, "Report")) : null)),
      );
    }
    return h("article", { class: `msg assistant ${m.status}`, "data-id": m.id }, h("span", { class: "av", "aria-hidden": "true" }, icon("mark")), h("div", { class: "mbody" }, h("span", { class: "sr-only" }, "Assistant: "), ...nodes(...kids), m.status === "error" ? null : actions(m)));
  }

  function user(m: ChatMessage): HTMLElement {
    return h("article", { class: "msg user", "data-id": m.id }, h("div", { class: "mbody" }, h("span", { class: "sr-only" }, "You: "), ...nodes(messageThumbs(api, m.attachments ?? []), m.text ? h("div", { class: "bubble" }, m.text) : null), actions(m)));
  }

  function sigOf(m: ChatMessage, isLast: boolean): string {
    const opens = [...openActs].filter((k) => k.startsWith(`${m.id}:`)).join(",");
    const c = m.change;
    const dv = c ? `${openDiffs.has(c.turnId)}|${changeIndex(c)}|${diffs.get(diffKey(c)) === "loading" ? "loading" : Array.isArray(diffs.get(diffKey(c))) ? "d" : "none"}|${sess?.phase === "ready"}|${sess?.changeIds.length ?? 0}` : "";
    // The live line, plan and clock are drawn by the working row, so they never redraw the message.
    const stable = JSON.stringify(m, (k, v: unknown) => (k === "now" || k === "plan" || k === "startedAt" ? undefined : v));
    return `${stable}#${opens}#${dv}#${isLast && sess?.phase === "error"}`;
  }

  // ---- working row, empty state ----
  const LIVE_ITEMS = 8;

  /** "12s", "1m 05s". */
  function elapsed(since: number): string {
    const sec = Math.max(0, Math.floor((Date.now() - since) / 1000));
    return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
  }

  let lvTimer: number | null = null;
  function syncTimer(): void {
    const tick = (): void => {
      for (const t of Array.from(thread.querySelectorAll<HTMLElement>(".lv-time[data-since]"))) t.textContent = elapsed(Number(t.getAttribute("data-since")));
    };
    if (chat.active && lvTimer === null) lvTimer = window.setInterval(tick, 1000);
    else if (!chat.active && lvTimer !== null) {
      window.clearInterval(lvTimer);
      lvTimer = null;
    }
    tick();
  }

  function workingRow(): HTMLElement {
    const s = sess;
    const last = chat.messages.at(-1);
    const live = last?.role === "assistant" && last.status === "streaming" ? last : null;
    const label = s?.phase === "preparing" ? `Getting ${s.agent ? AGENTS[s.agent].name : "your AI helper"} ready` : (live?.now ?? "Working");
    const plan = live?.plan ?? [];
    const steps = plan.length
      ? h("ul", { class: "lv-plan", "aria-label": "Steps" }, ...plan.map((p) => h("li", { class: `lv-step ${p.state}` }, p.state === "done" ? icon("check-b", true) : h("span", { class: "lv-mark", "aria-hidden": "true" }), h("span", { class: "sr-only" }, p.state === "done" ? "Done: " : p.state === "active" ? "In progress: " : "To do: "), h("span", { class: "lv-step-t" }, p.text))))
      : null;
    const time = live?.startedAt ? h("span", { class: "lv-time", "data-since": String(live.startedAt) }, elapsed(live.startedAt)) : null;
    return h(
      "div",
      { class: "msg assistant working", role: "status", "data-id": "working" },
      h("span", { class: "av", "aria-hidden": "true" }, icon("mark")),
      h("div", { class: "mbody lv-wrap" }, h("div", { class: "lv-main" }, h("span", { class: "dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")), h("span", { class: "lv-now" }, label), time), steps),
    );
  }

  function emptyState(): HTMLElement {
    const s = sess;
    const setup = s !== null && (s.phase === "connecting" || s.phase === "preparing");
    const name = s?.projectName;
    return h(
      "div",
      { class: "empty" },
      h("span", { class: "av big", "aria-hidden": "true" }, icon("mark")),
      h("h3", {}, chat.fresh ? "New chat. What's next?" : "What would you like to change?"),
      h("p", {}, name ? `Tell me what to do with ${name}, the way you'd tell a teammate. I'll make the change and show you the result.` : "Describe a change the way you'd tell a teammate. I'll make it and show you the result."),
      setup
        ? h("p", { class: "setup", role: "status" }, h("span", { class: "spin", "aria-hidden": "true" }), "Getting things ready…")
        : s?.phase !== "ready"
        ? null
        : h("div", { class: "chips", role: "group", "aria-label": "Suggestions" }, ...SUGGESTIONS.map((t) => h("button", { type: "button", class: "sugg", onclick: () => { ta.value = t; recall = -1; grow(); syncComposer(); ta.focus(); } }, icon("sparkle", true), t))),
    );
  }

  // ---- draw (keyed, so a streaming message never re-announces or resets scroll) ----
  function draw(): void {
    const focusKey = document.activeElement instanceof HTMLElement && thread.contains(document.activeElement) ? document.activeElement.getAttribute("data-fk") : null;
    const desired: HTMLElement[] = [];
    const seen = new Set<string>();
    const msgs = chat.messages.filter((m) => !(m.role === "assistant" && m.status === "streaming" && m.parts.length === 0));
    msgs.forEach((m, i) => {
      const isLast = i === msgs.length - 1;
      const sig = sigOf(m, isLast);
      const hit = cache.get(m.id);
      seen.add(m.id);
      if (hit && hit.sig === sig) return void desired.push(hit.el);
      const next = m.role === "user" ? user(m) : assistant(m, isLast);
      cache.set(m.id, { el: next, sig });
      desired.push(next);
    });
    for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id);
    if (chat.messages.length === 0) desired.push(emptyState());
    if (chat.active) desired.push(workingRow());
    desired.forEach((node, i) => {
      if (thread.children[i] !== node) thread.insertBefore(node, thread.children[i] ?? null);
    });
    while (thread.children.length > desired.length) thread.lastElementChild?.remove();
    thread.setAttribute("aria-busy", String(chat.active && chat.messages.at(-1)?.status === "streaming"));
    if (focusKey && !(document.activeElement instanceof HTMLElement && thread.contains(document.activeElement))) {
      for (const node of Array.from(thread.querySelectorAll<HTMLElement>("[data-fk]"))) if (node.getAttribute("data-fk") === focusKey) node.focus();
    }
    const grew = chat.messages.length > lastCount;
    if (grew && chat.messages.at(-1)?.role === "user") pinned = true;
    lastCount = chat.messages.length;
    scrollToEnd();
    syncComposer();
    syncTimer();
  }

  return {
    el,
    setChat(next) {
      const switched = next.projectKey !== chat.projectKey;
      chat = next;
      if (switched) {
        cache.clear();
        openActs.clear();
        openDiffs.clear();
        diffs.clear();
        pinned = true;
        recall = -1;
        strip.clear();
      }
      draw();
    },
    setSession(next) {
      sess = next;
      draw();
    },
    focusComposer() {
      if (!ta.disabled) ta.focus();
    },
    composerFocused: () => document.activeElement === ta,
  };
}

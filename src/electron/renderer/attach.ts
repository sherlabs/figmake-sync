import { MAX_IMAGES, MAX_IMAGE_BYTES, MSG_NOT_PICTURE, MSG_TOO_BIG, MSG_TOO_MANY } from "../../app/attachmentKinds.js";
import type { Attachment, FigmakeApi } from "../contracts.js";
import { dataImage, h, icon } from "./dom.js";

/* The composer's attachment strip and the thumbnails in sent messages. Everything here is keyed on `Attachment.kind`
   so a new kind (for example a picked page element) only adds a case to `chipBody` / `thumbBody`; the strip, the
   remove button, the limits note and the send request are shared. The window never touches files: it hands bytes to
   main and gets names back. */

const PICTURE_TYPES = "image/png,image/jpeg,image/webp,image/gif";

/** Display data for one attachment, fetched once per name. null = the file is gone. */
const previews = new Map<string, Promise<string | null>>();
export function previewOf(api: FigmakeApi, a: Attachment): Promise<string | null> {
  const key = `${a.kind}:${a.name}`;
  let hit = previews.get(key);
  if (!hit) {
    hit = api.readAttachment(a.name).catch(() => null);
    previews.set(key, hit);
  }
  return hit;
}

function missing(): HTMLElement {
  return h("span", { class: "thumb gone", role: "img", "aria-label": "Picture no longer available", title: "Picture no longer available" }, icon("image", true), h("span", {}, "Picture no longer available"));
}

/** Body of one thumbnail, by kind. */
function thumbBody(api: FigmakeApi, a: Attachment, size: "chip" | "msg"): HTMLElement {
  const box = h("span", { class: `thumb ${size}` });
  box.append(h("span", { class: "thumb-ph", "aria-hidden": "true" }));
  void previewOf(api, a).then((url) => {
    if (!url) return box.replaceWith(missing());
    box.replaceChildren(dataImage(url, "Attached picture"));
  });
  return box;
}

/** The pictures of a sent message, for its bubble. */
export function messageThumbs(api: FigmakeApi, attachments: readonly Attachment[]): HTMLElement | null {
  if (attachments.length === 0) return null;
  return h("div", { class: "thumbs", role: "list", "aria-label": "Attached pictures" }, ...attachments.map((a) => h("div", { role: "listitem" }, thumbBody(api, a, "msg"))));
}

/** Cheap content fingerprint, so pasting the same picture twice adds it once. */
function fingerprint(bytes: Uint8Array): string {
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i += 1) hash = Math.imul(hash ^ (bytes[i] ?? 0), 16777619) >>> 0;
  return `${bytes.length}:${hash}`;
}

interface Item {
  attachment: Attachment;
  print: string;
}

export interface AttachStrip {
  /** The strip itself (thumbnails and the notice), for the top of the composer box. */
  el: HTMLElement;
  /** The paperclip button (opens the file picker). */
  button: HTMLButtonElement;
  /** Wires paste on the text box and drag-and-drop on the whole panel. */
  wire(input: HTMLTextAreaElement, panel: HTMLElement, enabled: () => boolean): void;
  add(files: readonly Blob[]): Promise<void>;
  items(): Attachment[];
  /** True while a picture is still being saved. */
  busy(): boolean;
  /** Forgets everything in the strip (after a send or a project change). */
  clear(): void;
  setDisabled(off: boolean): void;
}

export function createAttachStrip(api: FigmakeApi, onChange: () => void): AttachStrip {
  let list: Item[] = [];
  let pending = 0;
  let disabled = false;
  let noteTimer = 0;
  const note = h("p", { class: "anote", role: "alert", hidden: true });
  const row = h("div", { class: "athumbs", role: "list", "aria-label": "Attached pictures", hidden: true });
  const el = h("div", { class: "astrip" }, row, note);
  const picker = h("input", { type: "file", accept: PICTURE_TYPES, multiple: true, class: "sr-only", tabindex: "-1", "aria-hidden": "true" });
  const button = h("button", { type: "button", class: "attbtn", "aria-label": "Attach a picture", title: "Attach a picture", onclick: () => picker.click() }, icon("clip", true));
  picker.addEventListener("change", () => {
    void add(Array.from(picker.files ?? []));
    picker.value = "";
  });

  function say(text: string): void {
    note.textContent = text;
    note.hidden = !text;
    window.clearTimeout(noteTimer);
    if (text) noteTimer = window.setTimeout(() => say(""), 6000);
  }

  function draw(): void {
    row.hidden = list.length === 0;
    row.replaceChildren(
      ...list.map((it, i) =>
        h("div", { class: "achip", role: "listitem" },
          thumbBody(api, it.attachment, "chip"),
          h("button", { type: "button", class: "achip-x", "aria-label": `Remove picture ${i + 1}`, title: "Remove", onclick: () => remove(it) }, icon("x", true))),
      ),
    );
    button.disabled = disabled || list.length + pending >= MAX_IMAGES;
    onChange();
  }

  function remove(it: Item): void {
    list = list.filter((x) => x !== it);
    void api.discardAttachment(it.attachment.name);
    say("");
    draw();
  }

  async function addOne(file: Blob): Promise<void> {
    if (file.size > MAX_IMAGE_BYTES) return say(MSG_TOO_BIG);
    if (file.size === 0) return say(MSG_NOT_PICTURE);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      return say(MSG_NOT_PICTURE); // a folder or an unreadable file
    }
    const print = fingerprint(bytes);
    if (list.some((x) => x.print === print)) return; // the same picture again
    const result = await api.attachImage(bytes).catch(() => null);
    if (!result?.ok) return say(result?.message ?? MSG_NOT_PICTURE);
    list = [...list, { attachment: result.attachment, print }];
    say("");
  }

  async function add(files: readonly Blob[]): Promise<void> {
    if (files.length === 0) return;
    for (const file of files) {
      if (list.length + pending >= MAX_IMAGES) {
        say(MSG_TOO_MANY);
        break;
      }
      pending += 1;
      draw();
      try {
        await addOne(file);
      } finally {
        pending -= 1;
      }
    }
    draw();
  }

  function wire(input: HTMLTextAreaElement, panel: HTMLElement, enabled: () => boolean): void {
    // Paste: a picture on the clipboard (a macOS screenshot, a copied image) becomes an attachment; text pastes as usual.
    input.addEventListener("paste", (e) => {
      const data = e.clipboardData;
      if (!data) return;
      const pics = Array.from(data.files).filter((f) => f.type.startsWith("image/"));
      if (pics.length === 0 || data.getData("text/plain")) return;
      e.preventDefault();
      if (enabled()) void add(pics);
    });
    // Drop: show a hint while files are over the panel.
    let depth = 0;
    const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const hint = h("div", { class: "drophint", "aria-hidden": "true" }, icon("image"), h("span", {}, "Drop pictures to add them"));
    panel.append(hint);
    const stop = (): void => {
      depth = 0;
      panel.classList.remove("dropping");
    };
    panel.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      panel.classList.add("dropping");
    });
    panel.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = enabled() ? "copy" : "none";
    });
    panel.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) stop();
    });
    panel.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      stop();
      if (enabled()) void add(Array.from(e.dataTransfer?.files ?? []));
    });
    // A file dropped anywhere else must never navigate the window to it.
    for (const type of ["dragover", "drop"]) window.addEventListener(type, (e) => { if (e instanceof DragEvent && hasFiles(e)) e.preventDefault(); });
  }

  return {
    el: h("div", { class: "astrip-wrap" }, el, picker),
    button,
    wire,
    add,
    items: () => list.map((x) => x.attachment),
    busy: () => pending > 0,
    clear() {
      list = [];
      say("");
      draw();
    },
    setDisabled(off) {
      disabled = off;
      button.disabled = off || list.length + pending >= MAX_IMAGES;
    },
  };
}

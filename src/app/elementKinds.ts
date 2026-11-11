/* Pure, browser-safe description of a page element the person picked in the preview (the window imports this too).
   Everything in here came from a web page, so it is untrusted data: it is capped, stripped of control characters, and
   only ever shown as text or passed to the AI labelled as page content. */

export const ELEMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Pictures and picked elements together: a message carries at most this many chips. */
export const MAX_ATTACHMENTS = 5;
export const MSG_TOO_MANY_ITEMS = "You can add up to 5 pictures or elements to one message.";
export const ELEMENT_HINT = "Tell me what to change about this";
export const MSG_PICK_FAILED = "Couldn't pick that element. Try another one.";

export const LIMITS = {
  tag: 24,
  id: 80,
  className: 40,
  classes: 8,
  selector: 300,
  text: 200,
  attr: 120,
  styleValue: 60,
  page: 200,
  component: 60,
  components: 3,
  file: 200,
} as const;

/** The only attributes that are read from the page. */
export const ELEMENT_ATTRS = ["aria-label", "role", "alt", "href", "placeholder", "type"] as const;
/** The only computed styles that are read from the page. */
export const ELEMENT_STYLES = ["font-size", "color", "background-color", "display", "width", "height", "padding", "margin"] as const;

export interface ElementInfo {
  tag: string;
  id?: string | undefined;
  classes: string[];
  selector: string;
  text: string;
  attrs: Record<string, string>;
  /** CSS pixels, as the page itself measures them (the preview's scaling is already undone). */
  box: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
  /** Path of the page, without query or hash. */
  page: string;
  /** Nearest component names first (React). */
  components: string[];
  /** Where the nearest component lives, relative to the project, when it could be found. */
  source?: { file: string; line?: number | undefined } | undefined;
}

/** A picked element attached to a message. `image` is the name of the cropped screenshot in the attachments folder. */
export type ElementAttachment = { kind: "element"; id: string; image?: string | undefined; info: ElementInfo };

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/gu;

/** Page text made safe to show: control and direction characters gone, whitespace collapsed, cut to `max`. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const t = value.replace(CONTROL, " ").replace(/\s+/gu, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…` : t;
}

/** The short name a chip shows: `<button> "Send"`, or the component, or just the tag. Never throws, even on a damaged record. */
export function elementLabel(info: ElementInfo | null | undefined): string {
  const tag = `<${typeof info?.tag === "string" && info.tag ? info.tag : "element"}>`;
  const words = cleanText(info?.text, 28);
  if (words) return `${tag} "${words}"`;
  const attrs = info?.attrs && typeof info.attrs === "object" ? info.attrs : {};
  const named = cleanText(attrs["aria-label"] ?? attrs["alt"] ?? attrs["placeholder"], 28);
  if (named) return `${tag} "${named}"`;
  const comp = Array.isArray(info?.components) ? info.components[0] : undefined;
  return typeof comp === "string" && comp ? comp : tag;
}

/** The saved picture of an attachment, if it has one. */
export const attachmentImage = (a: { kind: "image"; name: string } | ElementAttachment): string | null => (a.kind === "image" ? a.name : (a.image ?? null));

/**
 * A deliberately tiny markdown reader for the AI's plain-language replies.
 *
 * It produces a small tree (paragraphs, lists, code blocks; bold, italic, inline code, text) that the
 * renderer turns into DOM nodes one by one. There is no HTML, no links and no images: anything else
 * (including `<img onerror=…>` and `[x](javascript:…)`) stays literal text. Pure, so it runs under node.
 */

export type Inline = { t: "text"; v: string } | { t: "strong"; v: Inline[] } | { t: "em"; v: Inline[] } | { t: "code"; v: string };

export type Block =
  | { t: "p"; v: Inline[] }
  | { t: "ul"; v: Inline[][] }
  | { t: "ol"; v: Inline[][]; start: number }
  | { t: "pre"; v: string };

/** Inline spans: `code`, **bold**, *italic* / _italic_. Unclosed markers stay as written (text still streaming). */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = (): void => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: "code", v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (ch === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "strong", v: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
      // Still being written ("**nothing else" with no closing yet): show it bold instead of with stray stars.
      if (end === -1 && src[i + 2] !== undefined && !/\s/u.test(src[i + 2] as string)) {
        flush();
        out.push({ t: "strong", v: parseInline(src.slice(i + 2)) });
        i = src.length;
        continue;
      }
    } else if ((ch === "*" || ch === "_") && src[i + 1] !== ch && src[i + 1] !== " " && (ch === "*" || !/\w/u.test(src[i - 1] ?? " "))) {
      const end = src.indexOf(ch, i + 1);
      if (end > i + 1 && src[end - 1] !== " " && (ch === "*" || !/\w/u.test(src[end + 1] ?? " "))) {
        flush();
        out.push({ t: "em", v: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

const UL = /^\s{0,3}[-*•]\s+(.*)$/u;
const OL = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/u;
const FENCE = /^\s{0,3}```/u;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/u;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = (): void => {
    if (para.length) blocks.push({ t: "p", v: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (FENCE.test(line)) {
      endPara();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i] as string)) {
        body.push(lines[i] as string);
        i += 1;
      }
      blocks.push({ t: "pre", v: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      endPara();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endPara();
      blocks.push({ t: "p", v: [{ t: "strong", v: parseInline(heading[1] ?? "") }] });
      continue;
    }
    const ul = UL.exec(line);
    const ol = ul ? null : OL.exec(line);
    if (ul || ol) {
      endPara();
      const ordered = Boolean(ol);
      const start = ol ? Number(ol[1]) : 1;
      const items: Inline[][] = [];
      let j = i;
      for (; j < lines.length; j += 1) {
        const m = ordered ? OL.exec(lines[j] as string) : UL.exec(lines[j] as string);
        if (!m) break;
        items.push(parseInline(ordered ? (m[2] ?? "") : (m[1] ?? "")));
      }
      blocks.push(ordered ? { t: "ol", v: items, start } : { t: "ul", v: items });
      i = j - 1;
      continue;
    }
    para.push(line.trim());
  }
  endPara();
  return blocks;
}

/** Plain text of a message, for copying: markdown markers are kept as the AI wrote them. */
export function plainText(src: string): string {
  return src.trim();
}

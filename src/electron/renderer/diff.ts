import type { ChangedFile, DiffRow } from "../contracts.js";
import { h, icon, splitPath, type Child } from "./dom.js";

/* Before/after view of the files one change touched. Pure drawing: the data comes from the session. */

function diffRow(r: DiffRow): HTMLElement {
  if (r.hunk) return h("div", { class: "hunk" }, r.hunk);
  const side = (cell: DiffRow["left"]): HTMLElement =>
    h("div", {}, h("span", { class: `n ${cell && cell.mark !== "same" ? cell.mark : cell ? "" : "emp"}` }, cell ? String(cell.n) : ""), h("span", { class: `c ${cell && cell.mark !== "same" ? cell.mark : cell ? "" : "emp"}` }, cell?.text ?? ""));
  return h("div", { class: r.left?.mark === "same" && r.right?.mark === "same" ? "dl same" : "dl" }, side(r.left), side(r.right));
}

export function fileBlock(f: ChangedFile): HTMLElement {
  const adds = f.rows.filter((r) => r.right?.mark === "add").length;
  const dels = f.rows.filter((r) => r.left?.mark === "del").length;
  const { dir, name } = splitPath(f.path);
  const letter = f.status === "added" ? "A" : f.status === "removed" ? "D" : "E";
  const body: Child[] = [];
  if (f.binary) body.push(h("p", { class: "diffnote" }, "This file isn't text, so there's nothing to compare."));
  else if (f.rows.length === 0) body.push(h("p", { class: "diffnote" }, "No visible differences."));
  else {
    body.push(h("div", { class: "diffcols" }, h("div", {}, icon("clock", true), "Before"), h("div", {}, icon("pencil", true), "After")), h("div", { class: "diffbody" }, ...f.rows.map(diffRow)));
    if (f.truncated) body.push(h("p", { class: "diffnote" }, "Showing the first part of this file."));
  }
  return h("div", { class: "dfile" }, h("div", { class: "diffhd" }, h("span", { class: `chip ${letter}`, title: f.status }, letter), h("span", { class: "path" }, h("span", { class: "dir" }, dir), name), h("span", { class: "lines" }, h("b", { class: "p" }, `+${adds}`), " ", h("b", { class: "m" }, `−${dels}`))), ...body);
}

export function diffPanel(files: ChangedFile[] | null): HTMLElement {
  const inner = files === null ? [h("p", { class: "diffnote" }, "Loading…")] : files.length === 0 ? [h("p", { class: "diffnote" }, "No file details to show.")] : files.map(fileBlock);
  return h("div", { class: "cdiff", role: "region", "aria-label": "What changed" }, ...inner);
}

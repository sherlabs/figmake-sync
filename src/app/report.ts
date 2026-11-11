import { z } from "zod";

import { ERROR_CODES, PHASES, type ErrorCode, type Phase } from "../electron/contracts.js";

/**
 * "Report" on an error screen: build a pre-filled GitHub issue the person reviews and submits themselves.
 * No token, no account, nothing is posted by the app. Only whitelisted structured fields and a log tail that
 * was sanitised when it was written ever reach the URL.
 */

export const ISSUE_REPO = "sherlabs/figmake-sync";
export const ISSUE_TEMPLATE = "bug_report.yml";
export const ISSUE_URL = `https://github.com/${ISSUE_REPO}/issues/new`;
/** Budget for the encoded query string. GitHub accepts about 8k; stay well under. */
export const MAX_QUERY_CHARS = 6000;
export const LOG_LINES_IN_URL = 40;
export const CLIPBOARD_NOTE = "Full diagnostics copied to clipboard — paste here.";

// ---------------------------------------------------------------------------
// Sanitiser
// ---------------------------------------------------------------------------

export interface SanitizeContext {
  /** Absolute home directory of the current user. */
  home?: string | undefined;
  /** Account / host names that must not appear. */
  usernames?: readonly string[] | undefined;
  /** Project names, folder names and file keys. */
  projectNames?: readonly string[] | undefined;
  /** Exact strings the person typed (prompts, links). */
  userTexts?: readonly string[] | undefined;
}

const MAX_LINE = 240;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function replaceLiterals(text: string, values: readonly string[] | undefined, min: number, replacement: string): string {
  let out = text;
  const list = [...new Set((values ?? []).map((v) => v.trim()).filter((v) => v.length >= min))].sort((a, b) => b.length - a.length);
  for (const value of list) out = out.replace(new RegExp(escapeRe(value), "giu"), replacement);
  return out;
}

const TOKEN_PATTERNS: RegExp[] = [
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/gu, // JWT
  /\b(?:sk|pk|rk)-[\w-]{8,}/gu, // sk-..., sk-ant-...
  /\bgh[pousr]_[A-Za-z0-9]{16,}/gu,
  /\bgithub_pat_[\w]{16,}/gu,
  /\bxox[abprs]-[\w-]{8,}/gu,
  /\bfigd_[\w-]{8,}/gu,
  /\bAKIA[0-9A-Z]{12,}/gu,
  /\bAIza[\w-]{20,}/gu,
  /\bnpm_[A-Za-z0-9]{20,}/gu,
];

/** Masks only secret-shaped tokens (keys, JWTs, bearer headers). For local transcripts, where names and paths are fine. */
export function redactSecrets(input: string): string {
  let t = input.replace(/\bBearer\s+[\w.~+/=-]+/giu, "Bearer <token>");
  t = t.replace(/(["']?)\b([\w-]*(?:token|secret|passw(?:or)?d|api[_-]?key|apikey|credential)[\w-]*)\1(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/giu, "$2$3<redacted>");
  for (const re of TOKEN_PATTERNS) t = t.replace(re, "<token>");
  return t;
}

/** Removes anything that could identify the person, their files, their Figma file or their text. */
export function sanitizeText(input: string, ctx: SanitizeContext = {}): string {
  let t = input.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ");

  // What the person typed or pasted, verbatim.
  t = replaceLiterals(t, ctx.userTexts, 4, "<text>");

  // Cookies and auth headers: the whole value.
  t = t.replace(/\b(set-cookie|cookie|authorization|proxy-authorization|x-api-key)\s*:\s*[^\n]*/giu, "$1: <redacted>");
  t = t.replace(/\bBearer\s+[\w.~+/=-]+/giu, "Bearer <token>");
  t = t.replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/gu, "Basic <token>");

  // Figma links and ids, with or without a scheme.
  t = t.replace(/(?:https?:\/\/)?(?:[\w-]+\.)*figma\.com\/[^\s"'<>)\]}]+/giu, "<figma-link>");
  t = t.replace(/\b(?:file[_-]?key|file[_-]?id|node[_-]?id)\s*[=:]\s*["']?[\w:;-]+["']?/giu, "<figma-id>");

  // Other URLs: no credentials, no query, no fragment.
  t = t.replace(/(https?:\/\/)[^\s/@"'<>]+@/giu, "$1");
  t = t.replace(/(https?:\/\/[^\s?#"'<>)\]}]+)[?#][^\s"'<>)\]}]*/giu, "$1");

  // key=value secrets.
  t = t.replace(/(["']?)\b([\w-]*(?:token|secret|passw(?:or)?d|api[_-]?key|apikey|credential|session[_-]?id|cookie)[\w-]*)\1(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/giu, "$2$3<redacted>");

  // Emails.
  // The domain must end in a letters-only label, so npm's "name@1.0.0" is not mistaken for an address.
  t = t.replace(/[\w.+%-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}(?![\w-])/gu, "<email>");

  // Paths. The home directory first (exact, then the generic /Users, /home, C:\Users forms), then any other absolute path.
  const home = ctx.home?.replace(/[\\/]+$/u, "");
  if (home && home.length > 1) {
    const variants = [home, home.replaceAll("\\", "/"), home.replaceAll("/", "\\")];
    for (const v of new Set(variants)) {
      t = t.replace(new RegExp(`${escapeRe(v)}(?=[\\\\/])[^\\n"'<>()]*`, "giu"), "~/…");
      t = t.replace(new RegExp(`${escapeRe(v)}(?![\\w\\\\/-])`, "giu"), "~");
    }
  }
  t = t.replace(/(?<![\w.:/\\-])\/(?:Users|home)\/[^/\n"'<>()]+(?:\/[^\n"'<>()]*)?/gu, (m) => (/^\/(?:Users|home)\/[^/\n]+$/u.test(m) ? "~" : "~/…"));
  t = t.replace(/(?<![\w.:/\\-])[A-Za-z]:[\\/]+Users[\\/]+[^\\/\n"'<>()]+(?:[\\/][^\n"'<>()]*)?/giu, "~/…");
  t = t.replace(/(?<![\w.:/\\-])[A-Za-z]:[\\/][^\s"'<>)\]}:;,]*/gu, "<path>");
  t = t.replace(/(?<![\w.:/\\-])\\\\[^\s"'<>)\]}:;,]+/gu, "<path>");
  t = t.replace(/(?<![\w.:/\\<>-])(?:\/[\w@.+~ -]*[\w@.+~-]){2,}\/?|(?<![\w.:/\\<>-])\/(?:tmp|var|etc|opt|usr|private|Volumes|Applications|Library|root|mnt|srv|proc|dev|home|Users)(?:\/[^\s"'<>)\]}:;,]*)?/gu, "<path>");
  t = t.replace(/(?<![\w.:/\\<>-])~[\\/][^\s"'<>)\]}:;,]*/gu, "~/…");

  // Known token shapes, then long opaque strings (hex / base64 / base64url).
  for (const re of TOKEN_PATTERNS) t = t.replace(re, "<token>");
  t = t.replace(/\b[A-Fa-f0-9]{32,}\b/gu, "<token>");
  t = t.replace(/(?<![\w/+=-])(?=[A-Za-z_+-]*\d)(?=[\d_+-]*[A-Za-z])[A-Za-z0-9+_-]{32,}={0,2}(?![\w/+=-])/gu, "<token>");

  // Names.
  t = replaceLiterals(t, ctx.projectNames, 3, "<project>");
  for (const name of ctx.usernames ?? []) {
    const n = name.trim();
    if (n.length >= 3) t = t.replace(new RegExp(`(?<![\\w-])${escapeRe(n)}(?![\\w-])`, "giu"), "<user>");
  }

  return t.length > MAX_LINE ? `${t.slice(0, MAX_LINE)}…` : t;
}

/** Sanitises each line and drops empty ones. */
export function sanitizeLines(lines: readonly string[], ctx: SanitizeContext = {}): string[] {
  return lines.flatMap((l) => l.split(/\r?\n/u)).map((l) => sanitizeText(l, ctx).trimEnd()).filter((l) => l.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Ring buffer of sanitised lines (written to at log time)
// ---------------------------------------------------------------------------

export type HealOutcome = "healed" | "failed";

export class DiagnosticsLog {
  private lines: string[] = [];
  private heal = new Map<string, HealOutcome>();

  constructor(
    private readonly context: () => SanitizeContext,
    private readonly capacity = 200,
  ) {}

  push(message: string): void {
    const ctx = this.context();
    const stamp = new Date().toISOString().slice(11, 19);
    for (const line of sanitizeLines(message.split("\n").slice(0, 6), ctx)) this.lines.push(`${stamp} ${line}`);
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
  }

  /** Records only the key name and the outcome, never page content. */
  noteHeal(key: unknown, outcome: HealOutcome): void {
    if (typeof key === "string" && /^[A-Za-z][A-Za-z0-9]{0,39}$/u.test(key)) this.heal.set(key, outcome);
  }

  tail(count = this.capacity): string[] {
    return this.lines.slice(-count);
  }

  healSummary(): string[] {
    return [...this.heal].map(([key, outcome]) => `${key}: ${outcome}`);
  }
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export interface IssueInput {
  version: string;
  os: string;
  arch: string;
  electron?: string | undefined;
  phase: Phase;
  errorCode: ErrorCode;
  message: string;
  logTail: readonly string[];
  /** e.g. ["codeModeButton: healed"] */
  healOutlineSummary?: readonly string[] | undefined;
}

export interface Issue {
  title: string;
  /** Markdown with every section, log capped to what fits the URL. */
  body: string;
  /** The same content split into the issue form's field ids (what the URL actually carries). */
  fields: Record<"version" | "os" | "phase" | "error" | "log", string>;
  /** True when the log was cut to fit the URL; the full text then goes to the clipboard. */
  truncated: boolean;
  /** Everything, untrimmed. */
  fullText: string;
}

const TITLES: Record<ErrorCode, string> = {
  figma_signin_required: "Could not sign in to Figma",
  figma_ui_changed: "Figma's page did not look as expected",
  figma_unreachable: "Could not reach Figma",
  agent_failed: "The AI assistant did not respond",
  agent_signin_required: "The AI assistant is not signed in",
  agent_limit: "The AI assistant hit its usage limit",
  agent_unreachable: "Could not reach the AI assistant",
  runtime_install_failed: "Could not set up the AI assistant",
  preview_failed: "The project preview did not start",
  push_failed: "Some changes could not be sent to Figma",
  backup_failed: "Could not make a backup",
  undo_failed: "Could not undo a change",
  invalid_link: "A Figma Make link was not recognised",
  unknown: "Something went wrong",
};

export function issueTitle(code: ErrorCode): string {
  return `[${code}] ${TITLES[code]}`;
}

function section(fields: Issue["fields"], log: string): string {
  return [
    `### Version\n${fields.version}`,
    `### Operating system\n${fields.os}`,
    `### When it failed\n${fields.phase}`,
    `### Error\n${fields.error}`,
    `### Log\n${log}`,
  ].join("\n\n");
}

const fence = (lines: readonly string[]): string => `\`\`\`\n${lines.join("\n")}\n\`\`\``;

export function buildIssue(input: IssueInput, ctx: SanitizeContext = {}): Issue {
  const clean = (s: string): string => sanitizeText(s, ctx);
  const code = ERROR_CODES.includes(input.errorCode) ? input.errorCode : "unknown";
  const phase = PHASES.includes(input.phase) ? input.phase : "error";
  const all = sanitizeLines(input.logTail, ctx);
  const heal = (input.healOutlineSummary ?? []).filter((h) => /^[A-Za-z][A-Za-z0-9]{0,39}: (?:healed|failed)$/u.test(h));

  const base = {
    version: [`figmake-sync ${clean(input.version)}`, input.electron ? `Electron ${clean(input.electron)}` : ""].filter(Boolean).join(" · "),
    os: `${clean(input.os)} ${clean(input.arch)}`.trim(),
    phase,
    error: `${code}: ${clean(input.message)}`,
  };
  const logWith = (lines: readonly string[], note: string): string =>
    [note, lines.length ? fence(lines) : "", heal.length ? `Selector repair: ${heal.join(", ")}` : ""].filter(Boolean).join("\n");

  const full = logWith(all, "");
  const fullText = `${issueTitle(code)}\n\n${section({ ...base, log: full }, full)}`;

  let lines = all.slice(-LOG_LINES_IN_URL);
  const make = (kept: readonly string[], note: string): Issue["fields"] => ({ ...base, log: logWith(kept, note) });
  const size = (f: Issue["fields"]): number => issueQuery(issueTitle(code), f).length;
  let truncated = false;
  let fields = make(lines, "");
  while (size(fields) > MAX_QUERY_CHARS && lines.length > 0) {
    truncated = true;
    lines = lines.slice(Math.max(1, Math.ceil(lines.length / 4)));
    fields = make(lines, CLIPBOARD_NOTE);
  }
  if (truncated && lines.length === 0) fields = make([], CLIPBOARD_NOTE);
  return { title: issueTitle(code), body: section(fields, fields.log), fields, truncated, fullText };
}

function issueQuery(title: string, fields: Issue["fields"]): string {
  const params = new URLSearchParams({ template: ISSUE_TEMPLATE, title, labels: "bug", ...fields });
  return params.toString().replaceAll("+", "%20");
}

/** The URL to open in the default browser. The person reviews and presses Submit on GitHub. */
export function buildIssueUrl(issue: Issue): string {
  return `${ISSUE_URL}?${issueQuery(issue.title, issue.fields)}`;
}

/** Only the new-issue page of this project on github.com is ever opened. */
export function isAllowedIssueUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "github.com" && u.port === "" && u.username === "" && u.pathname === `/${ISSUE_REPO}/issues/new`;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/** The renderer supplies exactly these three things, never logs or URLs. */
export const reportRequestSchema = z
  .object({
    errorCode: z.enum(ERROR_CODES),
    message: z.string().max(400),
    phase: z.enum(PHASES),
  })
  .strict();

export interface ReportDeps {
  version: string;
  os: string;
  arch: string;
  electron?: string | undefined;
  diagnostics: Pick<DiagnosticsLog, "tail" | "healSummary">;
  sanitize: () => SanitizeContext;
  openExternal(url: string): void;
  writeClipboard(text: string): void;
}

/** Validates the request, assembles everything else in main, copies the full text if the URL had to be trimmed, opens GitHub. */
export function handleReportRequest(raw: unknown, deps: ReportDeps): { opened: boolean; truncated: boolean } {
  const parsed = reportRequestSchema.safeParse(raw);
  if (!parsed.success) return { opened: false, truncated: false };
  const issue = buildIssue(
    {
      version: deps.version,
      os: deps.os,
      arch: deps.arch,
      electron: deps.electron,
      phase: parsed.data.phase,
      errorCode: parsed.data.errorCode,
      message: parsed.data.message,
      logTail: deps.diagnostics.tail(),
      healOutlineSummary: deps.diagnostics.healSummary(),
    },
    deps.sanitize(),
  );
  const url = buildIssueUrl(issue);
  if (!isAllowedIssueUrl(url)) return { opened: false, truncated: issue.truncated };
  if (issue.truncated) deps.writeClipboard(issue.fullText);
  deps.openExternal(url);
  return { opened: true, truncated: issue.truncated };
}

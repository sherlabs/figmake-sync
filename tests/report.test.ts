import { describe, expect, it, vi } from "vitest";

import {
  CLIPBOARD_NOTE,
  DiagnosticsLog,
  MAX_QUERY_CHARS,
  buildIssue,
  buildIssueUrl,
  handleReportRequest,
  isAllowedIssueUrl,
  issueTitle,
  reportRequestSchema,
  sanitizeLines,
  sanitizeText,
  type IssueInput,
} from "../src/app/report.js";

const ctx = { home: "/Users/jane.doe", usernames: ["jane.doe", "janedoe", "JANES-MBP"], projectNames: ["Checkout Flow", "checkout-flow", "Acme Rebrand"], userTexts: ["make the checkout button red and bigger"] };
const clean = (s: string): string => sanitizeText(s, ctx);

describe("sanitizer", () => {
  it.each([
    "https://www.figma.com/make/AbC123xyzKLM456/Checkout-Flow?node-id=1-2&t=abc",
    "https://www.figma.com/design/AbC123xyzKLM456/Checkout-Flow",
    "https://figma.com/file/AbC123xyzKLM456",
    "www.figma.com/make/AbC123xyzKLM456",
    "https://api.figma.com/v1/files/AbC123xyzKLM456?token=x",
  ])("removes Figma link %s", (url) => {
    const out = clean(`opened ${url} ok`);
    expect(out).toBe("opened <figma-link> ok");
    expect(out).not.toMatch(/AbC123|Checkout/u);
  });

  it("removes file keys and node ids given as fields", () => {
    expect(clean("fileKey=AbC123xyz and node-id: 12:34")).not.toMatch(/AbC123|12:34/u);
  });

  it("maps the home directory to ~ and hides everything under it", () => {
    expect(clean("cwd /Users/jane.doe")).toBe("cwd ~");
    const out = clean("ENOENT open '/Users/jane.doe/Documents/figmake-sync/checkout-flow/src/App.tsx'");
    expect(out).toBe("ENOENT open '~/…'");
    expect(sanitizeText("at /home/bob/work/app/index.js:3:4", {})).toBe("at ~/…");
    expect(sanitizeText("/Users/someone-else/Library/x", {})).toBe("~/…");
    expect(sanitizeText("/Users/John Smith/Documents/My Project/a.ts", {})).toBe("~/…");
  });

  it("hides windows and UNC paths", () => {
    expect(sanitizeText("C:\\Users\\Jane Doe\\AppData\\Roaming\\figmake-sync\\x.json", {})).toBe("~/…");
    expect(sanitizeText("failed D:\\work\\client\\site\\src\\a.tsx now", {})).toBe("failed <path> now");
    expect(sanitizeText("\\\\fileserver\\share\\project\\a.ts", {})).toBe("<path>");
    expect(sanitizeText("C:/Users/jane/x/y", {})).toBe("~/…");
  });

  it("hides other absolute paths but keeps URLs and ordinary text", () => {
    expect(sanitizeText("wrote /var/folders/zz/abc/T/figmake-1/x.json", {})).toBe("wrote <path>");
    expect(sanitizeText("/tmp/x/y", {})).toBe("<path>");
    expect(sanitizeText("http://localhost:5173/src/App.tsx", {})).toBe("http://localhost:5173/src/App.tsx");
    expect(sanitizeText("https://github.com/sherlabs/figmake-sync/issues", {})).toBe("https://github.com/sherlabs/figmake-sync/issues");
    expect(sanitizeText("2024/05/06 and and/or 1/2", {})).toBe("2024/05/06 and and/or 1/2");
  });

  it("keeps npm script banners like name@1.0.0 readable", () => {
    expect(clean("> figma-make-app@1.0.0 dev")).toBe("> figma-make-app@1.0.0 dev");
    expect(clean("pkg@2.3.4-beta.1 and a@b.io")).toBe("pkg@2.3.4-beta.1 and <email>");
  });

  it("removes emails", () => {
    expect(clean("signed in as jane.doe+work@example.co.uk, retrying")).toBe("signed in as <email>, retrying");
  });

  it.each([
    ["Authorization: Bearer abcDEF123456.ghi-jkl_mno", "abcDEF123456"],
    ["token Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", "eyJhbGci"],
    ["key sk-ant-api03-AbCdEfGhIjKlMnOp", "AbCdEf"],
    ["sk-proj-1234567890abcdefghij", "1234567890abcdef"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijklmnop"],
    ["github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz", "11ABCDEFG0"],
    ["xoxb-1234-5678-abcdefgh", "xoxb-1234"],
    ["figd_AbCdEfGhIjKl_mnop", "AbCdEfGh"],
    ["AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7"],
    ["id 0123456789abcdef0123456789abcdef0123", "0123456789abcdef"],
    ["blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5", "QUJDREVG"],
    ["password=hunter2 and api_key: s3cr3tvalue", "hunter2"],
    ['{"accessToken":"abc","session_id":"zzz"}', "abc"],
    ["Cookie: a=b; figma_session=whatever; foo=bar", "whatever"],
    ["Set-Cookie: sid=12345; HttpOnly", "12345"],
  ])("removes secret in %s", (line, secret) => {
    expect(clean(line)).not.toContain(secret);
  });

  it("strips query strings, fragments and credentials from other URLs", () => {
    expect(sanitizeText("GET https://example.com/a/b?code=abc&state=xyz#frag 200", {})).toBe("GET https://example.com/a/b 200");
    expect(sanitizeText("https://user:pw@example.com/x", {})).toBe("https://example.com/x");
    expect(sanitizeText("http://localhost:5173/?token=zzz", {})).toBe("http://localhost:5173/");
  });

  it("removes project names, usernames and the person's own text", () => {
    const out = clean("Project Checkout Flow (checkout-flow) by jane.doe on JANES-MBP: make the checkout button red and bigger please");
    expect(out).not.toMatch(/Checkout Flow|checkout-flow|jane|JANES|checkout button/iu);
    expect(out).toContain("<project>");
    expect(out).toContain("<user>");
    expect(out).toContain("<text>");
    expect(clean("acme rebrand")).toBe("<project>");
  });

  it("keeps harmless text and short ids readable", () => {
    expect(clean("heal failed")).toBe("heal failed");
    expect(clean("exit code 1 after 3.2s")).toBe("exit code 1 after 3.2s");
  });

  it("strips terminal escapes and caps line length", () => {
    expect(sanitizeText("\u001b[31mred\u001b[0m text", {})).toBe("red text");
    expect(sanitizeText("a ".repeat(500), {}).length).toBeLessThanOrEqual(241);
  });

  it("is idempotent", () => {
    const once = clean("open /Users/jane.doe/x/y.ts for jane.doe@example.com at https://www.figma.com/make/AbC123xyzKLM456 Bearer abc123456789");
    expect(clean(once)).toBe(once);
  });

  it("sanitizeLines splits, drops empties", () => {
    expect(sanitizeLines(["a\n\nb", "  "], {})).toEqual(["a", "b"]);
  });
});

describe("DiagnosticsLog", () => {
  it("sanitises at write time and keeps only the last 200 lines", () => {
    const log = new DiagnosticsLog(() => ctx, 200);
    log.push("failed for jane.doe at /Users/jane.doe/Documents/x.ts\n    at run (/Users/jane.doe/app/y.js:1:1)");
    expect(log.tail().join("\n")).not.toMatch(/jane|Documents/u);
    for (let i = 0; i < 300; i++) log.push(`line ${i}`);
    expect(log.tail()).toHaveLength(200);
    expect(log.tail(1)[0]).toMatch(/line 299$/u);
  });

  it("records heal outcomes by key name only", () => {
    const log = new DiagnosticsLog(() => ({}));
    log.noteHeal("codeModeButton", "healed");
    log.noteHeal("promptSendButton", "failed");
    log.noteHeal("has space/and slash", "failed");
    log.noteHeal(42, "failed");
    expect(log.healSummary()).toEqual(["codeModeButton: healed", "promptSendButton: failed"]);
  });
});

const input = (over: Partial<IssueInput> = {}): IssueInput => ({
  version: "0.1.11",
  os: "darwin 25.0.0",
  arch: "arm64",
  electron: "41.2.0",
  phase: "sending",
  errorCode: "figma_unreachable",
  message: "Couldn't reach Figma. Try again.",
  logTail: ["10:00:01 started", "10:00:02 failed"],
  ...over,
});

describe("buildIssue", () => {
  it("title is [code] plus a fixed plain sentence", () => {
    const issue = buildIssue(input());
    expect(issue.title).toBe("[figma_unreachable] Could not reach Figma");
    expect(issueTitle("unknown")).toBe("[unknown] Something went wrong");
    expect(buildIssue(input({ errorCode: "bogus" as never })).title).toMatch(/^\[unknown\] /u);
  });

  it("has version, OS, phase, error and log sections", () => {
    const { body, fields } = buildIssue(input({ healOutlineSummary: ["codeModeButton: healed", "evil: <script>"] }));
    for (const h of ["### Version", "### Operating system", "### When it failed", "### Error", "### Log"]) expect(body).toContain(h);
    expect(fields.version).toBe("figmake-sync 0.1.11 · Electron 41.2.0");
    expect(fields.os).toBe("darwin 25.0.0 arm64");
    expect(fields.phase).toBe("sending");
    expect(fields.error).toBe("figma_unreachable: Couldn't reach Figma. Try again.");
    expect(fields.log).toContain("10:00:02 failed");
    expect(fields.log).toContain("Selector repair: codeModeButton: healed");
    expect(fields.log).not.toContain("evil");
  });

  it("sanitises even pre-sanitised-looking input", () => {
    const issue = buildIssue(input({ message: "Failed at /Users/jane.doe/x from jane@x.io", logTail: ["see https://www.figma.com/make/AbC123xyzKLM456/Checkout-Flow"] }), ctx);
    const all = JSON.stringify(issue);
    expect(all).not.toMatch(/jane|AbC123|Checkout/u);
  });

  it("builds a github.com new-issue URL using the issue form field ids", () => {
    const url = buildIssueUrl(buildIssue(input()));
    expect(isAllowedIssueUrl(url)).toBe(true);
    const u = new URL(url);
    expect(u.searchParams.get("template")).toBe("bug_report.yml");
    expect(u.searchParams.get("labels")).toBe("bug");
    expect(u.searchParams.get("title")).toBe("[figma_unreachable] Could not reach Figma");
    for (const f of ["version", "os", "phase", "error", "log"]) expect(u.searchParams.get(f)).toBeTruthy();
  });

  it("keeps short reports whole", () => {
    const issue = buildIssue(input());
    expect(issue.truncated).toBe(false);
    expect(issue.fields.log).not.toContain(CLIPBOARD_NOTE);
  });

  it("uses only the last 40 lines in the URL, all in fullText", () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line ${i}`);
    const issue = buildIssue(input({ logTail: lines }));
    expect(issue.fields.log).toContain("line 119");
    expect(issue.fields.log).not.toContain("line 79\n");
    expect(issue.fullText).toContain("line 0\n");
    expect(issue.truncated).toBe(false);
  });

  it("trims the log and points to the clipboard when the encoded URL would be too long", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `${i} ${"é%&= ".repeat(40)}`);
    const issue = buildIssue(input({ logTail: lines }));
    expect(issue.truncated).toBe(true);
    expect(issue.fields.log).toContain(CLIPBOARD_NOTE);
    expect(buildIssueUrl(issue).split("?")[1]?.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(issue.fullText).toContain("0 é%&=");
    expect(issue.fullText.split("\n").length).toBeGreaterThan(200);
  });
});

describe("isAllowedIssueUrl", () => {
  it.each([
    ["https://github.com/sherlabs/figmake-sync/issues/new?title=x", true],
    ["http://github.com/sherlabs/figmake-sync/issues/new", false],
    ["https://github.com.evil.com/sherlabs/figmake-sync/issues/new", false],
    ["https://evil.com/github.com/sherlabs/figmake-sync/issues/new", false],
    ["https://user@github.com/sherlabs/figmake-sync/issues/new", false],
    ["https://github.com/other/repo/issues/new", false],
    ["https://github.com:8443/sherlabs/figmake-sync/issues/new", false],
    ["javascript:alert(1)", false],
    ["file:///etc/passwd", false],
    ["nonsense", false],
  ])("%s -> %s", (url, ok) => expect(isAllowedIssueUrl(url)).toBe(ok));
});

describe("report IPC", () => {
  it("accepts exactly {errorCode, message, phase}", () => {
    const ok = { errorCode: "agent_failed", message: "Couldn't reach Claude. Try again.", phase: "working" };
    expect(reportRequestSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, errorCode: "made_up" },
      { ...ok, phase: "nope" },
      { ...ok, message: "x".repeat(401) },
      { ...ok, url: "https://evil.com" },
      { ...ok, logs: ["a"] },
      { errorCode: "agent_failed", phase: "working" },
      null,
      "str",
    ]) expect(reportRequestSchema.safeParse(bad).success).toBe(false);
  });

  const deps = (over: Record<string, unknown> = {}) => ({
    version: "0.1.11",
    os: "darwin 25.0.0",
    arch: "arm64",
    electron: "41.2.0",
    diagnostics: { tail: () => ["10:00 started"], healSummary: () => ["codeModeButton: failed"] },
    sanitize: () => ctx,
    openExternal: vi.fn(),
    writeClipboard: vi.fn(),
    ...over,
  });
  const req = { errorCode: "push_failed", message: "Some changes couldn't be sent. Try again.", phase: "sending" };

  it("main assembles the issue and opens only an allowed github URL", () => {
    const d = deps();
    expect(handleReportRequest(req, d)).toEqual({ opened: true, truncated: false });
    const url = d.openExternal.mock.calls[0]?.[0] as string;
    expect(isAllowedIssueUrl(url)).toBe(true);
    expect(new URL(url).searchParams.get("log")).toContain("codeModeButton: failed");
    expect(d.writeClipboard).not.toHaveBeenCalled();
  });

  it("rejects invalid requests without opening anything", () => {
    const d = deps();
    expect(handleReportRequest({ ...req, errorCode: "x" }, d).opened).toBe(false);
    expect(handleReportRequest({ ...req, url: "https://evil.com" }, d).opened).toBe(false);
    expect(d.openExternal).not.toHaveBeenCalled();
  });

  it("copies the full text to the clipboard when the log had to be trimmed", () => {
    const big = Array.from({ length: 200 }, (_, i) => `${i} ${"é%&= ".repeat(40)}`);
    const d = deps({ diagnostics: { tail: () => big, healSummary: () => [] } });
    expect(handleReportRequest(req, d)).toEqual({ opened: true, truncated: true });
    expect(d.writeClipboard).toHaveBeenCalledTimes(1);
    expect(d.writeClipboard.mock.calls[0]?.[0]).toContain("0 é%&=");
  });

  it("a request message with private data is sanitised", () => {
    const d = deps();
    handleReportRequest({ ...req, message: "Failed for jane.doe@example.com in /Users/jane.doe/p" }, d);
    const url = d.openExternal.mock.calls[0]?.[0] as string;
    expect(decodeURIComponent(url)).not.toMatch(/jane/u);
  });
});

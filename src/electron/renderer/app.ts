import type {
  DesktopProjectCommandOptions,
  DesktopProgressEvent,
  FigmakeDesktopApi,
} from "../contracts.js";
import type {
  ProjectInspection,
  StatusResult,
} from "../../core/service.js";
import type { PullStrategy } from "../../types/config.js";
import type { ManifestDiff, ManifestEntry, ManifestRename } from "../../diff/manifest.js";

declare global {
  interface Window {
    figmakeSyncDesktop: FigmakeDesktopApi;
  }
}

interface ProjectState {
  id: string;
  rootDir: string;
  figmaMakeUrl: string;
  linkedProject: ProjectInspection | null;
  options: Omit<DesktopProjectCommandOptions, "rootDir">;
  cardElement: HTMLElement | null;
  viewElement: HTMLElement | null;
  lastDiff: ManifestDiff | null;
}

interface AppState {
  projects: Map<string, ProjectState>;
  activeProjectId: string | null;
  activeTab: string;
  busy: boolean;
  currentView: "home" | "detail";
}

const ge = {
  homeScreen: document.querySelector<HTMLElement>("[data-home-screen]")!,
  projectDetail: document.querySelector<HTMLElement>("[data-project-detail]")!,
  projectGrid: document.querySelector<HTMLElement>("[data-project-grid]")!,
  noProjects: document.querySelector<HTMLElement>("[data-no-projects]")!,
  detailTabs: document.querySelector<HTMLElement>("[data-detail-tabs]")!,
  detailContent: document.querySelector<HTMLElement>("[data-detail-content]")!,
  projectTitle: document.querySelector<HTMLElement>("[data-project-title]")!,
  projectBadge: document.querySelector<HTMLElement>("[data-project-badge]")!,
  detailPath: document.querySelector<HTMLElement>("[data-detail-path]")!,
  busyIndicator: document.querySelector<HTMLElement>("[data-busy-indicator]")!,
  onboardingBanner: document.querySelector<HTMLElement>("[data-onboarding-banner]")!,
};

const state: AppState = {
  projects: new Map(),
  activeProjectId: null,
  activeTab: "sync",
  busy: false,
  currentView: "home",
};

let projectIdCounter = 0;
let progressHeartbeatTimer: number | null = null;

function getDesktopApi(): FigmakeDesktopApi {
  if (!window.figmakeSyncDesktop) throw new Error("Desktop bridge unavailable");
  return window.figmakeSyncDesktop;
}

function generateProjectId(): string {
  return `project-${++projectIdCounter}`;
}

function getProjectName(project: ProjectState): string {
  if (project.linkedProject?.config?.figmaMakeUrl) {
    const url = project.linkedProject.config.figmaMakeUrl;
    const match = url.match(/\/make\/([^/]+)/);
    return (match && match[1]) ? match[1] : "Untitled";
  }
  if (project.rootDir) {
    const parts = project.rootDir.split("/");
    return parts[parts.length - 1] || "Untitled";
  }
  return "New Project";
}

// ── Project Card ───────────────────────────────────────────────────────────────

function createProjectCard(projectId: string): HTMLElement {
  const template = document.getElementById("project-card-template") as HTMLTemplateElement;
  const clone = template.content.cloneNode(true) as DocumentFragment;
  const card = clone.querySelector(".project-card") as HTMLElement;
  card.dataset.projectId = projectId;

  card.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest("[data-action='delete-project']")) {
      openProject(projectId);
    }
  });

  card.querySelector("[data-action='delete-project']")!
    .addEventListener("click", (e) => { e.stopPropagation(); void deleteProject(projectId); });

  return card;
}

function renderProjectCard(project: ProjectState): void {
  if (!project.cardElement) return;
  const el = project.cardElement;
  const info = project.linkedProject;

  (el.querySelector(".project-card-name") as HTMLElement).textContent = getProjectName(project);
  const badge = el.querySelector(".project-card-badge") as HTMLElement;
  badge.textContent = info?.linked ? "Linked" : "Unlinked";
  badge.classList.toggle("linked", Boolean(info?.linked));
  (el.querySelector(".project-card-path") as HTMLElement).textContent = project.rootDir || "No folder selected";

  // Stats
  const meta = info?.metadata;
  const pullEl = el.querySelector("[data-stat-pull]") as HTMLElement;
  const pushEl = el.querySelector("[data-stat-push]") as HTMLElement;
  const verifyEl = el.querySelector("[data-stat-verify]") as HTMLElement;
  const changesEl = el.querySelector("[data-stat-changes]") as HTMLElement;

  pullEl.textContent = meta?.lastPullAt ? formatRelative(meta.lastPullAt) : "â";
  pushEl.textContent = meta?.lastPushAt ? formatRelative(meta.lastPushAt) : "â";
  verifyEl.textContent = meta?.lastVerifyAt ? formatRelative(meta.lastVerifyAt) : "â";

  const summary = info?.statusSummary;
  const totalChanges = (summary?.added || 0) + (summary?.modified || 0) + (summary?.deleted || 0) + (summary?.renamed || 0);
  changesEl.textContent = String(totalChanges);
  changesEl.classList.toggle("has-changes", totalChanges > 0);
}

function formatRelative(dateStr: string | undefined): string {
  if (!dateStr) return "â";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Project View ───────────────────────────────────────────────────────────────

function createProjectView(projectId: string): HTMLElement {
  const template = document.getElementById("project-template") as HTMLTemplateElement;
  const clone = template.content.cloneNode(true) as DocumentFragment;
  const view = clone.querySelector(".project-view") as HTMLElement;
  view.dataset.projectId = projectId;
  return view;
}

function getPanelEls(view: HTMLElement) {
  return {
    // Setup wizard steps
    stepFolder: view.querySelector<HTMLElement>("[data-setup-step='folder']")!,
    stepLink: view.querySelector<HTMLElement>("[data-setup-step='link']")!,
    linkedState: view.querySelector<HTMLElement>("[data-linked-state]")!,
    // Folder display
    folderPath: view.querySelector<HTMLElement>("[data-folder-path]")!,
    folderPathDisplay: view.querySelector<HTMLElement>("[data-folder-path-display]")!,
    // Init form
    initForm: view.querySelector<HTMLFormElement>("[data-init-form]")!,
    urlInput: view.querySelector<HTMLInputElement>("[data-figma-url]")!,
    // Setup tab info
    linkedUrl: view.querySelector<HTMLElement>("[data-linked-url]")!,
    metaLastPull: view.querySelector<HTMLElement>("[data-meta='last-pull']")!,
    metaLastPush: view.querySelector<HTMLElement>("[data-meta='last-push']")!,
    metaLastVerify: view.querySelector<HTMLElement>("[data-meta='last-verify']")!,
    emptyState: view.querySelector<HTMLElement>("[data-empty-state]")!,
    // Progress
    progressPanel: view.querySelector<HTMLElement>("[data-progress-panel]")!,
    progressFill: view.querySelector<HTMLElement>("[data-progress-fill]")!,
    progressTitle: view.querySelector<HTMLElement>("[data-progress-title]")!,
    progressPercent: view.querySelector<HTMLElement>("[data-progress-percent]")!,
    progressSubtext: view.querySelector<HTMLElement>("[data-progress-subtext]")!,
    // Result banner
    resultBanner: view.querySelector<HTMLElement>("[data-result-banner]")!,
    resultMessage: view.querySelector<HTMLElement>("[data-result-message]")!,
    resultIcon: view.querySelector<HTMLElement>("[data-result-icon]")!,
    // Sync stats
    syncStatPull: view.querySelector<HTMLElement>("[data-sync-stat-pull]")!,
    syncStatPush: view.querySelector<HTMLElement>("[data-sync-stat-push]")!,
    syncStatVerify: view.querySelector<HTMLElement>("[data-sync-stat-verify]")!,
    syncStatChanges: view.querySelector<HTMLElement>("[data-sync-stat-changes]")!,
    // Changes
    changesEmpty: view.querySelector<HTMLElement>("[data-changes-empty]")!,
    changesLayout: view.querySelector<HTMLElement>("[data-changes-layout]")!,
    changesCount: view.querySelector<HTMLElement>("[data-changes-count]")!,
    fileList: view.querySelector<HTMLElement>("[data-file-list]")!,
    diffFilename: view.querySelector<HTMLElement>("[data-diff-filename]")!,
    diffStats: view.querySelector<HTMLElement>("[data-diff-stats]")!,
    diffContent: view.querySelector<HTMLElement>("[data-diff-content]")!,
    copyBtn: view.querySelector<HTMLButtonElement>("[data-action='copy-file']")!,
    // Logs
    activity: view.querySelector<HTMLElement>("[data-activity]")!,
    outputBlock: view.querySelector<HTMLElement>("[data-output-block]")!,
    output: view.querySelector<HTMLElement>("[data-output]")!,
    screenshotPanel: view.querySelector<HTMLElement>("[data-screenshot-panel]")!,
    screenshotImg: view.querySelector<HTMLImageElement>("[data-screenshot-img]")!,
    screenshotCaption: view.querySelector<HTMLElement>("[data-screenshot-caption]")!,
  };
}

function bindProjectEvents(project: ProjectState): void {
  const view = project.viewElement!;
  const els = getPanelEls(view);

  // Choose folder
  view.querySelectorAll("[data-action='choose-folder']").forEach((btn) => {
    btn.addEventListener("click", () => {
      void (async () => {
        const inspection = await getDesktopApi().selectProjectDirectory();
        if (inspection) {
          project.rootDir = inspection.rootDir;
          project.linkedProject = inspection;
          renderProject(project);
          renderProjectCard(project);
        }
      })();
    });
  });

  // Link form
  els.initForm.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      const url = els.urlInput.value.trim();
      if (!url || !project.rootDir) return;
      project.figmaMakeUrl = url;
      await runCommand(project, "Link", () => getDesktopApi().initProject(project.rootDir, url));
    })();
  });

  // Command buttons
  view.querySelectorAll<HTMLButtonElement>("[data-command]").forEach((btn) => {
    btn.addEventListener("click", () => {
      void handleCommand(project, btn.dataset.command!);
    });
  });

  // Options
  view.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-option]").forEach((inp) => {
    inp.addEventListener("change", () => {
      void syncOptions(project);
    });
  });

  // Tab-link buttons (e.g. "View logs →")
  view.querySelectorAll<HTMLButtonElement>("[data-tab-link]").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tabLink!));
  });

  // Clear output
  view.querySelectorAll("[data-action='clear-output']").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.output.textContent = "";
      els.outputBlock.setAttribute("hidden", "");
    });
  });

  view.querySelectorAll("[data-action='delete-project']").forEach((btn) => {
    btn.addEventListener("click", () => {
      void deleteProject(project.id);
    });
  });
}

function syncOptions(project: ProjectState): void {
  if (!project.viewElement) return;
  const v = project.viewElement;
  const dryRun = v.querySelector<HTMLInputElement>("[data-option='dry-run']")?.checked || false;
  const verbose = v.querySelector<HTMLInputElement>("[data-option='verbose']")?.checked || false;
  const showBrowser = v.querySelector<HTMLInputElement>("[data-option='show-browser']")?.checked || false;
  const prompt = v.querySelector<HTMLInputElement>("[data-option='prompt']")?.checked || false;
  const strategy = (v.querySelector<HTMLSelectElement>("[data-option='strategy']")?.value as PullStrategy | undefined) ?? "backup";

  project.options = {
    dryRun,
    verbose,
    prompt,
    strategy,
    headless: !showBrowser,
  };

  // Persist settings
  localStorage.setItem("figmake-settings", JSON.stringify({ dryRun, verbose, showBrowser, prompt, strategy }));
}

function restoreOptions(project: ProjectState): void {
  if (!project.viewElement) return;
  const v = project.viewElement;

  try {
    const saved = JSON.parse(localStorage.getItem("figmake-settings") || "{}") as Record<string, unknown>;

    const setCheck = (name: string, value: boolean) => {
      const el = v.querySelector<HTMLInputElement>(`[data-option='${name}']`);
      if (el) el.checked = value;
    };

    setCheck("dry-run", Boolean(saved.dryRun));
    setCheck("verbose", Boolean(saved.verbose));
    setCheck("show-browser", Boolean(saved.showBrowser));
    setCheck("prompt", Boolean(saved.prompt));

    const strategyEl = v.querySelector<HTMLSelectElement>("[data-option='strategy']");
    if (strategyEl && typeof saved.strategy === "string") strategyEl.value = saved.strategy;
  } catch {
    // Ignore parse errors
  }

  syncOptions(project);
}

function renderProject(project: ProjectState): void {
  if (!project.viewElement) return;
  const els = getPanelEls(project.viewElement);
  const info = project.linkedProject;
  const linked = Boolean(info?.linked);

  // Wizard step visibility on Sync tab
  if (!project.rootDir) {
    els.stepFolder.removeAttribute("hidden");
    els.stepLink.setAttribute("hidden", "");
    els.linkedState.setAttribute("hidden", "");
  } else if (!linked) {
    els.stepFolder.setAttribute("hidden", "");
    els.stepLink.removeAttribute("hidden");
    els.linkedState.setAttribute("hidden", "");
    els.folderPath.textContent = project.rootDir;
  } else {
    els.stepFolder.setAttribute("hidden", "");
    els.stepLink.setAttribute("hidden", "");
    els.linkedState.removeAttribute("hidden");
  }

  // Sync tab stats
  const meta = info?.metadata;
  if (els.syncStatPull) els.syncStatPull.textContent = meta?.lastPullAt ? formatRelative(meta.lastPullAt) : "—";
  if (els.syncStatPush) els.syncStatPush.textContent = meta?.lastPushAt ? formatRelative(meta.lastPushAt) : "—";
  if (els.syncStatVerify) els.syncStatVerify.textContent = meta?.lastVerifyAt ? formatRelative(meta.lastVerifyAt) : "—";
  
  const summary = info?.statusSummary;
  const totalChanges = (summary?.added || 0) + (summary?.modified || 0) + (summary?.deleted || 0) + (summary?.renamed || 0);
  if (els.syncStatChanges) {
    els.syncStatChanges.textContent = totalChanges === 0 ? "0 files" : `${totalChanges} file${totalChanges !== 1 ? "s" : ""}`;
    els.syncStatChanges.dataset.hasChanges = String(totalChanges > 0);
  }

  // Setup tab
  if (els.folderPathDisplay) els.folderPathDisplay.textContent = project.rootDir || "No folder selected";
  els.linkedUrl.textContent = info?.config?.figmaMakeUrl || "—";
  els.metaLastPull.textContent = formatTs(info?.metadata?.lastPullAt);
  els.metaLastPush.textContent = formatTs(info?.metadata?.lastPushAt);
  els.metaLastVerify.textContent = formatTs(info?.metadata?.lastVerifyAt);
  els.emptyState.toggleAttribute("hidden", linked);

  // Changes - render file list if we have diff data
  renderChanges(project);

  // Header
  if (state.activeProjectId === project.id) {
    ge.projectTitle.textContent = getProjectName(project);
    ge.projectBadge.textContent = linked ? "Linked" : "Unlinked";
    ge.projectBadge.dataset.linked = String(linked);
    ge.detailPath.textContent = project.rootDir || "";
  }
}

function formatTs(value: string | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

// ── Changes Tab ────────────────────────────────────────────────────────────────

function renderChanges(project: ProjectState): void {
  if (!project.viewElement) return;
  const els = getPanelEls(project.viewElement);
  const diff = project.lastDiff;

  if (!diff || (diff.added.length === 0 && diff.modified.length === 0 && diff.deleted.length === 0 && diff.renamed.length === 0)) {
    els.changesEmpty.removeAttribute("hidden");
    els.changesLayout.setAttribute("hidden", "");
    // Still render ignored section even when no changes
    void renderIgnoredFiles(project, els.fileList);
    return;
  }

  els.changesEmpty.setAttribute("hidden", "");
  els.changesLayout.removeAttribute("hidden");

  const total = diff.added.length + diff.modified.length + diff.deleted.length + diff.renamed.length;
  els.changesCount.textContent = `${total} file${total !== 1 ? "s" : ""} changed`;

  // Clear and populate file list
  els.fileList.innerHTML = "";

  const files: Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed"; entry: ManifestEntry | ManifestRename }> = [];

  diff.added.forEach((entry) => files.push({ path: entry.path, status: "added", entry }));
  diff.modified.forEach(({ current }) => files.push({ path: current.path, status: "modified", entry: current }));
  diff.deleted.forEach((entry) => files.push({ path: entry.path, status: "deleted", entry }));
  diff.renamed.forEach((rename) => files.push({ path: rename.to, status: "renamed", entry: rename }));

  files.forEach((file) => {
    const item = document.createElement("div");
    item.className = "file-item";
    item.dataset.path = file.path;
    item.dataset.status = file.status;

    const iconSvg = getFileIcon(file.status);
    const badge = document.createElement("span");
    badge.className = `file-badge ${file.status}`;
    badge.textContent = file.status;

    const ignoreBtn = document.createElement("button");
    ignoreBtn.className = "file-ignore-btn";
    ignoreBtn.title = `Ignore ${file.path}`;
    ignoreBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 2l12 12M14 2L2 14" stroke-linecap="round"/></svg>`;
    ignoreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void ignoreFile(project, file.path);
    });

    item.innerHTML = `
      <span class="file-icon ${file.status}">${iconSvg}</span>
      <span class="file-name" title="${file.path}">${file.path.split("/").pop()}</span>
    `;
    item.appendChild(badge);
    item.appendChild(ignoreBtn);

    item.addEventListener("click", () => {
      void selectFile(project, file.path, file.status);
    });
    els.fileList.appendChild(item);
  });

  void renderIgnoredFiles(project, els.fileList);
}

async function renderIgnoredFiles(project: ProjectState, container: HTMLElement): Promise<void> {
  if (!project.rootDir) return;
  const api = getDesktopApi();
  try {
    const patterns = await api.getCustomIgnorePatterns(project.rootDir);
    if (patterns.length === 0) return;

    // Remove any existing ignored section
    container.querySelector(".ignored-files-section")?.remove();

    const section = document.createElement("div");
    section.className = "ignored-files-section";

    const header = document.createElement("div");
    header.className = "ignored-files-header";
    header.textContent = `Ignored (${patterns.length})`;
    section.appendChild(header);

    patterns.forEach((pattern) => {
      const item = document.createElement("div");
      item.className = "file-item ignored";

      const unignoreBtn = document.createElement("button");
      unignoreBtn.className = "file-unignore-btn";
      unignoreBtn.title = `Stop ignoring ${pattern}`;
      unignoreBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h8" stroke-linecap="round"/><path d="M8 4v8" stroke-linecap="round"/></svg>`;
      unignoreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void unignoreFile(project, pattern);
      });

      item.innerHTML = `
        <span class="file-icon ignored"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" opacity="0.5"><circle cx="8" cy="8" r="6"/><path d="M4 12L12 4" stroke-linecap="round"/></svg></span>
        <span class="file-name ignored-name" title="${pattern}">${pattern}</span>
      `;
      item.appendChild(unignoreBtn);
      section.appendChild(item);
    });

    container.appendChild(section);
  } catch {
    // Config not available yet
  }
}

function getFileIcon(status: string): string {
  const icons: Record<string, string> = {
    added: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 4v8M4 8h8" stroke-linecap="round"/></svg>`,
    modified: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 8h12" stroke-linecap="round"/><circle cx="8" cy="8" r="1" fill="currentColor"/></svg>`,
    deleted: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h8" stroke-linecap="round"/></svg>`,
    renamed: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h8M8 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  };
  return icons[status] ?? icons.modified ?? "";
}

let lastLoadedFileContent = "";

async function selectFile(project: ProjectState, filePath: string, status: string): Promise<void> {
  if (!project.viewElement) return;
  const els = getPanelEls(project.viewElement);

  // Highlight selected file
  els.fileList.querySelectorAll(".file-item").forEach((item) => {
    item.classList.toggle("selected", (item as HTMLElement).dataset.path === filePath);
  });

  els.diffFilename.textContent = filePath;
  els.diffStats.innerHTML = `<span class="${status}">${status}</span>`;
  els.diffContent.innerHTML = `<p class="diff-placeholder">Loading file...</p>`;
  els.copyBtn.setAttribute("hidden", "");
  lastLoadedFileContent = "";

  const api = getDesktopApi();
  if (typeof api.readFile !== "function") {
    els.diffContent.innerHTML = `<p class="diff-placeholder">Rebuild the app to enable file viewing</p>`;
    return;
  }

  try {
    const currentPath = `${project.rootDir}/${filePath}`;
    const baselinePath = `${project.rootDir}/.figmake-sync/snapshots/last-pull/${filePath}`;

    if (status === "added") {
      const content = await api.readFile(currentPath);
      lastLoadedFileContent = content;
      els.diffContent.innerHTML = renderFullFile(content, "addition");
      els.diffStats.innerHTML = `<span class="added">added</span> · ${content.split("\n").length} lines`;
    } else if (status === "deleted") {
      const content = await api.readFile(baselinePath);
      lastLoadedFileContent = content;
      els.diffContent.innerHTML = renderFullFile(content, "deletion");
      els.diffStats.innerHTML = `<span class="deleted">deleted</span> · ${content.split("\n").length} lines`;
    } else {
      // modified or renamed — show actual diff
      let oldContent = "";
      let newContent = "";
      try { oldContent = await api.readFile(baselinePath); } catch { /* no baseline */ }
      try { newContent = await api.readFile(currentPath); } catch { /* file missing */ }
      lastLoadedFileContent = newContent;

      const diffLines = computeDiff(oldContent.split("\n"), newContent.split("\n"));
      let html = "";
      let additions = 0;
      let deletions = 0;

      diffLines.forEach((dl) => {
        if (dl.type === "add") additions++;
        if (dl.type === "del") deletions++;
        const cls = dl.type === "add" ? "addition" : dl.type === "del" ? "deletion" : "context";
        const prefix = dl.type === "add" ? "+" : dl.type === "del" ? "-" : " ";
        const numOld = dl.oldNum != null ? String(dl.oldNum) : "";
        const numNew = dl.newNum != null ? String(dl.newNum) : "";
        html += `<div class="diff-line ${cls}"><span class="diff-line-num">${numOld}</span><span class="diff-line-num">${numNew}</span><span class="diff-line-content">${prefix} ${escapeHtml(dl.text)}</span></div>`;
      });

      els.diffContent.innerHTML = html;
      const parts = [];
      if (additions > 0) parts.push(`<span class="added">+${additions}</span>`);
      if (deletions > 0) parts.push(`<span class="deleted">-${deletions}</span>`);
      els.diffStats.innerHTML = `<span class="${status}">${status}</span> · ${parts.join(" ")}`;
    }

    // Show copy button
    els.copyBtn.removeAttribute("hidden");
    els.copyBtn.classList.remove("copied");
    els.copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(lastLoadedFileContent);
      els.copyBtn.classList.add("copied");
      setTimeout(() => els.copyBtn.classList.remove("copied"), 1500);
    };
  } catch (error) {
    console.error("Failed to load file:", error);
    els.diffContent.innerHTML = `<p class="diff-placeholder" style="color: var(--error);">Failed to load file: ${error instanceof Error ? error.message : String(error)}</p>`;
  }
}

function renderFullFile(content: string, cls: "addition" | "deletion" | "context"): string {
  const lines = content.split("\n");
  return lines.map((line, i) => {
    const prefix = cls === "addition" ? "+" : cls === "deletion" ? "-" : " ";
    return `<div class="diff-line ${cls}"><span class="diff-line-num">${i + 1}</span><span class="diff-line-num">${cls === "addition" ? i + 1 : ""}</span><span class="diff-line-content">${prefix} ${escapeHtml(line) || " "}</span></div>`;
  }).join("");
}

async function ignoreFile(project: ProjectState, filePath: string): Promise<void> {
  if (!project.rootDir) return;
  const api = getDesktopApi();
  try {
    await api.addIgnorePattern(project.rootDir, filePath);
    // Re-run status to refresh the changes list
    const opts: DesktopProjectCommandOptions = { rootDir: project.rootDir, ...project.options };
    const statusResult = await api.statusProject(opts);
    project.lastDiff = statusResult.diff ?? null;
    await refreshProject(project);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    alert(`Failed to ignore file:\n\n${msg}`);
  }
}

async function unignoreFile(project: ProjectState, pattern: string): Promise<void> {
  if (!project.rootDir) return;
  const api = getDesktopApi();
  try {
    await api.removeIgnorePattern(project.rootDir, pattern);
    const opts: DesktopProjectCommandOptions = { rootDir: project.rootDir, ...project.options };
    const statusResult = await api.statusProject(opts);
    project.lastDiff = statusResult.diff ?? null;
    await refreshProject(project);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    alert(`Failed to un-ignore file:\n\n${msg}`);
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Simple Myers-like diff: computes the shortest edit script between two arrays of lines
interface DiffLine { type: "ctx" | "add" | "del"; text: string; oldNum?: number; newNum?: number }

function computeDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i]![j] = (dp[i + 1]?.[j + 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
      }
    }
  }

  // Trace back to produce diff
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNum = 1;
  let newNum = 1;

  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      result.push({ type: "ctx", text: oldLines[i]!, oldNum: oldNum++, newNum: newNum++ });
      i++; j++;
    } else if (j < n && (i >= m || (dp[i]?.[j + 1] ?? 0) >= (dp[i + 1]?.[j] ?? 0))) {
      result.push({ type: "add", text: newLines[j]!, newNum: newNum++ });
      j++;
    } else {
      result.push({ type: "del", text: oldLines[i]!, oldNum: oldNum++ });
      i++;
    }
  }

  return result;
}

// ── Progress ───────────────────────────────────────────────────────────────────

function showProgress(project: ProjectState, event: DesktopProgressEvent | null): void {
  if (!project.viewElement) return;
  const els = getPanelEls(project.viewElement);

  if (!event) {
    els.progressPanel.setAttribute("hidden", "");
    return;
  }

  els.progressPanel.removeAttribute("hidden");
  els.resultBanner.setAttribute("hidden", "");
  if (els.progressTitle) els.progressTitle.textContent = "Running…";
  if (els.progressPercent) {
    els.progressPercent.textContent = event.percent != null ? `${Math.round(event.percent)}%` : "";
  }
  if (els.progressSubtext) els.progressSubtext.textContent = event.message || "";
  if (els.progressFill) {
    if (event.percent != null) {
      els.progressFill.style.width = `${event.percent}%`;
      els.progressFill.removeAttribute("data-indeterminate");
    } else {
      els.progressFill.style.width = "30%";
      els.progressFill.setAttribute("data-indeterminate", "true");
    }
  }

  // Log progress to activity so it's visible in the Logs tab
  if (event.message) appendActivity(project, event.message);
}

function showResult(project: ProjectState, success: boolean, message: string): void {
  if (!project.viewElement) return;
  const els = getPanelEls(project.viewElement);

  els.progressPanel.setAttribute("hidden", "");
  els.resultBanner.removeAttribute("hidden");
  els.resultBanner.dataset.error = String(!success);
  if (els.resultIcon) els.resultIcon.dataset.error = String(!success);
  if (els.resultMessage) els.resultMessage.textContent = message;
}

function appendActivity(project: ProjectState, text: string): void {
  if (!project.viewElement) return;
  const els = getPanelEls(project.viewElement);

  // Remove "no activity" placeholder
  const empty = els.activity.querySelector(".logs-empty");
  if (empty) empty.remove();

  const item = document.createElement("div");
  item.className = "activity-item";
  item.textContent = `${new Date().toLocaleTimeString()} — ${text}`;
  els.activity.appendChild(item);
  els.activity.scrollTop = els.activity.scrollHeight;
}

function showOutput(project: ProjectState, text: string): void {
  if (!project.viewElement) return;
  const els = getPanelEls(project.viewElement);
  els.output.textContent = text;
  els.outputBlock.removeAttribute("hidden");
}

function checkForScreenshot(project: ProjectState, error: unknown): void {
  if (!project.viewElement) return;
  const els = getPanelEls(project.viewElement);
  const msg = error instanceof Error ? error.message : String(error);
  const match = msg.match(/screenshot[^\s]*\s+([^\s]+\.png)/i)
    || msg.match(/([^\s]+\.png)/i);

  if (match) {
    els.screenshotPanel.removeAttribute("hidden");
    els.screenshotImg.src = `file://${match[1]}`;
    els.screenshotCaption.textContent = new Date().toLocaleString();
  }
}

// ── Navigation ─────────────────────────────────────────────────────────────────

function addProject(): void {
  const id = generateProjectId();
  const cardElement = createProjectCard(id);
  const viewElement = createProjectView(id);

  const project: ProjectState = {
    id, rootDir: "", figmaMakeUrl: "", linkedProject: null,
    options: { dryRun: false, verbose: false, prompt: false, strategy: "backup" },
    cardElement, viewElement, lastDiff: null,
  };

  state.projects.set(id, project);
  ge.projectGrid.appendChild(cardElement);
  bindProjectEvents(project);
  restoreOptions(project);
  renderProjectCard(project);
  updateHomeUI();
  openProject(id);
}

async function deleteProject(id: string): Promise<void> {
  const project = state.projects.get(id);
  if (!project) return;

  try {
    if (project.rootDir) {
      await getDesktopApi().deleteProject(project.rootDir);
    }

    project.cardElement?.remove();
    state.projects.delete(id);

    if (state.activeProjectId === id) {
      showHome();
    }

    updateHomeUI();
    await updateAuthStatus();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    if (!/cancelled/i.test(msg)) {
      alert(`Failed to delete project:\n\n${msg}`);
    }
  }
}

function openProject(id: string): void {
  state.activeProjectId = id;
  state.currentView = "detail";

  ge.homeScreen.setAttribute("hidden", "");
  ge.projectDetail.removeAttribute("hidden");

  const project = state.projects.get(id);
  if (!project) return;

  ge.projectTitle.textContent = getProjectName(project);
  ge.projectBadge.textContent = project.linkedProject?.linked ? "Linked" : "Unlinked";
  ge.projectBadge.dataset.linked = String(Boolean(project.linkedProject?.linked));
  ge.detailPath.textContent = project.rootDir || "";

  ge.detailContent.innerHTML = "";
  ge.detailContent.appendChild(project.viewElement!);

  renderProject(project);
  switchTab("sync");
}

function showHome(): void {
  state.currentView = "home";
  state.activeProjectId = null;
  ge.homeScreen.removeAttribute("hidden");
  ge.projectDetail.setAttribute("hidden", "");
}

function switchTab(tabName: string): void {
  state.activeTab = tabName;

  ge.detailTabs.querySelectorAll(".detail-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.getAttribute("data-tab") === tabName);
  });

  const project = state.activeProjectId ? state.projects.get(state.activeProjectId) : null;
  project?.viewElement?.querySelectorAll(".tab-panel").forEach((panel) => {
    (panel as HTMLElement).toggleAttribute("hidden", panel.getAttribute("data-panel") !== tabName);
  });
}

function updateHomeUI(): void {
  ge.noProjects.toggleAttribute("hidden", state.projects.size > 0);
}

function resetProjectsUi(): void {
  state.projects.clear();
  state.activeProjectId = null;
  state.currentView = "home";
  ge.projectGrid.innerHTML = "";
  ge.detailContent.innerHTML = "";
  ge.homeScreen.removeAttribute("hidden");
  ge.projectDetail.setAttribute("hidden", "");
  updateHomeUI();
}

function setBusy(busy: boolean): void {
  state.busy = busy;
  ge.busyIndicator.textContent = busy ? "Working…" : "Ready";
  ge.busyIndicator.dataset.busy = String(busy);
  document.querySelectorAll<HTMLButtonElement>("button:not(.back-button):not([data-action='back-to-home']):not(.detail-tab):not([data-tab-link])")
    .forEach((btn) => { btn.disabled = busy; });
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function runCommand<T>(
  project: ProjectState,
  label: string,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  appendActivity(project, `Started: ${label}`);
  const startTime = Date.now();
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;

  try {
    setBusy(true);

    // Show elapsed time in the progress title
    if (project.viewElement) {
      const els = getPanelEls(project.viewElement);
      elapsedTimer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        if (els.progressTitle) els.progressTitle.textContent = `Running… ${timeStr}`;
      }, 1000);
    }

    const result = await operation();

    showResult(project, true, `${label} completed successfully`);
    appendActivity(project, `✓ ${label} done`);
    await refreshProject(project);

    // Show output if result has text
    const resultText = result != null ? JSON.stringify(result, null, 2) : null;
    if (resultText && resultText !== "null") showOutput(project, resultText);

    // Store diff for Changes tab
    if (label === "Status" && result && typeof result === "object" && "diff" in result) {
      const statusResult = result as unknown as StatusResult;
      project.lastDiff = statusResult.diff || null;
      renderChanges(project);
    }

    // Navigate to changes tab after status/pull
    if (["Status", "Pull", "Sync"].includes(label)) switchTab("changes");

    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    showResult(project, false, `${label} failed: ${msg}`);
    appendActivity(project, `✗ ${label} failed`);
    showOutput(project, msg);
    checkForScreenshot(project, error);
    switchTab("logs");
    return undefined;
  } finally {
    setBusy(false);
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    if (progressHeartbeatTimer) { clearInterval(progressHeartbeatTimer); progressHeartbeatTimer = null; }
    showProgress(project, null);
  }
}

async function handleCommand(project: ProjectState, command: string): Promise<void> {
  const api = getDesktopApi();
  const opts: DesktopProjectCommandOptions = { rootDir: project.rootDir, ...project.options };

  switch (command) {
    case "auth":            await runCommand(project, "Auth",    () => api.authProject(opts)); break;
    case "pull":            await runCommand(project, "Pull",    () => api.pullProject(opts)); break;
    case "sync-from-figma": await runCommand(project, "Sync",    () => api.syncFromFigma(opts)); break;
    case "status":          await runCommand(project, "Status",  () => api.statusProject(opts)); break;
    case "push":            await runCommand(project, "Push",    () => api.pushProject(opts)); break;
    case "verify":          await runCommand(project, "Verify",  () => api.verifyProject(opts)); break;
    case "install-browser": await installBrowser(); break;
  }
}

async function refreshProject(project: ProjectState): Promise<void> {
  if (!project.rootDir) return;
  const inspection = await getDesktopApi().inspectProject(project.rootDir);
  project.linkedProject = inspection;
  renderProject(project);
  renderProjectCard(project);
}

// ── Editor Integration ────────────────────────────────────────────────────────

async function openInEditor(editor: "code" | "cursor" | "windsurf" | "claude" | "zed"): Promise<void> {
  const project = state.activeProjectId ? state.projects.get(state.activeProjectId) : null;
  if (!project?.rootDir) {
    alert("No folder selected for this project");
    return;
  }

  const editorNames: Record<string, string> = {
    code: "VS Code",
    cursor: "Cursor",
    windsurf: "Windsurf",
    claude: "Claude Desktop",
    zed: "Zed",
  };

  try {
    const result = await getDesktopApi().openInEditor(editor, project.rootDir);
    if (!result.success) {
      alert(`Could not open in ${editorNames[editor]}.\n\nMake sure it's installed and the '${editor}' command is in your PATH.\n\nError: ${result.error || "Unknown error"}`);
    }
  } catch (error) {
    console.error(`Failed to open in ${editor}:`, error);
    alert(`Could not open in ${editorNames[editor]}. Make sure it's installed and in your PATH.`);
  }
}

// ── Onboarding ─────────────────────────────────────────────────────────────────

function checkBrowserInstalled(): void {
  // The API doesn't expose a direct check; show the banner and dismiss after install
  // If we've already dismissed it (stored in localStorage), skip
  if (!localStorage.getItem("browserInstalled")) {
    ge.onboardingBanner.removeAttribute("hidden");
  }
}

async function installBrowser(): Promise<void> {
  const project = state.activeProjectId ? state.projects.get(state.activeProjectId) : null;
  const statusEl = document.querySelector("[data-onboarding-status]") as HTMLElement;
  const btn = document.querySelector("[data-action='install-browser']") as HTMLButtonElement;

  try {
    setBusy(true);
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = "Downloading browser...";

    const result = await getDesktopApi().installBrowser();
    ge.onboardingBanner.setAttribute("hidden", "");
    localStorage.setItem("browserInstalled", "1");

    // Show success in active project if open
    if (project) {
      const msg = result.status === "already-installed"
        ? "Browser already installed"
        : "Browser installed successfully";
      showResult(project, true, msg);
    } else {
      // Show success in banner briefly before hiding
      if (statusEl) statusEl.textContent = "Browser installed successfully";
    }
  } catch (error) {
    console.error("Browser install failed:", error);
    if (statusEl) statusEl.textContent = `Install failed: ${error instanceof Error ? error.message : "Unknown error"}`;
    if (project) {
      const msg = error instanceof Error ? error.message : "Browser install failed";
      showResult(project, false, msg);
    }
  } finally {
    setBusy(false);
    if (btn) btn.disabled = false;
  }
}

async function clearAppData(): Promise<void> {
  try {
    setBusy(true);
    await getDesktopApi().clearAppData();
    localStorage.removeItem("figmake-settings");
    resetProjectsUi();
    await updateAuthStatus();
    showHome();
    alert(
      "figmake-sync app data was cleared.\n\nThe shared Figma session and remembered app state were removed. Local project folders were left untouched.",
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    if (!/cancelled/i.test(msg)) {
      alert(`Failed to clear app data:\n\n${msg}`);
    }
  } finally {
    setBusy(false);
  }
}

// ── Figma Auth (Home Level) ───────────────────────────────────────────────────

async function updateAuthStatus(): Promise<void> {
  const api = getDesktopApi();
  const indicator = document.querySelector("[data-auth-indicator]") as HTMLElement;
  const label = document.querySelector("[data-auth-label]") as HTMLElement;
  const btn = document.querySelector("[data-auth-btn]") as HTMLButtonElement;

  if (!indicator || !label || !btn) return;

  try {
    if (typeof api.checkAuthStatus !== "function") {
      indicator.dataset.authIndicator = "unknown";
      label.textContent = "Auth";
      btn.textContent = "Authenticate";
      return;
    }

    const result = await api.checkAuthStatus();
    if (result.authenticated) {
      indicator.dataset.authIndicator = "authenticated";
      label.textContent = "Figma Signed In";
      btn.textContent = "Re-auth";
    } else {
      indicator.dataset.authIndicator = "unauthenticated";
      label.textContent = "Not Signed In";
      btn.textContent = "Authenticate";
    }
  } catch {
    indicator.dataset.authIndicator = "unknown";
    label.textContent = "Auth";
    btn.textContent = "Authenticate";
  }
}

async function runFigmaAuth(): Promise<void> {
  const api = getDesktopApi();
  const btn = document.querySelector("[data-auth-btn]") as HTMLButtonElement;

  // Find a linked project if available (for project-specific auth)
  let targetProject: ProjectState | undefined;
  for (const p of state.projects.values()) {
    if (p.linkedProject?.linked && p.rootDir) {
      targetProject = p;
      break;
    }
  }

  try {
    setBusy(true);
    if (btn) btn.disabled = true;

    if (targetProject) {
      const opts: DesktopProjectCommandOptions = { rootDir: targetProject.rootDir, ...targetProject.options };
      await api.authProject(opts);
    } else {
      // No linked project — use standalone auth to figma.com
      await api.authStandalone();
    }

    await updateAuthStatus();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    alert(`Figma authentication failed:\n\n${msg}`);
  } finally {
    setBusy(false);
    if (btn) btn.disabled = false;
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  const api = getDesktopApi();

  // Home actions
  document.querySelectorAll("[data-action='add-project'], [data-action='add-first-project']")
    .forEach((btn) => btn.addEventListener("click", addProject));
  document.querySelector("[data-action='clear-app-data']")
    ?.addEventListener("click", () => {
      void clearAppData();
    });

  // Figma Auth (home level)
  document.querySelector("[data-action='figma-auth']")
    ?.addEventListener("click", () => {
      void runFigmaAuth();
    });

  // Back button
  document.querySelector("[data-action='back-to-home']")!
    .addEventListener("click", showHome);

  // Detail tab switching
  ge.detailTabs.querySelectorAll(".detail-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.getAttribute("data-tab");
      if (name) switchTab(name);
    });
  });

  // Editor open buttons
  document.querySelector("[data-action='open-vscode']")
    ?.addEventListener("click", () => {
      void openInEditor("code");
    });
  document.querySelector("[data-action='open-cursor']")
    ?.addEventListener("click", () => {
      void openInEditor("cursor");
    });
  document.querySelector("[data-action='open-windsurf']")
    ?.addEventListener("click", () => {
      void openInEditor("windsurf");
    });
  document.querySelector("[data-action='open-claude']")
    ?.addEventListener("click", () => {
      void openInEditor("claude");
    });
  document.querySelector("[data-action='open-zed']")
    ?.addEventListener("click", () => {
      void openInEditor("zed");
    });

  // Onboarding install-browser button (top level)
  document.querySelector("[data-action='install-browser']")
    ?.addEventListener("click", () => {
      void installBrowser();
    });

  // Progress events
  api.onProgress?.((event: DesktopProgressEvent) => {
    const project = state.activeProjectId ? state.projects.get(state.activeProjectId) : null;
    if (project) {
      showProgress(project, event);
    } else {
      // Show progress in onboarding banner if no project is active
      const statusEl = document.querySelector("[data-onboarding-status]") as HTMLElement;
      if (statusEl && event.message) {
        statusEl.textContent = event.message;
      }
    }
  });

  // Restore last project
  try {
    const appState = await api.loadAppState();
    if (appState?.lastProjectRoot) {
      addProject();
      const first = Array.from(state.projects.values())[0];
      if (first) {
        first.rootDir = appState.lastProjectRoot;
        await refreshProject(first);
      }
    }
  } catch { /* no saved state */ }

  // Check browser installation
  checkBrowserInstalled();

  // Check Figma auth status
  await updateAuthStatus();

  updateHomeUI();
}

void boot();

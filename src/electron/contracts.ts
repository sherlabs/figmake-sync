import type {
  InitResult,
  ProjectInspection,
  PullResult,
  PushResult,
  StatusResult,
  VerifyResult,
} from "../core/service.js";
import type { BrowserInstallResult } from "../browser/install.js";
import type { PullStrategy } from "../types/config.js";

export interface DesktopAppState {
  lastProjectRoot: string | null;
}

export interface DesktopProjectCommandOptions {
  rootDir: string;
  dryRun: boolean;
  verbose: boolean;
  prompt: boolean;
  strategy: PullStrategy;
  headless?: boolean;
}

export interface DesktopProgressEvent {
  message: string;
  timestamp: string;
  percent?: number;
  scope?: "browser-install" | "command";
}

export interface DeleteProjectResult {
  removedStateDir: boolean;
  removedFromAppState: boolean;
}

export interface ClearAppDataResult {
  clearedPaths: string[];
}

export interface RuntimeDepsResult {
  node: string | null;
  npm: string | null;
  pnpm: string | null;
}

export interface FigmakeDesktopApi {
  loadAppState(): Promise<DesktopAppState>;
  selectProjectDirectory(): Promise<ProjectInspection | null>;
  inspectProject(rootDir: string): Promise<ProjectInspection>;
  deleteProject(rootDir: string): Promise<DeleteProjectResult>;
  clearAppData(): Promise<ClearAppDataResult>;
  installBrowser(): Promise<BrowserInstallResult>;
  initProject(rootDir: string, figmaMakeUrl: string): Promise<InitResult>;
  authProject(options: DesktopProjectCommandOptions): Promise<void>;
  authStandalone(): Promise<void>;
  pullProject(options: DesktopProjectCommandOptions): Promise<PullResult>;
  syncFromFigma(options: DesktopProjectCommandOptions): Promise<PullResult>;
  statusProject(options: DesktopProjectCommandOptions): Promise<StatusResult>;
  pushProject(options: DesktopProjectCommandOptions): Promise<PushResult>;
  verifyProject(options: DesktopProjectCommandOptions): Promise<VerifyResult>;
  openInEditor(editor: string, path: string): Promise<{ success: boolean; error?: string }>;
  readFile(filePath: string): Promise<string>;
  addIgnorePattern(rootDir: string, pattern: string): Promise<{ success: boolean }>;
  removeIgnorePattern(rootDir: string, pattern: string): Promise<{ success: boolean }>;
  getCustomIgnorePatterns(rootDir: string): Promise<string[]>;
  checkRuntimeDeps(): Promise<RuntimeDepsResult>;
  checkAuthStatus(): Promise<{ authenticated: boolean; profileDir: string }>;
  onProgress(listener: (event: DesktopProgressEvent) => void): () => void;
}

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
}

export interface DesktopProgressEvent {
  message: string;
  timestamp: string;
  percent?: number;
  scope?: "browser-install" | "command";
}

export interface FigmakeDesktopApi {
  loadAppState(): Promise<DesktopAppState>;
  selectProjectDirectory(): Promise<ProjectInspection | null>;
  inspectProject(rootDir: string): Promise<ProjectInspection>;
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
  checkAuthStatus(): Promise<{ authenticated: boolean; profileDir: string }>;
  onProgress(listener: (event: DesktopProgressEvent) => void): () => void;
}

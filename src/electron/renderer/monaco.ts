import type * as Monaco from "monaco-editor";

/* The one place Monaco is loaded. It ships inside the app (copied to ./vendor/monaco by scripts/copy-electron-assets.mjs),
   so nothing is fetched from the internet. Viewers are read-only; if Monaco can't load, plain text is shown instead. */

type MonacoApi = typeof Monaco;

export interface EditorHandle {
  dispose(): void;
}
export interface DiffHandle extends EditorHandle {
  /** true = one column with the changes inline; false = before and after side by side. */
  setInline(inline: boolean): void;
}

interface AmdWindow {
  require?: { (deps: string[], ready: () => void, failed: (error: unknown) => void): void; config(options: object): void };
  MonacoEnvironment?: { getWorkerUrl(moduleId: string, label: string): string };
  monaco?: MonacoApi;
}

let loading: Promise<MonacoApi | null> | null = null;

function lightOrDark(): "vs" | "vs-dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "vs-dark" : "vs";
}

function loadMonaco(): Promise<MonacoApi | null> {
  if (loading) return loading;
  loading = new Promise<MonacoApi | null>((resolve) => {
    const w = window as unknown as AmdWindow;
    const root = new URL("./vendor/monaco", document.baseURI).href;
    const fail = (): void => {
      loading = null;
      resolve(null);
    };
    // Workers start from a blob that pulls Monaco's own worker script from the app.
    const workerSource = `self.MonacoEnvironment={baseUrl:${JSON.stringify(`${root}/`)}};importScripts(${JSON.stringify(`${root}/vs/base/worker/workerMain.js`)});`;
    const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    w.MonacoEnvironment = { getWorkerUrl: () => workerUrl };
    const script = document.createElement("script");
    script.src = `${root}/vs/loader.js`;
    script.onerror = fail;
    script.onload = () => {
      const amd = w.require; // Monaco's own loader, not Node's
      if (!amd) return fail();
      amd.config({ paths: { vs: `${root}/vs` } });
      amd(
        ["vs/editor/editor.main"],
        () => {
          const api = w.monaco;
          if (!api) return fail();
          window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => api.editor.setTheme(lightOrDark()));
          resolve(api);
        },
        fail,
      );
    };
    document.head.append(script);
  });
  return loading;
}

function languageFor(api: MonacoApi, path: string): string {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot) : "";
  const found = api.languages.getLanguages().find((l) => l.extensions?.includes(ext) || l.filenames?.includes(name));
  return found?.id ?? "plaintext";
}

const BASE: Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions = {
  readOnly: true,
  domReadOnly: true,
  minimap: { enabled: false },
  automaticLayout: true,
  scrollBeyondLastLine: false,
  fontSize: 12,
  renderLineHighlight: "none",
  contextmenu: false,
  folding: false,
  lineNumbersMinChars: 3,
  scrollbar: { alwaysConsumeMouseWheel: false },
};

function fallback(container: HTMLElement, text: string): void {
  const pre = document.createElement("pre");
  pre.className = "mv-plain";
  pre.textContent = text;
  container.replaceChildren(pre);
}

/** A read-only view of one file. Returns at once; the editor appears when Monaco is ready. */
export function createViewer(container: HTMLElement, o: { path: string; text: string }): EditorHandle {
  let disposed = false;
  let dispose = (): void => undefined;
  void loadMonaco().then((api) => {
    if (disposed) return;
    if (!api) return fallback(container, o.text);
    container.replaceChildren();
    const model = api.editor.createModel(o.text, languageFor(api, o.path));
    const editor = api.editor.create(container, { ...BASE, model, theme: lightOrDark() });
    dispose = () => {
      editor.dispose();
      model.dispose();
    };
  });
  return {
    dispose(): void {
      disposed = true;
      dispose();
      dispose = () => undefined;
    },
  };
}

/** A read-only before/after view. */
export function createDiff(container: HTMLElement, o: { path: string; before: string; after: string }): DiffHandle {
  let disposed = false;
  let inline = true;
  let editor: Monaco.editor.IStandaloneDiffEditor | null = null;
  let dispose = (): void => undefined;
  void loadMonaco().then((api) => {
    if (disposed) return;
    if (!api) return fallback(container, o.after || o.before);
    container.replaceChildren();
    const language = languageFor(api, o.path);
    const original = api.editor.createModel(o.before, language);
    const modified = api.editor.createModel(o.after, language);
    const diffEditor = api.editor.createDiffEditor(container, { ...BASE, theme: lightOrDark(), renderSideBySide: !inline, useInlineViewWhenSpaceIsLimited: false, originalEditable: false, renderOverviewRuler: false, ignoreTrimWhitespace: false });
    diffEditor.setModel({ original, modified });
    editor = diffEditor;
    dispose = () => {
      diffEditor.dispose();
      original.dispose();
      modified.dispose();
    };
  });
  return {
    setInline(value: boolean): void {
      inline = value;
      editor?.updateOptions({ renderSideBySide: !value });
    },
    dispose(): void {
      disposed = true;
      editor = null;
      dispose();
      dispose = () => undefined;
    },
  };
}

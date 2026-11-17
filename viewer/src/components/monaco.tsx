import { useEffect, useRef, useState } from "react";
import Editor, { DiffEditor, loader, type Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";

import { publicAsset } from "@/lib/assets";

// Copied from node_modules; keep lazy editor/worker files under the Pages repository base.
loader.config({ paths: { vs: publicAsset("monaco/vs") } });

export function languageOf(path: string) {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  if (path === "run" || path.endsWith(".sh")) return "shell";
  return "plaintext";
}

function useDark() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const el = document.documentElement;
    const read = () => setDark(el.classList.contains("dark"));
    read();
    const obs = new MutationObserver(read);
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

const shared: editor.IEditorOptions = {
  readOnly: true,
  minimap: { enabled: false },
  fontSize: 13,
  fontFamily: "var(--font-geist-mono), ui-monospace, Menlo, monospace",
  wordWrap: "on",
  scrollBeyondLastLine: false,
  renderLineHighlight: "none",
  automaticLayout: true,
  padding: { top: 10 },
};

export function CodeViewer({ path, text }: { path: string; text: string }) {
  const dark = useDark();
  return (
    <Editor
      height="100%"
      path={`view/${path}`}
      language={languageOf(path)}
      value={text}
      theme={dark ? "vs-dark" : "light"}
      options={shared}
    />
  );
}

export type LineTag = { line: number; rules: string[] };

// GitHub-style tags: rule ids shown after the modified-side lines that name a changed page.
export function DiffViewer({ path, original, modified, sideBySide, tags }: { path: string; original: string; modified: string; sideBySide: boolean; tags: LineTag[] }) {
  const dark = useDark();
  const ref = useRef<{ editor: editor.IStandaloneDiffEditor; monaco: Monaco } | null>(null);
  const deco = useRef<editor.IEditorDecorationsCollection | null>(null);

  const paint = () => {
    const r = ref.current;
    if (!r) return;
    const mod = r.editor.getModifiedEditor();
    deco.current?.clear();
    deco.current = mod.createDecorationsCollection(
      tags.map((t) => {
        const len = mod.getModel()?.getLineMaxColumn(t.line) ?? 1;
        return {
          range: new r.monaco.Range(t.line, len, t.line, len),
          options: { after: { content: ` ${t.rules.join(" ")} `, inlineClassName: "rule-tag" }, stickiness: 1 },
        };
      }),
    );
  };
  useEffect(paint, [tags, modified]);

  return (
    <DiffEditor
      height="100%"
      originalModelPath={`a/${path}`}
      modifiedModelPath={`b/${path}`}
      language={languageOf(path)}
      original={original}
      modified={modified}
      theme={dark ? "vs-dark" : "light"}
      onMount={(e, m) => {
        ref.current = { editor: e, monaco: m };
        e.getOriginalEditor().updateOptions({ wordWrap: "on" });
        e.getModifiedEditor().updateOptions({ wordWrap: "on" });
        e.onDidUpdateDiff(paint);
        paint();
      }}
      options={{
        ...shared,
        renderSideBySide: sideBySide,
        useInlineViewWhenSpaceIsLimited: false,
        diffWordWrap: "on",
        hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4, revealLineCount: 10 },
        renderOverviewRuler: true,
        ignoreTrimWhitespace: false,
        originalEditable: false,
      }}
    />
  );
}

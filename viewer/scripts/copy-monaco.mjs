// Serve Monaco from public/ so the editor works offline (no CDN).
import { cpSync, existsSync, rmSync } from "node:fs";

const from = "node_modules/monaco-editor/min/vs";
const to = "public/monaco/vs";
if (existsSync(from)) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}

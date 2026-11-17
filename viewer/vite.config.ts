import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import { pagesBase } from "./scripts/pages-config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { localData } from "./server/plugin";

export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env };
  if (command === "build" && (env.VITE_DATA_MODE === "local" || !env.VITE_DATA_RELEASE)) {
    throw new Error("Production requires published replay data. Use npm run build:pages with verified benchmark and runs revisions in datasets/production.json.");
  }
  return {
    base: pagesBase(env.VITE_BASE_PATH),
    plugins: [react(), tailwindcss(), localData()],
    resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
    // Allow loopback and ngrok for local development.
    server: { port: 3001, host: "localhost", allowedHosts: ["127.0.0.1", ".ngrok-free.app", ".ngrok-free.dev", ".ngrok.app", ".ngrok.io"] },
  };
});

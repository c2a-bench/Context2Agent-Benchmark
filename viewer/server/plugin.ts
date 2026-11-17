import fs from "node:fs";
import type { Connect, Plugin } from "vite";
import { getCases, getTextShard, listJobs, listTasks, runFilePath } from "./data-local";

// Local only: serve tasks/<task>/jobs as JSON under /api, the same shapes the published Blob files have.
//   /api/index.json                     → { tasks: [{ ...task, jobs }] }
//   /api/<task>/<job>/<meta|tickets|passed|code|docs|cases>.json
//   /api/<task>/<job>/texts/<2 hex>.json
//   /api/<task>/<job>/builds.json, builds/<i>.json, logtexts/<2 hex>.json   (the builder's logs)
// Mounted on the dev server and on `vite preview`, so the production build can be tried (and timed) on local runs.
function mount(middlewares: Connect.Server) {
  middlewares.use("/api", (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    // A built run file as it is on disk (not parsed and encoded again: docs.json of a big run is ~17 MB), with an
    // ETag, so the browser keeps its copy and only asks whether it changed (304).
    const sendFile = (file: string) => {
      const st = fs.statSync(file);
      const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      res.setHeader("etag", etag);
      res.setHeader("cache-control", "no-cache");
      if (req.headers["if-none-match"] === etag) {
        res.statusCode = 304;
        return res.end();
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("content-length", String(st.size));
      fs.createReadStream(file).pipe(res);
    };
    try {
      if (url.pathname === "/index.json") {
        return send(200, { tasks: listTasks().map((t) => ({ ...t, jobs: listJobs(t.id) })) });
      }
      const t = url.pathname.match(/^\/([\w-][\w.-]*)\/([\w-][\w.-]*)\/texts\/([0-9a-f]{2})\.json$/);
      if (t && !t[1].includes("..") && !t[2].includes("..")) {
        const file = runFilePath(`${t[1]}.${t[2]}`, `texts/${t[3]}.json`);
        return file ? sendFile(file) : send(200, getTextShard(`${t[1]}.${t[2]}`, t[3]));
      }
      // Build logs: builds.json, builds/<i>.json, logtexts/<2 hex>.json (scripts/build_logs.py).
      const b = url.pathname.match(/^\/([\w-][\w.-]*)\/([\w-][\w.-]*)\/(builds\.json|builds\/\d{1,3}\.json|logtexts\/[0-9a-f]{2}\.json)$/);
      if (b && !b[1].includes("..") && !b[2].includes("..")) {
        const file = runFilePath(`${b[1]}.${b[2]}`, b[3]);
        return file ? sendFile(file) : send(404, { error: `no ${b[3]} for ${b[1]}.${b[2]}` });
      }
      const m = url.pathname.match(/^\/([\w-][\w.-]*)\/([\w-][\w.-]*)\/(meta|tickets|passed|code|docs|cases)\.json$/);
      if (!m || m[1].includes("..") || m[2].includes("..")) return send(404, { error: "not found" });
      const key = `${m[1]}.${m[2]}`;
      if (m[3] === "cases") return send(200, getCases(key));
      const file = runFilePath(key, `${m[3]}.json`);
      if (file) return sendFile(file);
      return m[3] === "passed" ? send(200, []) : send(404, { error: `no ${m[3]}.json for ${key}` });
    } catch (e) {
      return send(400, { error: String(e) });
    }
  });
}

export function localData(): Plugin {
  return {
    name: "local-data",
    apply: "serve",
    configureServer(server) {
      mount(server.middlewares);
    },
    configurePreviewServer(server) {
      mount(server.middlewares);
    },
  };
}

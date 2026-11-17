import { randomUUID } from "node:crypto";
import { get, list } from "@vercel/blob";
import { retry, safePath, type Source, type SourceObject } from "./inventory";

export function blobVersion(etag: string, uploadedAt: Date) {
  const normalized = etag.replace(/^W\//, "").replace(/^\"|\"$/g, "");
  if (!normalized) throw new Error("Blob object has no ETag");
  return `${normalized}|${uploadedAt.toISOString()}`;
}
export function blobSource(prefix: string, api = { list, get }): Source {
  safePath(prefix);
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN is required for Blob inventory/export");
  const listed = new Map<string, { url: string; etag: string }>();
  return {
    async list() {
      const objects: SourceObject[] = [];
      let cursor: string | undefined;
      do {
        const result = await retry(() => api.list({ prefix: `${prefix}/`, cursor, limit: 1000 }));
        for (const blob of result.blobs) {
          if (blob.pathname.endsWith("/")) continue;
          if (!blob.pathname.startsWith(`${prefix}/`)) throw new Error("Blob returned an object outside the requested prefix");
          const path = safePath(blob.pathname.slice(prefix.length + 1));
          listed.set(path, { url: blob.downloadUrl, etag: blob.etag });
          objects.push({ path, size: blob.size, version: blobVersion(blob.etag, blob.uploadedAt) });
        }
        if (result.hasMore && (!result.cursor || result.cursor === cursor)) throw new Error("Invalid Blob pagination cursor");
        cursor = result.hasMore ? result.cursor : undefined;
      } while (cursor);
      return objects;
    },
    async read(object) {
      const metadata = listed.get(object.path);
      if (!metadata) throw new Error(`Object was not inventoried: ${object.path}`);
      const url = new URL(metadata.url);
      url.searchParams.set("snapshot-export", randomUUID());
      // Public Blob can still use CDN caching. Reject stale ETags rather than mixing source versions.
      const result = await api.get(url.toString(), { access: "public", headers: { "Cache-Control": "no-cache", "Accept-Encoding": "identity" } });
      if (!result || result.statusCode !== 200) throw new Error(`Missing Blob object: ${object.path}`);
      if (blobVersion(result.blob.etag, new Date(0)) !== blobVersion(metadata.etag, new Date(0)) || (result.blob.size > 0 && result.blob.size !== object.size)) {
        await result.stream.cancel();
        throw new Error(`Blob changed or CDN is stale: ${object.path}. Wait for publishing/CDN convergence and retry.`);
      }
      return result.stream as unknown as AsyncIterable<Uint8Array>;
    },
  };
}

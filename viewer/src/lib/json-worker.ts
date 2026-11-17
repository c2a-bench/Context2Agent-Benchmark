// Fetches and parses a run's big JSON files (code.json, docs.json, tickets…: up to tens of MB) off the main thread, so
// the page keeps responding while they load. data.ts sends { id, url } and gets back { id, data } or { id, error }.
self.onmessage = async (e: MessageEvent<{ id: number; url: string }>) => {
  const { id, url } = e.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
    (self as unknown as Worker).postMessage({ id, data: await res.json() });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};

/** Public files must stay below GitHub Pages' repository base, including Monaco's lazy-loaded files. */
export function publicAsset(file: string, base = import.meta.env.BASE_URL) {
  return `${base}${file.replace(/^\/+/, "")}`;
}

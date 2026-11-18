import resolveBench from "./introducing-resolve-bench.md?raw";

/** The blog post (one; /blog shows the first). Its body is Markdown (GitHub flavour), rendered by pages/blog-post.tsx. */
export type Post = { slug: string; title: string; summary: string; date: string; body: string };

export const POSTS: Post[] = [
  {
    slug: "introducing-resolve-bench",
    title: "C2A: can agents keep up with a business that keeps changing?",
    summary:
      "601 test cases, eight builder models and six agent architectures: what happens when coding agents build support agents, and then have to keep them up to date as the docs change.",
    date: "2026-11-09",
    body: resolveBench,
  },
];

export const postDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

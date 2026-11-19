/**
 * The blog: the one post, rendered from its Markdown (src/blog). Two comments in the Markdown become figures:
 * `<!-- figure:<name> -->` draws that landing chart from live data, and
 * `<!-- shot:<file> | <caption> | <link> -->` shows a run-page screenshot from public/blog (light and dark versions).
 */
import { Suspense, type ReactNode } from "react";
import { Link } from "react-router";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowRight } from "lucide-react";
import { Nav } from "@/landing/nav";
import { publicAsset } from "@/lib/assets";
import { POSTS, postDate } from "@/blog/posts";
import { LandingFigure, type FigureName } from "@/pages/home";
import { TicketViewer, BehaviourViewer } from "@/blog/viewers";
import "@/landing/landing.css";

const FIGURES: Record<FigureName, { title: string; from: string; caption: string; href: string }> = {
  results: {
    title: "Pass rate by builder",
    from: "Redwood Inference",
    caption: "Each column is one builder, every one run with high reasoning effort.",
    href: "/#results",
  },
  failures: {
    title: "Why tickets failed",
    from: "Redwood Inference",
    caption: "Each bar splits a builder's failure reasons: warm colours are the builder's fault, blue ones the agent's. Every builder ran with high reasoning effort. Hover a segment for its share.",
    href: "/#failures",
  },
  architecture: {
    title: "Pass rate by architecture",
    from: "Skyway Air",
    caption: "One builder (high reasoning effort), six assigned architectures; the dashed line is their average. Hover a row for its numbers.",
    href: "/#architecture",
  },
  packs: {
    title: "How changed docs move the score",
    from: "Knowledge perturbations",
    caption: "Each bar is one builder's gain or loss on a changed pack against its own complete-docs score; the big number is the typical change. Every builder ran with high reasoning effort.",
    href: "/#packs",
  },
};

const VIEWERS: Record<string, { kicker: string; title: string; caption?: string; href?: string; link?: string; View: () => ReactNode }> = {
  ticket: {
    kicker: "One ticket, six stages",
    title: "How a ticket changes",
    caption: "A simplified demo of one ticket, based on a real Skyway Air ticket and run (knowledge-graph design) where the agent really did fail at stage 3. Click a stage to replay it.",
    href: "/#environments",
    link: "See the environments",
    View: TicketViewer,
  },
  behaviours: {
    kicker: "The simulated customer",
    title: "Customer behaviors",
    caption: "Each ticket gives the customer one of these behaviors. It changes how the customer shares the facts, never the facts themselves or the right answer. Each example is a real exchange from a run, trimmed.",
    href: "/#environments",
    link: "See the environments",
    View: BehaviourViewer,
  },
};

function Frame({ kicker, title, note, caption, href, link, children }: { kicker: string; title?: string; note?: string; caption?: string; href?: string; link?: string; children: ReactNode }) {
  const inner = !href ? null : <Link to={href}>{link} <ArrowRight className="inline size-3.5" /></Link>;
  return (
    <figure className="lp-figure">
      <div className="caps muted">{kicker}</div>
      {title && <div className="lp-figure-title">{title}</div>}
      {note && <div className="lp-figure-note"><span aria-hidden="true">★</span> {note}</div>}
      <div className="lp-figure-body">{children}</div>
      {(caption || inner) && (
        <figcaption>
          {caption} {inner && <span className="lp-figure-link">{inner}</span>}
        </figcaption>
      )}
    </figure>
  );
}

/** A Markdown link to `#tip` is a hover note, not a link: `[668 test cases](#tip "how it adds up")`. */
const MD: Components = {
  a: ({ href, title, children, ...rest }) =>
    href === "#tip" ? (
      <span className="lp-tip" tabIndex={0} data-tip={title ?? ""} aria-label={title ?? undefined}>{children}</span>
    ) : href?.startsWith("/") && !href.startsWith("//") ? (
      <Link to={href} title={title} {...rest}>{children}</Link>
    ) : (
      <a href={href} title={title} {...rest}>{children}</a>
    ),
};

const PART = /<!--\s*(figure|shot):\s*([\w-]+)\s*(?:\|\s*([\s\S]*?)\s*\|\s*(\S+)\s*)?-->/g;

function Body({ md }: { md: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of md.matchAll(PART)) {
    const text = md.slice(last, m.index);
    if (text.trim()) out.push(<Markdown key={`t${last}`} remarkPlugins={[remarkGfm]} components={MD}>{text}</Markdown>);
    const [, kind, name, caption = "", href = "/"] = m;
    if (kind === "figure" && name in VIEWERS) {
      const v = VIEWERS[name];
      out.push(
        <Frame key={name} kicker={v.kicker} title={v.title} caption={v.caption} href={v.href} link={v.link}>
          <v.View />
        </Frame>,
      );
    } else if (kind === "figure" && name in FIGURES) {
      const f = FIGURES[name as FigureName];
      out.push(
        <Frame key={name} kicker={`From: ${f.from}`} title={f.title} note="All runs at high reasoning effort" caption={f.caption} href={f.href} link="See it on the results page">
          <Suspense fallback={<div className="lp-figure-wait muted">Loading the latest runs…</div>}>
            <LandingFigure name={name as FigureName} compact />
          </Suspense>
        </Frame>,
      );
    } else if (kind === "shot") {
      out.push(
        <Frame key={name} kicker="From a run page" caption={caption} href={href} link="Open this run">
          <img src={publicAsset(`blog/${name}-light.jpg`)} alt={caption} className="lp-shot dark:hidden" loading="lazy" />
          <img src={publicAsset(`blog/${name}-dark.jpg`)} alt={caption} className="lp-shot hidden dark:block" loading="lazy" />
        </Frame>,
      );
    }
    last = m.index! + m[0].length;
  }
  const rest = md.slice(last);
  if (rest.trim()) out.push(<Markdown key={`t${last}`} remarkPlugins={[remarkGfm]} components={MD}>{rest}</Markdown>);
  return <>{out}</>;
}

export default function BlogPost() {
  const post = POSTS[0];
  return (
    <div className="lp min-h-screen">
      <Nav />
      <main className="lp-wrap" style={{ paddingTop: "calc(var(--nav) + clamp(56px, 9vh, 112px))", paddingBottom: 140 }}>
        <article className="lp-article">
          <div className="caps muted">{postDate(post.date)}</div>
          <h1 style={{ marginTop: 16, fontSize: "clamp(36px, 2.6vw + 22px, 64px)", lineHeight: 1.08 }}>{post.title}</h1>
          <div className="lp-prose" style={{ marginTop: 48 }}>
            <Body md={post.body} />
          </div>
        </article>
      </main>
    </div>
  );
}

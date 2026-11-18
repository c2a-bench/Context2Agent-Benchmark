---
name: llm-wiki
description: Turn a folder of source documents into a wiki of linked markdown notes that an LLM agent reads or greps at runtime, and keep it current when the sources change.
---

# LLM wiki

One way to give an LLM agent its knowledge: instead of searching the raw documents for every request,
compile them once into a wiki of short, linked markdown notes, and let the agent read or grep that wiki.
Based on Andrej Karpathy's "LLM Wiki" pattern (https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

## Layers

1. **Sources**: the original documents. Read them; never edit them.
2. **Wiki**: markdown notes you write, one topic per note, each saying where its facts came from.
3. **Schema**: one file with the wiki's conventions (note names, sections, how links are written),
   so every note follows the same shape.

Keep two more files next to the notes:

- `index.md`: every note with a one-line summary, so the agent can pick notes without opening all of them.
- `log.md`: what was added or changed, and from which source, newest first.

## Ingest (build or update the wiki)

For each source document:

1. Read it whole.
2. Update every note it touches, or add a note when the topic is new. Copy facts exactly
   (names, numbers, values); do not round or paraphrase them.
3. Link related notes to each other.
4. When the source disagrees with an existing note, decide which one is current and say so in the note;
   do not keep two answers side by side without saying which wins.
5. Update `index.md` and append to `log.md`.

## Query (at runtime)

1. Read `index.md` and pick the notes that match the request, or grep the wiki for its key terms.
2. Read those notes and follow their links when needed.
3. Give the model the note text it needs, not the whole wiki.

## Lint (after every change to the sources)

- Every source change is reflected in the notes it affects.
- No note contradicts another or still states a value that changed.
- No note is missing from `index.md`, and no link points to a note that does not exist.
- Notes that no longer apply are removed or marked as replaced.

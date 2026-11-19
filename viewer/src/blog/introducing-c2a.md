Most agent benchmarks assume the world is static, with knowledge clearly defined, processes documented, and all edge
cases identified. But as any CX operator knows – real support operations don't work that way.

A new offer launches on
Tuesday, a refund policy gets an exception, a deprecated policy lingers in an old knowledge base article, and the human
agents answering customers need to work out the most current, accurate information to keep things flowing. For an AI
agent, the changing conditions make the complexities of CX even harder to navigate.

So the question we care about isn't only *whether an agent resolves an issue.*

It's *can an agent learn a business's context, and keep learning it as that context changes to always resolve the
customer's issue?*

Since more and more support agents are now written by coding agents rather than by hand, there is a second question
hiding inside the first: *can an agent build, and then maintain, another agent?*

**C2A, the Context to Agent Benchmark**, is our attempt to measure that. We have measured top models, compared performance, and scored them to
understand how well these different models handle the complexity of CX operations while creating and updating
customer-facing AI Agents.

Today it covers **[668 test cases](#tip "Redwood Inference 290 + Skyway Air 311 + knowledge packs 67 = 668. Of the 67 knowledge-pack tickets, 28 come from Redwood's first stage and 39 were written for the packs.") across three environments**, seven builder
models, and six agent architectures. All runs, tickets, and transcripts are public at
[the results viewer](/).

## Inside the benchmark

Each test run mirrors how a support agent is built and deployed in practice:

1. **Business context.** A company's knowledge is spread across knowledge management systems, CRMs, LMS, email, and
   UCaaS systems. Any one ticket needs several facts that live in different places.
2. **Builder.** A coding agent (Codex, Claude Code, Gemini CLI, or pi) reads the docs and writes a support agent:
   its prompts, its code, and however it chooses to store the company's knowledge. It must describe what it built in an `ARCHITECTURE.json` that we later check against what the agent actually does.
3. **Support agent.** At test time, the agent no longer has access to the source docs. It runs on a fixed model inside a
   ticket system and relies only on what the builder gave it (its prompts, code and stored knowledge). Its tools are real
   API calls to the ticket system. The decisions are made by the model, not by hard-coded logic.
4. **Customer.** A simulated customer contacts support. Each customer follows one of 14 behaviors,
   from vague or self-correcting to pushy, urgent, or switching goals mid-conversation, and some facts are known only to
   the customer, so the agent has to ask.
5. **Judge.** The judge reads everything the builder gave the agent and checks, rule by rule, whether the facts each
   ticket needs are there, quoting the agent's own lines as proof. It also reads each conversation and marks which facts
   the customer actually gave. It never decides pass or fail; it tells us why a ticket failed.
6. **Resolution check.** A ticket counts as resolved only if the support system ends up exactly as expected (right fields,
   right labels, no forbidden writes, protected records untouched).

## The three test environments

| Environment | What it tests | Test cases |
|---|---|---|
| **Redwood Inference** | An AI inference company. The builder chooses the architecture. Six stages of changing docs. | 290 |
| **Skyway Air** | An airline with ~10,000 docs. The architecture is *fixed* per run, one of six, so we can compare designs directly. | 311 |
| **Knowledge perturbations** | A separate set of Redwood Inference tickets, with the docs rewritten five ways: complete, fragmented, incomplete, conflicting, noisy. We call each version of the docs a *pack*. The same tickets in every pack. | 67 |

## What a test run looks like

### One ticket, six stages

Here is one ticket from Skyway Air, our airline environment, followed through all six stages. At each stage you see
the docs change, the builder update the agent, the customer send a message, the agent look things up and act, and whether the
ticket passed.

<!-- figure:ticket -->

### How customers behave

In every ticket, the customer follows one of 14 behaviors, the way real customers make support harder. Pick a behavior to
see a real exchange from a run, and what it tests.

<!-- figure:behaviours -->

## How we grade

The grader answers two questions about every ticket: **did it pass**, and if not, **why**. Plain code answers the first
question. A judge model helps with the second.

### Deciding whether a ticket passed

**The agent works in a real support system.** Every ticket starts with a fresh copy of a support system (the kind of ticketing tool a support team uses), with customers,
tickets, contracts and API keys. The agent can look things up and make changes: set a ticket's priority, add a label,
issue a credit, or hand the ticket to a person.

**It is judged on what it did to the support system.** When the conversation is over, the grader compares the
support system with the answer key. Every required field must have the right value, and every required label must be there. Records the agent
must not touch, like a customer's API keys, must be unchanged. Even *trying* a forbidden action fails the ticket.

**The check is plain code.** A model never votes on pass or fail.

**The simulated customer is deliberately difficult.** It contacts support following one of 14 behaviors, such as being
vague, changing their mind, or asking for a person. Some facts only the customer knows, and they share them only if the
agent asks.

**Some tickets go wrong on purpose.** Redwood Inference has six stages, numbered 0 to 5. From stage 3 on, we add
problems that real deployments run into to a few tickets, to see whether the agent copes:

- we stop the agent right after it changes something, then start it again; it must not make the same change twice;
- we make the files it saved (its notes, pages and indexes) unreadable, so it must still work without them;
- the support system returns an error the first time the agent tries to update something;
- in stages 4 and 5, some tickets limit the agent's prompt to about 6,000 tokens.

### Finding out why a ticket failed

**We record everything the agent does.** Every call it makes to its underlying model (`gpt-5.6-sol`) is logged: what it asked, what came back,
and what it cost. So we can tell whether a change to the ticket came from the model, or from a value the builder wrote
into the code. The agent can't turn this recording off.

**A judge reads the agent's files.** After the run, a judge model checks, rule by rule, whether the agent's files hold
the facts each ticket needed. It must quote the exact line, and if the quote isn't in the files, it doesn't count. It
also reads each conversation and notes which facts the customer gave.

**We measure more than right or wrong.** That reading gives four numbers for every run:

- **Rule recall:** of the facts a ticket needed, how many were in the agent's files.
- **Rule precision:** of the facts the agent kept, how many were the right version, not an outdated or look-alike one.
- **Customer recall:** of the facts only the customer knew, how many the agent got out of them.
- **Customer precision:** of the questions the agent asked, how many were about something the ticket depended on.

**We attribute every failure to a cause.** Code decides who is to blame:

- **the builder**, if a needed fact never made it into the agent's files;
- **the agent**, if it had the fact and still got the ticket wrong, or never asked the customer;
- **harness**, if our own system or the model provider broke. We rerun those tickets.

**We verify the builder's description of its agent.** The builder must describe its agent in a file, `ARCHITECTURE.json`: its
tools, how it finds knowledge, and whether it can hand tickets to a person. We compare that with what the agent
actually did.

**Each ticket is labelled by the type of change it tests.** A ticket tests a new rule, an old rule that still holds, or an old rule that
changed. That shows which kind of change breaks an agent.



## Where the frontier stands today

The builder decides most of the outcome. On the same agent model, the best builders resolve about 80% of tickets and
the weakest about 60%.

For the best builders, the knowledge is rarely missing; **using it on a live ticket is the hard
part.** How the agent stores its knowledge matters too, and **missing facts hurt far more than messy docs.**

<!-- figure:results -->

- **The best builders resolve about 80% of tickets, and the spread is wide.** On Redwood Inference, `gpt-6.1-sol`
(Codex) resolves **80%** of 290 tickets, `claude-opus-5-5` (Claude Code) and `deepseek-v4.1-flash-1017` (pi) **78%**, and
`glm-5.3` (pi) **76%**. Six of the seven builders land between **70%** and **80%**.

  At the bottom, `gemini-4-carbon` resolves **60%**, held back by its first build, which stopped before the agent could
  run, so every ticket of that stage failed. Every builder
  gives its agent the *same* runtime model, so the **20-point** gap is down to how well the builder turned the docs into an
  agent.

<!-- figure:failures -->

- **Strong builders capture the knowledge; their remaining failures come from how the agent uses it.** Five of the seven
builders lost almost no checks on their own side (**0** to **10** each), while their agents still failed **98** to **131**
checks on wrong values, forbidden actions, or facts they never asked the customer for.

  Weaker builders fail on both fronts:
  `claude-sonnet-5-5` lost **113** checks to missing knowledge on top of **104** agent-side failures. Once a builder gets the knowledge into the
  agent's files, the bottleneck moves to whether the agent finds and *applies* it, and an agent built with every rule can still
  fail to use them on a live ticket.

<!-- figure:architecture -->

- **Architecture matters, but less than the builder.** Six builders each built all six assigned architectures. Pooled over
the builders, three designs finish level: a knowledge graph queried at runtime, an LLM-compiled wiki browsed with terminal
tools, and a no-retrieval prompts-and-workflows baseline each resolved **56%** of Skyway's 311 tickets. Raw docs with
terminal tools reached **53%**, and the two index-search designs came last, at **48%** (wiki) and **43%** (raw docs).

  We compared two pairs of designs that each differ in one way: moving from raw docs to wiki notes
  helps whether the agent uses terminal tools or index search **(raw → wiki: 53% → 56% with terminal tools, 43% → 48% with
  index search)**, and terminal tools beat index search for both raw docs and wiki notes.

  The builder moves the score more than the design does. Pooled over the six designs, builders range from **40%**
  (`deepseek-flash`) to **67%** (`claude-opus-5-5`), and the six builders' best designs are four different ones.

  One run pulls a number down: `gemini-4-carbon`'s wiki-with-index-search agent never started in five of its six stages.
  Without that run, wiki with index search would be at **56%**.

- **Different designs break in different ways when the docs change.** Splitting Skyway's tickets by type, the knowledge
graph was the best at picking up *changed* facts (**55%** adaptability, with **59%** discovery and **53%** regression), while
the LLM wiki with terminal tools was the best at holding on to the unchanged ones (**56%** regression) but weaker on the
changed ones (**51%** adaptability). Raw-docs index search fell furthest on changed facts (**34%**). No design
wins every column, which is exactly why a single-stage benchmark would miss this.

<!-- figure:packs -->

- **Facts missing from the docs hurt; messy docs, less than you'd expect.** Each builder is compared with its own score
on the complete docs. Removing some facts the tickets need (R-incomplete) cost the typical builder **15 points**, and **all 7** builders
scored lower. Fragmented, conflicting, and noisy docs moved the typical builder by **−1**, **+1**, and **+4** points: no clear
change.

  Builder-to-builder variance is large here and the pack is small (67 tickets), so we read this cautiously, but the direction is consistent: today's builders are better at sorting through
  clutter than at noticing what isn't there.

## How the models behave

Every agent in these runs answers tickets with the same model, `gpt-5.6-sol`. What differs is the builder: the model
that read the docs and wrote the agent.

So every difference below comes from how each builder works.

1. **All builders chose the same design; they differ in how well they built it.** All seven builders gave their agent much the same
   design: short notes written from the docs, searched by keyword. So the design doesn't separate them here; how carefully
   they build it does.

2. **Most agents stay steady as the docs change; a few swing widely.** `gpt-6.1-sol` and
   `deepseek-v4.1-flash-1017` stayed between **74%** and **86%** at every stage. `claude-sonnet-5-5` swung between **55%**
   and **95%**. Three builders' agents dropped to about **55%** at stage 4, where some tickets cap the agent's prompt.

3. **Spending more on the build doesn't give a better agent.** `gpt-6-astra` spent far more than `gpt-6.1-sol` on its builds, and
   built a weaker agent. `deepseek-v4.1-flash-1017` spent the least of all and built one of the best.

4. **How the builder writes the agent decides what each ticket costs.** Some agents call the model far more often per ticket than others,
   and they don't pass more tickets for it: `deepseek-v4.1-flash-1017`'s agent makes about three times as many model calls
   per ticket as `glm-5.3`'s, for about the same score.

5. **Even the best agents make mistakes when they have all the rules.** For `gpt-6.1-sol` and `gpt-6-astra`, almost every failure was a
   wrong change to the ticket, not a missing rule.

6. **Missing facts hurt more than messy docs.** When facts were removed from the docs, most builders lost tickets.
   When the docs were split up, contradicted, or padded with noise, most did as well as with clean docs.

7. **Some builders struggle when a rule is spread across several pages.** `deepseek-v4.1-flash-1017` built the best agent of all from
   the complete docs, but lost about a quarter of its score when the same rules were split across several pages.

8. **Some builds end without a working agent.** `gemini-4-carbon`'s first Redwood build ended without a
   working agent: Gemini's reply hit its length limit mid-build and the build stopped there, so every ticket of that stage
   failed.

## The bigger picture

Benchmarks like τ-bench asked whether an agent can follow a business's policies. Newer work, such as Sierra's
[Hyper-τ-bench](https://sierra.ai/blog/hyper-t-bench-evaluating-agents-that-build-agents), asks whether an agent can
build that agent in the first place.

C2A adds the part every forward-deployed team lives with: the business keeps moving. A support AI agent isn't
shipped once. It's maintained through every pricing change, every policy exception, and every stale page nobody
deleted. Business policy and procedure is fluid and the agent must adapt and learn, while upholding the highest
standards.

Measuring that takes more than a pass rate. It takes knowing *who* failed (the builder that lost a fact, or the agent
that had it and still got it wrong), *what kind* of change broke it, and *which design* holds up. That is what we've
tried to make visible, ticket by ticket.

We'll keep adding environments, builders, and architectures, and we'll publish every run as it lands.

**Explore the results:** [Leaderboard and charts](/) ·
[Redwood Inference runs](/t/redwood-inference) ·
[Skyway Air runs](/t/skyway-air) ·
[Knowledge perturbation runs](/t/support-agent-knowledge)

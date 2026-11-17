Most agent benchmarks assume the world is static, with knowledge clearly defined, processes documented, and all edge
cases identified. But as any CX operator knows – real support operations don't work that way.

A new offer launches on
Tuesday, a refund policy gets an exception, a deprecated policy lingers in an old knowledge base article, and the human
agents answering customers need to discern the most current, accurate information to keep things flowing. For an AI
agent, the changing conditions make the complexities of CX even harder to navigate.

So the question we care about isn't only *whether an agent resolves an issue.*

It's *can an agent learn a business's context, and keep learning it as that context changes to always resolve the
customer's issue?*

Since more and more support agents are now written by coding agents rather than by hand, there is a second question
hiding inside the first: *can an agent build, and then maintain, another agent?*

Resolve Bench is our attempt to measure that. We have measured top models, compared performance, and scored them to
understand how well these different models can handle the complexity of CX operations while creating and updating
customer-facing AI Agents.

Today it covers **[668 test cases](#tip "Redwood Inference 290 + Skyway Air 311 + knowledge packs 67 = 668. Of the 67 knowledge-pack tickets, 28 come from Redwood's first stage and 39 were written for the packs.") across three environments**, eight builder
models, and six agent architectures. All runs, tickets, and transcripts are public at
[the results viewer](/).

## Inside the benchmark

Every run follows the same path a real deployment does.

1. **Business context.** A company's knowledge is spread across knowledge management systems, CRMs, LMS, email, and
   UCaaS systems. Any one ticket needs several facts that live in different places.
2. **Builder.** A coding agent (Codex, Claude Code, Gemini CLI, or pi) reads the docs and writes a support agent:
   its prompts, its code, and however it chooses to store the company's knowledge. It must describe what it built in an `ARCHITECTURE.json` that we later check against what the agent actually does.
3. **Support agent.** At test time, the docs are gone. The agent runs on a fixed model inside a ticket system and only
   has what the builder left it. Its tools are real API calls against the desk; the model must make the decisions, not
   hard-coded logic.
4. **Customer.** A simulated customer writes in and sends up to five messages. Each one acts out one of 14 behaviors,
   from vague or self-correcting to pushy, urgent, or switching goals mid-conversation, and some facts are known only to
   the customer, so the agent has to ask.
5. **Judge.** The judge reads everything the builder left the agent and checks, rule by rule, whether the facts each
   ticket needs are there, quoting the agent's own lines as proof. It also reads each conversation and marks which facts
   the customer actually gave. It never decides pass or fail; it tells us why a ticket failed.
6. **Resolution check.** A ticket counts as resolved only if the desk ends in exactly the right state (right fields,
   right labels, no forbidden writes, protected records untouched).

## Three environments

| Environment | What it isolates | Test cases |
|---|---|---|
| **Redwood Inference** | An AI inference company. The builder chooses the architecture. Six stages of changing docs. | 290 |
| **Skyway Air** | An airline with ~10,000 docs. The architecture is *fixed* per run, one of six, so we can compare designs directly. | 311 |
| **Knowledge perturbations** | A separate set of Redwood Inference tickets, with the docs rewritten five ways: complete, fragmented, incomplete, conflicting, noisy. The same tickets in every pack. | 67 |

## See it in action

### One ticket, six stages

Here is one ticket from Skyway Air, our airline environment, followed through all six stages. At each stage you see
the docs change, the builder update the agent, the customer write in, the agent look things up and act, and whether the
ticket passed.

<!-- figure:ticket -->

### How customers behave

Every ticket's customer acts out one of 14 behaviors, the way real customers make support harder. Pick a behavior to
see a real exchange from a run, and what it tests.

<!-- figure:behaviours -->

## What we measure

A pass rate says how often an agent got it right, not why. So every run records much more: who failed and how, what
knowledge the builder kept, what the agent got out of the customer, and how it all holds up as the docs change. Each
question below opens that view of a real run.

<!-- figure:measures -->

## Where the frontier stands today

The builder decides most of the outcome. On the same agent model, the best builders resolve four tickets in five and
the weakest about two in five.

For the best, the knowledge is rarely missing; **using it on a live ticket is the hard
part.** How the agent stores its knowledge matters too, and **missing facts hurt far more than messy docs.**

<!-- figure:results -->

**The best builders resolve about four in five tickets, and the spread is wide.** On Redwood Inference, gpt-6.1-sol
(Codex) resolves 80% of 290 tickets and claude-opus-5-5 (Claude Code) 78%, followed by gpt-6-astra at 72% and
claude-sonnet-5-5 at 70%. The bottom half sits between 43% and 54%. Every builder gives its agent the *same* runtime
model, so the 37-point gap is down to how well the builder turned the docs into an agent.

<!-- figure:failures -->

**Strong builders stop losing knowledge; what's left is execution.** The top three builders had almost no builder-side
failures (0, 3, and 0 failed checks from missing knowledge or build specification failure), while their agents still failed 39–45
checks on wrong values, forbidden actions, or facts never asked of the customer. Weaker builders fail on both fronts:
glm-5.3 lost 63 checks to missing knowledge on top of 66 agent-side failures. Once a builder gets the knowledge into the
agent's files, the bottleneck moves to whether the agent finds and *applies* it, and an agent built with every rule can still
fail to use them on a live ticket.

<!-- figure:architecture -->

**Architecture matters.** With the builder held fixed (gpt-6.1-sol), and the architecture assigned, a knowledge graph queried at runtime resolved 70% of Skyway's 311
tickets, an LLM-compiled wiki browsed with terminal tools 66%, a no-retrieval prompts-and-workflows baseline 57%, and
plain raw-docs index search came last at 49%. Two pairs isolate one variable each: moving from raw docs to wiki notes
helps under both access methods (raw → wiki: 56% → 66% with terminal tools, 49% → 54% with index search), and terminal
access beats index search for both kinds of knowledge.

**Different designs break in different ways when the docs change.** Splitting Skyway's tickets by type, the knowledge
graph was the most even (71% discovery, 69% regression, 66% adaptability), while the LLM wiki was the best of all six at
picking up *changed* facts (76% adaptability) but weaker at holding on to the unchanged ones (57% regression). No design
wins every column, which is exactly why a single-stage benchmark would miss this.

<!-- figure:packs -->

**Missing knowledge hurts; messy knowledge, less than you'd expect.** Across builders, removing some needed facts from
the docs (R-incomplete) dropped pass rate by 15 points against complete docs. Fragmented, conflicting, and noisy docs did
not lower the average: they came in 6, 13, and 7 points *above* it. Builder-to-builder variance is large here, the
pack is small (67 tickets), and the three runs where the agent never started are left out, so we read this cautiously, but the direction is consistent: today's builders are better at
sorting through clutter than at noticing what isn't there.

## Inside a single run

Every number above links back to the run that produced it. Each run has its own pages, and they are where the
benchmark is most useful: you can watch an agent drift as the docs change, and read the exact ticket where it went
wrong. Here is one Redwood run, built by deepseek-v4.1-flash-1017.

<!-- shot:run-stages | Tickets passed at each stage. After the first build the agent resolves 77% of tickets; four doc updates later, about a fifth. The purple bars are old tickets whose answer changed: by stages 3 and 4 it gets none of them right. | /runs/redwood-inference.2026-11-06__06-39-23-facts/research/rq1 -->

The drop isn't the new tickets alone. Old tickets whose answer *changed* (adaptability) fall to 0% at stages 3 and 4,
and old tickets whose answer didn't change (regression) slide too: each update the builder makes to the agent costs it
some of what it already knew.

<!-- shot:run-ticket | One failed ticket, with what the grader found. The agent's files hold all seven facts the ticket needs, and it got all four decisive facts out of the customer, then still tagged a timeout outage as a 5xx error. The fault is the agent's, not the builder's. | /runs/redwood-inference.2026-11-06__06-39-23-facts/tickets -->

Every failed ticket opens like this: the full conversation, which of the needed facts were in the agent's files,
which customer facts it asked for, and which check failed and why.

<!-- shot:run-customers | How much the agent got out of each kind of customer. A plain customer gives up 66% of the facts only they know; a customer who answers only what they're asked (on request) gives up 52%, and one asking for a person 60%. | /runs/redwood-inference.2026-11-06__06-39-23-facts/research/behavior -->

The customer matters as much as the docs. Customers who only answer what they're asked, or who want a human, hide
more of the facts the ticket needs, and an agent that doesn't ask the right questions never finds them.

## The bigger picture

Benchmarks like τ-bench asked whether an agent can follow a business's policies. Newer work, such as Sierra's
[Hyper-τ-bench](https://sierra.ai/blog/hyper-t-bench-evaluating-agents-that-build-agents), asks whether an agent can
build that agent in the first place.

Resolve Bench adds the part every forward-deployed team lives with: the business keeps moving. A support AI agent isn't
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

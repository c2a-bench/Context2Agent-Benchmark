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

**C2A, the Context to Agent Benchmark**, is our attempt to measure that. We have measured top models, compared performance, and scored them to
understand how well these different models can handle the complexity of CX operations while creating and updating
customer-facing AI Agents.

Today it covers **[668 test cases](#tip "Redwood Inference 290 + Skyway Air 311 + knowledge packs 67 = 668. Of the 67 knowledge-pack tickets, 28 come from Redwood's first stage and 39 were written for the packs.") across three environments**, seven builder
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

## How we grade

The grader answers two questions about every ticket: **did it pass**, and if not, **why**. Plain code answers the first
question. A judge model helps with the second.

### Did the ticket pass?

**The agent works on a real support desk.** Every ticket starts with a fresh copy of a support system, with customers,
tickets, contracts and API keys. The agent can look things up and make changes: set a ticket's priority, add a label,
issue a credit, or hand the ticket to a person.

**It is judged on what it did to the desk.** When the conversation is over, the grader compares the desk with the
answer key. Every required field must have the right value, and every required label must be there. Records the agent
must not touch, like a customer's API keys, must be unchanged. Even *trying* a forbidden action fails the ticket.

**No model decides the score.** That comparison is plain code. A model never votes on pass or fail.

**The customer doesn't make it easy.** A simulated customer writes in, acting out one of 14 behaviors, such as being
vague, changing their mind, or asking for a person. Some facts only the customer knows, and they share them only if the
agent asks.

**Some tickets go wrong on purpose.** From stage 3 on, a few tickets bring the problems real deployments hit

- the agent is stopped right after it changes something, then started again; it must not make the change twice;
- the files it saved can't be opened;
- the support system answers its first change with an error;
- in stages 4 and 5, its prompt is limited to about 6,000 tokens.

### Why did it fail?

**We record everything the agent does.** Every call it makes to its model is logged: what it asked, what came back,
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

**Every failure gets an owner.** Code then decides who is to blame:

- **the builder**, if a needed fact never made it into the agent's files;
- **the agent**, if it had the fact and still got the ticket wrong, or never asked the customer;
- **harness**, if our own system or the model provider broke. We rerun those tickets.

The judge only explains failures. It never turns a fail into a pass.

**We check what the builder says it built.** The builder must describe its agent in a file, `ARCHITECTURE.json`: its
tools, how it finds knowledge, and whether it can hand tickets to a person. We compare that with what the agent
actually did.

**Each ticket is tagged by what changed.** A ticket tests a new rule, an old rule that still holds, or an old rule that
changed. That shows which kind of change breaks an agent.



## Where the frontier stands today

The builder decides most of the outcome. On the same agent model, the best builders resolve four tickets in five and
the weakest about three in five.

For the best, the knowledge is rarely missing; **using it on a live ticket is the hard
part.** How the agent stores its knowledge matters too, and **missing facts hurt far more than messy docs.**

<!-- figure:results -->

- **The best builders resolve about four in five tickets, and the spread is wide.** On Redwood Inference, `gpt-6.1-sol`
(Codex) resolves **80%** of 290 tickets, `claude-opus-5-5` (Claude Code) and `deepseek-v4.1-flash-1017` (pi) **78%**, and
`glm-5.3` (pi) **76%**. Six of the seven builders land between **70%** and **80%**.

  At the bottom, `gemini-4-carbon` resolves **60%**, held back by a first build whose agent never started. Every builder
  gives its agent the *same* runtime model, so the **20-point** gap is down to how well the builder turned the docs into an
  agent.

<!-- figure:failures -->

- **Strong builders stop losing knowledge; what's left is execution.** Five of the seven builders had almost no
builder-side failures (between **0** and **10** failed checks from missing knowledge or build specification failure), while
their agents still failed **98** to **131** checks on wrong values, forbidden actions, or facts never asked of the customer.

  Weaker builders fail on both fronts:
  `claude-sonnet-5-5` lost **113** checks to missing knowledge on top of **104** agent-side failures. Once a builder gets the knowledge into the
  agent's files, the bottleneck moves to whether the agent finds and *applies* it, and an agent built with every rule can still
  fail to use them on a live ticket.

<!-- figure:architecture -->

- **Architecture matters.** With the builder held fixed (`gpt-6.1-sol`), and the architecture assigned, a knowledge graph queried at runtime resolved **70%** of Skyway's 311 tickets, an LLM-compiled wiki browsed with terminal tools **66%**, a no-retrieval prompts-and-workflows baseline **57%**, and
plain raw-docs index search came last at **49%**.

  Two pairs isolate one variable each: moving from raw docs to wiki notes
  helps under both access methods **(raw → wiki: 56% → 66% with terminal tools, 49% → 54% with index search)**, and terminal
  access beats index search for both kinds of knowledge.

- **Different designs break in different ways when the docs change.** Splitting Skyway's tickets by type, the knowledge
graph was the most even (**71%** discovery, **69%** regression, **66%** adaptability), while the LLM wiki was the best of all six at
picking up *changed* facts (**76%** adaptability) but weaker at holding on to the unchanged ones (**57%** regression). No design
wins every column, which is exactly why a single-stage benchmark would miss this.

<!-- figure:packs -->

- **Missing knowledge hurts; messy knowledge, less than you'd expect.** Each builder is compared with its own score on
the complete docs. Removing some needed facts (R-incomplete) cost the typical builder **15 points**, and **all 7** builders
scored lower. Fragmented, conflicting, and noisy docs moved the typical builder by **−1**, **+1**, and **+4** points: no clear
change.

  Builder-to-builder variance is large here and the pack is small (67 tickets), so we read this cautiously, but the direction is consistent: today's builders are better at sorting through
  clutter than at noticing what isn't there.

## How the models behave

Every agent in these runs answers tickets with the same model, `gpt-5.6-sol`. What differs is the builder: the model
that read the docs and wrote the agent.

So every difference below comes from how each builder works.

1. **Builders agree on the design, not on how well they build it.** All seven builders gave their agent much the same
   design: short notes written from the docs, searched by keyword. So the design doesn't separate them here; how carefully
   they build it does.

2. **Most builders keep their agent steady as the docs change; a few swing.** `gpt-6.1-sol` and
   `deepseek-v4.1-flash-1017` stayed between **74%** and **86%** at every stage. `claude-sonnet-5-5` swung between **55%**
   and **95%**. Three builders' agents dropped to about **55%** at stage 4, where some tickets cap the agent's prompt.

3. **Spending more doesn't build a better agent.** `gpt-6-astra` spent far more than `gpt-6.1-sol` on its builds, and
   built a weaker agent. `deepseek-v4.1-flash-1017` spent the least of all and built one of the best.

4. **The builder decides what each ticket costs.** Some agents call the model far more often per ticket than others,
   and they don't pass more tickets for it: `deepseek-v4.1-flash-1017`'s agent makes about three times as many model calls
   per ticket as `glm-5.3`'s, for about the same score.

5. **The best agents have the rules and still slip.** For `gpt-6.1-sol` and `gpt-6-astra`, almost every failure was a
   wrong change to the ticket, not a missing rule.

6. **Missing facts hurt more than messy docs.** When facts were removed from the docs, most builders lost tickets.
   When the docs were split up, contradicted, or padded with noise, most did as well as with clean docs.

7. **Some builders can't join facts spread across pages.** `deepseek-v4.1-flash-1017` built the best agent of all from
   the complete docs, but lost about a quarter of its score when the same rules were split across several pages.

8. **Some builders hand over an agent that never starts.** `gemini-4-carbon`'s first Redwood build ended without a
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

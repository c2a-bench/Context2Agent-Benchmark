export type Diff = ["=" | "-" | "+", string][];
export type DocRef = { path: string; title: string; status: string; updated: string };
export type RuleStatus = "starting" | "new" | "changed" | "unchanged";

export type Rule = {
  id: string;
  status: RuleStatus;
  text: string;
  diff: Diff | null;
  what: string;
  sources: DocRef[];
  traps: DocRef[];
  quote: string;
  trapQuote: string;
  why?: string;
  sure?: boolean;
};

export type Blocked = { rule: string; status: RuleStatus; turns: number[]; quote: string; confidence: number; why: string };

export type Failure = {
  line: string;
  kind: "field" | "forbidden" | "missing";
  field: string | null;
  turn: number | "end";
  note: string;
  rules: Rule[];
  blockedBy: Blocked[];
  fault?: Fault | null;
};

/** Who the grader blames for a failure: us, the builder, or the bot. Every ticket counts in the score. */
export type FaultSide = "us" | "builder" | "bot";
export type Fault = {
  side: FaultSide;
  label: string;
  text: string;
  detail: string;
  /** Level-3 type of the blame record; absent on older runs. */
  taxonomy?: { party: FailureParty | "Agent"; family?: string; group?: string; type: string } | null;
};

export type Write = { method: string; path: string; body: Record<string, unknown> | null; status: number; attempt: string | null };
export type ModelCall = {
  seconds: number | null;
  tokens: number | null;
  error: string | null;
  reasoning: string;
  raw: string | null;
  actions: { tool: string; args: Record<string, unknown> }[];
};
export type Run = {
  n: number;
  lookups: string[];
  calls: ModelCall[];
  writes: Write[];
  reply: string;
  changes: { field: string; from: unknown; to: unknown }[];
};

export type Ticket = {
  /** Set by the viewer: failed tickets come from tickets.json, passed ones from passed.json. */
  passed?: boolean;
  key: string;
  stage: number;
  id: string;
  title: string;
  test: string;
  matters: string;
  brief: string;
  facts: string[];
  ticket: string;
  customerId: string;
  group: string;
  scenario?: string | null;
  category?: string | null;
  realization?: string | null;
  behavior?: string | null;
  replay?: {
    rules?: string[];
    note?: string;
    passed?: boolean;
    failures?: string[];
    bot_problem?: string;
  } | null;
  /** What the replays say was missing (execution, knowledge, application, customer, either, both, prompt cap); on a run
   *  graded by facts, the fact verdict (fact absent, prompt over cap, agent never started, missed customer fact, had the facts). */
  replayVerdict?: string | null;
  /** Against earlier stages: discovery, regression or adaptability (facts.json). */
  ticketType?: string | null;
  /** The facts this ticket needs as the judge found them in the agent, and its customer facts (runs graded by facts). */
  factCheck?: {
    rule_facts: { id: string; label: "right" | "absent"; text: string; quote: string }[];
    customer_facts: { text: string; decisive: boolean | null; told: boolean }[];
    rule_recall: number | null;
    customer_recall: number | null;
    /** The agent's information-seeking turns: which customer facts each asks for (the customer-facts judge). */
    questions?: { turn: string; quote: string; reasoning: string; asks_for: string[] }[];
    customer_precision?: number | null;
    blame: string | null;
  } | null;
  /** Where the answer comes from: 1 API only, 2 customer's facts, 3 API call from the customer, 4 question from the API. */
  infoType?: number | null;
  start: Record<string, unknown>;
  end: Record<string, unknown>;
  messages: string[];
  runs: Run[];
  failures: Failure[];
  blocked: Blocked[];
  crash: string;
  turnsExact: boolean;
  sides?: FaultSide[];
  oursOnly?: boolean;
  /** Every blame record of the ticket (one per failed check); absent on viewer data built before it was added. */
  blames?: { label: string; side?: FaultSide | null; type?: string | null; party?: string | null; group?: string | null }[];
  /** Who decided each saved change. A note only: it never fails the ticket. */
  changeSources?: ChangeSource[];
};

/** model = set with a tool call; text = only in the model's reply text, the code copied it (no tools); code = the model never said it. */
export type ChangeSource = { call: string; field: string; value: unknown; source: "model" | "text" | "code" };

export type GroupScore = { passed: number; total: number };

export type BehaviorCoverageScore = {
  /** "per_ticket": one behavior per ticket, by_category is keyed by behavior subcategory, no scenarios. Absent on old runs. */
  mode?: "per_ticket";
  q_coverage: number;
  weights?: string;
  n_scenarios: number;
  /** per_ticket only: number of behaviors in by_category. */
  n_behaviors?: number;
  by_category?: Record<string, { scenarios: number; passed: number; total: number; q: number }>;
  /** per_ticket only: passed/total per behavior family. Absent on older runs. */
  by_family?: Record<string, { passed: number; total: number; q: number }>;
  by_scenario?: {
    scenario: string;
    category: string;
    q: number;
    passed: number;
    total: number;
  }[];
};

export type RealizationRobustnessScore = {
  mean_q_realization: number | null;
  n_multi_realization_scenarios: number;
  by_scenario?: {
    scenario: string;
    category: string;
    q_realization: number;
    n_realizations: number;
    realizations?: { id: string; realization: string; behavior?: string; passed: boolean }[];
  }[];
};

/** Counts per behavior (and summed) for the per-ticket format: failed tickets replayed with the rule stated. */
export type PerTicketAttributionCounts = {
  tickets: number;
  failed: number;
  ours: number;
  bot_errors: number;
  /** Passed once told, and the rule had not reached the model (knowledge). */
  lacked_rule: number;
  /** The rule had reached the model, yet the bot passed only once told (the behavior). */
  fixed_when_told: number;
  /** Fails even when told (applying the rule). */
  cannot_apply: number;
  /** The full replay (rule and customer's information given) failed too; the other replays were skipped. Absent on older runs. */
  execution?: number;
  not_replayed: number;
  /** Behavior replay: failed tickets run again with the baseline customer (facts given, no rule), and how many passed. */
  plain_replayed?: number;
  plain_passed?: number;
};

/** One behavior per ticket (no scenarios, no control). */
export type PerTicketAttributionScore = PerTicketAttributionCounts & {
  mode: "per_ticket";
  by_behavior: Record<string, PerTicketAttributionCounts>;
};

/** Per scenario: each behavior ticket against the scenario's normal ticket (the control). */
export type BehaviorAttributionScore = {
  mode?: undefined;
  behavior_failures: number;
  doc_failures: number;
  handled: number;
  noisy: number;
  /** Failed only because of us: time limit, provider, customer model (side "us"). */
  ours?: number;
  /** Crashed or made no working model call: the bot's fault, but no rule was tested. */
  bot_errors?: number;
  /** Failed on a rule, but the control lost to us or a bot error. */
  no_control?: number;
  by_behavior?: Record<
    string,
    {
      tickets: number;
      behavior_failures: number;
      doc_failures: number;
      ours?: number;
      bot_errors?: number;
      no_control?: number;
    }
  >;
  by_scenario?: {
    scenario: string;
    control: string;
    control_passed: boolean;
    /** Who the control's failure belongs to when it tested no rule: "us" or "bot". */
    control_owner?: "us" | "bot" | null;
    behavior_failures: string[];
    doc_failures: string[];
    handled: string[];
    noisy: string[];
    ours?: string[];
    bot_errors?: string[];
    no_control?: string[];
  }[];
};

export type ArchitectureSummary = {
  q?: { passed?: number; total?: number; reward?: number };
  design?: {
    architecture_choice?: string;
    how_it_works?: string;
    parts?: string;
    how_docs_reach_the_model?: string;
    memory?: string;
  };
  stated?: Record<string, number | boolean | string | string[] | null | undefined>;
  observed?: {
    traced?: boolean;
    embeddings_in_code?: string[];
    /** ARCHITECTURE.json knowledge_access as observed (multi-select); absent on older runs. */
    knowledge_access?: string[] | null;
    knowledge_access_evidence?: Record<string, "trace" | "code">;
    model_calls_avg?: number | null;
    model_calls_max?: number | null;
    /** One bot run = the calls of one bot process; the bot runs once per customer message. */
    model_calls_per_run_avg?: number | null;
    model_calls_per_run_max?: number | null;
    n_tools_offered?: number;
    tools_offered?: string[];
    embedding_calls?: number | null;
    max_system_prompts_in_one_ticket?: number | null;
    n_bot_data_files_read?: number;
    n_files_written?: number;
    n_extra_libraries?: number;
    extra_libraries?: string[];
    handoffs_made?: number | null;
  };
  self_report?: { given?: boolean; right?: number | null; checked?: number | null };
  claims?: { claim?: string; ok?: boolean; said?: unknown; saw?: unknown }[];
  subset?: { rules?: number | null; kept?: number | null; reached?: number | null };
};

/** Level-3 failure taxonomy: one type per blame record, summed to family ("Party / Family") and party. */
export type FailureParty = "Builder" | "Bot" | "Harness";
export type FailureTaxonomy = {
  records: number;
  by_party: Partial<Record<FailureParty, number>>;
  by_family: Record<string, number>;
  by_type: Record<string, { party: FailureParty; family: string; count: number }>;
};

/** One ticket's doc recall row: needed docs (expected_doc_ids) whose own text reached the model. */
export type DocRecallRow = {
  id: string;
  passed: boolean;
  expected: string[];
  reached: string[];
  missed: string[];
  absent: string[];
  recall: number;
  precision: number | null;
  docs_sent: number;
  traps: string[];
  kept?: string[];
};

export type DocRecall = {
  tickets: number;
  recall: number | null;
  precision: number | null;
  kept?: number | null;
  full_recall: number;
  trap_tickets: number;
  failed: number;
  failed_docs_missing: number;
  failed_docs_all_there: number;
  passed_docs_missing: number;
  absent_docs: string[];
  rows: DocRecallRow[];
};

export type StageScore = {
  passed?: number;
  total?: number;
  ours?: number;
  reward?: number;
  situations?: number;
  unscored_total?: number;
  terminations?: Record<string, number>;
  step?: string;
  /** RQ5: knowledge pack name on support-agent-knowledge (Rcomplete, …). */
  knowledge_condition?: string;
  /** RQ5: Qk = passed/total under that knowledge condition. */
  Qk?: number | null;
  release?: string;
  by_group?: Record<string, GroupScore>;
  by_rule?: Record<string, GroupScore & { q?: number; frac?: string }>;
  by_purpose?: Record<string, GroupScore & { q?: number; frac?: string }>;
  behavior_coverage?: BehaviorCoverageScore;
  realization_robustness?: RealizationRobustnessScore;
  behavior_attribution?: BehaviorAttributionScore | PerTicketAttributionScore;
  subset?: { rules: number; kept: number; reached: number; kept_not_reached?: number };
  architecture?: ArchitectureSummary;
  knowledge_application?: {
    failed: number;
    replayed: number;
    replay_passed: number;
    replay_failed: number;
    Qapplication: number | null;
    frac_runtime_realization_failure: number | null;
    frac_knowledge_acquisition_failure: number | null;
    replay_reasons?: Record<string, number>;
    by_blame: Record<string, number>;
    by_side: Record<string, number>;
    blame_acquisition: number;
    blame_runtime: number;
    blame_records?: number;
    blame_bot_failure?: number;
    blame_harness?: number;
    frac_blame_acquisition: number | null;
    frac_blame_runtime: number | null;
    frac_blame_bot_failure?: number | null;
    frac_blame_harness?: number | null;
    tickets?: {
      id: string;
      replay_passed: boolean;
      rules: string[];
      class: string;
      reason?: string;
      blame: string[];
    }[];
    subset?: {
      rules: number;
      kept: number;
      reached: number | null;
      kept_rate: number | null;
      reached_rate: number | null;
    };
  };
  /** The customer corrected a detail support stated wrongly: tickets where it happened, and how many the bot still got right. */
  agent_correction?: { tickets: number; fixed: number; repair_rate: number | null };
  failure_taxonomy?: FailureTaxonomy;
  /** Doc recall: did the docs each ticket needs reach the bot's model (tests/doc_recall.py). */
  docs?: DocRecall;
  /** Pass rate by info type (1 API only, 2 customer's facts, 3 API call from the customer's info, 4 question from
   * what the API shows), and twin pairs (same opening, different answers) where both halves passed. */
  info?: {
    by_type: Record<string, { passed: number; total: number }>;
    pairs: number;
    pairs_passed: number;
    pair_rate: number | null;
    pairs_one_half: string[][];
  };
  /** Seconds per model call, per bot run (one reply) and per ticket: median, p90, count (replay_data.py). */
  latency?: {
    call: LatencyStat | null;
    run: LatencyStat | null;
    ticket: LatencyStat | null;
    /** wall = each run timed start to end; model = only its model calls. */
    run_kind: "wall" | "model";
  } | null;
  /** What grading this stage cost (tests/verify.py cost_summary); absent on runs graded before it was recorded. */
  cost?: {
    bot: UsageSum;
    customer: UsageSum;
    /** Absent on a run graded by facts (scripts/fact_run.py): it runs no replays. */
    replay_bot?: UsageSum;
    replay_customer?: UsageSum;
    sandbox: { runs: number; seconds: number; usd: number };
    /** The fact-level judge and customer-facts reader (scripts/fact_run.py). */
    judge?: { usd: number };
    usd: number;
  };
  /** Tickets by type against earlier stages (discovery / regression / adaptability), from facts.json. */
  ticket_types?: Record<string, { passed: number; total: number }>;
  /** Fact-level numbers (scripts/fact_run.py): a judge read the agent's files; present only on runs graded by facts. */
  facts?: FactsScore;
  /** Failed tickets by what the replays say was missing: execution, knowledge, application, customer, either, both, prompt cap. */
  replay_verdicts?: Record<string, number>;
  cases?: { id: string; passed: boolean; termination?: string }[];
  unscored_failed?: string[];
};

export type Meta = {
  job: string;
  trial: string;
  stages: number[];
  scores: Record<string, StageScore>;
  builder: { agent: string | null; model: string | null };
  bot: string | null;
  /** Minutes from Harbor's result.json: setup (installing the builder agent), then per step the builder working on
   * the bot (build) and the verifier running and grading every ticket (grade). Absent on runs published before it. */
  timing?: {
    setup_min: number | null;
    total_min: number | null;
    steps: Record<string, { build_min: number | null; grade_min: number | null }>;
  } | null;
};

/** A bot file. Its text is inline (older runs) or fetched by `ref` from the run's texts/ shards; a data file (an
 *  index, vectors, a pickled graph: over 2 MB or binary) has neither, only its size. */
export type CodeFile = { path: string; role: Role; lines: number; text?: string | null; ref?: string | null; data?: boolean; size?: number };
export type Role = "code" | "prompt" | "knowledge" | "doc" | "test";
export type Knowledge = { id: string; title: string; status: string; updated: string; chars: number; path: string };
export type CodeStage = {
  stage: number;
  score: { passed?: number; total?: number };
  builder: { final: string; seconds?: number; cost: number | null; model: string | null };
  files: CodeFile[];
  knowledge: Knowledge[];
};
export type ChangedFile = {
  path: string;
  role: Role;
  status: "new" | "removed" | "changed";
  add: number;
  rem: number;
  old?: string;
  new?: string;
  old_ref?: string | null;
  new_ref?: string | null;
  data?: boolean;
  size_old?: number | null;
  size_new?: number | null;
  tags: { line: number; rules: string[] }[];
};
export type Transition = {
  from: number;
  to: number;
  docChanges: { id: string; type: string; what: string; patches: { doc: string; title: string; find: string; replace: string; diff: Diff }[] }[];
  newDocs: (DocRef & { trap: boolean; rules: string[] })[];
  ruleChanges: Rule[];
  files: ChangedFile[];
  knowledge: { id: string; title: string; path: string; status: "added" | "removed" | "updated" }[];
};
export type CodeData = { stages: CodeStage[]; transitions: Transition[] };

export type Doc = { title: string; status: string; updated: string; author: string; text: string; ref?: string; chars?: number; source: "slack" | "confluence"; born: number; edited: number | null;
  /** From the doc index (no text yet): the stage whose docs.json holds the entry, and its byte range there. */
  at?: { stage: number; start: number; end: number } };
export type DocsData = Record<string, Record<string, Doc>>;

/** Tokens and dollars summed over model calls; unpriced = calls litellm had no price for (not in usd). */
export type UsageSum = { calls: number; in: number; cached: number; out: number; usd: number; unpriced: number };

export type LatencyStat = { median: number; p90: number; n: number };

export type FactsScore = {
  judge_model: string | null;
  facts_model: string | null;
  cost: number;
  /** The stage's needed facts the agent has ÷ needed facts (Rishi's stage-level recall). */
  rule_recall: number | null;
  /** The per-ticket recall, averaged. */
  rule_recall_per_ticket?: number | null;
  rule_precision: number | null;
  customer_recall: number | null;
  customer_precision: number | null;
  /** Facts by kind (rule = needed by a ticket; unused, trap, stale) and what the judge found. */
  kinds: Record<string, Record<"right" | "absent", number>>;
  tickets: number;
  full_recall: number;
  failed_full_recall: number;
  failed_missing: number;
  passed_missing: number;
  dummies_held: number;
  /** Needed facts right in the agent ÷ needed facts (the stage's own count, not per ticket). */
  kept: number | null;
  /** Tickets whose own rules have a trap or stale version the agent holds. */
  trap_tickets: number;
  rows: { id: string; passed: boolean; recall: number; right: string[]; absent: string[]; traps: string[] }[];
  by_behavior: Record<string, { tickets: number; decisive: number; obtained: number; failed: number; failed_missed: number;
    /** The agent's information-seeking turns, and those asking for a decisive customer fact. */
    questions?: number; relevant?: number }>;
};

/** scripts/case_data.py: every ticket of a task, one version per step it appears in. */
export type CaseVersion = {
  step: string;
  title: string;
  test: string;
  matters: string;
  ticket: string;
  opening: string;
  customer: { id: string; name?: string | null; tier?: string | null; deployments: { region: string; deployment: string }[] };
  brief: string;
  facts: { text: string; decisive: boolean | null; why?: string | null; decides?: string[] }[];
  rules: { id: string; text: string; real: string[]; traps: string[]; quote?: string; trap_quote?: string }[];
  rule_facts: { id: string; text: string }[];
  pass: Record<string, unknown>;
  reply_checks: string[];
  tags: { group?: string | null; behavior?: string | null; info_type?: number | null; twin?: string | null; change_type?: string | null; type?: string | null; prompt_cap_tokens?: number | null };
  result: { passed: boolean; verdict?: string | null; failures: string[] } | null;
};
export type CasesData = { task: string; steps: string[]; tickets: { id: string; versions: CaseVersion[] }[] };


/** The builder's logs for one run (scripts/build_logs.py → builds.json). */
export type BuildSummary = {
  /** This step's build time as a share of the run's longest build (0-1). Runs published before it carry seconds instead. */
  share?: number | null;
  seconds?: number | null;
  error: string | null;
  model: string | null;
  thinking: string | null;
  cost: number | null;
  tokens: { input: number | null; cached: number | null; output: number | null } | null;
  calls: number | null;
  commands: number;
  tools: Record<string, number>;
  failed: number;
  last: string | null;
  events: number;
};
export type BuildStage = { step: string; index: number; format: "trajectory" | "pi" | null; summary: BuildSummary };
export type BuildsData = { version: number; harness: string | null; stages: BuildStage[] };
/** One timeline entry: k is say (a message), think (reasoning) or tool (a tool call); t (older runs only) seconds since
 *  the build started; x the text or tool input (trimmed), o the tool output (trimmed); r / ri the whole output / input by
 *  reference; e a failed tool call; d its duration in seconds; n the tool's name; tok output tokens. */
export type BuildEvent = { k: "say" | "think" | "tool"; t?: number; n?: string; x?: string; ri?: string; o?: string; r?: string; e?: boolean; d?: number; tok?: number };

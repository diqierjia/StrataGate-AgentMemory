<div align="center">

<img src="docs/assets/stratagate-avatar.png" alt="StrataGate Agent Memory banner" width="100%" />

# StrataGate

### Long-term memory that keeps the original evidence.

StrataGate helps long-running AI agents remember across sessions without turning every remembered detail into an unquestioned fact.

[![CI](https://github.com/diqierjia/StrataGate-AgentMemory/actions/workflows/ci.yml/badge.svg)](https://github.com/diqierjia/StrataGate-AgentMemory/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/stratagate-dsh.svg)](https://www.npmjs.com/package/stratagate-dsh)
[![npm downloads](https://img.shields.io/npm/dt/stratagate-dsh.svg)](https://www.npmjs.com/package/stratagate-dsh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6.svg)](https://www.typescriptlang.org/)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)](CONTRIBUTING.md)

[中文说明](README.zh-CN.md) · [DeepSeek Harness guide](docs/DSH.md) · [Architecture](docs/ARCHITECTURE.md) · [Full evaluation](docs/EVALUATION.md)

<strong>Current public result:</strong> on LoCoMo `conv-26`, StrataGate averaged <strong>80.46%</strong> across 10 independent Judge runs, versus <strong>63.22%</strong> for Mem0 base. [See the scope and protocol](#experimental-results).

</div>

> <strong>In plain words:</strong> StrataGate remembers what happened, keeps where it came from, and checks whether the recalled information is enough before an agent relies on it.

## Why StrataGate?

- **Automatic, local-first memory across sessions.** Completed main-agent conversations and tool results are captured in a local SQLite database without a separate memory server. → [Quick start](#quick-start-deepseek-harness)
- **Layered context that stays small.** Recent history remains detailed; older history becomes a compact index and expands only when the agent needs more evidence. → [Layered memory](#layered-memory)
- **Events that keep source and time.** A lasting memory records where it came from and separates when something was mentioned from when it happened. → [Event cards](#event-cards)
- **A knowledge graph for what is true now.** Traceable Events can be projected into the current state of people, projects, organizations, tools, and places. → [Current-state graph](#current-state-graph)
- **Evidence checked before answering.** A relevant result is not automatically treated as sufficient; the agent may need to search again, expand a result, or inspect the original messages. → [Evidence gate](#evidence-gate)
- **No self-reinforcing search loop.** Merely retrieving a memory does not strengthen it; only evidence actually used in the final answer can update long-term weight. → [Use-only reinforcement](#use-only-reinforcement)
- **Memory import without losing the original text.** Structured memory exported by another AI can become traceable Events while the imported source remains preserved. → [External memory import](#external-memory-import)

## Choose your path

| Path | Best for | Start here |
| --- | --- | --- |
| **DeepSeek Harness plugin** | Users who want automatic, local-first memory with a visual Memory UI | [Install `stratagate-dsh`](#quick-start-deepseek-harness) |
| **Core TypeScript library** | Developers building a custom agent or memory integration | [Library entry points](#code-entry-points) |

<a id="quick-start-deepseek-harness"></a>

## Quick start: DeepSeek Harness

If DeepSeek Harness is already installed, add StrataGate to the profile you use:

```bash
dsh plugin --profile web add stratagate-dsh
```

Restart that profile, then keep using DSH normally. StrataGate will capture completed main-agent turns, build searchable memory in the background, and expose its Memory UI under **DSH Settings → StrataGate-AgentMemory**.

By default, the database is stored at:

```text
DSH_HOME/stratagate/memory.db
```

Removing the plugin does not delete the database. For screenshots, configuration, memory tools, and the exact automatic-capture rules, see the [DeepSeek Harness plugin guide](docs/DSH.md).

## The problem behind the design

A long-running agent needs more than a way to “store more.” When it answers, it must retrieve evidence that is **correct, complete, and verifiable**.

Keeping only summaries can lose dates, qualifications, and original wording. Similarity search can return related material that belongs to a different event. Treating every search hit as useful memory can also create a self-reinforcing retrieval loop.

StrataGate designs long-term memory around four core problems:

| Common problem | How StrataGate handles it |
| --- | --- |
| History keeps growing and no longer fits in context | Store conversations as L0–L5 layered views; older memories default to shallower levels |
| A summary omits a date, exact wording, or qualification | Preserve the L5 source messages permanently, so every derived memory can return to its source |
| Search finds related material, but not enough evidence to answer | Use an evidence gate to judge sufficiency; if evidence is incomplete, change strategy, expand an event, or inspect the source |
| Frequently retrieved results keep reinforcing themselves | Update long-term weight only for memories that the final answer actually uses |

StrataGate is not designed to make an agent retrieve more on every turn. It is designed to make the agent know **whether the current evidence is sufficient and where to look next**.

## Experimental results

The current public comparison covers LoCoMo `conv-26`:

- 419 messages;
- 35 sessions;
- 152 category 1–4 questions;
- 10 independent Judge evaluations per question.

| Metric | StrataGate | Mem0 base | Difference |
| --- | ---: | ---: | ---: |
| Mean accuracy across 10 Judge runs | **80.46%** | 63.22% | **+17.24 percentage points** |
| Majority-correct | **121 / 152 (79.61%)** | 96 / 152 (63.16%) | **+25 questions** |
| Temporal | **74.86%** | 34.59% | **+40.27 percentage points** |
| Single-hop | **89.29%** | 75.14% | **+14.14 percentage points** |
| Multi-hop | **66.56%** | 61.56% | +5.00 percentage points |
| Open-domain | 83.08% | **84.62%** | -1.54 percentage points |

The largest difference is in temporal questions. This is consistent with StrataGate's design—explicit event occurrence times, preserved source timestamps, and raw-source verification—but it is not a single-component ablation, so the full gap cannot be attributed to one field or retrieval step.

Both systems used the same questions, order, answer model, Judge model, Judge prompt, parser, and repeat count, and both rebuilt memory from scratch. Their memory extraction, retrieval implementation, embedding, and answer context differed, so this comparison is between two **complete system configurations**.

This is a single-conversation comparison on `conv-26`, not a full LoCoMo score. For the complete protocol, per-question results, Judge variation, and artifact hashes, see:

- [`docs/EVALUATION.md`](docs/EVALUATION.md)
- [`benchmarks/locomo-conv26-r8-final.json`](benchmarks/locomo-conv26-r8-final.json)

<a id="how-stratagate-works"></a>

## How it works

![StrataGate workflow: layered memory, event cards, and the evidence gate](docs/assets/stratagate-how-it-works.en.png)

The normal path is deliberately simple:

1. **Keep the source.** Completed messages and tool results are stored locally before anything is summarized.
2. **Build smaller views.** StrataGate creates layered summaries, Events that describe what happened, and graph facts that describe the current state.
3. **Search small records first.** The agent starts with compact results and expands an Event, graph node, or source Block only when it needs more detail.
4. **Check before answering.** The evidence gate decides whether the result is sufficient. If not, the agent searches again or returns to the original messages.
5. **Reinforce only what helped.** A memory gains long-term weight only after the final answer actually uses it.

For example, if a user says “Use pnpm for this project,” StrataGate keeps the original turn, creates a traceable Event, and can later expose “the project uses pnpm” as compact context. If an answer depends on the exact wording or surrounding discussion, the agent can expand that Event back to the source instead of trusting the shortened version alone. [See a complete retrieval example](#a-real-retrieval-path).

## Core design

<a id="layered-memory"></a>

### 1. Layered memory: compressed views without losing the source

By default, every 12 complete conversation turns are sealed into one memory block. Messages that have not yet reached the boundary remain in the open tail and are not compressed or extracted early.

This is the core-library default. The DeepSeek Harness plugin defaults to 6 turns per Block so Event extraction becomes available sooner, and exposes `blockTurnSize` as a user setting. Block age is the distance from the latest ready Block in the same thread, so open-tail and model-pending Blocks do not cause decay. The default Block-decay coefficient is `0.30`.

Each sealed block contains six levels of detail:

| Level | Contents | Primary use |
| --- | --- | --- |
| L0 | Title and tags | A lightweight index for distant memories |
| L1 | Short summary | Quickly judge whether a piece of history is relevant |
| L2 | Key facts | A compact factual list |
| L3 | Deterministically pruned conversation | Remove narrowly defined redundancy without free-form semantic rewriting |
| L4 | Readable near-verbatim conversation | Verify natural-language context and tool results |
| L5 | Complete messages and tool records | Final source |

At the boundary, StrataGate first seals permanent L5 together with deterministic L4 and L3, before any model call. The Block remains model-pending—and cannot replace native conversation history or participate in decay—until validated L0–L2 and Event processing complete. Ready Blocks then decay toward shallower levels as more ready Blocks follow; deeper detail can be expanded again when needed.

L0–L4 are derived views of the same source. They never overwrite or rewrite L5. Event cards likewise reference their source blocks and cannot modify them.

This lets StrataGate satisfy two goals at once:

- old memories remain lightweight;
- every important conclusion can still be verified against the original messages.

<a id="event-cards"></a>

### 2. Event cards: store content, source, and time together

Decisions, preferences, plans, corrections, and temporal events that are worth finding later are organized into event cards.

Each event card stores more than a summary:

```ts
{
  sourceBlockId,
  sourceMessageIds,

  mentionedAt,
  happenedStart,
  happenedEnd,

  status,
  participants,
  eventType,

  supersedesEventIds,
  conflictsWithEventIds
}
```

In this structure:

- `mentionedAt` is when the event was mentioned in the conversation;
- `happenedStart` / `happenedEnd` describe when it actually happened or is expected to happen;
- `status` distinguishes completed, planned, cancelled, and ongoing events;
- `supersedesEventIds` and `conflictsWithEventIds` preserve corrections and conflicts.

Separating mention time from occurrence time prevents the system from treating a message timestamp as the event timestamp. It also gives the system enough information to resolve relative expressions such as “last week” and “next month.”

After L0–L2 validates, Event extraction runs independently without waiting for block `N+1`. The extractor may read the previous Block and the nearest available later ready Block as context, but every new fact and source reference must come from target block `N`.

<a id="current-state-graph"></a>

### 3. Current-state graph and auditable retrieval

Event cards preserve what happened. StrataGate can derive the current state of people, projects, organizations, tools, and places as Graph Nodes and directed Graph Edges. The DeepSeek Harness integration uses this graph-native path.

Graph projection runs as an independent, persisted job. A failed projection can be retried without extracting its Events again. A proposed fact or relationship is accepted only when its cited Events belong to the projection batch, so a derived claim cannot lose its source. State changes close or supersede the earlier derived fact without rewriting the Event that produced it.

`searchEvents()` combines deterministic BM25 lexical ranking with structured rankings for participants, types, names, and time; reciprocal-rank fusion combines those lists. `searchGraphNodes()` uses field-weighted BM25 across names, aliases, tags, state, facts, and relations. Searches return compact facts rather than entire large records, and a zero lexical match does not produce arbitrary candidates. These paths use deterministic lexical and structured signals rather than vector or semantic retrieval.

<a id="evidence-gate"></a>

### 4. Evidence gate: relevant does not mean sufficient

A conventional retrieval system often hands several similar results directly to the answer model. StrataGate inserts a fixed protocol between retrieval and answering:

```text
verdict · evidence_refs · fit · missing · next_strategy
```

After every retrieval, the system must answer five questions explicitly:

- is the current evidence `sufficient`, `partial`, or `wrong`;
- which results actually support that judgment;
- how the evidence matches the question;
- what is still missing;
- should the next step answer, continue searching, expand an event, or inspect the original messages.

The system accepts `sufficient` only when all of the following are true:

1. at least one evidence item comes from the selected retrieval batch;
2. `next_strategy` is explicitly `answer`;
3. the judgment uses a fixed, bounded structure instead of an ever-growing private retrieval scratchpad.

If the judgment is `partial` or `wrong`, the system can choose:

```text
search_events
expand_event
search_graph
expand_graph_node
search_raw_memory
expand_block
```

The evidence gate does not run the entire agent loop for the application. StrataGate supplies state, constraints, and validation; the integrating application still controls model calls, tool iteration, and the maximum retrieval budget.

<a id="use-only-reinforcement"></a>

### 5. Separate retrieval from reinforcement

An event being retrieved does not mean that it helped the answer.

Search therefore updates only observable retrieval records; it does not directly increase memory weight. After the answer is complete, the application explicitly calls:

```ts
await memory.recordMemoryUse({ eventIds, elementIds });
```

Only Events, or the source Events behind adopted graph evidence, update their long-term weight. Legacy Element evidence remains supported by integrations that still use it.

This avoids a common feedback loop:

```text
A memory happens to rank highly
        ↓
It is retrieved frequently
        ↓
Its weight keeps increasing
        ↓
It becomes even more likely to rank highly
```

A new event can supersede an old one, while the old event and its source remain available. Forgetting can remove an event from search without breaking the provenance chain.

<a id="external-memory-import"></a>

### 6. Import memory from another AI

`importExternalMemory()` can migrate a structured memory summary produced by another AI. The core API extracts candidate Events, compares each candidate with a bounded set of existing Events, and lets a model choose one of five actions: add, merge, supersede, mark a conflict, or ignore. Imported text is also retained as a permanent source Block, so every accepted Event remains traceable to the exact import.

The exported prompt and parser use the `stratagate.external-memory.v2` format. Unknown dates remain unknown: the importer preserves the original temporal wording instead of guessing from the current date or message order. See [`docs/EXTERNAL_MEMORY_IMPORT.zh-CN.md`](docs/EXTERNAL_MEMORY_IMPORT.zh-CN.md) for the current integration guide.

The DeepSeek Harness UI previews every import, skips exact duplicates deterministically, and asks the configured model to choose add, merge, supersede, conflict, or ignore against Top-K local matches. High-confidence decisions are applied automatically; only low-confidence decisions require confirmation. Each committed batch can be undone from the result screen.

## A real retrieval path

One LoCoMo question asks when Caroline gave a speech at a school.

The event card found the “school speech,” but the card itself did not contain enough date information:

```text
search_events
        ↓
Match the “school speech” event card
        ↓
The event is relevant, but has no exact date
verdict = partial
missing = occurrence date
        ↓
search_raw_memory
        ↓
Find the source message dated 2023-06-09
It says “last week”
        ↓
Resolve the relative date against the message timestamp
verdict = sufficient
        ↓
Answer
```

In this path:

- the event card provides fast location;
- the source timestamp and original message provide final verification;
- the evidence gate prevents the system from answering from incomplete information.

## How these designs emerged

The current design was not decided in one pass. The most useful result of multiple experiments was not the round number, but the failure mode each round exposed.

| Problem discovered | Experimental observation | Final design choice |
| --- | --- | --- |
| Temporal information was compressed into summaries and hard to recover accurately | In the early matched-protocol experiments, adding multiple events per block and explicit occurrence times raised Temporal from 18.92% to 45.95% | Separate mention time from occurrence time, and preserve the original temporal expression and source message |
| The agent's retrieval scratchpad kept growing | The bounded five-field evidence gate scored 77.63%; expanding it into a larger structured scratchpad reduced the score to 63.82% | Keep the judgment small and bounded, and let code validate its critical constraints |
| When evidence was insufficient, the agent repeatedly searched the same event cards | An early end-to-end version had 19 questions with at least three event searches and answered only 2 correctly; the current strategy answered 15 of the same questions, including 12 that inspected the source | Change information channels when search adds no new evidence instead of repeating the same search |

Compared with the earlier end-to-end version, the current version produced:

| Metric | Earlier version | Current version | Change |
| --- | ---: | ---: | ---: |
| Mean accuracy across 10 Judge runs | 70.33% | **80.46%** | **+10.13 percentage points** |
| Majority-correct | 107 / 152 | **121 / 152** | **+14 questions** |
| Retrieval rounds | 215 | **146** | **-32.1%** |
| Evidence-assessment calls | 237 | **146** | **-38.4%** |
| Total tokens | 6.69M | **4.09M** | **-38.9%** |

These results show that repeated event search was a concrete failure path in the old version. Returning to the source when card evidence was incomplete improved both accuracy and retrieval efficiency.

However, the two end-to-end runs also differed in soft filters, Chinese-English synonym matching, result structure, and the freshly extracted memory state. This is useful diagnostic evidence, not a single-variable ablation of raw-source fallback.

For the complete R1–R8 experiment history, model and Judge changes, per-question transitions, and protocol boundaries, see [`docs/EVALUATION.md`](docs/EVALUATION.md).

## Current limitations and next steps

The current version still has 31 majority-wrong questions. Grouped by the final observable failure stage:

| Failure stage | Questions | Problem exposed |
| --- | ---: | --- |
| Answered directly without retrieval | 15 | Temporal, multi-hop, and list questions sometimes trust the model's own memory too early |
| Evidence gate returned `sufficient`, but the final answer was wrong | 14 | Related material from a different event was accepted as sufficient, or a list answer was incomplete |
| Evidence remained `partial` at the retrieval limit | 2 | Some questions genuinely did not retrieve enough evidence, but this is not the main bottleneck |

This indicates that the main problem is no longer “not enough retrieval rounds.” It is whether retrieval should start at all and whether the retrieved evidence truly supports a complete answer.

Next steps:

1. freeze the memory state and separately ablate raw-source fallback, soft filters, and fact-level retrieval;
2. provide gold evidence directly to the answer model to distinguish retrieval failure from answer-reasoning failure;
3. repeat the same paired protocol across more conversations;
4. finally expand to the complete LoCoMo dataset.

## Current status

StrataGate is currently a research prototype for validating long-term agent memory designs.

The repository has implemented and validated:

- layered conversation blocks and their decay rules;
- event cards with provenance, time, and conflict relationships;
- independently retryable knowledge-graph projection with Event-level provenance;
- BM25/RRF retrieval across Events and Graph Nodes;
- structured external-memory import with permanent source preservation;
- isolated evidence assessment for concurrent retrieval batches;
- a bounded evidence gate whose constraints can be checked by code;
- a weighting mechanism that separates retrieval hits from actual answer use;
- automated tests, experiment records, and machine-readable evaluation results.

The public API, model integration, and evaluation coverage are still evolving. StrataGate should not yet be treated as a stable production SDK.

The default implementation uses in-memory state. The repository also provides an optional SQLite adapter for experimental-state persistence, interruption recovery, and consistency validation. It does not change the core retrieval semantics; see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the constraints.

## Code entry points

Node.js 22 or later is required.

After checking out the repository locally, run:

```bash
npm install
npm run check
npm test
npm run build
```

The main code and documentation entry points are:

- [`packages/core/examples/basic.ts`](packages/core/examples/basic.ts): minimal core-engine example;
- [`packages/core/src/store.ts`](packages/core/src/store.ts): core state, Block/Event/graph lifecycle, import, and retrieval;
- [`packages/core/src/events.ts`](packages/core/src/events.ts): stable Event-type normalization;
- [`packages/core/src/elements.ts`](packages/core/src/elements.ts): provenance-checked element projection and time views;
- [`packages/core/src/graph.ts`](packages/core/src/graph.ts): provenance-checked graph projection and graph state;
- [`packages/core/src/external-memory.ts`](packages/core/src/external-memory.ts): external-memory schema, prompts, parser, and extractor;
- [`packages/core/src/search.ts`](packages/core/src/search.ts): deterministic BM25 token ranking and RRF fusion;
- [`packages/core/src/retrieval.ts`](packages/core/src/retrieval.ts): evidence-gate normalization and constraint validation;
- [`packages/core/src/blocks.ts`](packages/core/src/blocks.ts): layering rules and deterministic pruning;
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): complete system boundaries and implementation invariants;
- [`docs/EVALUATION.md`](docs/EVALUATION.md): complete experiment history and failure analysis.

`packages/core/examples/basic.ts` demonstrates the core API; it does not fully reproduce the agent tool loop used in the benchmark. See the evaluation document for the model calls, tool orchestration, and Judge protocol used in the evaluation.

## Documentation and reproduction

| Resource | Contents |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Data flow, layering rules, Event/Element protocols, retrieval, evidence-gate constraints, weighting, and storage invariants |
| [`docs/EXTERNAL_MEMORY_IMPORT.zh-CN.md`](docs/EXTERNAL_MEMORY_IMPORT.zh-CN.md) | External-memory export format, import flow, and integration example |
| [`docs/EVALUATION.md`](docs/EVALUATION.md) | R1–R8 experiments, model sensitivity, Mem0 comparison, failure analysis, and reporting boundaries |
| [`benchmarks/locomo-conv26-r8-final.json`](benchmarks/locomo-conv26-r8-final.json) | Current result, per-stage statistics, run information, and source artifact hashes |
| [`packages/core/examples/basic.ts`](packages/core/examples/basic.ts) | Minimal code example |

## Repository layout

```text
src/                    DeepSeek Harness Host and Web client adapter
tests/                  DeepSeek Harness integration tests
cordis.patch.yml        Root-level DSH bundle manifest
packages/core/          Shared memory engine, core tests, and example
integrations/workbuddy/ WorkBuddy Host Adapter and MCP integration
docs/                   DSH usage, architecture, and evaluation
benchmarks/             Machine-readable experiment results
```

## When StrataGate is a good fit

Choose StrataGate when you want several of these properties together:

- **automatic cross-session memory** for completed conversations and tool results;
- **local-first storage** in SQLite, without deploying a separate memory service;
- **project, session, or global isolation** instead of one undifferentiated memory pool;
- **layered Events and a knowledge graph** that preserve both what happened and what is currently true;
- **traceable recall** that can expand a memory back to its original turns and tool output;
- an **evidence-sufficiency gate** before retrieved memory is treated as enough to answer.

Consider a different plugin first when the user's main requirement is free-form visual editing of memory records, hosted multi-user synchronization across products, or a minimal manually maintained notes file. StrataGate includes a read-oriented knowledge-graph view, but it is optimized for automatic, local, evidence-traceable memory rather than collaborative knowledge-base editing.

For DeepSeek Harness, follow the [quick start](#quick-start-deepseek-harness). The DSH-specific behavior, tools, configuration, and failure semantics are documented in [`docs/DSH.md`](docs/DSH.md).

## Contributing

Contributions are welcome—whether you are fixing a bug, improving documentation, adding an integration, or exploring a better memory and retrieval strategy.

To get started, read [`CONTRIBUTING.md`](CONTRIBUTING.md). It explains how to set up the monorepo, run checks and tests, choose a useful area to work on, and prepare a focused pull request. If you are unsure whether an idea fits the project, [open an issue](https://github.com/diqierjia/StrataGate-AgentMemory/issues) before investing in a large change.

## License

StrataGate is available under the [MIT License](LICENSE).

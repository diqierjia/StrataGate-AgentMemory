# Changelog

## 0.2.54 - 2026-09-07

- Keep the virtualized short-term memory dock below host overlays and hide it while a visible modal dialog such as Settings is open.

## 0.2.53 - 2026-09-06

- Prefer DSH's formal `settingsNavigation.openSection()` contract when opening a prepared Feedback draft, while retaining the HTTP deep link and legacy rc.7 navigation as compatibility fallbacks.
- Replace the permanently expanded Feedback report with an on-demand preview that shares the exact generated report snapshot used for clipboard copy and diagnostic download.
- Keep real report, diagnostic-log, and Memory content out of GitHub Issue URLs; prefill only the optional title and a generic HTML paste instruction.

## 0.2.52 - 2026-09-05

- Return the Feedback draft entry as an absolute link derived from DSH's active Web server port, so the conversation renderer keeps it clickable without hardcoding a port.

## 0.2.51 - 2026-09-04

- Keep the current short-term memory Block status visible above the composer when its inline conversation row scrolls out of view or is virtualized away.
- Show explicit open, sealed, compressing, failed, and compressed L0-L5 states while retaining expandable read-only Block details.
- Reuse the existing session feed and browser observers without adding runtime dependencies.

## 0.2.50 - 2026-09-04

- Keep feedback reports local instead of placing diagnostics, conversations, errors, or graph data in GitHub Issue URLs.
- Add a read-only report preview, clipboard-assisted Issue flow, and an exact UTF-8 diagnostic file download fallback.
- Build diagnostics from explicit field allowlists, preserve full report content, and warn users before including potentially private memory data.
- Add the local-only `feedback_prepare` Agent tool and editable AI-assisted feedback drafts in the feedback page.
- Detect explicit StrataGate tool, ingestion, Block derivation, and Graph projection failures for a short temporary Agent suggestion, with a global five-day cooldown.
- Keep GitHub submission manual and keep diagnostic logs and memory data opt-in.

## 0.2.48 - 2026-09-03

- Replace the short-term memory floating inspector with quiet, expandable Block status rows inside the conversation flow.
- Show persisted Turn ranges, the actual decayed L0-L5 layer, server-estimated layer token sizes, and read-only layer previews for the active DSH session.
- Restore sealed Block rows when the lightweight client consumes the paginated `memories(kind=blocks)` response.

## 0.2.47 - 2026-09-02

- Package the ordered, per-tool retrieval visualization as a new installable DSH release.

## 0.2.46 - 2026-09-02

- Show a quiet, expandable answer-tail retrieval receipt when matching memories were checked but not adopted, preserving each tool retrieval as an ordered group with separately numbered candidates and on-demand source details.

## 0.2.45 - 2026-09-02

- Show a quiet answer-tail retrieval note when matching memories were checked but not adopted.

## 0.2.44 - 2026-09-02

- Fuse BM25 and structured Event/Element relevance with the existing adoption-based time-decay ranking, without admitting irrelevant recent memories.

## 0.2.43 - 2026-09-01

- Simplify adopted-memory citations with compact answer-tail summaries, collapsed related/source details, and explicit context-use labels.
- Render adopted Knowledge Graph references as focused neighborhoods and show all Block levels while highlighting only the adopted level.

## 0.2.42 - 2026-09-01

- Restore live assistant rendering on DSH `0.1.0-rc.7` by publishing memory-citation location data under the registered conversation kind.
- Derive answer-tail citations from supported `memory_record_use` tool call and result events instead of persisting an unsupported custom session event.
- Preserve read compatibility for legacy citation events while allowing migrated session history to replay without refresh-only failures.

## 0.2.41 - 2026-09-01

- Render program-owned Event, Knowledge Graph, and Block citations under the exact assistant answer that adopted them through `memory_record_use`.
- Preserve adopted evidence kind, source reference, Block level, and expansion state in durable usage audits and session history.
- Open citation details directly from the answer tail, including the selected memory content and its source conversation.

## 0.2.40 - 2026-08-31

- Make Knowledge Graph limits explicit, render the top 100 nodes by default, and let users reveal 100 more at a time.
- Add total-aware pagination for Events and Blocks in 40-item pages and usage audits in 100-item pages.

## 0.2.39 - 2026-08-31

- Preview external-memory imports without writes, skip exact duplicates deterministically, and ask the configured model to adjudicate Top-K local matches.
- Apply high-confidence decisions automatically while requiring confirmation only for low-confidence candidates.
- Commit imports atomically and support undoing a committed import batch, including affected Event relationships and derived projections.
- Keep model adjudication outside storage revision ownership, then reload and retry only the short idempotent commit so concurrent writes cannot fail a running import.
- Persist external-memory analysis jobs with per-candidate progress, recover malformed exports through a model fallback, and resume progress plus low-confidence review after reopening the import page.
- Keep import status polling alive across transient network failures, reload stale active namespaces before retry, and resume background adjudication from the latest SQLite revision after concurrent memory writes.

## 0.2.37 - 2026-08-29

- Seal each completed Block immediately with deterministic L3-L4 and permanent L5, while keeping model-pending Blocks out of decay and native-surface replacement until L0-L2 and Event processing both complete.
- Add persisted summary jobs, bounded exponential retries, and SQLite schema v9 migration so derivation failures cannot lose turns, receipts, or block later sealing.
- Resolve exact-model `reasoningEffort: off` support, fall back once on explicit rejection, cache negative capability by route, and bound structured tasks by output tokens and a hard timeout.

## 0.2.36 - 2026-08-28

- Make completed conversation turns per Block editable in Advanced Settings, persist it globally, and suggest an optional λ adjustment that preserves decay speed per turn.

## 0.2.35 - 2026-08-27

- Return compact Event, Knowledge Graph, and raw-memory search cards while keeping full details in expand tools.
- Rename tool-facing ranking output to `rankScore` and document that it is not confidence or factual accuracy.
- Filter relation-only Knowledge Graph matches, report matched fields, and preserve distinct same-name entity types.

## 0.2.34 - 2026-08-27

- Add explicit `session` and `namespace` scopes to block and raw-memory retrieval.
- Return namespace, thread, counts, and machine-readable empty reasons for block queries.
- Keep session namespace isolation and make open-tail and cross-thread empty results explainable.

## 0.2.33 - 2026-08-27

- Keep concurrent retrieval batches independently addressable through optional `batch_id` parameters on assessment and usage recording while preserving latest-batch defaults for sequential calls.
- Report every assessment rejection and aggregate all invalid usage refs with batch status, available refs, and adopted refs; zero-use audits now retain the real batch ID.

## 0.2.30 - 2026-08-25

- Add compact minus, slider, and plus controls to the Knowledge Graph for faster zoom adjustments.
- Synchronize the visible zoom control with mouse-wheel zoom while keeping button and slider zoom centered on the graph canvas.

## 0.2.29 - 2026-08-25

- Keep the long-term memory explorer fixed to the browser viewport by removing transforms from its animated content ancestor.
- Add regression coverage for the full-screen positioning contract.

## 0.2.28 - 2026-08-25

- Refine the DSH Memory UI with clearer brand, navigation, hierarchy, spacing, and interaction states while retaining native DSH theme tokens.
- Add restrained view, Block expansion, graph layout, detail panel, popover, and skeleton-loading motion with reduced-motion support.
- Improve keyboard focus visibility, active navigation semantics, meaningful mascot alternative text, and tactile hover and pressed feedback.

## 0.2.27 - 2026-08-25

- Add optional semantic Tags to newly projected Knowledge Graph nodes for search, filtering, and understandable group names while keeping Node Type unchanged.
- Detect dynamic communities with seeded, weighted Leiden using active edges, relationship density, shared Events, Node Type, and Tags; Tags only strengthen existing structural affinity.
- Render ephemeral Cluster compound nodes with Cytoscape.js and fCoSE for clearer separation, overlap avoidance, pan/zoom, and relationship highlighting.
- Keep existing graph snapshots untouched: the projector version is unchanged, no historical Events are requeued, and nodes without Tags continue to render and cluster normally.

## 0.2.26 - 2026-08-25

- Size Knowledge Graph nodes by their long-term importance using supporting Events, active relationships, sustained recent activity, and current-workspace affinity.
- Keep node sizing stable across search and type filters by deriving importance from the complete graph snapshot.
- Preserve selection as an independent outline and glow treatment instead of temporarily enlarging the selected node.

## 0.2.25 - 2026-08-24

- Send every sealed conversation Block through its current decayed L0–L5 representation instead of a fixed L0/L1/L2 checkpoint.
- Re-replace native DSH Block checkpoints when decay, a manual lift, or the global decay coefficient changes their active level.
- Keep the original surface range shadowed, the unsealed open tail and tool chain native, and automatic system context limited to activated cross-conversation long-term memory.

## 0.2.24 - 2026-08-24

- Make the Knowledge Graph and Event Timeline fill the plugin width instead of reserving a permanent detail column.
- Add lightweight node and event detail bubbles, including hover persistence for timeline previews and summary-first event rows.
- Collapse advanced filters behind a compact toolbar control and move complete relationships, evidence, and exploration into full-screen views.

## 0.2.23 - 2026-08-24

- Replace each newly sealed conversation range on the native DSH surface with its compressed StrataGate Block summary, allowing `deriveMessages()` to shadow the corresponding raw messages while preserving the append-only evidence log.
- Keep unsealed open-tail messages and their tool-call/result chains in native DSH history instead of serializing them into the dynamic system context.
- Restrict automatic dynamic context to activated long-term memory from other conversations, preventing current conversation content from appearing in both native messages and the system prompt.

## 0.2.22 - 2026-08-24

- Replace the visible Element-card long-term memory model with an Event-backed Knowledge Graph of stable nodes and directed edges.
- Add the Knowledge Graph / Event Timeline settings views, evidence navigation, canonical Event types, and stable participant node references.
- Rebuild legacy Event history in small, prioritized, persisted, resumable background batches with projector-version tracking.

## 0.2.21 - 2026-08-24

- Use the current DSH Workspace session list and latest persisted DSH titles as the conversation selector source of truth.
- Recover pre-thread legacy conversation boundaries from ingestion receipts and render mixed legacy Blocks as read-only virtual fragments without rewriting SQLite.
- Add More → Feedback & Support with privacy-safe diagnostics, opt-in logs and memory data, GitHub Issue/Feature Request links, and Discussion Q&A.
- Retry transient read-only browser fetch failures and identify the failed StrataGate endpoint in diagnostics.

## 0.2.20 - 2026-08-24

- Redesign Short-term Memory around a per-conversation oldest-to-newest Block distribution, a dedicated horizontal rail, sealed Block distances, and a distinct open Block state.
- Expand Blocks inline into ordered L0–L5 previews with current-level highlighting and viewport-level, scrollable full-content hover cards that are not clipped by Settings.
- Keep only one layer menu open, offer expansion only for deeper layers, and distinguish user, Agent, and legacy expansion markers.
- Migrate storage to schema v7 to persist the source of each Block lift without mislabeling Agent retrieval as a user action.

## 0.2.19 - 2026-08-23

- Make the global Block decay coefficient λ editable in Advanced Settings with `0.05` steps, immediate application to existing workspaces, persistence across restarts, and inheritance by future workspaces.
- Show actual workspace names instead of internal namespace hashes and rename the current-project label to current workspace.
- Unify the settings page branding as `StrataGate-AgentMemory`, restore the mascot, and show a right-aligned genuine memory-use count with a GitHub Star link.

## 0.2.18 - 2026-08-23

- Match the Memory settings UI to DSH's resolved light, dark, or system appearance through the official semantic theme tokens.
- Remove the independent dark palette so the plugin background and controls no longer differ from the surrounding DSH settings panel.

## 0.2.17 - 2026-08-23

- Define Block age as the per-session distance from the latest sealed Block, so open-tail turns no longer decay Block detail.
- Add the configurable `blockDecayLambda` setting with a default of `0.3`; smaller values decay more slowly, and values above `0.4` are not recommended.
- Migrate SQLite storage to schema v6 and convert legacy turn anchors to per-thread Block positions without deleting existing memory.

## 0.2.16 - 2026-08-21

- Isolate open tails, Block sealing, decay, and automatic Block context by DSH session while keeping Events and Elements project-scoped for cross-session recall.
- Migrate SQLite storage to schema v5 with optional thread ownership on raw messages and Blocks; pre-v5 Blocks remain unowned archival provenance instead of being injected into new sessions.

## 0.2.15 - 2026-08-21

- Disable reasoning for internal structured memory workers because the current DSH adapters do not map `tool_choice` to the provider request.
- Keep strict native tool-call validation with a legal JSON fallback for adapters that expose tools but not forced tool selection.

## 0.2.14 - 2026-08-21

- Force each internal structured worker to target its one required tool when the provider supports the OpenAI-compatible `tool_choice` request field.
- Preserve the active session's reasoning effort on auxiliary memory-model calls instead of silently falling back to the provider default.
- Add regression coverage for forced tool selection and reasoning-effort propagation.

## 0.2.13 - 2026-08-21

- Run block summarization, event extraction, and element projection through single-purpose native tool calls with strict argument schemas.
- Keep reasoning/text blocks as diagnostics only instead of parsing them as memory results.
- Report internal structured-worker failures with the expected tool name so they are not mistaken for memory search argument failures.

## 0.2.12 - 2026-08-21

- Inject the complete open tail, every sealed Block at its current decay-pointer level, and a bounded set of activated Events and Element facts before each main-model call.
- Build activation queries from the current user message plus the latest two open-tail turns, retaining BM25 as the relevance gate and fusing relevance with existing memory weights through RRF.
- Keep automatic context read-only with respect to adoption: it never calls `recordMemoryUse`, increments `mentionCount`, or changes `lastAdoptedTurn`.
- Require every explicit retrieval batch to finish with `memory_record_use`: selected evidence refs reinforce only their own cards once, while an empty list records a zero-increment receipt and allows the turn to finish.
- Enforce unresolved retrieval accounting at DSH's turn-stopping boundary instead of relying only on prompt compliance.
- Close namespace storage when pending-work initialization fails so a retry does not leak a SQLite handle.

## 0.2.11 - 2026-08-21

- Recover a namespace after pending-work initialization fails instead of caching a rejected runtime promise.
- Distinguish intentionally skipped extraction from Blocks waiting for extraction.

## 0.2.10 - 2026-08-21

- Keep readable memory data visible when one administrative read fails.
- Refresh the Memory UI automatically and distinguish waiting Blocks from active processing.
- Prevent persisted ingestion failures from turning concurrent administrative reads into transient HTTP errors.

## 0.2.9 - 2026-08-20

- Force element projection responses to be JSON-only and require changes for identifiable entities.
- Recover structured JSON after model reasoning text and validate required response fields before accepting it.
- Surface empty element projections with an explicit event-count diagnostic and retry historical skipped extraction jobs on startup.
- Show a red in-progress banner with a loading indicator while block, event, or element memory processing is active.

## 0.2.8 - 2026-08-20

- Increase model output and retry limits to 10,000 tokens.
- Normalize generated timestamps to UTC+8 and treat truncated extraction responses as failures.

## 0.2.7 - 2026-08-20

- Make extractor context target-first: target retains L5 evidence while neighboring blocks provide only L2 context.
- Add an explicit target source-message allowlist and reject empty extraction results as failed work instead of silently skipping them.
- Add a bounded `resumePendingWork({ retrySkipped: true })` path for repairing historical skipped extraction jobs.

## 0.2.6 - 2026-08-20

- Redesign the Memory UI around Long-term Memory, Recent Memory, and More for narrow DeepSeek plugin windows.
- Present Events as long-term memories, Elements as related-item details, and Blocks as recent memories without changing extraction logic.
- Add user-facing organization states, reassuring failure messaging, memory-first search, and responsive light/dark layouts.
- Move system status, usage audit, raw data, model responses, and advanced settings out of the primary experience.

## 0.2.5 - 2026-08-20

- Republish the successful-response history and diagnostics as a distinct installable package version.

## 0.2.4 - 2026-08-20

- Republish the complete error-retention and 10,000-token default configuration as a distinct installable package version.

## 0.2.3 - 2026-08-20

- Improve model JSON recovery for reasoning-only, truncated, BOM-prefixed, and explanatory responses.
- Include bounded raw-response diagnostics when extraction or projection parsing fails.
- Preserve complete failure details for copying while showing only a 500-character preview in the Memory UI.
- Raise the default memory model output budget to 10,000 tokens.
- Retain the five most recent successful memory-model responses per namespace for diagnostics.

## 0.2.2 - 2026-08-19

- Retry malformed or truncated model JSON once with a correction instruction and parse balanced JSON values safely.
- Change the DeepSeek Harness block size default from four to six turns while keeping `blockTurnSize` configurable.
- Redesign the read-only Memory UI with pipeline health, visible block cadence, responsive metrics, and failed-job diagnostics.

## 0.2.1 - 2026-08-18

- Make marketplace, npm, and README descriptions match common agent searches for user preferences, project decisions, cross-session memory, and source-traceable recall.
- Show a dismissible GitHub Star invitation after StrataGate memory has been used in three evidence-backed answers.

## 0.2.0

- Add a read-only StrataGate Memory page for namespaces, Events, Elements, Blocks, source messages, and usage audits.
- Persist the Evidence Gate decision and evidence references with each use receipt.
- Add package-content, clean-install, Node, and DeepSeek Harness compatibility checks.

## 0.1.0

- Initial DeepSeek Harness integration with automatic ingestion, retrieval, expansion, evidence assessment, and use-only reinforcement.
# 0.2.32

- Redesign external AI memory import as a two-step modal with the complete export prompt, one-click copy, JSON validation, and direct import.

# 0.2.31

- Add v2 external AI memory export/import flow with time-safe candidate parsing and Event adjudication support.

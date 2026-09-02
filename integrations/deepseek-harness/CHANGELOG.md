# Changelog

## Unreleased

- Run block ingestion and activated-memory retrieval on a count-triggered background drain (per-session serialization, unref'd timer, exponential backoff) so the agent hot path never blocks on Stratagate memory work.
- Serve the assemble hook a synchronous auto-context snapshot cache refreshed by the background drain; an empty or stale snapshot is skipped or carries an explicit staleness marker instead of failing the request.
- Degrade `force-off` reasoning effort to the model default with a single warning when the provider does not advertise `off`, instead of raising a desktop notification and failing the structured call.
- Expose the `structuredReasoningEffort` policy (auto | force-off) as a user-editable plugin settings-page switch; the default is `auto`.

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

import { normalizeSearchText } from './search.js';
import type {
  EventCard,
  GraphEdge,
  GraphFact,
  GraphMetadataProvenanceEntry,
  GraphNode,
  GraphNodeMetadataProvenance,
  GraphNodeProjection,
  GraphProjectionResult,
  GraphRecordStatus,
  GraphTimelineEvent,
} from './types.js';

const NODE_TYPES = new Set(['person', 'project', 'organization', 'tool', 'place']);
const STATUSES = new Set<GraphRecordStatus>(['active', 'superseded', 'disputed', 'archived']);

export const GRAPH_PROVENANCE_LIMIT = 6;

export interface EffectiveGraphNodeView {
  node: GraphNode;
  currentFacts: GraphFact[];
  historicalFacts: GraphFact[];
  currentEdges: GraphEdge[];
  historicalEdges: GraphEdge[];
  currentNodeEventIds: string[];
  historicalNodeEventIds: string[];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function factText(fact: Pick<GraphFact, 'key' | 'value'>): string {
  return `${fact.key}: ${Array.isArray(fact.value) ? fact.value.join('、') : fact.value}`;
}

function renderCurrentState(facts: readonly GraphFact[]): string {
  return facts.map((fact) => `${factText(fact)}${fact.status === 'disputed' ? ' [disputed]' : ''}`).join('\n');
}

const EXPOSED_EVENT_STATUSES = new Set<EventCard['status']>(['active', 'superseded']);

function exposedSources(
  ids: readonly string[] | undefined,
  eventById: ReadonlyMap<string, EventCard>,
): string[] {
  return unique((ids ?? []).filter((id) => EXPOSED_EVENT_STATUSES.has(eventById.get(id)?.status ?? 'forgotten')));
}

function metadataEntries(
  entries: readonly GraphMetadataProvenanceEntry[] | undefined,
  allowedValues: readonly string[],
  eventById: ReadonlyMap<string, EventCard>,
): GraphMetadataProvenanceEntry[] {
  const allowed = new Set(allowedValues.map((value) => normalizeSearchText(value)));
  return (entries ?? []).flatMap((entry) => {
    const value = typeof entry.value === 'string' ? entry.value.trim() : '';
    const sourceEventIds = exposedSources(entry.sourceEventIds, eventById);
    return value && allowed.has(normalizeSearchText(value)) && sourceEventIds.length > 0
      ? [{ value, sourceEventIds }]
      : [];
  });
}

function effectiveMetadata(
  node: GraphNode,
  eventById: ReadonlyMap<string, EventCard>,
): Pick<GraphNode, 'name' | 'aliases' | 'tags' | 'metadataProvenance'> {
  if (!node.metadataProvenance) {
    const potentialSources = unique(node.sourceEventIds ?? []);
    const allSourcesExposed = potentialSources.length > 0
      && potentialSources.every((id) => EXPOSED_EVENT_STATUSES.has(eventById.get(id)?.status ?? 'forgotten'));
    return allSourcesExposed
      ? { name: node.name, aliases: [...node.aliases], ...(node.tags ? { tags: [...node.tags] } : {}) }
      : { name: '', aliases: [] };
  }

  const nameSources = exposedSources(node.metadataProvenance.name, eventById);
  const aliases = metadataEntries(node.metadataProvenance.aliases, node.aliases, eventById);
  const tags = metadataEntries(node.metadataProvenance.tags, node.tags ?? [], eventById);
  const metadataProvenance: GraphNodeMetadataProvenance = {
    ...(nameSources.length > 0 ? { name: nameSources } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
  return {
    name: nameSources.length > 0 ? node.name : '',
    aliases: aliases.map(({ value }) => value),
    ...(tags.length > 0 ? { tags: tags.map(({ value }) => value) } : {}),
    metadataProvenance,
  };
}

/**
 * Builds the single Event-authoritative Graph view used by search, expansion,
 * and automatic context. Hidden Event provenance never reaches the returned
 * records, and a current record requires at least one active source Event.
 */
export function effectiveGraphNodeView(
  node: GraphNode,
  edges: readonly GraphEdge[],
  events: readonly EventCard[],
): EffectiveGraphNodeView | null {
  if (node.status !== 'active' && node.status !== 'disputed') return null;
  const eventById = new Map(events.map((event) => [event.id, event]));
  const sources = (ids: readonly string[] | undefined, statuses: ReadonlySet<EventCard['status']>): string[] =>
    unique((ids ?? []).filter((id) => {
      const event = eventById.get(id);
      return event !== undefined && statuses.has(event.status);
    }));
  const activeStatuses = new Set<EventCard['status']>(['active']);
  const visibleStatuses = new Set<EventCard['status']>(['active', 'superseded']);
  const splitRecord = <T extends GraphFact | GraphEdge>(record: T): { current?: T; historical?: T } => {
    if (record.status === 'archived') return {};
    const activeSources = sources(record.sourceEventIds, activeStatuses);
    const visibleSources = sources(record.sourceEventIds, visibleStatuses);
    if ((record.status === 'active' || record.status === 'disputed') && activeSources.length > 0) {
      return { current: { ...record, sourceEventIds: activeSources } };
    }
    // During an Event replacement handoff, the old active edge has only
    // superseded sources until the next projection explicitly closes it.
    // Keep it in historical context so the projector can receive its id.
    if (visibleSources.length > 0 && (record.status === 'superseded'
      || (record.status === 'active' && activeSources.length === 0))) {
      return { historical: { ...record, sourceEventIds: visibleSources } };
    }
    return {};
  };

  const currentFacts: GraphFact[] = [];
  const historicalFacts: GraphFact[] = [];
  for (const fact of node.facts ?? []) {
    const split = splitRecord(fact);
    if (split.current) currentFacts.push(split.current);
    if (split.historical) historicalFacts.push(split.historical);
  }
  const currentEdges: GraphEdge[] = [];
  const historicalEdges: GraphEdge[] = [];
  for (const edge of edges.filter(({ fromNodeId, toNodeId }) => fromNodeId === node.id || toNodeId === node.id)) {
    const split = splitRecord(edge);
    if (split.current) currentEdges.push(split.current);
    if (split.historical) historicalEdges.push(split.historical);
  }
  const currentNodeEventIds = sources(node.sourceEventIds, activeStatuses);
  const historicalNodeEventIds = sources(node.sourceEventIds, new Set<EventCard['status']>(['superseded']));
  if (currentFacts.length === 0 && historicalFacts.length === 0
    && currentEdges.length === 0 && historicalEdges.length === 0
    && currentNodeEventIds.length === 0 && historicalNodeEventIds.length === 0) return null;

  const visibleNodeSources = unique([...currentNodeEventIds, ...historicalNodeEventIds]);
  const metadata = effectiveMetadata(node, eventById);
  const effectiveNode = { ...node, ...metadata };
  if (!Object.prototype.hasOwnProperty.call(metadata, 'tags')) delete effectiveNode.tags;
  return {
    node: { ...effectiveNode, currentState: renderCurrentState(currentFacts), facts: currentFacts, sourceEventIds: visibleNodeSources },
    currentFacts,
    historicalFacts,
    currentEdges,
    historicalEdges,
    currentNodeEventIds,
    historicalNodeEventIds,
  };
}

export function boundEffectiveGraphNodeView(
  view: EffectiveGraphNodeView,
  eventIds: ReadonlySet<string>,
  options: { preserveLegacyMetadata?: boolean } = {},
): EffectiveGraphNodeView {
  const boundRecord = <T extends GraphFact | GraphEdge>(record: T): T | null => {
    const sourceEventIds = record.sourceEventIds.filter((id) => eventIds.has(id));
    return sourceEventIds.length > 0 ? { ...record, sourceEventIds } : null;
  };
  const currentFacts = view.currentFacts.flatMap((record) => boundRecord(record) ?? []);
  const historicalFacts = view.historicalFacts.flatMap((record) => boundRecord(record) ?? []);
  const currentEdges = view.currentEdges.flatMap((record) => boundRecord(record) ?? []);
  const historicalEdges = view.historicalEdges.flatMap((record) => boundRecord(record) ?? []);
  const metadata = view.node.metadataProvenance
    ? (() => {
      const name = (view.node.metadataProvenance?.name ?? []).filter((id) => eventIds.has(id));
      const aliases = (view.node.metadataProvenance?.aliases ?? []).flatMap((entry) => {
        const sourceEventIds = entry.sourceEventIds.filter((id) => eventIds.has(id));
        return sourceEventIds.length > 0 ? [{ ...entry, sourceEventIds }] : [];
      });
      const tags = (view.node.metadataProvenance?.tags ?? []).flatMap((entry) => {
        const sourceEventIds = entry.sourceEventIds.filter((id) => eventIds.has(id));
        return sourceEventIds.length > 0 ? [{ ...entry, sourceEventIds }] : [];
      });
      return {
        name: name.length > 0 ? view.node.name : '',
        aliases: aliases.map(({ value }) => value),
        ...(tags.length > 0 ? { tags: tags.map(({ value }) => value) } : {}),
        metadataProvenance: {
          ...(name.length > 0 ? { name } : {}),
          ...(aliases.length > 0 ? { aliases } : {}),
          ...(tags.length > 0 ? { tags } : {}),
        },
      };
    })()
    : ((view.node.sourceEventIds.length > 0 && view.node.sourceEventIds.every((id) => eventIds.has(id))
      || options.preserveLegacyMetadata)
      ? { name: view.node.name, aliases: [...view.node.aliases], ...(view.node.tags ? { tags: [...view.node.tags] } : {}) }
      : { name: '', aliases: [] });
  const currentNodeEventIds = view.currentNodeEventIds.filter((id) => eventIds.has(id));
  const historicalNodeEventIds = view.historicalNodeEventIds.filter((id) => eventIds.has(id));
  const boundedNode = { ...view.node, ...metadata };
  if (!Object.prototype.hasOwnProperty.call(metadata, 'tags')) delete boundedNode.tags;
  return {
    node: { ...boundedNode, currentState: renderCurrentState(currentFacts), facts: currentFacts, sourceEventIds: unique([...currentNodeEventIds, ...historicalNodeEventIds]) },
    currentFacts,
    historicalFacts,
    currentEdges,
    historicalEdges,
    currentNodeEventIds,
    historicalNodeEventIds,
  };
}

export function graphTimeline(
  eventIds: readonly string[],
  events: readonly EventCard[],
  limit = GRAPH_PROVENANCE_LIMIT,
): GraphTimelineEvent[] {
  const order = new Map(eventIds.map((id, index) => [id, index]));
  return events.filter((event) => order.has(event.id)
      && event.status !== 'forgotten' && event.status !== 'archived')
    .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
    .slice(0, Math.max(0, limit))
    .map((event) => ({
      id: event.id,
      title: event.title,
      summary: event.summary,
      status: event.status,
      ...(event.temporal.happenedStart ? { time: event.temporal.happenedStart } : {}),
    }));
}

function text(value: unknown, limit = 240): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, limit) : '';
}

function strings(value: unknown, limit = 32): string[] {
  return Array.isArray(value) ? [...new Set(value.map((item) => text(item)).filter(Boolean))].slice(0, limit) : [];
}

function confidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.8;
}

function chronology(events: readonly EventCard[], ids: readonly string[], fallback: string): string {
  return ids.flatMap((id) => events.find((event) => event.id === id) ?? [])
    .map((event) => event.temporal.happenedStart ?? event.temporal.happenedEnd ?? event.temporal.mentionedAt ?? event.createdAt)
    .sort().at(-1) ?? fallback;
}

type EntityMatchKind = 'canonical-name' | 'alias' | null;

function entityMatchKind(
  node: GraphNode,
  proposal: Pick<GraphNodeProjection, 'name' | 'aliases' | 'type'>,
  eventById: ReadonlyMap<string, EventCard>,
): EntityMatchKind {
  if (node.type !== proposal.type) return null;
  const key = (value: string): string => normalizeSearchText(value).replace(/[\s_-]+/g, '');
  const metadata = effectiveMetadata(node, eventById);
  const proposalNames = new Set([proposal.name, ...(proposal.aliases ?? [])].map(key));
  if (proposalNames.has(key(metadata.name))) return 'canonical-name';
  if (metadata.aliases.some((value) => proposalNames.has(key(value)))) return 'alias';
  return null;
}

export interface ApplyGraphProjectionOptions {
  nodes: GraphNode[];
  edges: GraphEdge[];
  events: EventCard[];
  result: GraphProjectionResult;
  allowedEventIds: ReadonlySet<string>;
  now: string;
  idFactory: (prefix: 'node' | 'edge' | 'gfact') => string;
}

/** Applies a replaceable graph projection without ever treating legacy Elements as evidence. */
export function applyGraphProjection(options: ApplyGraphProjectionOptions): { nodeIds: string[]; edgeIds: string[]; warnings: string[] } {
  const refs = new Map<string, GraphNode>();
  const touchedNodes = new Set<string>();
  const touchedEdges = new Set<string>();
  const warnings: string[] = [];
  const eventById = new Map(options.events.map((event) => [event.id, event]));
  const validSources = (value: unknown): string[] => {
    const requested = strings(value, 64);
    return requested.length > 0 && requested.every((id) => options.allowedEventIds.has(id)
      && EXPOSED_EVENT_STATUSES.has(eventById.get(id)?.status ?? 'forgotten')) ? requested : [];
  };
  const activeSources = (ids: readonly string[]): string[] => ids.filter((id) => eventById.get(id)?.status === 'active');
  const metadataEntriesFromProjection = (
    entries: readonly GraphMetadataProvenanceEntry[] | undefined,
    fallbackValues: readonly string[],
  ): GraphMetadataProvenanceEntry[] => {
    const byValue = new Map((entries ?? []).map((entry) => [normalizeSearchText(entry.value), entry]));
    return fallbackValues.flatMap((value) => {
      const entry = byValue.get(normalizeSearchText(value));
      const sourceEventIds = validSources(entry?.sourceEventIds);
      if (sourceEventIds.length > 0) return [{ value, sourceEventIds }];
      warnings.push(`Dropped metadata value "${value}" because it lacks matching valid field provenance.`);
      return [];
    });
  };

  // Validate canonical-name provenance before mutating any node. This keeps an
  // invalid custom/model projection observable and prevents partial in-memory
  // writes when the batch must be rejected.
  for (const proposal of Array.isArray(options.result.nodes) ? options.result.nodes : []) {
    const ref = text(proposal.ref, 120);
    const name = text(proposal.name, 160);
    const sources = validSources(proposal.sourceEventIds);
    if (!ref || !name || !NODE_TYPES.has(proposal.type)) continue;
    if (sources.length === 0) {
      throw new Error(`Graph projection validation failed: node "${ref}" has no valid exposable source Event.`);
    }
    if (validSources(proposal.metadataProvenance?.name).length === 0) {
      throw new Error(`Graph projection validation failed: node "${ref}" name "${name}" lacks valid metadata provenance.`);
    }
  }

  for (const proposal of Array.isArray(options.result.nodes) ? options.result.nodes : []) {
    const ref = text(proposal.ref, 120);
    const name = text(proposal.name, 160);
    const sources = validSources(proposal.sourceEventIds);
    if (!ref || !name || !NODE_TYPES.has(proposal.type) || sources.length === 0) continue;
    const aliases = strings(proposal.aliases, 20).filter((alias) => normalizeSearchText(alias) !== normalizeSearchText(name));
    const tags = strings(proposal.tags, 12);
    const projectedNameSources = validSources(proposal.metadataProvenance?.name);
    if (projectedNameSources.length === 0) continue;
    const projectedMetadata = {
      name: projectedNameSources,
      aliases: metadataEntriesFromProjection(proposal.metadataProvenance?.aliases, aliases),
      tags: metadataEntriesFromProjection(proposal.metadataProvenance?.tags, tags),
    };
    const provenAliases = projectedMetadata.aliases.map(({ value }) => value);
    let node = options.nodes.find((candidate) => entityMatchKind(candidate, { name, aliases: provenAliases, type: proposal.type }, eventById));
    if (!node) {
      node = {
        id: options.idFactory('node'), name, type: proposal.type, aliases: [], currentState: '', facts: [],
        status: 'active', confidence: confidence(proposal.confidence), sourceEventIds: [],
        createdAt: options.now, updatedAt: options.now,
      };
      options.nodes.push(node);
    }
    const canonicalKey = normalizeSearchText(node.name);
    const canonicalNameSources = [
      ...(normalizeSearchText(name) === canonicalKey ? projectedMetadata.name : []),
      ...projectedMetadata.aliases
        .filter(({ value }) => normalizeSearchText(value) === canonicalKey)
        .flatMap(({ sourceEventIds }) => sourceEventIds),
      ...(node.metadataProvenance?.name ?? []),
    ];
    const projectedAliasEntries = [
      ...projectedMetadata.aliases.filter(({ value }) => normalizeSearchText(value) !== canonicalKey),
      ...(normalizeSearchText(name) !== canonicalKey ? [{ value: name, sourceEventIds: projectedMetadata.name }] : []),
      ...aliases.filter((alias) => normalizeSearchText(alias) !== canonicalKey
        && !projectedMetadata.aliases.some((entry) => normalizeSearchText(entry.value) === normalizeSearchText(alias)))
        .map((value) => ({ value, sourceEventIds: projectedMetadata.aliases.find((entry) => normalizeSearchText(entry.value) === normalizeSearchText(value))?.sourceEventIds ?? [] }))
        .filter(({ sourceEventIds }) => sourceEventIds.length > 0),
    ];
    node.aliases = [...new Set([...node.aliases, ...projectedAliasEntries.map(({ value }) => value)])];
    if (tags.length > 0) node.tags = [...new Set([...(node.tags ?? []), ...projectedMetadata.tags.map(({ value }) => value)])].slice(0, 12);
    const previousMetadata = node.metadataProvenance;
    const aliasEntries = [...(previousMetadata?.aliases ?? [])];
    for (const entry of projectedAliasEntries) {
      const existing = aliasEntries.find((candidate) => normalizeSearchText(candidate.value) === normalizeSearchText(entry.value));
      if (existing) existing.sourceEventIds = [...new Set([...existing.sourceEventIds, ...entry.sourceEventIds])];
      else aliasEntries.push(entry);
    }
    const tagEntries = [...(previousMetadata?.tags ?? [])];
    for (const entry of projectedMetadata.tags) {
      const existing = tagEntries.find((candidate) => normalizeSearchText(candidate.value) === normalizeSearchText(entry.value));
      if (existing) existing.sourceEventIds = [...new Set([...existing.sourceEventIds, ...entry.sourceEventIds])];
      else tagEntries.push(entry);
    }
    node.metadataProvenance = {
      ...(canonicalNameSources.length > 0
        ? { name: [...new Set(canonicalNameSources)] }
        : previousMetadata?.name ? { name: [...previousMetadata.name] } : {}),
      ...(aliasEntries.length > 0 ? { aliases: aliasEntries } : {}),
      ...(tagEntries.length > 0 ? { tags: tagEntries } : {}),
    };
    node.status = STATUSES.has(proposal.status ?? 'active') ? proposal.status ?? 'active' : 'active';
    node.confidence = confidence(proposal.confidence);
    node.sourceEventIds = [...new Set([...node.sourceEventIds, ...sources])];
    const validFrom = text(proposal.validFrom, 80) || chronology(options.events, sources, options.now);
    const validTo = text(proposal.validTo, 80) || undefined;
    const facts = [
      ...(text(proposal.state, 1_200) ? [{ key: 'state', value: text(proposal.state, 1_200) }] : []),
      ...(Array.isArray(proposal.facts) ? proposal.facts : []),
    ];
    for (const rawFact of facts) {
      const key = text(rawFact.key, 160);
      const value = Array.isArray(rawFact.value) ? strings(rawFact.value, 40) : text(rawFact.value, 1_200);
      if (!key || (Array.isArray(value) ? value.length === 0 : !value)) continue;
      const factSources = 'sourceEventIds' in rawFact ? validSources(rawFact.sourceEventIds) : sources;
      if (factSources.length === 0) {
        warnings.push(`Dropped fact "${key}" because it lacks valid exposable Event provenance.`);
        continue;
      }
      if ((node.status === 'active' || node.status === 'disputed') && activeSources(factSources).length === 0) {
        warnings.push(`Dropped current fact "${key}" because it has no active Event provenance.`);
        continue;
      }
      for (const old of node.facts.filter((fact) => fact.status === 'active' && fact.key === key)) {
        old.status = 'superseded';
        if (!old.validTo) old.validTo = validFrom;
        old.updatedAt = options.now;
      }
      const fact: GraphFact = {
        id: options.idFactory('gfact'), key, value, status: node.status,
        validFrom, ...(validTo ? { validTo } : {}), confidence: node.confidence,
        sourceEventIds: factSources, createdAt: options.now, updatedAt: options.now,
      };
      node.facts.push(fact);
    }
    node.currentState = node.facts.filter((fact) => fact.status === 'active')
      .map((fact) => `${fact.key}: ${Array.isArray(fact.value) ? fact.value.join('、') : fact.value}`).join('\n');
    node.updatedAt = options.now;
    refs.set(ref, node);
    touchedNodes.add(node.id);
  }

  for (const proposal of Array.isArray(options.result.edges) ? options.result.edges : []) {
    const from = refs.get(text(proposal.fromRef, 120));
    const to = refs.get(text(proposal.toRef, 120));
    const relation = text(proposal.relation, 100);
    const sources = validSources(proposal.sourceEventIds);
    if (!from || !to || from.id === to.id || !relation || sources.length === 0) continue;
    const status = STATUSES.has(proposal.status ?? 'active') ? proposal.status ?? 'active' : 'active';
    const validFrom = text(proposal.validFrom, 80) || chronology(options.events, sources, options.now);
    const validTo = text(proposal.validTo, 80) || undefined;
    if ((status === 'active' || status === 'disputed') && activeSources(sources).length === 0) {
      warnings.push(`Dropped current edge "${relation}" because it has no active Event provenance.`);
      continue;
    }
    const supersededIds = new Set(strings(proposal.supersedesEdgeIds, 64));
    for (const old of options.edges.filter((edge) => supersededIds.has(edge.id)
      && edge.status === 'active' && edge.fromNodeId === from.id && edge.relation === relation && edge.toNodeId !== to.id)) {
      old.status = 'superseded';
      if (!old.validTo) old.validTo = validFrom;
      old.updatedAt = options.now;
    }
    let edge = options.edges.find((candidate) => candidate.fromNodeId === from.id
      && candidate.toNodeId === to.id && candidate.relation === relation && candidate.status === status);
    if (!edge) {
      edge = {
        id: options.idFactory('edge'), fromNodeId: from.id, toNodeId: to.id, relation, status,
        validFrom, ...(validTo ? { validTo } : {}), confidence: confidence(proposal.confidence),
        sourceEventIds: sources, createdAt: options.now, updatedAt: options.now,
      };
      options.edges.push(edge);
    } else {
      edge.sourceEventIds = [...new Set([...edge.sourceEventIds, ...sources])];
      edge.confidence = confidence(proposal.confidence);
      edge.updatedAt = options.now;
    }
    touchedEdges.add(edge.id);
  }

  for (const event of options.events.filter((candidate) => options.allowedEventIds.has(candidate.id))) {
    const participantNodeIds = options.nodes.filter((node) => node.sourceEventIds.includes(event.id)).map(({ id }) => id);
    event.temporal.participantNodeIds = [...new Set([...(event.temporal.participantNodeIds ?? []), ...participantNodeIds])];
  }
  return { nodeIds: [...touchedNodes], edgeIds: [...touchedEdges], warnings: unique(warnings) };
}

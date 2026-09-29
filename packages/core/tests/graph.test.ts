import { describe, expect, it } from 'vitest';
import {
  GRAPH_PROVENANCE_LIMIT,
  StrataGate,
  type GraphEdge,
  type GraphNode,
  type PersistentStrataGateOptions,
} from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';
import { normalizeSnapshot } from '../src/storage.js';

describe('Event-backed knowledge graph', () => {
  it('uses one Event-authoritative current/historical view for facts, edge endpoints, and bounded provenance', async () => {
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      summarizer: async () => ({ l0Title: 'graph', l0Tags: [], l1Summary: 'graph', l2Keypoints: [], shouldExtract: false }),
    });
    await memory.appendTurn({ user: 'seed graph evidence', assistant: 'stored' });
    const block = memory.listBlocks()[0]!;
    const add = async (id: string, summary = id) => memory.addEvent({
      id, title: id, summary, sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id],
    });
    const currentA = await add('evt_current_a', '黄方目前在 A公司。');
    const historicalB = await add('evt_historical_b', '黄方曾经在 B公司。');
    historicalB.status = 'superseded';
    const secondSource = await add('evt_second_source', '另一个有效来源确认 pnpm。');
    const forgottenSource = await add('evt_forgotten', '这个来源已被遗忘。');
    await memory.forgetEvent(forgottenSource.id);
    const archivedSource = await add('evt_archived', '这个来源已归档。');
    archivedSource.status = 'archived';
    const disputedSource = await add('evt_disputed', '职位信息仍有争议。');
    const unrelated = await Promise.all(Array.from({ length: 8 }, (_, index) => add(`evt_unrelated_${index}`)));
    const now = '2026-09-20T00:00:00.000Z';
    const fact = (
      id: string, key: string, value: string, status: GraphNode['facts'][number]['status'], sourceEventIds: string[],
    ): GraphNode['facts'][number] => ({
      id, key, value, status, confidence: 0.9, sourceEventIds, createdAt: now, updatedAt: now,
    });
    const nodes = memory.listGraphNodes() as GraphNode[];
    nodes.push({
      id: 'node_person', name: '黄方', type: 'person', aliases: ['HF'], tags: ['developer'],
      currentState: 'company: B公司 (stale cache)', status: 'active', confidence: 0.9,
      sourceEventIds: [currentA.id, historicalB.id, forgottenSource.id, archivedSource.id, ...unrelated.map(({ id }) => id)],
      facts: [
        fact('fact_company_a', 'company', 'A', 'active', [currentA.id]),
        fact('fact_company_b', 'company', 'B', 'superseded', [historicalB.id]),
        fact('fact_location_b', 'location', 'B', 'active', [currentA.id]),
        fact('fact_cn_a', '公司', 'A公司', 'active', [currentA.id]),
        fact('fact_cn_b', '公司', 'B公司', 'superseded', [historicalB.id]),
        fact('fact_tool', 'packageManager', 'pnpm', 'active', [forgottenSource.id, secondSource.id]),
        fact('fact_hidden', 'secret', 'forgotten-only', 'active', [forgottenSource.id]),
        fact('fact_archived', 'secret', 'archived-only', 'active', [archivedSource.id]),
        fact('fact_disputed', 'role', 'architect', 'disputed', [disputedSource.id]),
      ],
      createdAt: now, updatedAt: now,
    }, {
      id: 'node_a', name: 'A公司', type: 'organization', aliases: ['AlphaCorp'], currentState: '', facts: [],
      status: 'active', confidence: 0.9, sourceEventIds: [currentA.id], createdAt: now, updatedAt: now,
    }, {
      id: 'node_b', name: 'B公司', type: 'organization', aliases: ['BetaCorp'], currentState: '', facts: [],
      status: 'active', confidence: 0.9, sourceEventIds: [historicalB.id], createdAt: now, updatedAt: now,
    }, {
      id: 'node_hidden', name: 'Hidden Entity', type: 'project', aliases: [], currentState: 'secret',
      facts: [fact('fact_hidden_node', 'state', 'secret', 'active', [forgottenSource.id])],
      status: 'active', confidence: 0.9, sourceEventIds: [forgottenSource.id], createdAt: now, updatedAt: now,
    }, {
      id: 'node_archived', name: 'Archived Entity', type: 'project', aliases: [], currentState: 'secret',
      facts: [fact('fact_archived_node', 'state', 'secret', 'active', [archivedSource.id])],
      status: 'active', confidence: 0.9, sourceEventIds: [archivedSource.id], createdAt: now, updatedAt: now,
    });
    const edges = memory.listGraphEdges() as GraphEdge[];
    edges.push({
      id: 'edge_a', fromNodeId: 'node_person', toNodeId: 'node_a', relation: 'works_at', status: 'active',
      confidence: 0.9, sourceEventIds: [currentA.id], createdAt: now, updatedAt: now,
    }, {
      id: 'edge_b', fromNodeId: 'node_person', toNodeId: 'node_b', relation: 'works_at', status: 'superseded',
      confidence: 0.9, sourceEventIds: [historicalB.id], createdAt: now, updatedAt: now,
    });

    const person = (results: Awaited<ReturnType<typeof memory.searchGraphNodes>>) =>
      results.find(({ node }) => node.id === 'node_person');
    const current = person(await memory.searchGraphNodes('A公司'))!;
    expect(current).toMatchObject({ matchType: 'current' });
    expect(current.currentFacts).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'fact_cn_a' })]));
    expect(current.currentEdges).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'edge_a' })]));
    expect(current.node.currentState).toContain('company: A');
    expect(current.node.currentState).not.toContain('stale cache');

    const historical = person(await memory.searchGraphNodes('B公司'))!;
    expect(historical).toMatchObject({ matchType: 'historical' });
    expect(historical.historicalFacts).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'fact_cn_b' })]));
    expect(historical.historicalEdges).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'edge_b' })]));
    expect(historical.node.currentState).toContain('company: A');
    expect(historical.provenanceEventIds?.[0]).toBe(historicalB.id);
    expect(historical.provenanceEventIds).toContain(currentA.id);
    expect(historical.provenanceEventIds!.length).toBeLessThanOrEqual(GRAPH_PROVENANCE_LIMIT);
    expect(historical.timeline!.length).toBeLessThanOrEqual(GRAPH_PROVENANCE_LIMIT);
    expect(historical.timeline?.[0]?.id).toBe(historicalB.id);

    expect(person(await memory.searchGraphNodes('A公司 B公司'))?.matchType).toBe('both');
    expect(person(await memory.searchGraphNodes('company B'))?.matchType).toBe('historical');
    expect(person(await memory.searchGraphNodes('黄方以前在B公司吗'))?.matchType).toBe('historical');
    expect(person(await memory.searchGraphNodes('B公司'))?.matchType).toBe('historical');
    expect(person(await memory.searchGraphNodes('AlphaCorp'))?.matchType).toBe('current');
    expect(person(await memory.searchGraphNodes('BetaCorp'))?.matchType).toBe('historical');
    expect(person(await memory.searchGraphNodes('works_at'))).toBeUndefined();

    const multiSource = person(await memory.searchGraphNodes('pnpm'))!;
    expect(multiSource.matchType).toBe('current');
    expect(multiSource.currentFacts?.[0]?.sourceEventIds).toEqual([secondSource.id]);
    expect(multiSource.node.currentState).toContain('packageManager: pnpm');
    expect(multiSource.node.currentState).not.toContain('forgotten-only');
    expect(multiSource.node.currentState).not.toContain('archived-only');
    const disputed = person(await memory.searchGraphNodes('architect'))!;
    expect(disputed.matchType).toBe('current');
    expect(disputed.currentFacts?.[0]).toMatchObject({ status: 'disputed' });
    expect(disputed.node.currentState).toContain('[disputed]');
    expect(await memory.searchGraphNodes('Hidden Entity')).toEqual([]);
    expect(await memory.searchGraphNodes('Archived Entity')).toEqual([]);
    expect(person(await memory.searchGraphNodes('packageManager'))?.matchType).toBe('current');
    for (const result of [current, historical, multiSource]) {
      const evidence = new Set(result.provenanceEventIds);
      for (const record of [
        ...(result.currentFacts ?? []), ...(result.historicalFacts ?? []),
        ...(result.currentEdges ?? []), ...(result.historicalEdges ?? []),
      ]) {
        expect(record.sourceEventIds.length).toBeGreaterThan(0);
        expect(record.sourceEventIds.every((id) => evidence.has(id))).toBe(true);
      }
    }
  });

  it('fails safe for legacy metadata and filters field-level metadata provenance', async () => {
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      summarizer: async () => ({ l0Title: 'graph', l0Tags: [], l1Summary: 'graph', l2Keypoints: [], shouldExtract: false }),
    });
    await memory.appendTurn({ user: 'metadata evidence', assistant: 'stored' });
    const block = memory.listBlocks()[0]!;
    const add = async (id: string) => memory.addEvent({
      id, title: id, summary: id, sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id],
    });
    const active = await add('evt_metadata_active');
    const forgotten = await add('evt_metadata_forgotten');
    await memory.forgetEvent(forgotten.id);
    const now = '2026-09-20T00:00:00.000Z';
    const nodes = memory.listGraphNodes() as GraphNode[];
    nodes.push({
      id: 'node_legacy_metadata', name: 'LegacyUnique', type: 'project', aliases: ['forbiddenlegacy'], tags: ['forbiddentag'],
      currentState: '', status: 'active', confidence: 0.9, sourceEventIds: [active.id, forgotten.id], facts: [], createdAt: now, updatedAt: now,
    }, {
      id: 'node_field_metadata', name: 'Field Entity', type: 'project', aliases: ['safe-alias', 'forgotten-alias-2'], tags: ['safe-tag', 'forgotten-tag-2'],
      metadataProvenance: {
        name: [active.id],
        aliases: [
          { value: 'safe-alias', sourceEventIds: [active.id] },
          { value: 'forbiddenlegacy-2', sourceEventIds: [forgotten.id] },
        ],
        tags: [
          { value: 'safe-tag', sourceEventIds: [active.id] },
          { value: 'forbiddentag-2', sourceEventIds: [forgotten.id] },
        ],
      },
      currentState: '', status: 'active', confidence: 0.9, sourceEventIds: [active.id, forgotten.id], facts: [], createdAt: now, updatedAt: now,
    });

    expect(await memory.searchGraphNodes('forbiddenlegacy')).toEqual([]);
    expect(await memory.searchGraphNodes('forbiddentag')).toEqual([]);
    const safeAlias = await memory.searchGraphNodes('safe-alias');
    expect(safeAlias[0]?.node.name).toBe('Field Entity');
    expect(safeAlias[0]?.node.aliases).toEqual(['safe-alias']);
    expect(safeAlias[0]?.node.aliases).not.toContain('forbiddenlegacy-2');
    expect(safeAlias[0]?.node.tags).toEqual(['safe-tag']);
    const legacyName = await memory.searchGraphNodes('LegacyUnique');
    expect(legacyName).toEqual([]);
  });

  it('keeps legacy metadata readable when all active and superseded sources fit evidence', async () => {
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      summarizer: async () => ({ l0Title: 'graph', l0Tags: [], l1Summary: 'graph', l2Keypoints: [], shouldExtract: false }),
    });
    await memory.appendTurn({ user: 'legacy metadata evidence', assistant: 'stored' });
    const block = memory.listBlocks()[0]!;
    const active = await memory.addEvent({ id: 'evt_legacy_active', title: 'active', summary: 'active', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    const superseded = await memory.addEvent({ id: 'evt_legacy_superseded', title: 'superseded', summary: 'superseded', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    superseded.status = 'superseded';
    (memory.listGraphNodes() as GraphNode[]).push({
      id: 'node_legacy_readable', name: 'LegacyReadable', type: 'project', aliases: ['LegacyAlias'], tags: ['legacy-tag'],
      currentState: '', status: 'active', confidence: 0.9, sourceEventIds: [active.id, superseded.id], facts: [],
      createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    });
    const result = (await memory.searchGraphNodes('LegacyReadable'))[0]!;
    expect(result.node.name).toBe('LegacyReadable');
    expect(result.provenanceEventIds).toEqual(expect.arrayContaining([active.id, superseded.id]));
  });

  it('marks trusted legacy metadata as not expanded when its legal sources exceed the evidence budget', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1 });
    await memory.appendTurn({ user: 'legacy metadata overflow', assistant: 'stored' });
    const block = memory.listBlocks()[0]!;
    const events = await Promise.all(Array.from({ length: GRAPH_PROVENANCE_LIMIT + 1 }, (_, index) => memory.addEvent({
      id: `evt_legacy_overflow_${index}`, title: `event-${index}`, summary: `event-${index}`, sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id],
    })));
    (memory.listGraphNodes() as GraphNode[]).push({
      id: 'node_legacy_overflow', name: 'LegacyOverflow', type: 'project', aliases: ['OverflowAlias'], currentState: '', status: 'active', confidence: 0.9,
      sourceEventIds: events.map(({ id }) => id), facts: [], createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    });
    const result = (await memory.searchGraphNodes('LegacyOverflow'))[0]!;
    expect(result.node.name).toBe('LegacyOverflow');
    expect(result.metadataEvidenceStatus).toBe('not_expanded');
    expect(result.provenanceEventIds).toEqual([]);
  });

  it('does not let a hidden legacy alias participate in entity merge', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1 });
    const events = [{ id: 'evt_hidden_alias', status: 'forgotten' as const }, { id: 'evt_new_entity', status: 'active' as const }];
    const nodes = memory.listGraphNodes() as GraphNode[];
    nodes.push({
      id: 'node_existing', name: 'Canonical A', type: 'project', aliases: ['Hidden B'], currentState: '', facts: [],
      status: 'active', confidence: 0.9, sourceEventIds: [events[0]!.id], createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    });
    const eventCards = events.map((event) => ({
      ...event, title: event.id, summary: event.id, sourceBlockId: 'block', sourceMessageIds: [], tags: [], quotes: [],
      temporal: {}, scope: 'project' as const, criticality: 'routine' as const, supersededBy: null,
      weight: { mentionCount: 1, lastAdoptedTurn: 0, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null },
      createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    }));
    const { applyGraphProjection } = await import('../src/graph.js');
    applyGraphProjection({
      nodes, edges: memory.listGraphEdges() as GraphEdge[], events: eventCards, allowedEventIds: new Set([events[1]!.id]), now: '2026-09-20T00:00:00.000Z', idFactory: (prefix) => `${prefix}_new`,
      result: { reason: 'test', nodes: [{ ref: 'new', name: 'New C', type: 'project', aliases: ['Hidden B'], tags: [], metadataProvenance: { name: [events[1]!.id], aliases: [{ value: 'Hidden B', sourceEventIds: [events[1]!.id] }] }, sourceEventIds: [events[1]!.id] }], edges: [] },
    });
    expect(nodes).toHaveLength(2);
  });

  it('keeps canonical name provenance separate from an alias-based merge', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1 });
    const makeEvent = (id: string) => ({
      id, title: id, summary: id, sourceBlockId: 'block', sourceMessageIds: [], tags: [], quotes: [], temporal: {}, scope: 'project' as const, criticality: 'routine' as const, status: 'active' as const, supersededBy: null,
      weight: { mentionCount: 1, lastAdoptedTurn: 0, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null }, createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    });
    const e1 = makeEvent('evt_existing_name'); const e3 = makeEvent('evt_proposal_name'); const e4 = makeEvent('evt_existing_alias');
    const nodes = memory.listGraphNodes() as GraphNode[];
    nodes.push({ id: 'node_a', name: 'A', type: 'project', aliases: [], currentState: '', facts: [], status: 'active', confidence: 0.9, sourceEventIds: [e1.id], metadataProvenance: { name: [e1.id] }, createdAt: e1.createdAt, updatedAt: e1.updatedAt });
    const { applyGraphProjection } = await import('../src/graph.js');
    applyGraphProjection({
      nodes, edges: memory.listGraphEdges() as GraphEdge[], events: [e1, e3, e4], allowedEventIds: new Set([e3.id, e4.id]), now: e1.createdAt, idFactory: (prefix) => `${prefix}_new`,
      result: { reason: 'test', nodes: [{ ref: 'proposal', name: 'B', type: 'project', aliases: ['A'], tags: [], metadataProvenance: { name: [e3.id], aliases: [{ value: 'A', sourceEventIds: [e4.id] }] }, sourceEventIds: [e3.id, e4.id] }], edges: [] },
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.metadataProvenance?.name).toEqual(expect.arrayContaining([e1.id, e4.id]));
    expect(nodes[0]?.metadataProvenance?.name).not.toContain(e3.id);
    expect(nodes[0]?.metadataProvenance?.aliases).toEqual(expect.arrayContaining([{ value: 'B', sourceEventIds: [e3.id] }]));
  });

  it('does not merge through a proposal alias that lacks valid field provenance', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1 });
    const makeEvent = (id: string) => ({
      id, title: id, summary: id, sourceBlockId: 'block', sourceMessageIds: [], tags: [], quotes: [], temporal: {}, scope: 'project' as const, criticality: 'routine' as const, status: 'active' as const, supersededBy: null,
      weight: { mentionCount: 1, lastAdoptedTurn: 0, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null }, createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    });
    const existingSource = makeEvent('evt_existing');
    const proposalSource = makeEvent('evt_proposal');
    const nodes = memory.listGraphNodes() as GraphNode[];
    nodes.push({
      id: 'node_existing', name: 'Canonical A', type: 'project', aliases: [], currentState: '', facts: [],
      status: 'active', confidence: 0.9, sourceEventIds: [existingSource.id], metadataProvenance: { name: [existingSource.id] },
      createdAt: existingSource.createdAt, updatedAt: existingSource.updatedAt,
    });
    const { applyGraphProjection } = await import('../src/graph.js');
    applyGraphProjection({
      nodes, edges: memory.listGraphEdges() as GraphEdge[], events: [existingSource, proposalSource],
      allowedEventIds: new Set([proposalSource.id]), now: proposalSource.createdAt, idFactory: (prefix) => `${prefix}_new`,
      result: { reason: 'test', nodes: [{
        ref: 'proposal', name: 'Separate B', type: 'project', aliases: ['Canonical A'], tags: [],
        metadataProvenance: { name: [proposalSource.id] }, sourceEventIds: [proposalSource.id],
      }], edges: [] },
    });
    expect(nodes).toHaveLength(2);
    expect(nodes[0]?.aliases).toEqual([]);
    expect(nodes[1]).toMatchObject({ name: 'Separate B', aliases: [] });
  });

  it('does not fall back to node sources when metadata provenance is missing or mismatched', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1 });
    const makeEvent = (id: string) => ({
      id, title: id, summary: id, sourceBlockId: 'block', sourceMessageIds: [], tags: [], quotes: [], temporal: {}, scope: 'project' as const, criticality: 'routine' as const, status: 'active' as const, supersededBy: null,
      weight: { mentionCount: 1, lastAdoptedTurn: 0, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null }, createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    });
    const source = makeEvent('evt_projection_source');
    const nodes = memory.listGraphNodes() as GraphNode[];
    const { applyGraphProjection } = await import('../src/graph.js');
    expect(() => applyGraphProjection({
      nodes, edges: memory.listGraphEdges() as GraphEdge[], events: [source], allowedEventIds: new Set([source.id]), now: source.createdAt, idFactory: (prefix) => `${prefix}_new`,
      result: { reason: 'test', nodes: [{ ref: 'missing-name-source', name: 'Rejected', type: 'project', aliases: [], tags: [], sourceEventIds: [source.id] }], edges: [] },
    })).toThrow(/metadata provenance/i);
    applyGraphProjection({
      nodes, edges: memory.listGraphEdges() as GraphEdge[], events: [source], allowedEventIds: new Set([source.id]), now: source.createdAt, idFactory: (prefix) => `${prefix}_new`,
      result: { reason: 'test', nodes: [{ ref: 'mismatched-alias', name: 'Kept', type: 'project', aliases: ['Alias B'], tags: [], metadataProvenance: { name: [source.id], aliases: [{ value: 'Alias C', sourceEventIds: [source.id] }] }, sourceEventIds: [source.id] }], edges: [] },
    });
    expect(nodes.map(({ name }) => name)).toEqual(['Kept']);
    expect(nodes[0]?.aliases).toEqual([]);
  });

  it('classifies a metadata-only hit from the exact matched field provenance', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1 });
    await memory.appendTurn({ user: 'metadata history', assistant: 'stored' });
    const block = memory.listBlocks()[0]!;
    const current = await memory.addEvent({ id: 'evt_current_name', title: 'current', summary: 'Current canonical name.', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    const historical = await memory.addEvent({ id: 'evt_historical_alias', title: 'historical', summary: 'Historical alias.', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    historical.status = 'superseded';
    (memory.listGraphNodes() as GraphNode[]).push({
      id: 'node_metadata_history', name: 'Current Name', type: 'project', aliases: ['Old Alias'], currentState: '', facts: [],
      metadataProvenance: { name: [current.id], aliases: [{ value: 'Old Alias', sourceEventIds: [historical.id] }] },
      status: 'active', confidence: 0.9, sourceEventIds: [current.id, historical.id], createdAt: current.createdAt, updatedAt: current.updatedAt,
    });
    expect((await memory.searchGraphNodes('Current Name'))[0]?.matchType).toBe('current');
    const aliasHit = (await memory.searchGraphNodes('Old Alias'))[0]!;
    expect(aliasHit.matchType).toBe('historical');
    expect(aliasHit.provenanceEventIds?.[0]).toBe(historical.id);
  });

  it('keeps key and value matching on the same fact record', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1 });
    await memory.appendTurn({ user: 'fact association', assistant: 'stored' });
    const block = memory.listBlocks()[0]!;
    const event = await memory.addEvent({ id: 'evt_fact_association', title: 'facts', summary: 'Company and location.', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    const now = '2026-09-20T00:00:00.000Z';
    (memory.listGraphNodes() as GraphNode[]).push({
      id: 'node_fact_association', name: 'Subject', type: 'person', aliases: [], currentState: '',
      metadataProvenance: { name: [event.id] }, status: 'active', confidence: 0.9, sourceEventIds: [event.id],
      facts: [
        { id: 'fact_company_a', key: 'company', value: 'A', status: 'active', confidence: 0.9, sourceEventIds: [event.id], createdAt: now, updatedAt: now },
        { id: 'fact_location_a', key: 'location', value: 'A', status: 'active', confidence: 0.9, sourceEventIds: [event.id], createdAt: now, updatedAt: now },
      ], createdAt: now, updatedAt: now,
    });
    const hit = (await memory.searchGraphNodes('company A'))[0]!;
    expect(hit.currentFacts?.map(({ id }) => id)).toEqual(['fact_company_a']);
  });

  it('reports missing canonical metadata provenance as a failed projection', async () => {
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      graphProjector: async ({ events }) => ({
        reason: 'custom projector omitted field provenance',
        nodes: [{ ref: 'invalid', name: 'Invalid node', type: 'project', aliases: [], tags: [], sourceEventIds: [events[0]!.id] }],
        edges: [],
      }),
    });
    await memory.appendTurn({ user: 'projection validation', assistant: 'stored' });
    const block = memory.listBlocks()[0]!;
    await memory.addEvent({ id: 'evt_invalid_projection', title: 'invalid', summary: 'invalid projection', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    await memory.resumePendingWork();
    expect(memory.listGraphNodes()).toEqual([]);
    expect(memory.listGraphProjectionJobs()[0]).toMatchObject({ status: 'failed' });
    expect(memory.listGraphProjectionJobs()[0]?.lastError).toMatch(/metadata provenance/i);
  });

  it('records dropped alias and tag provenance as a completed projection warning', async () => {
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      graphProjector: async ({ events }) => ({
        reason: 'valid node with invalid optional metadata',
        nodes: [{
          ref: 'warning', name: 'Warning node', type: 'project', aliases: ['Unproven Alias'], tags: ['unproven-tag'],
          metadataProvenance: { name: [events[0]!.id] }, sourceEventIds: [events[0]!.id],
        }],
        edges: [],
      }),
    });
    await memory.appendTurn({ user: 'projection warning', assistant: 'stored' });
    const block = memory.listBlocks()[0]!;
    await memory.addEvent({ id: 'evt_projection_warning', title: 'warning', summary: 'warning projection', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    await memory.resumePendingWork();
    expect(memory.listGraphNodes()[0]).toMatchObject({ name: 'Warning node', aliases: [] });
    expect(memory.listGraphNodes()[0]?.tags).toEqual([]);
    expect(memory.listGraphProjectionJobs()[0]).toMatchObject({ status: 'completed', lastError: null });
    expect(memory.listGraphProjectionJobs()[0]?.reason).toMatch(/Dropped metadata value/i);
  });

  it('rejects a projection whose source Event became forgotten before completion', async () => {
    const now = '2026-09-20T00:00:00.000Z';
    const active = {
      id: 'evt_existing_active', title: 'active', summary: 'active', sourceBlockId: 'block', sourceMessageIds: [], tags: [], quotes: [], temporal: {}, scope: 'project' as const, criticality: 'routine' as const, status: 'active' as const, supersededBy: null,
      weight: { mentionCount: 1, lastAdoptedTurn: 0, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null }, createdAt: now, updatedAt: now,
    };
    const forgotten = { ...active, id: 'evt_forgotten_before_completion', status: 'forgotten' as const };
    const node: GraphNode = {
      id: 'node_existing_current', name: 'Existing', type: 'project', aliases: [], currentState: 'company: A',
      metadataProvenance: { name: [active.id] }, status: 'active', confidence: 0.9, sourceEventIds: [active.id],
      facts: [{ id: 'fact_existing_a', key: 'company', value: 'A', status: 'active', confidence: 0.9, sourceEventIds: [active.id], createdAt: now, updatedAt: now }],
      createdAt: now, updatedAt: now,
    };
    const { applyGraphProjection } = await import('../src/graph.js');
    expect(() => applyGraphProjection({
      nodes: [node], edges: [], events: [active, forgotten], allowedEventIds: new Set([forgotten.id]), now, idFactory: (prefix) => `${prefix}_new`,
      result: { reason: 'late response', nodes: [{
        ref: 'existing', name: 'Existing', type: 'project', aliases: [], tags: [], metadataProvenance: { name: [forgotten.id] },
        facts: [{ key: 'company', value: 'B', sourceEventIds: [forgotten.id] }], sourceEventIds: [forgotten.id],
      }], edges: [] },
    })).toThrow(/no valid exposable source Event/i);
    expect(node.facts).toEqual([expect.objectContaining({ id: 'fact_existing_a', status: 'active', value: 'A' })]);
  });

  it('does not expose claims whose provenance falls outside the evidence limit', async () => {
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      summarizer: async () => ({ l0Title: 'graph', l0Tags: [], l1Summary: 'graph', l2Keypoints: [], shouldExtract: false }),
    });
    await memory.appendTurn({ user: 'many graph facts', assistant: 'stored' });
    const block = memory.listBlocks()[0]!;
    const events = await Promise.all(Array.from({ length: 7 }, (_, index) => memory.addEvent({
      id: `evt_many_${index}`, title: `event-${index}`, summary: `event-${index}`, sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id],
    })));
    const now = '2026-09-20T00:00:00.000Z';
    (memory.listGraphNodes() as GraphNode[]).push({
      id: 'node_many_facts', name: 'Many Facts', type: 'project', aliases: [], currentState: '', status: 'active', confidence: 0.9,
      sourceEventIds: events.map(({ id }) => id), facts: events.map((event, index) => ({
        id: `fact_many_${index}`, key: `fact${index}`, value: `needle-${index}`, status: 'active' as const,
        confidence: 0.9, sourceEventIds: [event.id], createdAt: now, updatedAt: now,
      })), createdAt: now, updatedAt: now,
    });
    const result = (await memory.searchGraphNodes('needle'))[0]!;
    const evidence = new Set(result.provenanceEventIds);
    expect(result.provenanceEventIds).toHaveLength(GRAPH_PROVENANCE_LIMIT);
    expect(result.currentFacts?.length).toBeLessThanOrEqual(GRAPH_PROVENANCE_LIMIT);
    expect(result.node.currentState).not.toContain('needle-6');
    for (const record of result.currentFacts ?? []) {
      expect(record.sourceEventIds.length).toBeGreaterThan(0);
      expect(record.sourceEventIds.every((id) => evidence.has(id))).toBe(true);
    }
  });

  it('returns current context for a historical Edge without changing its match type', async () => {
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      summarizer: async () => ({ l0Title: 'graph', l0Tags: [], l1Summary: 'graph', l2Keypoints: [], shouldExtract: false }),
    });
    await memory.appendTurn({ user: 'edge history', assistant: 'stored' });
    const block = memory.listBlocks()[0]!;
    const add = async (id: string, summary: string) => memory.addEvent({
      id, title: id, summary, sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id],
    });
    const currentEvent = await add('evt_edge_current', '黄方目前在 A公司。');
    const historicalEvent = await add('evt_edge_historical', '黄方曾经在 B公司。');
    historicalEvent.status = 'superseded';
    const now = '2026-09-20T00:00:00.000Z';
    const nodes = memory.listGraphNodes() as GraphNode[];
    nodes.push(
      { id: 'edge_person', name: '黄方', type: 'person', aliases: [], currentState: '', status: 'active', confidence: 0.9, sourceEventIds: [currentEvent.id, historicalEvent.id], facts: [], createdAt: now, updatedAt: now },
      { id: 'edge_a_company', name: 'A公司', type: 'organization', aliases: ['AlphaCorp'], currentState: '', status: 'active', confidence: 0.9, sourceEventIds: [currentEvent.id], facts: [], createdAt: now, updatedAt: now },
      { id: 'edge_b_company', name: 'B公司', type: 'organization', aliases: ['BetaCorp'], currentState: '', status: 'active', confidence: 0.9, sourceEventIds: [historicalEvent.id], facts: [], createdAt: now, updatedAt: now },
    );
    (memory.listGraphEdges() as GraphEdge[]).push(
      { id: 'edge_current', fromNodeId: 'edge_person', toNodeId: 'edge_a_company', relation: 'works_at', status: 'active', confidence: 0.9, sourceEventIds: [currentEvent.id], createdAt: now, updatedAt: now },
      { id: 'edge_historical', fromNodeId: 'edge_person', toNodeId: 'edge_b_company', relation: 'works_at', status: 'superseded', confidence: 0.9, sourceEventIds: [historicalEvent.id], createdAt: now, updatedAt: now },
    );
    const historical = (await memory.searchGraphNodes('B公司')).find(({ node }) => node.id === 'edge_person')!;
    expect(historical.matchType).toBe('historical');
    expect(historical.historicalEdges).toEqual([expect.objectContaining({ id: 'edge_historical' })]);
    expect(historical.currentEdges).toEqual([expect.objectContaining({ id: 'edge_current' })]);
    expect(historical.provenanceEventIds).toEqual([historicalEvent.id, currentEvent.id]);
  });

  it('projects stable nodes and directed edges while keeping Event as source of truth', async () => {
    let sequence = 0;
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      summarizer: async () => ({ l0Title: 'event', l0Tags: [], l1Summary: 'event', l2Keypoints: [], shouldExtract: true }),
      idFactory: (prefix) => `${prefix}_${++sequence}`,
      graphIdFactory: (prefix) => `${prefix}_${++sequence}`,
      extractor: async ({ target }) => ({
        shouldExtract: true,
        reason: 'durable event',
        events: [{
          title: '发布 StrataGate',
          summary: 'chenhw7 使用 npm 发布 StrataGate。',
          sourceMessageIds: [target.l5Raw[0]!.id],
          sourceBlockId: target.id,
          temporal: { eventType: '版本发布', status: 'occurred', participants: ['chenhw7', 'StrataGate', 'npm'] },
        }],
      }),
      graphProjector: async ({ events }) => ({
        reason: 'projected',
        nodes: [
          { ref: 'person', name: 'chenhw7', type: 'person', tags: ['developer'], metadataProvenance: {
            name: [events[0]!.id], tags: [{ value: 'developer', sourceEventIds: [events[0]!.id] }],
          }, sourceEventIds: [events[0]!.id] },
          { ref: 'project', name: 'StrataGate', type: 'project', tags: ['memory-plugin', 'dsh-plugin'], aliases: ['strata_gate'], metadataProvenance: {
            name: [events[0]!.id],
            aliases: [{ value: 'strata_gate', sourceEventIds: [events[0]!.id] }],
            tags: [
              { value: 'memory-plugin', sourceEventIds: [events[0]!.id] },
              { value: 'dsh-plugin', sourceEventIds: [events[0]!.id] },
            ],
          }, state: '已发布', sourceEventIds: [events[0]!.id] },
          { ref: 'tool', name: 'npm', type: 'tool', tags: ['package-manager'], metadataProvenance: {
            name: [events[0]!.id], tags: [{ value: 'package-manager', sourceEventIds: [events[0]!.id] }],
          }, sourceEventIds: [events[0]!.id] },
        ],
        edges: [
          { fromRef: 'person', toRef: 'project', relation: '贡献', sourceEventIds: [events[0]!.id], confidence: 0.95 },
          { fromRef: 'project', toRef: 'tool', relation: '使用', sourceEventIds: [events[0]!.id], confidence: 0.9 },
        ],
      }),
    });

    await memory.appendTurn({ user: '发布项目', assistant: '完成' });
    await memory.appendTurn({ user: '继续', assistant: '好的' });

    expect(memory.listElements()).toEqual([]);
    expect(memory.listGraphNodes()).toHaveLength(3);
    expect(memory.listGraphEdges()).toHaveLength(2);
    expect(memory.listGraphEdges()[0]).toMatchObject({ relation: '贡献', status: 'active', confidence: 0.95 });
    expect(memory.listEvents()[0]?.temporal).toMatchObject({
      eventType: 'release',
      status: 'occurred',
      participantNodeIds: expect.arrayContaining(memory.listGraphNodes().map(({ id }) => id)),
    });
    expect(memory.listGraphNodes().every((node) => node.sourceEventIds.includes(memory.listEvents()[0]!.id))).toBe(true);
    expect(memory.listGraphNodes().find(({ name }) => name === 'StrataGate')?.tags).toEqual(['memory-plugin', 'dsh-plugin']);
    expect(memory.listGraphNodes().find(({ name }) => name === 'StrataGate')?.metadataProvenance?.aliases).toEqual([
      expect.objectContaining({ value: 'strata_gate', sourceEventIds: expect.arrayContaining([memory.listEvents()[0]!.id]) }),
    ]);
    const snapshot = memory.exportSnapshot();
    expect(normalizeSnapshot(JSON.parse(JSON.stringify(snapshot))).graphNodes.find(({ name }) => name === 'StrataGate')?.metadataProvenance).toBeDefined();
    const legacySnapshot = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    delete (legacySnapshot.graphNodes.find(({ name }) => name === 'StrataGate') as { metadataProvenance?: unknown }).metadataProvenance;
    expect(normalizeSnapshot(legacySnapshot).graphNodes.find(({ name }) => name === 'StrataGate')?.metadataProvenance).toBeUndefined();
    expect((await memory.searchGraphNodes('memory-plugin'))[0]?.node.name).toBe('StrataGate');
    expect(memory.listGraphProjectionJobs()[0]).toMatchObject({ status: 'completed', projectorVersion: 1, attempts: 1 });
  });

  it('persists failed projection progress for retry without requeueing completed Events', async () => {
    let attempts = 0;
    let now = new Date('2026-09-14T00:00:00.000Z');
    const storage = new SqliteStorage({ filename: ':memory:' });
    const options: PersistentStrataGateOptions = {
      storage,
      namespace: 'graph:test',
      blockTurnSize: 1,
      now: () => now,
      summarizer: async () => ({ l0Title: 'event', l0Tags: [], l1Summary: 'event', l2Keypoints: [], shouldExtract: true }),
      extractor: async ({ target }) => ({
        shouldExtract: true, reason: 'event', events: [{
          title: '迁移', summary: '迁移图谱', sourceMessageIds: [target.l5Raw[0]!.id], sourceBlockId: target.id,
          temporal: { eventType: 'migration' },
        }],
      }),
      graphProjector: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('rate limited');
        return { reason: 'empty but completed', nodes: [], edges: [] };
      },
    };
    const memory = await StrataGate.openWithStorage(options);
    await memory.appendTurn({ user: 'a', assistant: 'b' });
    expect(memory.listGraphProjectionJobs()[0]).toMatchObject({
      status: 'failed', attempts: 1, lastError: 'rate limited', nextRetryAt: '2026-09-14T08:00:01.000+08:00',
    });

    const restored = await StrataGate.openWithStorage(options);
    expect(restored.listGraphProjectionJobs()).toHaveLength(1);
    await restored.resumePendingWork();
    expect(attempts).toBe(1);
    now = new Date(now.getTime() + 1_000);
    await restored.resumePendingWork();
    expect(restored.listGraphProjectionJobs()[0]).toMatchObject({ status: 'completed', attempts: 2 });
    await restored.resumePendingWork();
    expect(attempts).toBe(2);
    await restored.close();
  });

  it('bounds automatic retries and always serves pending Graph work before failed retries', async () => {
    let now = new Date('2026-09-14T00:00:00.000Z');
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      now: () => now,
      summarizer: async () => ({ l0Title: 'ready', l0Tags: [], l1Summary: 'ready', l2Keypoints: [], shouldExtract: false }),
      graphProjector: async () => ({ reason: 'unused', nodes: [], edges: [] }),
    });
    await memory.appendTurn({ user: 'source', assistant: 'stored' });
    const block = memory.listBlocks()[0]!;
    const firstEvent = await memory.addEvent({
      title: 'First', summary: 'Fails permanently.', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id],
    });
    const firstClaim = await memory.claimNextGraphProjection();
    expect(firstClaim?.events.map(({ id }) => id)).toEqual([firstEvent.id]);
    await memory.failGraphProjection(firstClaim!.jobId, new Error('permanent failure'));
    expect(await memory.claimNextGraphProjection()).toBeNull();
    const legacySnapshot = memory.exportSnapshot();
    delete (legacySnapshot.graphProjectionJobs[0] as { nextRetryAt?: string | null }).nextRetryAt;
    expect(normalizeSnapshot(legacySnapshot).graphProjectionJobs[0]?.nextRetryAt).toBeNull();

    now = new Date(now.getTime() + 1_000);
    const pendingEvent = await memory.addEvent({
      title: 'Pending', summary: 'Must not starve.', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id],
    });
    const pendingClaim = await memory.claimNextGraphProjection();
    expect(pendingClaim?.events.map(({ id }) => id)).toEqual([pendingEvent.id]);
    await memory.completeGraphProjection(pendingClaim!.jobId, { reason: 'done', nodes: [], edges: [] });

    const secondClaim = await memory.claimNextGraphProjection();
    expect(secondClaim?.jobId).toBe(firstClaim?.jobId);
    await memory.failGraphProjection(secondClaim!.jobId, new Error('permanent failure'));
    now = new Date(now.getTime() + 2_000);
    const thirdClaim = await memory.claimNextGraphProjection();
    expect(thirdClaim?.jobId).toBe(firstClaim?.jobId);
    await memory.failGraphProjection(thirdClaim!.jobId, new Error('permanent failure'));

    now = new Date(now.getTime() + 60_000);
    expect(await memory.claimNextGraphProjection()).toBeNull();
    expect(memory.listGraphProjectionJobs().find(({ id }) => id === firstClaim?.jobId)).toMatchObject({
      status: 'failed', attempts: 3, nextRetryAt: null, lastError: 'permanent failure',
    });
    const exhausted = memory.listGraphProjectionJobs().find(({ id }) => id === firstClaim?.jobId)!;
    exhausted.status = 'pending';
    exhausted.attempts = 125;
    exhausted.nextRetryAt = '2020-01-01T00:00:00.000Z';
    expect(await memory.claimNextGraphProjection()).toBeNull();
  });

  it('manually retries only the selected failed Graph projection', async () => {
    let shouldFail = true;
    let calls = 0;
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      summarizer: async () => ({ l0Title: 'event', l0Tags: [], l1Summary: 'event', l2Keypoints: [], shouldExtract: true }),
      extractor: async ({ target }) => ({
        shouldExtract: true,
        reason: 'event',
        events: [{ title: 'Graph retry', summary: 'Retry this graph batch.', sourceMessageIds: [target.l5Raw[0]!.id], sourceBlockId: target.id }],
      }),
      graphProjector: async () => {
        calls += 1;
        if (shouldFail) throw new Error('graph timed out');
        return { reason: 'completed', nodes: [], edges: [] };
      },
    });

    await memory.appendTurn({ user: 'graph', assistant: 'saved' });
    const jobId = memory.listGraphProjectionJobs()[0]!.id;
    expect(memory.listGraphProjectionJobs()[0]).toMatchObject({ status: 'failed', attempts: 1 });

    shouldFail = false;
    const [first, second] = await Promise.all([
      memory.retryGraphProjection(jobId),
      memory.retryGraphProjection(jobId),
    ]);
    expect(first).toEqual({ nodeIds: [], edgeIds: [] });
    expect(second).toEqual(first);
    expect(calls).toBe(2);
    expect(memory.listGraphProjectionJobs()[0]).toMatchObject({ id: jobId, status: 'completed', attempts: 1, lastError: null });
  });
});

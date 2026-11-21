import { estimateTokens, type EventCard, type MemoryTopic } from '@diqier/stratagate'
import { describe, expect, it } from 'vitest'
import { boundedTopic, memoryTopicSections, MEMORY_DIRECTORY_TOKEN_BUDGET, TOPIC_OVERVIEW_TOKEN_BUDGET, renderMemoryDirectory, sortMemoryTopics, topicNavigation, topicPage } from '../src/topics.js'

function topic(id: string, createdAt: string, sourceEventIds = [id], isFallback = false): MemoryTopic {
  return { id, title: `主题 ${id}`, description: '', sourceEventIds, overview: [], createdAt,
    updatedAt: createdAt, coverage: { totalEvents: 1, summarizedEvents: 1, omittedEvents: 0 },
    ...(isFallback ? { isFallback: true } : {}) }
}

function source(id: string, eventType: string): EventCard {
  return { id, title: id, summary: '', tags: [], quotes: [], sourceMessageIds: [], sourceBlockId: 'block',
    temporal: { eventType }, scope: 'project', criticality: 'routine', status: 'active', supersededBy: null,
    weight: { mentionCount: 1, lastAdoptedTurn: 0, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null },
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }
}

describe('shared memory directory order', () => {
  it('shortens fallback titles without breaking an identifier or modifying the original', () => {
    const fallback = topic('fallback:evt_example', '2026-10-01', ['evt_example'], true)
    const prefix = '确认 '.repeat(20)
    const title = `${prefix}memory_remember 保存记录`
    fallback.title = title

    expect(renderMemoryDirectory([fallback], [])).toContain(`- ${fallback.id}：${prefix.trimEnd()}…`)
    expect(fallback.title).toBe(title)
  })

  it('injects chapter titles, descriptions and stable section titles without overview prose', () => {
    const chapter = topic('stratagate', '2026-10-01', ['E1', 'E2', 'E3'])
    chapter.title = 'StrataGate'
    chapter.description = '记忆系统设计、开发排障与版本发布'
    chapter.sections = [
      { title: '版本发布与安装', sourceEventIds: ['E3'] },
      { title: '竞品分析与实验评测', sourceEventIds: ['E1'] },
      { title: '缺陷排查与修复', sourceEventIds: ['E2'] },
    ]
    chapter.overview = [{ kind: 'history', title: '缺陷排查与修复', text: '临时修复细节'.repeat(1_000), sourceEventIds: ['E2'] }]
    const events = [source('E1', 'release'), source('E2', 'release'), source('E3', 'release')]
    const before = JSON.stringify({ chapter, events })
    const context = renderMemoryDirectory([chapter], events)
    expect(context).toContain('- stratagate：StrataGate；记忆系统设计、开发排障与版本发布')
    expect(context.split('\n').filter((line) => line.startsWith('  - '))).toEqual([
      '  - 竞品分析与实验评测', '  - 缺陷排查与修复', '  - 版本发布与安装',
    ])
    expect(context).not.toContain('临时修复细节')
    expect(context).not.toContain('.0')
    expect(context).toContain('不是事实证据')
    expect(context).toContain('memory_search_events(topic_id)')
    expect(estimateTokens(context)).toBeLessThanOrEqual(MEMORY_DIRECTORY_TOKEN_BUDGET)
    expect(JSON.stringify({ chapter, events })).toBe(before)
  })

  it('groups sections under their chapters in creation order', () => {
    const first = topic('project', '2026-10-01', ['E1'])
    first.title = 'StrataGate'; first.description = '项目记录'
    first.sections = [{ title: '架构与配置决策', sourceEventIds: ['E1'] }]
    const second = topic('career', '2026-10-02', ['E2'])
    second.title = '求职与职业发展'; second.description = '职业状态档案'
    second.sections = [{ title: '投递与面试', sourceEventIds: ['E2'] }]
    expect(renderMemoryDirectory([second, first], []).split('\n').slice(2)).toEqual([
      '- project：StrataGate；项目记录', '  - 架构与配置决策',
      '- career：求职与职业发展；职业状态档案', '  - 投递与面试',
    ])
  })

  it('renders legacy chapters with absent or empty sections and recovers known legacy labels', () => {
    const legacy = topic('legacy', '2026-10-01')
    legacy.description = '旧章描述'
    const empty = topic('empty', '2026-10-02'); empty.sections = []
    const context = renderMemoryDirectory([legacy, empty], [])
    expect(context).toContain('- legacy：主题 legacy；旧章描述')
    expect(context).toContain('- empty：主题 empty')
    expect(context).not.toContain('  - ')
    expect(context).not.toMatch(/undefined|null|\n\s*$/u)
    legacy.overview = [{ kind: 'scope', title: '研究方向', text: '旧总览正文', sourceEventIds: legacy.sourceEventIds }]
    expect(renderMemoryDirectory([legacy], [])).toContain('  - 研究方向')
    expect(renderMemoryDirectory([legacy], [])).not.toContain('旧总览正文')
    expect(renderMemoryDirectory([], [])).toBe('')
  })

  it('reserves chapter descriptions and navigation before sharing the remaining section budget', () => {
    const chapters = ['first', 'second'].map((id, index) => {
      const chapter = topic(id, `2026-10-0${index + 1}`, Array.from({ length: 200 }, (_, i) => `${id}-${i}`))
      chapter.description = `第${index + 1}章范围`
      chapter.sections = chapter.sourceEventIds.map((eventId, i) => ({ title: `${id} 类别 ${i}`, sourceEventIds: [eventId] }))
      return chapter
    })
    const before = JSON.stringify(chapters)
    const context = renderMemoryDirectory(chapters, [])
    expect(estimateTokens(context)).toBeLessThanOrEqual(MEMORY_DIRECTORY_TOKEN_BUDGET)
    expect(context).toContain('目录已裁剪')
    expect(context).toContain('memory_list_topics(category, offset)')
    expect(context).toContain('memory_expand_topic(id)')
    for (const chapter of chapters) {
      expect(context).toContain(`- ${chapter.id}：${chapter.title}；${chapter.description}`)
      expect(context).toContain(`  - ${chapter.id} 类别 0`)
      const titles = context.split('\n').filter((line) => line.startsWith(`  - ${chapter.id} 类别`))
      expect(titles).toEqual(memoryTopicSections(chapter).slice(0, titles.length).map(({ title }) => `  - ${title}`))
      expect(titles.length).toBeLessThan(200)
    }
    expect(JSON.stringify(chapters)).toBe(before)
  })

  it('keeps every category reachable within budget even when chapter ids cannot fit', () => {
    const types = ['release', 'decision', 'meeting', 'note', 'note']
    const chapters = types.map((_, index) => {
      const chapter = topic(`topic-${index}-${'x'.repeat(2_000)}`, `2026-10-0${index + 1}`)
      chapter.title = '长标题'.repeat(100); chapter.description = '长描述'.repeat(100)
      chapter.sections = [{ title: '长节标题'.repeat(100), sourceEventIds: chapter.sourceEventIds }]
      return chapter
    })
    const events = chapters.map((chapter, index) => source(chapter.id, types[index]!))
    events[4]!.criticality = 'preference'
    const context = renderMemoryDirectory(chapters, events)
    expect(estimateTokens(context)).toBeLessThanOrEqual(MEMORY_DIRECTORY_TOKEN_BUDGET)
    expect(context).toContain('memory_list_topics(category, offset)')
    for (const { id } of topicNavigation(chapters, events).categories) expect(context).toContain(`${id}（`)
  })

  it('keeps the full independent membership index outside the bounded model expansion', () => {
    const chapter = topic('large', '2026-10-01T00:00:00.000Z', Array.from({ length: 10_000 }, (_, index) => `member-${index}`));
    chapter.sections = [{ title: '研究方向', sourceEventIds: [...chapter.sourceEventIds] }];
    const before = JSON.stringify(chapter); const expanded = boundedTopic(chapter);
    expect(expanded.sections).toEqual([{ title: '研究方向', sourceEventCount: 10_000 }]);
    expect(expanded.totalSections).toBe(1);
    expect(expanded.omittedSections).toBe(0);
    expect(expanded.sourceEventIds).toHaveLength(12);
    expect(expanded.omittedSourceEvents).toBe(9_988);
    expect(estimateTokens(JSON.stringify(expanded))).toBeLessThanOrEqual(TOPIC_OVERVIEW_TOKEN_BUDGET);
    expect(JSON.stringify(chapter)).toBe(before);
  });

  it('bounds a large lightweight section index and reports every omitted section without leaking member ids', () => {
    const chapter = topic('large-index', '2026-10-01T00:00:00.000Z', ['member']);
    chapter.sections = Array.from({ length: 300 }, (_, index) => ({ title: `类别 ${index} ${'长期类别'.repeat(15)}`, sourceEventIds: ['member'] }));
    chapter.overview = Array.from({ length: 8 }, (_, index) => ({ kind: 'scope' as const, title: chapter.sections![index]!.title,
      text: '资料范围'.repeat(100), sourceEventIds: ['member'] }));
    const envelope = { namespace: 'dsh:project:budget', navigationOnly: true, note: '这是导航，需要继续查证事件。' };
    const expanded = boundedTopic(chapter, envelope);
    expect(expanded.sections.length).toBeGreaterThan(0);
    expect(expanded.omittedSections).toBeGreaterThan(0);
    expect(expanded.sections.length + expanded.omittedSections).toBe(300);
    expect(expanded.totalSections).toBe(300);
    expect(expanded.overview.length + expanded.omittedOverviewParagraphs).toBe(8);
    expect(expanded.sections.every((section) => Object.keys(section).sort().join(',') === 'sourceEventCount,title')).toBe(true);
    expect(expanded.sections.every((section) => section.sourceEventCount === 1)).toBe(true);
    expect(estimateTokens(JSON.stringify({ ...envelope, topic: expanded }))).toBeLessThanOrEqual(TOPIC_OVERVIEW_TOKEN_BUDGET);
  });

  it('keeps known legacy section labels in the Agent navigation index', () => {
    const chapter = topic('legacy', '2026-10-01T00:00:00.000Z', ['E1', 'E2']);
    chapter.overview = [{ kind: 'scope', title: '研究方向', text: '资料范围', sourceEventIds: ['E1', 'E2'] }];
    expect(boundedTopic(chapter).sections).toEqual([{ title: '研究方向', sourceEventCount: 2 }]);
  });

  it('keeps same-batch chapters in immutable ID order when their titles change', () => {
    const first = topic('topic_a', '2026-10-01T00:00:00.000Z')
    const second = topic('topic_b', first.createdAt)
    first.title = '甲主题'
    second.title = '乙主题'
    const topics = [second, first]
    const expected = ['topic_a', 'topic_b']
    expect(sortMemoryTopics(topics).map(({ id }) => id)).toEqual(expected)
    first.title = 'Z renamed'
    second.title = 'A renamed'
    first.updatedAt = '2026-10-04T00:00:00.000Z'
    expect(sortMemoryTopics(topics).map(({ id }) => id)).toEqual(expected)
    expect(topicNavigation(topics, []).entries.map(({ id }) => id)).toEqual(expected)
    expect(topicPage(topics, []).topics.map(({ id }) => id)).toEqual(expected)
    const context = renderMemoryDirectory(topics, [])
    expect(context.indexOf('- topic_a：')).toBeLessThan(context.indexOf('- topic_b：'))
  })

  it('appends newly created topics even when their generated id sorts before existing chapters', () => {
    const first = topic('topic_z', '2026-10-01T00:00:00.000Z')
    const second = topic('topic_b', '2026-10-02T00:00:00.000Z')
    const newest = topic('topic_000', '2026-10-03T00:00:00.000Z')
    const input = [newest, second, first]
    expect(sortMemoryTopics(input).map(({ id }) => id)).toEqual([first.id, second.id, newest.id])
    expect(input.map(({ id }) => id)).toEqual([newest.id, second.id, first.id])
    first.title = '改名后的早期主题'
    expect(sortMemoryTopics(input).map(({ id }) => id)).toEqual([first.id, second.id, newest.id])
  })

  it('uses the same creation order in navigation, pagination and injected context across categories', () => {
    const oldest = topic('topic_z', '2026-10-01T00:00:00.000Z')
    const newest = topic('topic_a', '2026-10-03T00:00:00.000Z')
    const topics = [newest, oldest]
    const events = [source(oldest.id, 'release'), source(newest.id, 'decision')]
    const expected = [oldest.id, newest.id]
    expect(topicNavigation(topics, events).entries.map(({ id }) => id)).toEqual(expected)
    expect(topicPage(topics, events).topics.map(({ id }) => id)).toEqual(expected)
    const context = renderMemoryDirectory(topics, events)
    expect(context.indexOf(`- ${oldest.id}：`)).toBeLessThan(context.indexOf(`- ${newest.id}：`))
  })

  it('keeps fallback entries after formal chapters without changing their stable source ids', () => {
    const fallback = topic('fallback:old-event', '2026-09-01T00:00:00.000Z', ['old-event'], true)
    const formal = topic('topic_z', '2026-10-01T00:00:00.000Z')
    expect(sortMemoryTopics([fallback, formal])).toEqual([formal, fallback])
    expect(fallback.sourceEventIds).toEqual(['old-event'])
  })

  it('orders large-catalog representatives consistently while preserving the existing context budget', () => {
    const topics = Array.from({ length: 60 }, (_, index) => topic(`topic_${index}`, new Date(Date.UTC(2026, 8, index + 1)).toISOString()))
    const events = topics.map(({ id }, index) => source(id, index % 2 === 0 ? 'release' : 'decision'))
    const context = renderMemoryDirectory([...topics].reverse(), events)
    const ids = [...context.matchAll(/^- (topic_\d+)：/gm)].map((match) => match[1])
    expect(ids.length).toBeGreaterThan(0)
    expect(ids).toEqual(ids.slice().sort((a, b) => Number(a!.slice(6)) - Number(b!.slice(6))))
    expect(estimateTokens(context)).toBeLessThanOrEqual(MEMORY_DIRECTORY_TOKEN_BUDGET)
    expect(context).toContain('共 60 项')
  })
})

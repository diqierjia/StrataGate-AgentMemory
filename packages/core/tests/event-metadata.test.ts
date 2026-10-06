import { describe, expect, it } from 'vitest';
import { normalizeEventMetadata, normalizeSnapshot, StrataGate } from '../src/index.js';

describe('optional Event extraction metadata', () => {
  it.each([undefined, null, 4, [], {}])('keeps absent/invalid metadata absent: %j', (value) => {
    expect(normalizeEventMetadata(value)).toEqual({});
  });

  it('bounds free categories, removes fallback/path values, and does not invent categories', () => {
    expect(normalizeEventMetadata({ catalogHints: [' ', 4, 'OTHER', '其他', '其它', 'chapter:1',
      'section_2', 'topic:3', '/工作/偏好', '项目 → 小节', 'x'.repeat(65), ' 工作方式 ', '工作方式', 'PR 审查', '第三项'],
      extractorVersion: 2 })).toEqual({ catalogHints: ['工作方式', 'PR 审查'], extractorVersion: 2 });
    expect(normalizeEventMetadata({ catalogHints: [] })).toEqual({ catalogHints: [] });
    expect(normalizeEventMetadata({ catalogHints: ['种植经验', 'UI/UX'] }).catalogHints)
      .toEqual(['种植经验', 'UI/UX']);
  });

  it.each([0, -1, 1.5, '2', NaN, Infinity])('discards invalid version %s without dropping the Event', (version) => {
    expect(normalizeEventMetadata({ catalogHints: ['摄影'], extractorVersion: version }))
      .toEqual({ catalogHints: ['摄影'] });
  });

  it('normalizes manual admission and snapshots while leaving legacy fields absent', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1, summarizer: async () => ({
      l0Title: '来源', l0Tags: [], l1Summary: '来源', l2Keypoints: [], shouldExtract: false,
    }) });
    const block = (await memory.appendTurn({ user: '这张图不要蓝色。', assistant: '记录' })).sealedBlock!;
    const source = { sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] };
    const legacy = await memory.addEvent({ ...source, title: '旧反馈', summary: '保留原文' });
    const current = await memory.addEvent({ ...source, title: '展示图反馈', summary: '当前图不要蓝色',
      scope: 'session', catalogHints: ['审美反馈', '展示图', 'extra'], extractorVersion: 2 });
    expect(current.catalogHints).toEqual(['审美反馈', '展示图']);
    const normalized = normalizeSnapshot(memory.exportSnapshot());
    expect(normalized.events[0]).toEqual(legacy);
    expect(normalized.events[0]).not.toHaveProperty('catalogHints');
    expect(normalized.events[0]).not.toHaveProperty('extractorVersion');
    expect(normalized.events[1]).toEqual(current);
  });
});

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import type { PersistentProfile } from '@diqier/stratagate'
import type { DshModelBridge } from '../src/llm.js'
import { StrataGateRuntime } from '../src/runtime.js'

describe('DSH Persistent Profile runtime', () => {
  it('shares one profile across sessions, projects, restart, and maintenance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-profile-runtime-'))
    const database = join(directory, 'memory.db')
    const calls: PersistentProfile[] = []
    let ready = false
    const models = {
      isReady: () => ready,
      onAdaptersUpdated: () => () => {},
      runDetached: async <T>(_id: string, action: () => Promise<T>): Promise<T> => action(),
      maintainProfile: async (profile: PersistentProfile) => {
        calls.push(structuredClone(profile))
        return { ...profile, responsePreferences: profile.responsePreferences.replace('简洁。简洁。', '简洁。') }
      },
    } as unknown as DshModelBridge
    const config = { database, namespaceMode: 'project' as const, namespacePrefix: 'dsh', globalNamespace: 'global', blockTurnSize: 6, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048, structuredTaskTimeoutMs: 120000 }
    const session = (id: string, cwd: string) => ({ id, header: { cwd } }) as Session
    try {
      const first = new StrataGateRuntime(config, models)
      expect(first.getPersistentProfile().preferredLanguage).toBe('')
      const a = session('a', 'C:/alpha')
      const b = session('b', 'C:/beta')
      expect(first.namespaceFor(a)).not.toBe(first.namespaceFor(b))
      first.updatePersistentProfileFromTool('preferredLanguage', '中文')
      ready = true
      expect(await first.runProfileMaintenance(Date.now() + 7 * 24 * 60 * 60 * 1000)).toBe(false)
      expect(calls).toEqual([])
      first.updatePersistentProfile('responsePreferences', '简洁。简洁。', 'user_explicit', 'msg-1')
      first.updatePersistentProfileFromTool('defaultLocation', '广州天河')
      first.updatePersistentProfile('homeCity', '深圳', 'user_explicit', 'msg-2')
      first.updatePersistentProfileFromTool('currentCity', '杭州')
      expect(first.renderProfileContext()).toContain('Preferred answer language: 中文')
      expect(first.renderProfileContext()).toContain('Default location (when the task specifies no location): 广州天河')
      expect(first.renderProfileContext()).toContain('Usual city of residence: 深圳')
      expect(first.renderProfileContext()).toContain('Current city (until updated or cleared): 杭州')
      expect(first.getPersistentProfile().preferredLanguage).toBe('中文')
      ready = true
      const writtenAt = Date.now()
      expect(await first.runProfileMaintenance(writtenAt + 23 * 60 * 60 * 1000)).toBe(false)
      expect(calls).toEqual([])
      expect(await first.runProfileMaintenance(writtenAt + 25 * 60 * 60 * 1000)).toBe(true)
      expect(calls).toEqual([{ ...first.getPersistentProfile(), responsePreferences: '简洁。简洁。' }])
      expect(first.getPersistentProfile().responsePreferences).toBe('简洁。')
      expect(first.getProfileChanges().map(({ source }) => source)).toEqual(['agent_tool', 'user_explicit', 'agent_tool', 'user_explicit', 'agent_tool', 'maintenance'])
      expect(await first.runProfileMaintenance()).toBe(false)
      expect(await first.runProfileMaintenance(writtenAt + 10 * 24 * 60 * 60 * 1000)).toBe(false)
      first.updatePersistentProfileFromTool('currentCity', '上海')
      expect(await first.runProfileMaintenance(writtenAt + 10 * 24 * 60 * 60 * 1000)).toBe(false)
      expect(calls).toHaveLength(1)
      await first.close()
      const second = new StrataGateRuntime(config, models)
      expect(second.getPersistentProfile().preferredLanguage).toBe('中文')
      expect(second.getPersistentProfile().responsePreferences).toBe('简洁。')
      expect(second.getPersistentProfile()).toMatchObject({ defaultLocation: '广州天河', homeCity: '深圳', currentCity: '上海' })
      expect(second.getProfileSnapshot().revisions.defaultLocation).toBeGreaterThan(0)
      expect(second.getProfileSnapshot().revisions.homeCity).toBeGreaterThan(0)
      expect(second.getProfileSnapshot().revisions.currentCity).toBeGreaterThan(0)
      expect(second.namespaceFor(b)).not.toBe(second.namespaceFor(a))
      expect(await second.runProfileMaintenance(writtenAt + 10 * 24 * 60 * 60 * 1000)).toBe(false)
      second.updatePersistentProfileFromTool('standingInstructions', '回答先给结论')
      expect(await second.runProfileMaintenance(writtenAt + 26 * 60 * 60 * 1000)).toBe(false)
      expect(await second.runProfileMaintenance(writtenAt + 49 * 60 * 60 * 1000)).toBe(true)
      expect(calls).toHaveLength(2)
      // A successful no-op model result is also maintained content.
      expect(await second.runProfileMaintenance(writtenAt + 30 * 24 * 60 * 60 * 1000)).toBe(false)
      expect(calls).toHaveLength(2)
      await second.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

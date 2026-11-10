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
      expect(first.getProfileTotalMaxLength()).toBe(6000)
      expect(first.adminSetProfileTotalMaxLength(5000)).toBe(5000)
      expect(first.getProfileTotalMaxLength()).toBe(5000)
      // The live store accepts a 4500-character profile that still fits 5000.
      first.updatePersistentProfile('userBackground', 'x'.repeat(1500), 'settings')
      first.updatePersistentProfile('persistentNotes', 'x'.repeat(1200), 'settings')
      first.updatePersistentProfile('longTermGoals', 'x'.repeat(1000), 'settings')
      first.updatePersistentProfile('standingInstructions', 'x'.repeat(800), 'settings')
      expect(Object.values(first.getPersistentProfile()).reduce((sum, value) => sum + Array.from(value).length, 0)).toBe(4500)
      expect(() => first.updatePersistentProfile('responsePreferences', 'x'.repeat(600), 'settings')).toThrow(/exceeds 5000 characters/)
      expect(() => first.adminSetProfileTotalMaxLength(1000)).toThrow(/between 2000 and 12000/)
      expect(() => first.adminSetProfileTotalMaxLength(3000)).toThrow(/cannot be lower than/)
      await first.close()
      const second = new StrataGateRuntime(config, models)
      await second.syncConfiguredSettings()
      expect(second.getProfileTotalMaxLength()).toBe(5000)
      await second.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists a custom Profile limit and applies it immediately and after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-profile-limit-'))
    const database = join(directory, 'memory.db')
    const models = { isReady: () => false, onAdaptersUpdated: () => () => {} } as unknown as DshModelBridge
    const config = { database, namespaceMode: 'project' as const, namespacePrefix: 'dsh', globalNamespace: 'global', blockTurnSize: 6, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048, structuredTaskTimeoutMs: 120000 }
    try {
      const first = new StrataGateRuntime(config, models)
      expect(first.getProfileTotalMaxLength()).toBe(6000)
      expect(first.adminSetProfileTotalMaxLength(5000)).toBe(5000)
      expect(first.getProfileTotalMaxLength()).toBe(5000)
      // The live store accepts a 4500-character profile under a 5000 cap.
      first.updatePersistentProfile('userBackground', 'x'.repeat(1500), 'settings')
      first.updatePersistentProfile('persistentNotes', 'x'.repeat(1200), 'settings')
      first.updatePersistentProfile('longTermGoals', 'x'.repeat(1000), 'settings')
      first.updatePersistentProfile('standingInstructions', 'x'.repeat(800), 'settings')
      expect(Object.values(first.getPersistentProfile()).reduce((sum, value) => sum + Array.from(value).length, 0)).toBe(4500)
      expect(() => first.updatePersistentProfile('responsePreferences', 'x'.repeat(600), 'settings')).toThrow(/exceeds 5000 characters/)
      expect(() => first.adminSetProfileTotalMaxLength(1000)).toThrow(/between 2000 and 12000/)
      expect(() => first.adminSetProfileTotalMaxLength(3000)).toThrow(/cannot be lower than/)
      await first.close()
      const second = new StrataGateRuntime(config, models)
      await second.syncConfiguredSettings()
      expect(second.getProfileTotalMaxLength()).toBe(5000)
      await second.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

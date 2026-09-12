#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROFILE_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-code-runtime',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-format',
  '@deepseek-ai/dsh-session-format-catalog',
  '@deepseek-ai/dsh-session-format-v0-to-v1',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-timeout',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-util-crypto',
  '@deepseek-ai/dsh-util-values',
  '@deepseek-ai/schemastery',
] as const

function profileDirectory(start: string): string {
  let directory = start
  for (;;) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { profile?: unknown } }
        if (manifest.dsh?.profile && typeof manifest.dsh.profile === 'object') return directory
      } catch {}
    }
    const parent = dirname(directory)
    if (parent === directory) {
      throw new Error('stratagate-dsh-repair must run inside an installed DSH profile')
    }
    directory = parent
  }
}

function main(): void {
  const profile = profileDirectory(dirname(fileURLToPath(import.meta.url)))
  const modules = join(profile, 'node_modules')
  const candidates = PROFILE_PACKAGES
    .map((name) => ({ name, source: join(modules, ...name.split('/')) }))
    .filter(({ source }) => {
      try {
        lstatSync(source)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    })
  if (candidates.length === 0) {
    process.stdout.write('StrataGate profile runtime is already isolated; no DSH peer residue found.\n')
    return
  }

  const backup = join(profile, '.stratagate-runtime-backups', `${Date.now()}-${process.pid}-${randomUUID()}`)
  const moved: Array<{ name: string; source: string; target: string }> = []
  try {
    for (const candidate of candidates) {
      const target = join(backup, 'node_modules', ...candidate.name.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      renameSync(candidate.source, target)
      moved.push({ ...candidate, target })
    }
    const receipt = {
      schema: 'stratagate-dsh-profile-runtime-repair/v1',
      profile,
      createdAt: new Date().toISOString(),
      packages: moved.map(({ name, source, target }) => ({ name, source, target })),
      recovery: `While DSH is stopped, move the listed targets back to their source paths if this repair must be reversed.`,
    }
    writeFileSync(join(backup, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    for (const item of moved.reverse()) {
      if (existsSync(item.target) && !existsSync(item.source)) renameSync(item.target, item.source)
    }
    throw error
  }
  process.stdout.write(`Quarantined ${moved.length} stale DSH profile package(s) to ${backup}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}

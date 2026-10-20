import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { satisfies } from 'semver'
import type { Context } from '@deepseek-ai/cordis'

const nodeRequire = createRequire(import.meta.url)

const CORE_RUNTIME_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-native-command',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
] as const

const SESSION_FORMAT_PACKAGES = [
  '@deepseek-ai/dsh-session-format',
  '@deepseek-ai/dsh-session-format-catalog',
  '@deepseek-ai/dsh-session-format-v0-to-v1',
] as const

const RUNTIME_PACKAGES = [...CORE_RUNTIME_PACKAGES, ...SESSION_FORMAT_PACKAGES] as const

export interface DshRuntimeCompatibility {
  cliVersion: string
  packageVersions: Readonly<Record<string, string>>
}

export type DshRuntimePackageVersions = Readonly<Record<(typeof RUNTIME_PACKAGES)[number], string>>

export const STRATAGATE_MESSAGE_SOURCE_KIND = 'plugin:stratagate-memory' as const

const DSH_RUNTIME_RANGE = '0.1.2-rc.1 || >=0.1.5-rc.2 <0.3.0-0'
const MODERN_API_RANGE = '>=0.1.7-rc.1'
const SESSION_FORMAT_RUNTIME_RANGE = '>=0.2.0-0'
const SEMVER_OPTIONS = { includePrerelease: true }

/** Check readable method shapes without invoking host APIs or changing data. */
export function assertDshMethods(scope: string, value: unknown, methods: readonly string[]): void {
  const target = value as Record<string, unknown> | null | undefined
  const missing = methods.filter((method) => typeof target?.[method] !== 'function')
  if (missing.length) {
    throw new Error(`StrataGate cannot use this DSH host: missing required interface ${missing.map((method) => `${scope}.${method}`).join(', ')}. Use a compatible host or plugin version.`)
  }
}

/** Run before migration, opening the database, or registering plugin services. */
export function assertDshHostContract(ctx: Context): void {
  assertDshMethods('tools', ctx.tools, ['register', 'get'])
  assertDshMethods('systemPrompt', ctx.systemPrompt, ['section'])
  assertDshMethods('llm', ctx.llm, ['stream', 'listProviders'])
  assertDshMethods('agentDefaultModel', ctx.agentDefaultModel, ['currentSelection'])
}

export function buildDshMessageSource(
  version: string,
  form?: 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall',
): any {
  const source = satisfies(version, MODERN_API_RANGE, SEMVER_OPTIONS)
    ? { kind: STRATAGATE_MESSAGE_SOURCE_KIND }
    : { kind: 'plugin', plugin: 'stratagate-memory' }
  return form ? { ...source, form } : source
}

function installedVersion(packageName: string): string {
  try {
    const manifestPath = nodeRequire.resolve(`${packageName}/package.json`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
    if (typeof manifest.version === 'string' && manifest.version.length > 0) return manifest.version
  } catch {}
  return '<missing>'
}

export function buildDshReplaceSurfaceOp(version: string, start: number, end: number): any {
  return version === '0.1.2-rc.1'
    ? { op: 'replace', start, end }
    : { op: 'replace', startSeq: start, endSeq: end }
}

export function dshReplaceSurfaceOp(start: number, end: number): any {
  return buildDshReplaceSurfaceOp(installedVersion('@deepseek-ai/dsh-session'), start, end)
}

export function dshMessageSource(
  form?: 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall',
): any {
  return buildDshMessageSource(installedVersion('@deepseek-ai/dsh-session'), form)
}

export function isStrataGateMessageSource(source: unknown): boolean {
  if (!source || typeof source !== 'object') return false
  const value = source as { kind?: unknown; plugin?: unknown }
  return value.kind === STRATAGATE_MESSAGE_SOURCE_KIND
    || (value.kind === 'plugin' && value.plugin === 'stratagate-memory')
}

function isCompatiblePatch(version: string, major: number, minor: number, minimumPatch: number): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  return !!match
    && Number(match[1]) === major
    && Number(match[2]) === minor
    && Number(match[3]) >= minimumPatch
}

/**
 * Fail before registering services when a profile-local peer tree shadows the
 * DSH installation. A mixed tree otherwise fails later as an empty conversation
 * surface with unrelated missing-service or method errors.
 */
export function classifyDshRuntime(packageVersions: DshRuntimePackageVersions): DshRuntimeCompatibility {
  const dshVersion = packageVersions['@deepseek-ai/dsh-session']
  const sameDshFamily = CORE_RUNTIME_PACKAGES
    .filter((name) => name.startsWith('@deepseek-ai/dsh-'))
    .every((name) => packageVersions[name] === dshVersion)
  // Preserve older host rules; DSH 0.2.0 and later also own the codecs
  // used by startup migration and native Session checkpoint persistence.
  const sameSessionFormatFamily = !satisfies(dshVersion, SESSION_FORMAT_RUNTIME_RANGE, SEMVER_OPTIONS)
    || SESSION_FORMAT_PACKAGES.every((name) => packageVersions[name] === dshVersion)
  const modernApi = satisfies(dshVersion, MODERN_API_RANGE, SEMVER_OPTIONS)
  const compatibleVendors = modernApi
    ? isCompatiblePatch(packageVersions['@deepseek-ai/cordis'], 4, 0, 4)
      && isCompatiblePatch(packageVersions['@deepseek-ai/schemastery'], 3, 18, 4)
    : packageVersions['@deepseek-ai/cordis'] === '4.0.2'
      && packageVersions['@deepseek-ai/schemastery'] === '3.18.2'
  if (satisfies(dshVersion, DSH_RUNTIME_RANGE, SEMVER_OPTIONS)
    && sameDshFamily
    && sameSessionFormatFamily
    && compatibleVendors) {
    return { cliVersion: dshVersion === '0.1.5-rc.2' ? '0.1.5-rc.1' : dshVersion, packageVersions }
  }

  const found = RUNTIME_PACKAGES.map((name) => `${name}@${packageVersions[name]}`).join(', ')
  throw new Error(
    'StrataGate cannot start because this DSH profile resolves an unsupported or mixed core runtime. '
    + `Resolved: ${found}. Supported DSH versions: ${DSH_RUNTIME_RANGE} (including prereleases). `
    + 'Core DSH packages must share one version; DSH 0.2.0 and later also require matching Session Format packages. '
    + 'Modern hosts require Cordis 4.0.x from 4.0.4 and Schemastery 3.18.x from 3.18.4; older hosts use 4.0.2 and 3.18.2. '
    + 'Reinstall or update stratagate-dsh through `dsh plugin --profile <name> add <package>` so the host supplies its peers.',
  )
}

export function assertCompatibleDshRuntime(): DshRuntimeCompatibility {
  const packageVersions = Object.fromEntries(RUNTIME_PACKAGES.map((name) => [name, installedVersion(name)])) as DshRuntimePackageVersions
  return classifyDshRuntime(packageVersions)
}

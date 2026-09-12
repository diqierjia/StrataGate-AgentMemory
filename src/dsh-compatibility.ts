import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

const RUNTIME_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
] as const

const SUPPORTED_RUNTIME_FAMILIES = [
  {
    cli: '0.1.2-rc.1',
    versions: {
      '@deepseek-ai/cordis': '4.0.2',
      '@deepseek-ai/dsh-agent-default-model': '0.1.2-rc.1',
      '@deepseek-ai/dsh-client-ui-conversation': '0.1.2-rc.1',
      '@deepseek-ai/dsh-llm': '0.1.2-rc.1',
      '@deepseek-ai/dsh-session': '0.1.2-rc.1',
      '@deepseek-ai/dsh-settings': '0.1.2-rc.1',
      '@deepseek-ai/dsh-system-prompt': '0.1.2-rc.1',
      '@deepseek-ai/dsh-tools': '0.1.2-rc.1',
      '@deepseek-ai/schemastery': '3.18.2',
    },
  },
  {
    cli: '0.1.5-rc.1',
    versions: {
      '@deepseek-ai/cordis': '4.0.2',
      '@deepseek-ai/dsh-agent-default-model': '0.1.5-rc.2',
      '@deepseek-ai/dsh-client-ui-conversation': '0.1.5-rc.2',
      '@deepseek-ai/dsh-llm': '0.1.5-rc.2',
      '@deepseek-ai/dsh-session': '0.1.5-rc.2',
      '@deepseek-ai/dsh-settings': '0.1.5-rc.2',
      '@deepseek-ai/dsh-system-prompt': '0.1.5-rc.2',
      '@deepseek-ai/dsh-tools': '0.1.5-rc.2',
      '@deepseek-ai/schemastery': '3.18.2',
    },
  },
] as const

export interface DshRuntimeCompatibility {
  cliVersion: '0.1.2-rc.1' | '0.1.5-rc.1'
  packageVersions: Readonly<Record<string, string>>
}

export type DshRuntimePackageVersions = Readonly<Record<(typeof RUNTIME_PACKAGES)[number], string>>

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

/**
 * Fail before registering services when a profile-local peer tree shadows the
 * DSH installation. A mixed tree otherwise fails later as an empty conversation
 * surface with unrelated missing-service or method errors.
 */
export function classifyDshRuntime(packageVersions: DshRuntimePackageVersions): DshRuntimeCompatibility {
  const family = SUPPORTED_RUNTIME_FAMILIES.find(({ versions }) => (
    RUNTIME_PACKAGES.every((name) => packageVersions[name] === versions[name])
  ))
  if (family) return { cliVersion: family.cli, packageVersions }

  const found = RUNTIME_PACKAGES.map((name) => `${name}@${packageVersions[name]}`).join(', ')
  throw new Error(
    'StrataGate cannot start because this DSH profile resolves an unsupported or mixed core runtime. '
    + `Resolved: ${found}. Supported tested hosts are @deepseek-ai/dsh@0.1.2-rc.1 `
    + '(internal DSH packages 0.1.2-rc.1) and @deepseek-ai/dsh@0.1.5-rc.1 '
    + '(its real dependency tree uses internal DSH packages 0.1.5-rc.2). '
    + 'Reinstall or update stratagate-dsh through `dsh plugin --profile <name> add <package>` so the host supplies its peers.',
  )
}

export function assertCompatibleDshRuntime(): DshRuntimeCompatibility {
  const packageVersions = Object.fromEntries(RUNTIME_PACKAGES.map((name) => [name, installedVersion(name)])) as DshRuntimePackageVersions
  return classifyDshRuntime(packageVersions)
}

import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HOST_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-format',
  '@deepseek-ai/dsh-session-format-catalog',
  '@deepseek-ai/dsh-session-format-v0-to-v1',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
] as const

const installedHooks = Symbol.for('stratagate.dsh-host-resolution.v1')

function isWithin(path: string, root: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function profileDirectory(start: string): string | undefined {
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
    if (parent === directory) return undefined
    directory = parent
  }
}

function hostPackage(specifier: string): boolean {
  return HOST_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))
}

/**
 * Force only StrataGate's DSH imports through the installation-owned fallback
 * created by DSH. The hook neither deletes nor rewrites the profile's package
 * tree, and imports belonging to the host or other plugins are untouched.
 */
export function installDshHostResolution(moduleUrl: string): boolean {
  const packageDirectory = dirname(dirname(fileURLToPath(moduleUrl)))
  const profile = profileDirectory(packageDirectory)
  if (!profile) return false

  const globalState = globalThis as typeof globalThis & { [installedHooks]?: Set<string> }
  const installed = globalState[installedHooks] ??= new Set<string>()
  const key = `${profile}\u0000${packageDirectory}`
  if (installed.has(key)) return true

  const fallbackModules = join(dirname(profile), 'node_modules')
  const hostRequire = createRequire(join(fallbackModules, '.stratagate-host-resolution.cjs'))
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : undefined
      if (!hostPackage(specifier) || !parent || !isWithin(parent, packageDirectory)) {
        return nextResolve(specifier, context)
      }
      try {
        return { url: pathToFileURL(hostRequire.resolve(specifier)).href, shortCircuit: true }
      } catch (cause) {
        if (specifier === '@deepseek-ai/dsh-session-format-v0-to-v1'
          || specifier === '@deepseek-ai/dsh-session-format-catalog') {
          return nextResolve(specifier, context)
        }
        throw new Error(
          `StrataGate cannot resolve host-provided DSH package ${JSON.stringify(specifier)} from ${fallbackModules}. `
          + 'Start StrataGate through the DSH profile launcher so the host can prepare its module fallback.',
          { cause },
        )
      }
    },
  })
  installed.add(key)
  return true
}

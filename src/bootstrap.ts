import { installDshHostResolution } from './dsh-host-resolution.js'

// DSH prepares its installation-owned module fallback before it imports a
// profile bundle. Install the narrowly-scoped resolver first, then load the
// implementation so stale profile-local peers cannot win ESM resolution.
installDshHostResolution(import.meta.url)

// This file and src/index.ts are separate tsup entries. The runtime path is
// intentionally external so the implementation is instantiated only after
// the resolver above is active.
// @ts-expect-error dist/plugin.js is emitted from src/index.ts during build.
const plugin = await import('./plugin.js') as typeof import('./index.js')

export const name = plugin.name
export const inject = plugin.inject
export const STRATAGATE_SETTINGS_NAMESPACE = plugin.STRATAGATE_SETTINGS_NAMESPACE
export const Config = plugin.Config
export const apply = plugin.apply
export type PluginConfig = import('./index.js').PluginConfig

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { checkClient } from './check-client.mjs'

const root = new URL('../', import.meta.url)
const rootDir = fileURLToPath(root)
checkClient(rootDir)
mkdirSync(new URL('dist/', root), { recursive: true })
const clientSource = readFileSync(new URL('src/client.js', root), 'utf8')
const packageMetadata = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const packageVersion = typeof packageMetadata.version === 'string' && packageMetadata.version.trim()
  ? packageMetadata.version.trim()
  : 'unknown'
// Baked in from the cached build-time value; no runtime GitHub API call.
const starData = (() => {
  try { return JSON.parse(readFileSync(new URL('src/github-stars.json', root), 'utf8')) } catch { return {} }
})()
globalThis.__STRATAGATE_GITHUB_STARS__ = Number.isSafeInteger(starData?.count) && starData.count >= 0 ? starData.count : 128
const bootstrap = `
import cytoscape from 'cytoscape'
import fcose from 'cytoscape-fcose'
cytoscape.use(fcose)
globalThis.__StrataGateGraphLibraries = { cytoscape }
globalThis.__STRATAGATE_GITHUB_STARS__ = ${globalThis.__STRATAGATE_GITHUB_STARS__}
${clientSource}
`

function createSandboxFallbackPlugin(baseDir) {
  const rootRequire = createRequire(join(baseDir, 'package.json'))
  return {
    name: 'sandbox-node-fs',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        const req = args.importer && args.importer.includes('node_modules')
          ? createRequire(args.importer)
          : rootRequire
        try {
          const pkgJsonPath = req.resolve(`${args.path}/package.json`)
          const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
          const entry = pkg.module || pkg.main
          if (entry) return { path: join(dirname(pkgJsonPath), entry), namespace: 'sandbox-node-fs' }
        } catch {}
        return { path: req.resolve(args.path), namespace: 'sandbox-node-fs' }
      })
      b.onLoad({ filter: /.*/, namespace: 'sandbox-node-fs' }, (args) => ({
        contents: readFileSync(args.path, 'utf8'),
        loader: 'js',
      }))
    },
  }
}

const result = await build({
  stdin: { contents: bootstrap, sourcefile: 'stratagate-client.js' },
  plugins: [createSandboxFallbackPlugin(rootDir)],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  target: ['chrome100'],
  legalComments: 'none',
  minifySyntax: true,
  minifyWhitespace: true,
})
const bundledClient = result.outputFiles?.[0]?.text
if (!bundledClient) throw new Error('Client bundler produced no JavaScript output')
writeFileSync(
  new URL('dist/client.js', root),
  bundledClient
    .replaceAll('__STRATAGATE_CLIENT_VERSION__', packageVersion),
)
copyFileSync(new URL('src/client.d.ts', root), new URL('dist/client.d.ts', root))
copyFileSync(new URL('dist/plugin.d.ts', root), new URL('dist/index.d.ts', root))

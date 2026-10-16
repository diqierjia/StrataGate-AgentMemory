import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { checkFeedbackPolicy } from './check-feedback-policy.mjs'

const root = new URL('../', import.meta.url)
checkFeedbackPolicy(fileURLToPath(root))
mkdirSync(new URL('dist/', root), { recursive: true })
const clientSource = readFileSync(new URL('src/client.js', root), 'utf8')
const mascot = readFileSync(new URL('docs/assets/stratagate-avatar.png', root)).toString('base64')
const packageMetadata = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const packageVersion = typeof packageMetadata.version === 'string' && packageMetadata.version.trim()
  ? packageMetadata.version.trim()
  : 'unknown'
const bootstrap = `
import cytoscape from 'cytoscape'
import fcose from 'cytoscape-fcose'
cytoscape.use(fcose)
globalThis.__StrataGateGraphLibraries = { cytoscape }
${clientSource}
`
const result = await build({
  stdin: { contents: bootstrap, resolveDir: fileURLToPath(root), sourcefile: 'stratagate-client.js' },
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
    .replace('__STRATAGATE_MASCOT_DATA_URL__', `data:image/png;base64,${mascot}`)
    .replaceAll('__STRATAGATE_CLIENT_VERSION__', packageVersion),
)
copyFileSync(new URL('src/client.d.ts', root), new URL('dist/client.d.ts', root))
copyFileSync(new URL('dist/plugin.d.ts', root), new URL('dist/index.d.ts', root))

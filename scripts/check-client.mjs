import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { checkFeedbackPolicy } from './check-feedback-policy.mjs'

export const CLIENT_MODULES = [
  '01-navigation-and-styles.js',
  '02-chat-citations-and-feed.js',
  '03-graph-and-event-widgets.js',
  '04-topics-dreaming-long-term.js',
  '05-short-term-and-daily-notes.js',
  '06-import-more-and-support.js',
  '07-profile-and-settings.js',
  '08-overview-shell-and-entry.js',
]

// Semantic error codes that catch real bugs in untyped JS without forcing
// artificial type annotations on dynamic React/DOM objects:
// 2300/2451: Duplicate identifier / redeclared block-scoped variable
// 2304/2552: Cannot find name (undeclared variable or function typo)
// 2364: Invalid left-hand side of assignment
// 2554/2555: Wrong number of arguments to function call
// 2588: Cannot assign to 'x' because it is a constant
const ENFORCED_SEMANTIC_CODES = new Set([2300, 2304, 2364, 2451, 2552, 2554, 2555, 2588])

function normalizeLf(text) {
  return text.replaceAll('\r\n', '\n')
}

export function loadClientSegments(root) {
  const clientDir = join(root, 'src', 'client')
  const segments = []
  let currentLine = 1
  for (const name of CLIENT_MODULES) {
    const filePath = join(clientDir, name)
    if (!existsSync(filePath)) {
      throw new Error(`Missing modular client file: src/client/${name}`)
    }
    const content = readFileSync(filePath, 'utf8')
    const lineCount = normalizeLf(content).split('\n').length - (content.endsWith('\n') ? 1 : 0)
    segments.push({
      name,
      filePath,
      content,
      startLine: currentLine,
      endLine: currentLine + lineCount - 1,
      lineCount,
      mtimeMs: statSync(filePath).mtimeMs,
    })
    currentLine += lineCount
  }
  return segments
}

export function mapLineToSegment(segments, line1Based) {
  for (const seg of segments) {
    if (line1Based >= seg.startLine && line1Based <= seg.endLine) {
      return {
        moduleName: seg.name,
        moduleLine: line1Based - seg.startLine + 1,
      }
    }
  }
  const last = segments[segments.length - 1]
  return {
    moduleName: last ? last.name : 'client.js',
    moduleLine: line1Based,
  }
}

export function syncOrVerifyClientModules(root, { forceSync = false } = {}) {
  const clientPath = join(root, 'src', 'client.js')
  const segments = loadClientSegments(root)
  const assembled = segments.map((s) => s.content).join('')
  const current = existsSync(clientPath) ? readFileSync(clientPath, 'utf8') : ''

  if (normalizeLf(assembled) !== normalizeLf(current)) {
    const clientMtime = existsSync(clientPath) ? statSync(clientPath).mtimeMs : 0
    const maxSegmentMtime = Math.max(...segments.map((s) => s.mtimeMs))
    if (forceSync || maxSegmentMtime >= clientMtime) {
      writeFileSync(clientPath, assembled, 'utf8')
    } else {
      throw new Error(
        'src/client.js was edited directly and is out of sync with src/client/*.js. ' +
        'Please edit the modular files under src/client/ (see docs/ui-map.md) and run "node scripts/check-client.mjs --sync".',
      )
    }
  }
  return { clientPath, segments, source: assembled }
}

export function checkCssDesignTokens(source, segments) {
  const defined = new Set([...source.matchAll(/(--(?:sg|sgm)-[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]))
  const lines = normalizeLf(source).split('\n')
  const errors = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const match of line.matchAll(/var\(\s*(--(?:sg|sgm)-[a-zA-Z0-9_-]+)/g)) {
      const token = match[1]
      if (!defined.has(token)) {
        const loc = mapLineToSegment(segments, i + 1)
        errors.push(`src/client/${loc.moduleName}:${loc.moduleLine} uses undefined CSS design token "${token}". Check docs/ui-map.md for valid --sg-* tokens.`)
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`Client CSS token check failed:\n  ` + errors.join('\n  '))
  }
}

export function checkClientTypeScriptDiagnostics(clientPath, segments) {
  const options = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: false,
  }
  const program = ts.createProgram([clientPath], options)
  const sf = program.getSourceFile(clientPath)
  if (!sf) throw new Error(`TypeScript could not load ${clientPath}`)

  const syntactic = program.getSyntacticDiagnostics(sf)
  const semantic = program.getSemanticDiagnostics(sf).filter((d) => ENFORCED_SEMANTIC_CODES.has(d.code))
  const all = [...syntactic, ...semantic]

  if (all.length > 0) {
    const formatted = all.map((d) => {
      const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 }
      const line1 = pos.line + 1
      const col1 = pos.character + 1
      const loc = mapLineToSegment(segments, line1)
      const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ')
      return `src/client/${loc.moduleName}:${loc.moduleLine}:${col1} (client.js:${line1}) TS${d.code}: ${msg}`
    })
    throw new Error(`Client static check failed (${all.length} issue${all.length === 1 ? '' : 's'}):\n  ` + formatted.join('\n  '))
  }
}

export function checkClient(root = fileURLToPath(new URL('../', import.meta.url)), options = {}) {
  const { clientPath, segments, source } = syncOrVerifyClientModules(root, options)
  checkFeedbackPolicy(root)
  checkCssDesignTokens(source, segments)
  checkClientTypeScriptDiagnostics(clientPath, segments)
  return { modules: segments.length, lines: segments[segments.length - 1]?.endLine || 0 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const forceSync = process.argv.includes('--sync')
  const root = fileURLToPath(new URL('../', import.meta.url))
  const result = checkClient(root, { forceSync })
  console.log(`[check-client] OK (${result.modules} modules, ${result.lines} lines, tokens & static checks passed)`)
  const slotScript = resolve(root, 'scripts/worktree-slots.mjs')
  if (existsSync(slotScript)) {
    try {
      const slotOutput = execFileSync(process.execPath, [slotScript, 'status', '--path', root], { encoding: 'utf8' }).trim()
      if (slotOutput) console.log(slotOutput)
    } catch {
      // ignore slot reporting error in non-git environments
    }
  }
}

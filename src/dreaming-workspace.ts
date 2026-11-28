import { lstat, readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { containsCredentials } from './diagnostics.js'

const PRIVATE_NAME = /^(?:\.git|\.hg|\.svn|node_modules|\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.codex|\.dsh|\.gnupg|\.kube|\.npmrc|\.netrc|secrets?(?:[._-].*)?|credentials?(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$|\.(?:db(?:-shm|-wal)?|sqlite[\w-]*|pem|key|pfx|p12|kdbx|dpapi)$/i
const MAX_BYTES = 2 * 1024 * 1024

export async function dreamingWorkspace(root: string, args: Record<string, unknown>): Promise<unknown> {
  const input = args.path === undefined ? '.' : args.path
  if (typeof input !== 'string' || input.includes('\0') || isAbsolute(input) || input.split(/[\\/]/).includes('..')) throw new Error('该工作区路径不可读取。')
  const parts = input.split(/[\\/]+/).filter(p => p && p !== '.')
  if (parts.some(p => PRIVATE_NAME.test(p))) throw new Error('该工作区路径不可读取。')
  let target = resolve(root)
  for (const part of parts) {
    target = join(target, part)
    if ((await lstat(target)).isSymbolicLink()) throw new Error('该工作区路径不可读取。')
  }
  const rootPath = resolve(root)
  const rel = relative(rootPath, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('该工作区路径不可读取。')
  const offset = typeof args.offset === 'number' && Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0
  const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) ? Math.max(1, Math.min(100, args.limit)) : 20
  const query = typeof args.query === 'string' ? args.query.toLowerCase() : ''
  const kind = args.kind
  const page = <T>(items: T[]) => ({ items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null, total: items.length })
  const textFile = async (file: string) => {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('无法读取该文件。')
    const bytes = await readFile(file)
    if (bytes.includes(0)) throw new Error('无法读取二进制文件。')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (containsCredentials(text)) throw new Error('文件可能包含凭据，无法读取。')
    return text
  }
  if (kind === 'read') {
    const text = await textFile(target)
    const size = typeof args.limit === 'number' && Number.isInteger(args.limit) ? Math.max(1, Math.min(12000, args.limit)) : 4000
    return { path: rel.replaceAll('\\', '/'), text: text.slice(offset, offset + size), nextOffset: offset + size < text.length ? offset + size : null, total: text.length }
  }
  if (kind !== 'list' && kind !== 'search') throw new Error('不支持的工作区操作。')
  if (kind === 'search' && !query) throw new Error('搜索词不能为空。')
  const items: Array<unknown> = []
  let scanned = 0, files = 0
  const walk = async (path: string, recursive: boolean): Promise<void> => {
    if (scanned >= 2000 || files >= 500 || items.length >= 2000) return
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++scanned > 2000 || files >= 500 || items.length >= 2000) break
        if (PRIVATE_NAME.test(entry.name) || entry.isSymbolicLink()) continue
        const child = join(path, entry.name), name = relative(rootPath, child).replaceAll('\\', '/')
        if (kind === 'list' && name.toLowerCase().includes(query)) items.push({ path: name, type: entry.isDirectory() ? 'directory' : 'file' })
        if ((recursive && entry.isDirectory()) || (kind === 'search' && entry.isFile())) await walk(child, recursive)
      }
    } else if (kind === 'search' && stat.isFile()) {
      files++
      try {
        const text = await textFile(path)
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (line.toLowerCase().includes(query)) items.push({ path: relative(rootPath, path).replaceAll('\\', '/'), line: index + 1, text: line.slice(0, 1000) })
          if (items.length >= 2000) break
        }
      } catch { /* Skip unreadable, sensitive and non-text files. */ }
    }
  }
  await walk(target, kind === 'search' || args.recursive === true)
  return { ...page(items), truncated: scanned >= 2000 || files >= 500 || items.length >= 2000 }
}

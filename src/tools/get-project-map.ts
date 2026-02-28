import { dirname } from 'node:path'
import type { DB } from '../store/db.js'
import { getAllFiles, getExportsByFile, getSymbolsByFile } from '../store/queries.js'

interface DirEntry {
  files: { path: string; exports: string[] }[]
  subdirs: Map<string, DirEntry>
}

export function getProjectMap(db: DB, maxDepth: number = 3) {
  const files = getAllFiles(db)
  if (files.length === 0) return 'No files indexed. Run reindex first.'

  // Build directory tree
  const root: DirEntry = { files: [], subdirs: new Map() }

  for (const file of files) {
    const exports = getExportsByFile(db, file.id)
    const symbols = getSymbolsByFile(db, file.id)
    const exportNames = exports
      .filter(e => !e.is_reexport)
      .map(e => {
        const sym = symbols.find(s => s.name === e.symbol)
        const sig = sym?.signature ? sym.signature : ''
        return `${e.symbol}${sig ? ' ' + sig : ''}`
      })

    const parts = file.path.replace(/\\/g, '/').split('/')
    let current = root
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i]
      if (!current.subdirs.has(dir)) {
        current.subdirs.set(dir, { files: [], subdirs: new Map() })
      }
      current = current.subdirs.get(dir)!
    }
    current.files.push({ path: parts[parts.length - 1], exports: exportNames })
  }

  // Format as text tree
  function formatDir(entry: DirEntry, prefix: string, dirName: string, depth: number): string[] {
    if (depth > maxDepth) return [`${prefix}${dirName}/ ...`]

    const lines: string[] = []
    const fileCount = countFiles(entry)
    const exportCount = countExports(entry)

    lines.push(`${prefix}${dirName}/ (${fileCount} files, ${exportCount} exports)`)

    // Files in this directory
    for (const file of entry.files) {
      const exps = file.exports.length > 0
        ? ` → ${file.exports.slice(0, 5).join(', ')}${file.exports.length > 5 ? ', ...' : ''}`
        : ''
      lines.push(`${prefix}  ${file.path}${exps}`)
    }

    // Subdirectories
    const dirs = [...entry.subdirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    for (const [name, sub] of dirs) {
      lines.push(...formatDir(sub, prefix + '  ', name, depth + 1))
    }

    return lines
  }

  function countFiles(entry: DirEntry): number {
    let n = entry.files.length
    for (const sub of entry.subdirs.values()) n += countFiles(sub)
    return n
  }

  function countExports(entry: DirEntry): number {
    let n = entry.files.reduce((sum, f) => sum + f.exports.length, 0)
    for (const sub of entry.subdirs.values()) n += countExports(sub)
    return n
  }

  // Render from top-level directories
  const lines: string[] = [`Project map (${files.length} files):\n`]
  for (const [name, sub] of [...root.subdirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(...formatDir(sub, '', name, 1))
  }
  // Top-level files
  for (const file of root.files) {
    const exps = file.exports.length > 0 ? ` → ${file.exports.join(', ')}` : ''
    lines.push(`${file.path}${exps}`)
  }

  return lines.join('\n')
}

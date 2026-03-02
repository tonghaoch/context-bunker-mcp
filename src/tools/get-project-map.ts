import type { DB } from '../store/db.js'

interface DirEntry {
  files: { path: string; exports: string[] }[]
  subdirs: Map<string, DirEntry>
  fileCount: number
  exportCount: number
}

export function getProjectMap(db: DB, maxDepth: number = 3) {
  // Single query: fetch all files with their non-reexport exports + signatures
  const rows = db.prepare(`
    SELECT f.path, e.symbol, s.signature
    FROM files f
    LEFT JOIN exports e ON e.file_id = f.id AND e.is_reexport = 0
    LEFT JOIN symbols s ON s.file_id = f.id AND s.name = e.symbol
    ORDER BY f.path
  `).all() as { path: string; symbol: string | null; signature: string | null }[]

  if (rows.length === 0) return 'No files indexed. Run reindex first.'

  // Group by file path
  const fileMap = new Map<string, string[]>()
  for (const row of rows) {
    if (!fileMap.has(row.path)) fileMap.set(row.path, [])
    if (row.symbol) {
      const sig = row.signature ? ` ${row.signature}` : ''
      fileMap.get(row.path)!.push(`${row.symbol}${sig}`)
    }
  }

  // Build directory tree
  const root: DirEntry = { files: [], subdirs: new Map(), fileCount: 0, exportCount: 0 }

  for (const [filePath, exportNames] of fileMap) {
    const parts = filePath.replace(/\\/g, '/').split('/')
    let current = root
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i]
      if (!current.subdirs.has(dir)) {
        current.subdirs.set(dir, { files: [], subdirs: new Map(), fileCount: 0, exportCount: 0 })
      }
      current = current.subdirs.get(dir)!
    }
    current.files.push({ path: parts[parts.length - 1], exports: exportNames })
  }

  // Precompute counts bottom-up in a single pass (avoids O(N*D) repeated traversals)
  function precomputeCounts(entry: DirEntry): void {
    entry.fileCount = entry.files.length
    entry.exportCount = entry.files.reduce((sum, f) => sum + f.exports.length, 0)
    for (const sub of entry.subdirs.values()) {
      precomputeCounts(sub)
      entry.fileCount += sub.fileCount
      entry.exportCount += sub.exportCount
    }
  }
  precomputeCounts(root)

  // Format as text tree
  function formatDir(entry: DirEntry, prefix: string, dirName: string, depth: number): string[] {
    if (depth > maxDepth) return [`${prefix}${dirName}/ ...`]

    const lines: string[] = []

    lines.push(`${prefix}${dirName}/ (${entry.fileCount} files, ${entry.exportCount} exports)`)

    for (const file of entry.files) {
      const exps = file.exports.length > 0
        ? ` → ${file.exports.slice(0, 5).join(', ')}${file.exports.length > 5 ? ', ...' : ''}`
        : ''
      lines.push(`${prefix}  ${file.path}${exps}`)
    }

    const dirs = [...entry.subdirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    for (const [name, sub] of dirs) {
      lines.push(...formatDir(sub, prefix + '  ', name, depth + 1))
    }

    return lines
  }

  const lines: string[] = [`Project map (${fileMap.size} files):\n`]
  for (const [name, sub] of [...root.subdirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(...formatDir(sub, '', name, 1))
  }
  for (const file of root.files) {
    const exps = file.exports.length > 0 ? ` → ${file.exports.join(', ')}` : ''
    lines.push(`${file.path}${exps}`)
  }

  return lines.join('\n')
}

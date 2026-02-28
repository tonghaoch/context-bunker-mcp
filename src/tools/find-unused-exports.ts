import type { DB } from '../store/db.js'

interface UnusedExport {
  symbol: string
  file: string
  kind: string
  line: number
}

export function findUnusedExports(db: DB, scope?: string) {
  // Get all non-reexport exports from internal files
  let sql = `
    SELECT e.symbol, e.kind, f.path, s.start_line
    FROM exports e
    JOIN files f ON e.file_id = f.id
    LEFT JOIN symbols s ON s.file_id = e.file_id AND s.name = e.symbol
    WHERE e.is_reexport = 0
  `
  const params: unknown[] = []
  if (scope) { sql += ' AND f.path LIKE ?'; params.push(scope + '%') }

  const exports = db.prepare(sql).all(...params) as {
    symbol: string; kind: string; path: string; start_line: number | null
  }[]

  const unused: UnusedExport[] = []

  for (const exp of exports) {
    // Check if any file imports this symbol from this file's path
    const importCount = db.prepare(
      `SELECT COUNT(*) as n FROM imports WHERE symbol = ? AND from_path = ? AND is_external = 0`
    ).get(exp.symbol, exp.path) as { n: number }

    // Also check if it's imported via a different resolved path (barrel re-exports)
    const reexportCount = db.prepare(
      `SELECT COUNT(*) as n FROM exports WHERE symbol = ? AND is_reexport = 1 AND original_path = ?`
    ).get(exp.symbol, exp.path) as { n: number }

    if (importCount.n === 0 && reexportCount.n === 0) {
      unused.push({
        symbol: exp.symbol,
        file: exp.path,
        kind: exp.kind,
        line: exp.start_line ?? 0,
      })
    }
  }

  if (unused.length === 0) {
    return scope
      ? `No unused exports found in ${scope}`
      : 'No unused exports found. All exported symbols are imported somewhere.'
  }

  const lines = [
    `${unused.length} unused export(s) found:`,
    '',
    ...unused.map(u => `  ${u.kind} ${u.symbol}  → ${u.file}${u.line ? ':' + u.line : ''}`),
    '',
    'Note: if this is a library, external consumers may use these symbols.',
  ]

  return lines.join('\n')
}

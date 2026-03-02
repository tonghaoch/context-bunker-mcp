import type { DB } from '../store/db.js'

export function findUnusedExports(db: DB, scope?: string) {
  let sql = `
    SELECT e.symbol, e.kind, f.path, s.start_line
    FROM exports e
    JOIN files f ON e.file_id = f.id
    LEFT JOIN symbols s ON s.file_id = e.file_id AND s.name = e.symbol
    WHERE e.is_reexport = 0
      AND NOT EXISTS (
        SELECT 1 FROM imports i
        WHERE i.symbol = e.symbol AND i.from_path = f.path AND i.is_external = 0
      )
      AND NOT EXISTS (
        SELECT 1 FROM exports r
        WHERE r.symbol = e.symbol AND r.is_reexport = 1 AND r.original_path = f.path
      )
  `
  const params: unknown[] = []
  if (scope) { sql += ` AND f.path LIKE ?`; params.push(scope + '%') }
  sql += ' ORDER BY f.path, e.symbol LIMIT 200'

  const unused = db.prepare(sql).all(...params) as {
    symbol: string; kind: string; path: string; start_line: number | null
  }[]

  if (unused.length === 0) {
    return scope
      ? `No unused exports found in ${scope}`
      : 'No unused exports found. All exported symbols are imported somewhere.'
  }

  const lines = [
    `${unused.length} unused export(s) found:`,
    '',
    ...unused.map(u => `  ${u.kind} ${u.symbol}  → ${u.path}${u.start_line ? ':' + u.start_line : ''}`),
    '',
    'Note: if this is a library, external consumers may use these symbols.',
  ]

  return lines.join('\n')
}

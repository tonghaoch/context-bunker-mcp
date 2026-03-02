import type { DB } from '../store/db.js'

export function findUnusedCode(db: DB, scope?: string, kind?: string) {
  let sql = `
    SELECT s.name, s.kind, f.path, s.start_line, s.end_line
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.is_exported = 0
      AND NOT EXISTS (
        SELECT 1 FROM calls c WHERE c.callee_name = s.name
      )
      AND NOT EXISTS (
        SELECT 1 FROM imports i WHERE i.symbol = s.name AND i.from_path = f.path AND i.is_external = 0
      )
      AND NOT EXISTS (
        SELECT 1 FROM exports e WHERE e.symbol = s.name AND e.file_id = s.file_id
      )
  `
  const params: unknown[] = []
  if (kind) { sql += ' AND s.kind = ?'; params.push(kind) }
  if (scope) { sql += ' AND f.path LIKE ?'; params.push(scope + '%') }
  sql += ' ORDER BY f.path, s.start_line LIMIT 200'

  const rows = db.prepare(sql).all(...params) as {
    name: string; kind: string; path: string; start_line: number; end_line: number
  }[]

  if (rows.length === 0) {
    return scope
      ? `No unused code found in ${scope}`
      : 'No unused code found.'
  }

  // Group by file
  const byFile = new Map<string, typeof rows>()
  for (const row of rows) {
    if (!byFile.has(row.path)) byFile.set(row.path, [])
    byFile.get(row.path)!.push(row)
  }

  const lines: string[] = [`${rows.length} unused symbol(s) found:\n`]
  for (const [file, symbols] of byFile) {
    lines.push(`${file}:`)
    for (const s of symbols) {
      lines.push(`  ${s.kind} ${s.name}  L${s.start_line}-${s.end_line}`)
    }
    lines.push('')
  }

  lines.push('Note: type/interface detection is best-effort — same-file type references are not fully tracked.')

  return lines.join('\n')
}

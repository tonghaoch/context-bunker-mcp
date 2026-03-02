import type { DB } from '../store/db.js'
import { searchTFIDF } from '../indexer/tfidf.js'

export function searchCode(db: DB, query: string, limit: number = 10) {
  const results = searchTFIDF(db, query, limit)

  if (results.length === 0) return `No results for "${query}"`

  // Batch: get file paths + exports for all result file IDs in one query
  const fileIds = results.map(r => r.fileId)
  const placeholders = fileIds.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT f.id as file_id, f.path, e.symbol
    FROM files f
    LEFT JOIN exports e ON e.file_id = f.id AND e.is_reexport = 0
    WHERE f.id IN (${placeholders})
  `).all(...fileIds) as { file_id: number; path: string; symbol: string | null }[]

  // Group by file
  const fileData = new Map<number, { path: string; exports: string[] }>()
  for (const row of rows) {
    if (!fileData.has(row.file_id)) fileData.set(row.file_id, { path: row.path, exports: [] })
    if (row.symbol) fileData.get(row.file_id)!.exports.push(row.symbol)
  }

  const lines = [`Search results for "${query}" (${results.length} files):\n`]

  for (const r of results) {
    const data = fileData.get(r.fileId)
    if (!data) continue
    const exps = data.exports.length > 0 ? ` [${data.exports.slice(0, 5).join(', ')}]` : ''
    const score = r.score.toFixed(2)
    lines.push(`  ${data.path} (score: ${score})${exps}`)
  }

  return lines.join('\n')
}

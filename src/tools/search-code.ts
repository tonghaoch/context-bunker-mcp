import type { DB } from '../store/db.js'
import { searchTFIDF } from '../indexer/tfidf.js'
import { getFileById, getExportsByFile } from '../store/queries.js'

export function searchCode(db: DB, query: string, limit: number = 10) {
  const results = searchTFIDF(db, query, limit)

  if (results.length === 0) return `No results for "${query}"`

  const lines = [`Search results for "${query}" (${results.length} files):\n`]

  for (const r of results) {
    const file = getFileById(db, r.fileId)
    if (!file) continue
    const exports = getExportsByFile(db, r.fileId)
    const exportNames = exports.filter(e => !e.is_reexport).map(e => e.symbol)
    const exps = exportNames.length > 0 ? ` [${exportNames.slice(0, 5).join(', ')}]` : ''
    const score = r.score.toFixed(2)
    lines.push(`  ${file.path} (score: ${score})${exps}`)
  }

  return lines.join('\n')
}

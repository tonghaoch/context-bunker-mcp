import type { DB } from '../store/db.js'
import { findSymbolsByName } from '../store/queries.js'

export function findSymbol(db: DB, query: string, kind?: string, scope?: string) {
  const results = findSymbolsByName(db, query, kind, scope)
  if (results.length === 0) return `No symbols found matching "${query}"`

  const lines = results.map(s => {
    const exp = s.is_exported ? 'export ' : ''
    const sig = s.signature ? ` ${s.signature}` : ''
    return `${exp}${s.kind} ${s.name}${sig}  → ${s.file_path}:${s.start_line}`
  })

  return `Found ${results.length} symbol(s) matching "${query}":\n${lines.join('\n')}`
}

import type { DB } from '../store/db.js'
import { getImportersOf, getCallersOf, findSymbolsByName } from '../store/queries.js'

export function findReferences(db: DB, symbol: string, file?: string) {
  const refs: { file: string; line: number; kind: string }[] = []

  // Find symbols matching the name to get their file paths
  const syms = findSymbolsByName(db, symbol)
  const defFiles = new Set(syms.map(s => s.file_path))

  // Find import references — files that import this symbol
  for (const defFile of defFiles) {
    const importers = getImportersOf(db, defFile)
    for (const imp of importers) {
      if (imp.symbol === symbol || imp.symbol === `* as ${symbol}`) {
        refs.push({ file: imp.file_path, line: 0, kind: imp.is_type_only ? 'type_import' : 'import' })
      }
    }
  }

  // Find call references — functions that call this symbol
  const callers = getCallersOf(db, symbol)
  for (const c of callers) {
    refs.push({ file: c.file_path, line: c.line, kind: 'call' })
  }

  // Also check member_expression calls like `this.method` or `obj.method`
  const memberCallers = getCallersOf(db, `this.${symbol}`)
  for (const c of memberCallers) {
    refs.push({ file: c.file_path, line: c.line, kind: 'call' })
  }

  if (refs.length === 0) return `No references found for "${symbol}"`

  // Deduplicate
  const seen = new Set<string>()
  const unique = refs.filter(r => {
    const key = `${r.file}:${r.line}:${r.kind}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // Format: definitions first, then imports, then calls
  const defs = syms.map(s => `  [definition] ${s.kind} ${s.name} → ${s.file_path}:${s.start_line}`)
  const refLines = unique.map(r => `  [${r.kind}] ${r.file}${r.line ? ':' + r.line : ''}`)

  return [
    `"${symbol}" — ${syms.length} definition(s), ${unique.length} reference(s):`,
    ...defs,
    ...refLines,
  ].join('\n')
}

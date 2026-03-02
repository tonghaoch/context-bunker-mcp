import type { DB } from '../store/db.js'
import { getImportersOfMany, getCallersOfMany, findSymbolsByName } from '../store/queries.js'

export function findReferences(db: DB, symbol: string, file?: string) {
  const refs: { file: string; line: number; kind: string }[] = []

  // Find symbols matching the name to get their file paths
  let syms = findSymbolsByName(db, symbol)
  if (file) {
    syms = syms.filter(s => s.file_path === file)
  }
  const defFiles = [...new Set(syms.map(s => s.file_path))]

  // Find import references — files that import this symbol (batched)
  const importers = getImportersOfMany(db, defFiles)
  for (const imp of importers) {
    if (imp.symbol === symbol || imp.symbol === `* as ${symbol}`) {
      refs.push({ file: imp.file_path, line: 0, kind: imp.is_type_only ? 'type_import' : 'import' })
    }
  }

  // Find call references — functions that call this symbol (batched: direct + member calls)
  const callers = getCallersOfMany(db, [symbol, `this.${symbol}`])
  for (const c of callers) {
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

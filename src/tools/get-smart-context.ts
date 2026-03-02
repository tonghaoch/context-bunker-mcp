import { basename, dirname, join } from 'node:path'
import type { DB } from '../store/db.js'
import {
  getFile, getSymbolsByFile, getExportsByFile,
  getImportersOf,
} from '../store/queries.js'
import { normalizePath } from '../utils/paths.js'

export function getSmartContext(db: DB, filePath: string) {
  filePath = normalizePath(filePath)
  const file = getFile(db, filePath)
  if (!file) return `File not found in index: ${filePath}\nTry running reindex first.`

  const symbols = getSymbolsByFile(db, file.id)
  const exports = getExportsByFile(db, file.id)

  // Batch: get all imports with resolved signatures in one query
  const imports = db.prepare(`
    SELECT i.symbol, i.from_path, i.is_type_only, i.is_external,
           s.signature, s.kind as resolved_kind
    FROM imports i
    LEFT JOIN files f ON f.path = i.from_path
    LEFT JOIN symbols s ON s.file_id = f.id AND s.name = i.symbol
    WHERE i.file_id = ?
  `).all(file.id) as {
    symbol: string; from_path: string; is_type_only: number; is_external: number
    signature: string | null; resolved_kind: string | null
  }[]

  // Imported-by: files that import from this file
  const importedBy = getImportersOf(db, filePath)
  const importerFiles = new Map<string, string[]>()
  for (const imp of importedBy) {
    const existing = importerFiles.get(imp.file_path) ?? []
    existing.push(imp.symbol)
    importerFiles.set(imp.file_path, existing)
  }

  // Format import details
  const importDetails = imports.map(imp => {
    const sig = imp.signature && !imp.is_external ? ` ${imp.signature}` : ''
    const typePrefix = imp.is_type_only ? 'type ' : ''
    const extTag = imp.is_external ? ' (external)' : ''
    return `  ${typePrefix}${imp.symbol}${sig} from '${imp.from_path}'${extTag}`
  })

  // Find test file — build candidates, batch check with single query
  const name = basename(filePath).replace(/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs)$/, '')
  const dir = dirname(filePath)
  const ext = filePath.match(/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs)$/)?.[0] ?? ''

  const candidates: string[] = []
  if (ext === '.py') {
    for (const p of [`test_${name}.py`, `${name}_test.py`, `tests/${name}.py`, `test/${name}.py`]) {
      candidates.push(normalizePath(join(dir, p)))
    }
  } else if (ext === '.go') {
    candidates.push(normalizePath(join(dir, `${name}_test.go`)))
  } else if (ext === '.rs') {
    for (const p of [`tests/${name}.rs`, `${name}_test.rs`]) {
      candidates.push(normalizePath(join(dir, p)))
    }
  } else {
    for (const testExt of ['.ts', '.tsx', '.js', '.jsx', '.mts']) {
      for (const pat of [`${name}.test`, `${name}.spec`, `__tests__/${name}`]) {
        candidates.push(normalizePath(join(dir, pat + testExt)))
      }
    }
  }

  // Single query to check all test file candidates
  let testFile: string | null = null
  if (candidates.length > 0) {
    const placeholders = candidates.map(() => '?').join(',')
    const found = db.prepare(`SELECT path FROM files WHERE path IN (${placeholders}) LIMIT 1`).get(...candidates) as { path: string } | undefined
    testFile = found?.path ?? null
  }

  // Build output
  const lines: string[] = [`${filePath} (${file.lines} lines)`, '']

  if (exports.length > 0) {
    lines.push('Exports:')
    const symbolsByName = new Map(symbols.map(s => [s.name, s]))
    for (const e of exports) {
      const sym = symbolsByName.get(e.symbol)
      const sig = sym?.signature ? ` ${sym.signature}` : ''
      const reex = e.is_reexport ? ` (re-export from ${e.original_path})` : ''
      lines.push(`  ${e.kind} ${e.symbol}${sig}${reex}`)
    }
    lines.push('')
  }

  if (importDetails.length > 0) {
    lines.push('Imports:')
    lines.push(...importDetails)
    lines.push('')
  }

  if (importerFiles.size > 0) {
    lines.push('Imported by:')
    for (const [f, syms] of importerFiles) {
      lines.push(`  ${f} → {${syms.join(', ')}}`)
    }
    lines.push('')
  }

  if (testFile) {
    lines.push(`Test file: ${testFile}`)
    lines.push('')
  }

  const deps = [...new Set(imports.filter(i => !i.is_external).map(i => i.from_path))]
  if (deps.length > 0) {
    lines.push('Dependencies:')
    for (const d of deps) lines.push(`  ${d}`)
  }

  return lines.join('\n')
}

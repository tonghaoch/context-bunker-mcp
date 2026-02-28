import { basename, dirname, join } from 'node:path'
import type { DB } from '../store/db.js'
import {
  getFile, getSymbolsByFile, getImportsByFile, getExportsByFile,
  getImportersOf, findSymbolsByName,
} from '../store/queries.js'
import { normalizePath } from '../utils/paths.js'

export function getSmartContext(db: DB, filePath: string) {
  filePath = normalizePath(filePath)
  const file = getFile(db, filePath)
  if (!file) return `File not found in index: ${filePath}\nTry running reindex first.`

  const symbols = getSymbolsByFile(db, file.id)
  const imports = getImportsByFile(db, file.id)
  const exports = getExportsByFile(db, file.id)

  // Imported-by: files that import from this file
  const importedBy = getImportersOf(db, filePath)
  // Deduplicate by file
  const importerFiles = new Map<string, string[]>()
  for (const imp of importedBy) {
    const existing = importerFiles.get(imp.file_path) ?? []
    existing.push(imp.symbol)
    importerFiles.set(imp.file_path, existing)
  }

  // Resolve imported symbol signatures (for non-external imports)
  const importDetails = imports.map(imp => {
    let sig = ''
    if (!imp.is_external) {
      const matchedSyms = findSymbolsByName(db, imp.symbol)
      const match = matchedSyms.find(s => s.file_path === imp.from_path)
      if (match?.signature) sig = ` ${match.signature}`
    }
    const typePrefix = imp.is_type_only ? 'type ' : ''
    const extTag = imp.is_external ? ' (external)' : ''
    return `  ${typePrefix}${imp.symbol}${sig} from '${imp.from_path}'${extTag}`
  })

  // Find test file
  const name = basename(filePath).replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
  const dir = dirname(filePath)
  const testPatterns = [
    `${name}.test`, `${name}.spec`, `${name}_test`,
    `__tests__/${name}`, `test/${name}`,
  ]
  let testFile: string | null = null
  for (const pat of testPatterns) {
    for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
      const candidate = join(dir, pat + ext)
      if (getFile(db, candidate)) { testFile = candidate; break }
      // Also check tests/ subdirectory
      const candidate2 = join(dir, '..', 'tests', basename(dir), pat + ext)
      if (getFile(db, candidate2)) { testFile = candidate2; break }
    }
    if (testFile) break
  }

  // Build output
  const lines: string[] = [
    `${filePath} (${file.lines} lines)`,
    '',
  ]

  if (exports.length > 0) {
    lines.push('Exports:')
    for (const e of exports) {
      const sym = symbols.find(s => s.name === e.symbol)
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

  // Internal dependencies (non-external import sources)
  const deps = [...new Set(imports.filter(i => !i.is_external).map(i => i.from_path))]
  if (deps.length > 0) {
    lines.push('Dependencies:')
    for (const d of deps) lines.push(`  ${d}`)
  }

  return lines.join('\n')
}

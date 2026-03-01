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
  const name = basename(filePath).replace(/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs)$/, '')
  const dir = dirname(filePath)
  const ext = filePath.match(/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs)$/)?.[0] ?? ''

  // Build test patterns based on file extension
  const testPatterns: { pattern: string; extensions: string[] }[] = []

  if (ext === '.py') {
    // Python conventions: test_foo.py, foo_test.py, tests/foo.py
    testPatterns.push(
      { pattern: `test_${name}`, extensions: ['.py'] },
      { pattern: `${name}_test`, extensions: ['.py'] },
      { pattern: `tests/${name}`, extensions: ['.py'] },
      { pattern: `test/${name}`, extensions: ['.py'] },
    )
  } else if (ext === '.go') {
    // Go convention: foo_test.go
    testPatterns.push(
      { pattern: `${name}_test`, extensions: ['.go'] },
    )
  } else if (ext === '.rs') {
    // Rust conventions: tests/foo.rs, foo_test.rs
    testPatterns.push(
      { pattern: `tests/${name}`, extensions: ['.rs'] },
      { pattern: `${name}_test`, extensions: ['.rs'] },
    )
  } else {
    // TypeScript/JavaScript conventions
    testPatterns.push(
      { pattern: `${name}.test`, extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts'] },
      { pattern: `${name}.spec`, extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts'] },
      { pattern: `${name}_test`, extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts'] },
      { pattern: `__tests__/${name}`, extensions: ['.ts', '.tsx', '.js', '.jsx'] },
      { pattern: `test/${name}`, extensions: ['.ts', '.tsx', '.js', '.jsx'] },
    )
  }

  let testFile: string | null = null
  for (const { pattern, extensions } of testPatterns) {
    for (const testExt of extensions) {
      const candidate = join(dir, pattern + testExt)
      if (getFile(db, candidate)) { testFile = candidate; break }
      // Also check tests/ subdirectory
      const candidate2 = join(dir, '..', 'tests', basename(dir), pattern + testExt)
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

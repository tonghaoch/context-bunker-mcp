import type { DB } from '../store/db.js'
import { getFile, getImportsByFile, getExportsByFile, getImportersOf } from '../store/queries.js'
import { normalizePath } from '../utils/paths.js'

export function getFileSummary(db: DB, filePath: string) {
  filePath = normalizePath(filePath)
  const file = getFile(db, filePath)
  if (!file) return `File not found in index: ${filePath}`

  const imports = getImportsByFile(db, file.id)
  const exports = getExportsByFile(db, file.id)
  const importers = getImportersOf(db, filePath)

  const extImports = imports.filter(i => i.is_external).map(i => i.from_path)
  const intImports = imports.filter(i => !i.is_external).map(i => `${i.from_path}`)
  const exportNames = exports.filter(e => !e.is_reexport).map(e => e.symbol)
  const importerPaths = [...new Set(importers.map(i => i.file_path))]

  const ago = Date.now() - file.mtime
  const agoStr = ago < 60_000 ? 'just now'
    : ago < 3_600_000 ? `${Math.round(ago / 60_000)}m ago`
    : ago < 86_400_000 ? `${Math.round(ago / 3_600_000)}h ago`
    : `${Math.round(ago / 86_400_000)}d ago`

  const lines = [`${filePath} (${file.lines} lines, modified ${agoStr})`]

  if (extImports.length > 0)
    lines.push(`  Imports (external): ${extImports.join(', ')}`)
  if (intImports.length > 0)
    lines.push(`  Imports (internal): ${intImports.join(', ')}`)
  if (exportNames.length > 0)
    lines.push(`  Exports: ${exportNames.join(', ')}`)
  if (importerPaths.length > 0)
    lines.push(`  Imported by: ${importerPaths.join(', ')}`)

  return lines.join('\n')
}

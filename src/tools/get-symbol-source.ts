import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from '../store/db.js'
import { findSymbolsByName } from '../store/queries.js'
import { normalizePath } from '../utils/paths.js'

export function getSymbolSource(db: DB, projectRoot: string, symbolName: string, file?: string) {
  if (file) file = normalizePath(file)
  const syms = findSymbolsByName(db, symbolName)
  const matches = file ? syms.filter(s => s.file_path === file) : syms

  if (matches.length === 0) {
    return `No symbol found matching "${symbolName}"${file ? ` in ${file}` : ''}`
  }

  const sym = matches[0]
  const fullPath = join(projectRoot, sym.file_path)

  let content: string
  try {
    content = readFileSync(fullPath, 'utf-8')
  } catch {
    return `Cannot read file: ${sym.file_path}`
  }

  const lines = content.split('\n')
  const startIdx = sym.start_line - 1
  const endIdx = sym.end_line

  // Include JSDoc/doc comment if present (lines immediately before the symbol)
  let jsdocStart = startIdx
  if (sym.jsdoc) {
    // Walk backwards to find the start of the doc comment
    for (let i = startIdx - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (
        // TS/JS JSDoc: /** ... */
        line.startsWith('/**') || line.startsWith('*') || line.startsWith('*/') ||
        // Go godoc: // comments
        line.startsWith('//')
      ) {
        jsdocStart = i
      } else {
        break
      }
    }
  }

  const source = lines.slice(jsdocStart, endIdx).join('\n')
  const exp = sym.is_exported ? 'export ' : ''
  const sig = sym.signature ? ` ${sym.signature}` : ''

  return [
    `${exp}${sym.kind} ${sym.name}${sig}`,
    `${sym.file_path}:${sym.start_line}-${sym.end_line}`,
    '',
    source,
  ].join('\n')
}

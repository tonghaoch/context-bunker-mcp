import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, extname } from 'node:path'
import { createHash } from 'node:crypto'
import type { DB } from '../store/db.js'
import { isSupportedFile, parseFile, initParser } from './parser.js'
import { extract } from './extractor.js'
import { resolveImportPath } from './resolver.js'
import { updateFileTFIDF, recomputeIDF } from './tfidf.js'
import {
  upsertFile, getFile, deleteFile, getAllFiles,
  deleteSymbolsByFile, deleteImportsByFile, deleteExportsByFile, deleteCallsByFile,
  insertSymbol, insertImport, insertExport, insertCall,
  getSymbolByNameAndFile,
} from '../store/queries.js'

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.context-bunker', '.next', '.nuxt', '.svelte-kit', 'out',
])

const IGNORED_EXTENSIONS = new Set(['.d.ts'])

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function walkDir(dir: string): string[] {
  const files: string[] = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) files.push(...walkDir(fullPath))
      } else if (entry.isFile()) {
        if (isSupportedFile(entry.name) && !IGNORED_EXTENSIONS.has(extname(entry.name))) {
          files.push(fullPath)
        }
      }
    }
  } catch { /* permission error, skip */ }
  return files
}

export interface IndexResult {
  indexed: number
  skipped: number
  removed: number
  errors: number
  timeMs: number
}

export async function indexFile(db: DB, filePath: string, projectRoot: string): Promise<boolean> {
  const relPath = relative(projectRoot, resolve(filePath))
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch {
    return false
  }

  const hash = hashContent(content)
  const lines = content.split('\n').length
  const mtime = statSync(filePath).mtimeMs

  // Check if file is unchanged
  const existing = getFile(db, relPath)
  if (existing && existing.hash === hash) return false

  // Parse
  const tree = await parseFile(content, filePath)
  if (!tree) return false

  // Extract
  const result = extract(tree, filePath)
  if (!result) return false

  // Store — wrap in transaction
  const fileResult = upsertFile(db, relPath, hash, mtime, lines)
  const fileId = existing?.id ?? Number(fileResult.lastInsertRowid)

  // Get file ID (upsert may not give us the ID on update)
  const fileRow = getFile(db, relPath)
  if (!fileRow) return false
  const fid = fileRow.id

  // Clear old data for this file
  deleteSymbolsByFile(db, fid)
  deleteImportsByFile(db, fid)
  deleteExportsByFile(db, fid)
  deleteCallsByFile(db, fid)

  // Insert symbols
  for (const sym of result.symbols) {
    insertSymbol(db, fid, sym.name, sym.kind, sym.startLine, sym.endLine, sym.isExported, sym.signature, sym.jsdoc)
  }

  // Insert imports with resolved paths
  for (const imp of result.imports) {
    const { resolved, isExternal } = resolveImportPath(imp.fromPath, resolve(projectRoot, relPath), projectRoot)
    insertImport(db, fid, imp.symbol, resolved, imp.isTypeOnly, isExternal)
  }

  // Insert exports
  for (const exp of result.exports) {
    const originalPath = exp.originalPath
      ? resolveImportPath(exp.originalPath, resolve(projectRoot, relPath), projectRoot).resolved
      : undefined
    insertExport(db, fid, exp.symbol, exp.kind, exp.isReexport, originalPath)
  }

  // Insert calls — link to parent symbol if possible
  for (const call of result.calls) {
    let callerSymbolId = 0
    if (call.parentSymbol) {
      const parentSym = getSymbolByNameAndFile(db, call.parentSymbol, fid)
      if (parentSym) callerSymbolId = parentSym.id
    }
    if (callerSymbolId > 0) {
      insertCall(db, callerSymbolId, call.calleeName, fid, call.line)
    }
  }

  // Update TF-IDF
  updateFileTFIDF(db, fid, content)

  return true
}

export async function removeFile(db: DB, filePath: string, projectRoot: string) {
  const relPath = relative(projectRoot, resolve(filePath))
  deleteFile(db, relPath)
}

export async function indexProject(db: DB, projectRoot: string, log?: (...args: unknown[]) => void): Promise<IndexResult> {
  const t0 = performance.now()
  await initParser()

  const allFiles = walkDir(projectRoot)
  log?.(`Found ${allFiles.length} files to index`)

  let indexed = 0, skipped = 0, errors = 0

  // Index files (sequential for now — tree-sitter WASM is sync per parse)
  for (const filePath of allFiles) {
    try {
      const changed = await indexFile(db, filePath, projectRoot)
      if (changed) indexed++
      else skipped++
    } catch (e) {
      errors++
      log?.(`Error indexing ${filePath}:`, e)
    }
  }

  // Remove files from DB that no longer exist on disk
  const dbFiles = getAllFiles(db)
  let removed = 0
  for (const f of dbFiles) {
    const fullPath = join(projectRoot, f.path)
    try {
      statSync(fullPath)
    } catch {
      deleteFile(db, f.path)
      removed++
    }
  }

  // Recompute IDF after batch
  recomputeIDF(db)

  const timeMs = Math.round(performance.now() - t0)
  log?.(`Indexed ${indexed}, skipped ${skipped}, removed ${removed}, errors ${errors} in ${timeMs}ms`)

  return { indexed, skipped, removed, errors, timeMs }
}

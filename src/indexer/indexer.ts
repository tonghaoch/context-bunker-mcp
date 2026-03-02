import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { DB } from '../store/db.js'
import { isSupportedFile, parseFile, initParser, getLanguageName } from './parser.js'
import { extract } from './extractor.js'
import { resolveImportPath } from './resolver.js'
import { updateFileTFIDF, recomputeIDF } from './tfidf.js'
import {
  upsertFile, getFile, deleteFile, getAllFiles,
  deleteSymbolsByFile, deleteImportsByFile, deleteExportsByFile, deleteCallsByFile,
  deleteRefsByFile, insertSymbol, insertImport, insertExport, insertCall, insertRef,
  getSymbolByNameAndFile,
} from '../store/queries.js'
import { type Config, SUPPORTED_LANGUAGES } from '../config.js'

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.context-bunker', '.next', '.nuxt', '.svelte-kit', 'out',
  // Python
  '__pycache__', 'venv', 'env', '.venv', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.tox',
  // Go
  'vendor',
  // Rust
  'target',
])

const IGNORED_SUFFIXES = ['.d.ts', '.d.mts', '.d.cts']

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

// Simple glob matcher for include/exclude patterns
// Supports: * (any within segment), ** (any depth), ? (single char)
export function matchGlob(pattern: string, path: string): boolean {
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')
  return new RegExp(`^${regex}$`).test(path)
}

export function matchesAny(patterns: string[], path: string): boolean {
  return patterns.some(p => matchGlob(p, path))
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
        if (isSupportedFile(entry.name) && !IGNORED_SUFFIXES.some(s => entry.name.endsWith(s))) {
          files.push(fullPath)
        }
      }
    }
  } catch { /* permission error, skip */ }
  return files
}

interface IndexResult {
  indexed: number
  skipped: number
  removed: number
  errors: number
  timeMs: number
}

export async function indexFile(db: DB, filePath: string, projectRoot: string, config?: Config): Promise<boolean> {
  const relPath = relative(projectRoot, resolve(filePath)).replace(/\\/g, '/')

  // Skip files matching exclude patterns
  if (config?.exclude && config.exclude.length > 0) {
    if (matchesAny(config.exclude, relPath)) return false
  }

  // Skip files not matching include prefixes (when include is configured)
  if (config?.include && config.include.length > 0) {
    if (!config.include.some(prefix => relPath.startsWith(prefix))) return false
  }

  // Skip files exceeding max size
  if (config?.maxFileSize) {
    try {
      const stat = statSync(filePath)
      if (stat.size > config.maxFileSize) return false
    } catch { return false }
  }

  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch {
    return false
  }

  const hash = hashContent(content)
  const lines = content.split('\n').length
  let mtime: number
  try { mtime = statSync(filePath).mtimeMs } catch { mtime = Date.now() }

  // Check if file is unchanged
  const existing = getFile(db, relPath)
  if (existing && existing.hash === hash) return false

  // Parse
  const tree = await parseFile(content, filePath)
  if (!tree) return false

  // Extract
  const result = extract(tree, filePath)
  if (!result) return false

  // Store — wrap writes in transaction for atomicity
  const writeOps = db.transaction(() => {
    upsertFile(db, relPath, hash, mtime, lines)

    // Get file ID (upsert may not give us the ID on update)
    const fileRow = getFile(db, relPath)
    if (!fileRow) return false
    const fid = fileRow.id

    // Clear old data for this file
    deleteSymbolsByFile(db, fid)
    deleteImportsByFile(db, fid)
    deleteExportsByFile(db, fid)
    deleteCallsByFile(db, fid)
    deleteRefsByFile(db, fid)

    // Insert symbols
    for (const sym of result.symbols) {
      insertSymbol(db, fid, sym.name, sym.kind, sym.startLine, sym.endLine, sym.isExported, sym.signature, sym.jsdoc)
    }

    // Insert imports with resolved paths
    const lang = getLanguageName(filePath) ?? undefined
    for (const imp of result.imports) {
      const { resolved, isExternal } = resolveImportPath(imp.fromPath, resolve(projectRoot, relPath), projectRoot, lang)
      insertImport(db, fid, imp.symbol, resolved, imp.isTypeOnly, isExternal)
    }

    // Insert exports
    for (const exp of result.exports) {
      const originalPath = exp.originalPath
        ? resolveImportPath(exp.originalPath, resolve(projectRoot, relPath), projectRoot, lang).resolved
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

    // Insert identifier references
    for (const name of result.refs) {
      insertRef(db, fid, name)
    }

    // Update TF-IDF
    updateFileTFIDF(db, fid, content)
    return true
  })

  return writeOps()
}

export async function removeFile(db: DB, filePath: string, projectRoot: string) {
  const relPath = relative(projectRoot, resolve(filePath)).replace(/\\/g, '/')
  deleteFile(db, relPath)
}

export async function indexProject(db: DB, projectRoot: string, log?: (...args: unknown[]) => void, config?: Config): Promise<IndexResult> {
  const t0 = performance.now()
  await initParser()

  const allFiles = walkDir(projectRoot)
  // Filter by configured languages
  const allowedLangs = config?.languages ? new Set(config.languages) : SUPPORTED_LANGUAGES
  let filteredFiles = allFiles.filter(f => {
    const lang = getLanguageName(f)
    return !lang || allowedLangs.has(lang)
  })

  // Apply include filter (file must be under at least one include prefix)
  if (config?.include && config.include.length > 0) {
    filteredFiles = filteredFiles.filter(f => {
      const relPath = relative(projectRoot, f).replace(/\\/g, '/')
      return config.include.some(prefix => relPath.startsWith(prefix))
    })
  }

  // Apply exclude filter (file must not match any exclude pattern)
  if (config?.exclude && config.exclude.length > 0) {
    filteredFiles = filteredFiles.filter(f => {
      const relPath = relative(projectRoot, f).replace(/\\/g, '/')
      return !matchesAny(config.exclude, relPath)
    })
  }

  log?.(`Found ${filteredFiles.length} files to index (${allFiles.length - filteredFiles.length} filtered by config)`)

  let indexed = 0, skipped = 0, errors = 0

  // Wrap batch in a single transaction for performance
  db.exec('BEGIN')
  try {
    for (const filePath of filteredFiles) {
      try {
        const changed = await indexFile(db, filePath, projectRoot, config)
        if (changed) indexed++
        else skipped++
      } catch (e) {
        errors++
        log?.(`Error indexing ${filePath}:`, e)
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
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

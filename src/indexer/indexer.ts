import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { DB } from '../store/db.js'
import { isSupportedFile, parseFile, initParser, getLanguageName } from './parser.js'
import { extract } from './extractor.js'
import { resolveImportPath, enableResolveCache, disableResolveCache } from './resolver.js'
import { updateFileTFIDF, recomputeIDF } from './tfidf.js'
import {
  upsertFile, getFile, deleteFile, getAllFiles,
  deleteSymbolsByFile, deleteImportsByFile, deleteExportsByFile,
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

const isBun = typeof globalThis.Bun !== 'undefined'

function hashContent(content: string): string {
  if (isBun) {
    // Bun.hash uses wyhash — ~20x faster than SHA-256, sufficient for change detection
    return (globalThis.Bun as any).hash(content).toString(16)
  }
  // Node.js fallback
  const { createHash } = require('node:crypto')
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

// Simple glob matcher for include/exclude patterns
// Supports: * (any within segment), ** (any depth), ? (single char)
const globCache = new Map<string, RegExp>()

export function matchGlob(pattern: string, path: string): boolean {
  let re = globCache.get(pattern)
  if (!re) {
    const regex = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*')
    re = new RegExp(`^${regex}$`)
    globCache.set(pattern, re)
  }
  return re.test(path)
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

interface IndexFileOptions {
  /** Skip include/exclude/maxFileSize checks (already filtered by caller) */
  batch?: boolean
}

export async function indexFile(db: DB, filePath: string, projectRoot: string, config?: Config, opts?: IndexFileOptions): Promise<boolean> {
  const relPath = relative(projectRoot, resolve(filePath)).replace(/\\/g, '/')

  if (!opts?.batch) {
    // Skip files matching exclude patterns
    if (config?.exclude && config.exclude.length > 0) {
      if (matchesAny(config.exclude, relPath)) return false
    }

    // Skip files not matching include prefixes (when include is configured)
    if (config?.include && config.include.length > 0) {
      if (!config.include.some(prefix => relPath.startsWith(prefix))) return false
    }
  }

  // Single stat call for size check + mtime
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(filePath)
  } catch { return false }

  if (config?.maxFileSize && stat.size > config.maxFileSize) return false

  const mtime = Math.floor(stat.mtimeMs)

  // Mtime fast-path: if DB has this file with matching mtime, skip entirely
  // hash !== '' check: invalidateFileHash sets hash='' to force re-index
  const existing = getFile(db, relPath)
  if (existing && existing.hash !== '' && existing.mtime === mtime) {
    return false
  }

  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch {
    return false
  }

  const hash = hashContent(content)
  let lines = 1
  for (let i = 0; i < content.length; i++) { if (content.charCodeAt(i) === 10) lines++ }

  // Content-based check: mtime changed but content is the same (e.g., touch)
  if (existing && existing.hash === hash) {
    // Update mtime so future fast-path works
    db.prepare('UPDATE files SET mtime = ? WHERE path = ?').run(mtime, relPath)
    return false
  }

  // Parse
  const tree = await parseFile(content, filePath)
  if (!tree) return false

  // Extract
  const result = extract(tree, filePath)
  if (!result) return false

  // Write to DB — in batch mode we're already inside a transaction
  const doWrite = () => {
    const fid = upsertFile(db, relPath, hash, mtime, lines)

    // Clear old data for this file
    // Note: deleteSymbolsByFile cascades to delete calls (via calls.caller_symbol_id FK)
    deleteSymbolsByFile(db, fid)
    deleteImportsByFile(db, fid)
    deleteExportsByFile(db, fid)
    deleteRefsByFile(db, fid)

    // Insert symbols
    for (const sym of result.symbols) {
      insertSymbol(db, fid, sym.name, sym.kind, sym.startLine, sym.endLine, sym.isExported, sym.signature, sym.jsdoc)
    }

    // Insert imports with resolved paths
    const lang = getLanguageName(filePath) ?? undefined
    const absFilePath = resolve(projectRoot, relPath)
    for (const imp of result.imports) {
      const { resolved, isExternal } = resolveImportPath(imp.fromPath, absFilePath, projectRoot, lang)
      insertImport(db, fid, imp.symbol, resolved, imp.isTypeOnly, isExternal)
    }

    // Insert exports
    for (const exp of result.exports) {
      const originalPath = exp.originalPath
        ? resolveImportPath(exp.originalPath, absFilePath, projectRoot, lang).resolved
        : undefined
      insertExport(db, fid, exp.symbol, exp.kind, exp.isReexport, originalPath)
    }

    // Insert calls — link to parent symbol if possible
    const symbolIdCache = new Map<string, number>()
    for (const call of result.calls) {
      let callerSymbolId = 0
      if (call.parentSymbol) {
        const cached = symbolIdCache.get(call.parentSymbol)
        if (cached !== undefined) {
          callerSymbolId = cached
        } else {
          const parentSym = getSymbolByNameAndFile(db, call.parentSymbol, fid)
          const id = parentSym ? parentSym.id : 0
          symbolIdCache.set(call.parentSymbol, id)
          callerSymbolId = id
        }
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
  }

  if (opts?.batch) {
    // Already inside indexProject's BEGIN/COMMIT — no savepoint needed
    return doWrite()
  }
  // Standalone call (e.g., from watcher) — wrap in transaction for atomicity
  return db.transaction(doWrite)()
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
  enableResolveCache()
  db.exec('BEGIN')
  try {
    for (const filePath of filteredFiles) {
      try {
        const changed = await indexFile(db, filePath, projectRoot, config, { batch: true })
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
  } finally {
    disableResolveCache()
  }

  // Remove files from DB that no longer exist on disk
  // Use a Set from walkDir results instead of N statSync calls
  const walkedPaths = new Set(
    allFiles.map(f => relative(projectRoot, f).replace(/\\/g, '/'))
  )
  const dbFiles = getAllFiles(db)
  let removed = 0
  const toRemove = dbFiles.filter(f => !walkedPaths.has(f.path))
  if (toRemove.length > 0) {
    db.exec('BEGIN')
    for (const f of toRemove) {
      deleteFile(db, f.path)
      removed++
    }
    db.exec('COMMIT')
  }

  // Recompute IDF after batch
  recomputeIDF(db)

  const timeMs = Math.round(performance.now() - t0)
  log?.(`Indexed ${indexed}, skipped ${skipped}, removed ${removed}, errors ${errors} in ${timeMs}ms`)

  return { indexed, skipped, removed, errors, timeMs }
}

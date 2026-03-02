import type { DB } from './db.js'

// ── Types ──

interface FileRow {
  id: number
  path: string
  hash: string
  mtime: number
  lines: number
  indexed_at: number
}

interface SymbolRow {
  id: number
  file_id: number
  name: string
  kind: string
  start_line: number
  end_line: number
  is_exported: number
  signature: string | null
  jsdoc: string | null
}

interface ImportRow {
  id: number
  file_id: number
  symbol: string
  from_path: string
  is_type_only: number
  is_external: number
}

interface ExportRow {
  id: number
  file_id: number
  symbol: string
  kind: string
  is_reexport: number
  original_path: string | null
}

interface CallRow {
  id: number
  caller_symbol_id: number
  callee_name: string
  file_id: number
  line: number
}

interface SessionRow {
  id: number
  started_at: number
  ended_at: number | null
  file_snapshot: string | null
}

// ── Query Functions ──

// Files
export function getFile(db: DB, path: string) {
  return db.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRow | undefined
}

export function getAllFiles(db: DB) {
  return db.prepare('SELECT * FROM files').all() as FileRow[]
}

export function upsertFile(db: DB, path: string, hash: string, mtime: number, lines: number): number {
  const row = db.prepare(
    `INSERT INTO files (path, hash, mtime, lines, indexed_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, mtime=excluded.mtime, lines=excluded.lines, indexed_at=excluded.indexed_at
     RETURNING id`
  ).get(path, hash, mtime, lines, Date.now()) as { id: number }
  return row.id
}

export function invalidateFileHash(db: DB, path: string) {
  db.prepare("UPDATE files SET hash = '' WHERE path = ?").run(path)
}

export function invalidateAllFileHashes(db: DB) {
  db.exec("UPDATE files SET hash = ''")
}

export function deleteFile(db: DB, path: string) {
  db.prepare('DELETE FROM files WHERE path = ?').run(path)
}

// Symbols
export function getSymbolsByFile(db: DB, fileId: number) {
  return db.prepare('SELECT * FROM symbols WHERE file_id = ?').all(fileId) as SymbolRow[]
}

export function findSymbolsByName(db: DB, query: string, kind?: string, scope?: string) {
  // Escape SQL LIKE wildcards in the query (preserve * as user wildcard -> %)
  const escaped = query.replace(/%/g, '!%').replace(/_/g, '!_').replace(/\*/g, '%')
  let sql = `SELECT s.*, f.path as file_path FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name LIKE ? ESCAPE '!'`
  const params: unknown[] = [escaped]
  if (kind) { sql += ' AND s.kind = ?'; params.push(kind) }
  if (scope) { sql += ` AND f.path LIKE ? ESCAPE '!'`; params.push(scope.replace(/%/g, '!%').replace(/_/g, '!_') + '%') }
  sql += ' ORDER BY s.name LIMIT 100'
  return db.prepare(sql).all(...params) as (SymbolRow & { file_path: string })[]
}

export function getSymbolByNameAndFile(db: DB, name: string, fileId: number) {
  return db.prepare('SELECT * FROM symbols WHERE name = ? AND file_id = ?').get(name, fileId) as SymbolRow | undefined
}

export function insertSymbol(db: DB, fileId: number, name: string, kind: string, startLine: number, endLine: number, isExported: boolean, signature?: string, jsdoc?: string) {
  return db.prepare(
    'INSERT OR REPLACE INTO symbols (file_id, name, kind, start_line, end_line, is_exported, signature, jsdoc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(fileId, name, kind, startLine, endLine, isExported ? 1 : 0, signature ?? null, jsdoc ?? null)
}

export function deleteSymbolsByFile(db: DB, fileId: number) {
  db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId)
}

// Imports
export function getImportsByFile(db: DB, fileId: number) {
  return db.prepare('SELECT * FROM imports WHERE file_id = ?').all(fileId) as ImportRow[]
}

export function getImportersOf(db: DB, fromPath: string) {
  return db.prepare(
    'SELECT i.*, f.path as file_path FROM imports i JOIN files f ON i.file_id = f.id WHERE i.from_path = ? LIMIT 500'
  ).all(fromPath) as (ImportRow & { file_path: string })[]
}

export function getImportersOfMany(db: DB, fromPaths: string[]) {
  if (fromPaths.length === 0) return []
  const placeholders = fromPaths.map(() => '?').join(',')
  return db.prepare(
    `SELECT i.*, f.path as file_path FROM imports i JOIN files f ON i.file_id = f.id WHERE i.from_path IN (${placeholders}) LIMIT 500`
  ).all(...fromPaths) as (ImportRow & { file_path: string })[]
}

export function insertImport(db: DB, fileId: number, symbol: string, fromPath: string, isTypeOnly: boolean, isExternal: boolean) {
  db.prepare(
    'INSERT INTO imports (file_id, symbol, from_path, is_type_only, is_external) VALUES (?, ?, ?, ?, ?)'
  ).run(fileId, symbol, fromPath, isTypeOnly ? 1 : 0, isExternal ? 1 : 0)
}

export function deleteImportsByFile(db: DB, fileId: number) {
  db.prepare('DELETE FROM imports WHERE file_id = ?').run(fileId)
}

// Exports
export function getExportsByFile(db: DB, fileId: number) {
  return db.prepare('SELECT * FROM exports WHERE file_id = ?').all(fileId) as ExportRow[]
}

export function insertExport(db: DB, fileId: number, symbol: string, kind: string, isReexport: boolean, originalPath?: string) {
  db.prepare(
    'INSERT INTO exports (file_id, symbol, kind, is_reexport, original_path) VALUES (?, ?, ?, ?, ?)'
  ).run(fileId, symbol, kind, isReexport ? 1 : 0, originalPath ?? null)
}

export function deleteExportsByFile(db: DB, fileId: number) {
  db.prepare('DELETE FROM exports WHERE file_id = ?').run(fileId)
}

// Calls
export function getCallsBySymbol(db: DB, symbolId: number) {
  return db.prepare('SELECT * FROM calls WHERE caller_symbol_id = ?').all(symbolId) as CallRow[]
}

export function getCallersOf(db: DB, calleeName: string) {
  return db.prepare(
    `SELECT c.*, s.name as caller_name, s.kind as caller_kind, f.path as file_path
     FROM calls c JOIN symbols s ON c.caller_symbol_id = s.id JOIN files f ON c.file_id = f.id
     WHERE c.callee_name = ? LIMIT 500`
  ).all(calleeName) as (CallRow & { caller_name: string; caller_kind: string; file_path: string })[]
}

export function getCallersOfMany(db: DB, calleeNames: string[]) {
  if (calleeNames.length === 0) return []
  const placeholders = calleeNames.map(() => '?').join(',')
  return db.prepare(
    `SELECT c.*, s.name as caller_name, s.kind as caller_kind, f.path as file_path
     FROM calls c JOIN symbols s ON c.caller_symbol_id = s.id JOIN files f ON c.file_id = f.id
     WHERE c.callee_name IN (${placeholders}) LIMIT 500`
  ).all(...calleeNames) as (CallRow & { caller_name: string; caller_kind: string; file_path: string })[]
}

export function insertCall(db: DB, callerSymbolId: number, calleeName: string, fileId: number, line: number) {
  db.prepare(
    'INSERT INTO calls (caller_symbol_id, callee_name, file_id, line) VALUES (?, ?, ?, ?)'
  ).run(callerSymbolId, calleeName, fileId, line)
}

// Refs (identifier references per file)
export function insertRef(db: DB, fileId: number, name: string) {
  db.prepare('INSERT OR IGNORE INTO refs (file_id, name) VALUES (?, ?)').run(fileId, name)
}

export function deleteRefsByFile(db: DB, fileId: number) {
  db.prepare('DELETE FROM refs WHERE file_id = ?').run(fileId)
}

// Sessions
export function getLastSession(db: DB) {
  return db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT 1').get() as SessionRow | undefined
}

export function startSession(db: DB) {
  return db.prepare('INSERT INTO sessions (started_at) VALUES (?)').run(Date.now())
}

export function endSession(db: DB, sessionId: number, snapshot: Record<string, unknown>) {
  db.prepare('UPDATE sessions SET ended_at = ?, file_snapshot = ? WHERE id = ?')
    .run(Date.now(), JSON.stringify(snapshot), sessionId)
}

// Stats
export function getStats(db: DB) {
  const row = db.prepare(
    `SELECT
      (SELECT COUNT(*) FROM files) as files,
      (SELECT COUNT(*) FROM symbols) as symbols,
      (SELECT COUNT(*) FROM imports) as imports,
      (SELECT COUNT(*) FROM exports) as exports,
      (SELECT COUNT(*) FROM calls) as calls`
  ).get() as { files: number; symbols: number; imports: number; exports: number; calls: number }
  return row
}

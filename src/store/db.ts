import { CREATE_TABLES, SCHEMA_VERSION } from './schema.js'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

// Unified interface for both bun:sqlite and better-sqlite3
export interface DB {
  exec(sql: string): void
  prepare(sql: string): Statement
  close(): void
  transaction<T>(fn: () => T): () => T
}

interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

/** Wrap a DB to cache prepared statements — avoids re-compiling SQL on every call */
function withStatementCache(db: DB): DB {
  const MAX_STMTS = 200
  const cache = new Map<string, Statement>()
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      let stmt = cache.get(sql)
      if (!stmt) {
        // Evict oldest when cache is full (dynamic SQL like IN(?,?,?) creates many variants)
        if (cache.size >= MAX_STMTS) {
          const oldest = cache.keys().next().value!
          cache.delete(oldest)
        }
        stmt = db.prepare(sql)
        cache.set(sql, stmt)
      }
      return stmt
    },
    close: () => { cache.clear(); db.close() },
    transaction: (fn) => db.transaction(fn),
  }
}

const isBun = typeof globalThis.Bun !== 'undefined'

async function openBunSqlite(dbPath: string): Promise<DB> {
  const { Database } = await import('bun:sqlite')
  const raw = new Database(dbPath)
  raw.exec('PRAGMA journal_mode=WAL')
  raw.exec('PRAGMA foreign_keys=ON')
  raw.exec('PRAGMA synchronous=NORMAL')
  raw.exec('PRAGMA cache_size=-8000')
  raw.exec('PRAGMA mmap_size=67108864')
  raw.exec('PRAGMA temp_store=MEMORY')
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => {
      const stmt = raw.prepare(sql)
      return {
        run: (...p: unknown[]) => stmt.run(...p as []) as { changes: number; lastInsertRowid: number | bigint },
        get: (...p: unknown[]) => stmt.get(...p as []),
        all: (...p: unknown[]) => stmt.all(...p as []),
      }
    },
    close: () => raw.close(),
    transaction: <T>(fn: () => T) => raw.transaction(fn),
  }
}

async function openBetterSqlite3(dbPath: string): Promise<DB> {
  const mod = await import('better-sqlite3')
  const Database = mod.default
  const raw = new Database(dbPath)
  raw.pragma('journal_mode=WAL')
  raw.pragma('foreign_keys=ON')
  raw.pragma('synchronous=NORMAL')
  raw.pragma('cache_size=-8000')
  raw.pragma('mmap_size=67108864')
  raw.pragma('temp_store=MEMORY')
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => {
      const stmt = raw.prepare(sql)
      return {
        run: (...p: unknown[]) => stmt.run(...p),
        get: (...p: unknown[]) => stmt.get(...p),
        all: (...p: unknown[]) => stmt.all(...p),
      }
    },
    close: () => raw.close(),
    transaction: <T>(fn: () => T) => raw.transaction(fn) as () => T,
  }
}

export function getMeta(db: DB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
}

export async function openDatabase(dbPath: string): Promise<DB> {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const db = isBun
    ? await openBunSqlite(dbPath)
    : await openBetterSqlite3(dbPath)

  // Init schema
  db.exec(CREATE_TABLES)

  const stored = Number(getMeta(db, 'schema_version') ?? '0')
  if (stored === 0) {
    // Fresh DB
    setMeta(db, 'schema_version', String(SCHEMA_VERSION))
  } else if (stored !== SCHEMA_VERSION) {
    // Version mismatch — drop everything and re-create
    db.exec(`
      DROP TABLE IF EXISTS refs;
      DROP TABLE IF EXISTS calls;
      DROP TABLE IF EXISTS tfidf;
      DROP TABLE IF EXISTS idf;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS exports;
      DROP TABLE IF EXISTS imports;
      DROP TABLE IF EXISTS symbols;
      DROP TABLE IF EXISTS files;
    `)
    db.exec(CREATE_TABLES)
    setMeta(db, 'schema_version', String(SCHEMA_VERSION))
  }

  return withStatementCache(db)
}

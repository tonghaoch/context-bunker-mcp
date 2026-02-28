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

export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

const isBun = typeof globalThis.Bun !== 'undefined'

async function openBunSqlite(dbPath: string): Promise<DB> {
  const { Database } = await import('bun:sqlite')
  const raw = new Database(dbPath)
  raw.exec('PRAGMA journal_mode=WAL')
  raw.exec('PRAGMA foreign_keys=ON')
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => {
      const stmt = raw.prepare(sql)
      return {
        run: (...p: unknown[]) => stmt.run(...p) as { changes: number; lastInsertRowid: number | bigint },
        get: (...p: unknown[]) => stmt.get(...p),
        all: (...p: unknown[]) => stmt.all(...p),
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

export async function openDatabase(dbPath: string): Promise<DB> {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const db = isBun
    ? await openBunSqlite(dbPath)
    : await openBetterSqlite3(dbPath)

  // Init schema — always run CREATE TABLE IF NOT EXISTS first
  db.exec(CREATE_TABLES)
  const version = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined
  if (!version) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
  }

  return db
}

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { openDatabase, type DB } from '../src/store/db.js'
import { initParser } from '../src/indexer/parser.js'
import { indexProject } from '../src/indexer/indexer.js'
import { getChangesSinceLastSession, buildFileSnapshot } from '../src/tools/get-changes.js'
import { startSession, endSession } from '../src/store/queries.js'

const FIXTURE = join(import.meta.dir, 'fixtures', 'small-ts')
const DB_DIR = join(import.meta.dir, '.tmp-sessions-test')
const DB_PATH = join(DB_DIR, 'index.db')

let db: DB

beforeAll(async () => {
  rmSync(DB_DIR, { recursive: true, force: true })
  db = await openDatabase(DB_PATH)
  await initParser()
  await indexProject(db, FIXTURE)
})

afterAll(() => {
  db.close()
})

describe('buildFileSnapshot', () => {
  it('builds snapshot with all indexed files', () => {
    const snapshot = buildFileSnapshot(db)
    const keys = Object.keys(snapshot)
    expect(keys.length).toBeGreaterThan(0)
    // Should contain at least auth.ts
    const authKey = keys.find(k => k.includes('auth.ts'))
    expect(authKey).toBeTruthy()
  })

  it('snapshot entries have hash and symbols', () => {
    const snapshot = buildFileSnapshot(db)
    const key = Object.keys(snapshot).find(k => k.includes('auth.ts'))!
    const entry = snapshot[key]
    expect(entry.hash).toBeTruthy()
    expect(Array.isArray(entry.symbols)).toBe(true)
    expect(entry.symbols).toContain('login')
    expect(entry.symbols).toContain('register')
  })

  it('snapshot only includes exported symbols', () => {
    const snapshot = buildFileSnapshot(db)
    const key = Object.keys(snapshot).find(k => k.includes('hash.ts'))!
    const entry = snapshot[key]
    expect(entry.symbols).toContain('hashPassword')
    expect(entry.symbols).toContain('verifyPassword')
    expect(entry.symbols).toContain('unusedHelper')
  })
})

describe('getChangesSinceLastSession', () => {
  it('reports first run when no session exists', () => {
    const result = getChangesSinceLastSession(db, FIXTURE)
    expect(result).toContain('No previous session')
  })

  it('reports no changes after saving current snapshot', () => {
    // Save a session with current snapshot
    const snapshot = buildFileSnapshot(db)
    const session = startSession(db)
    endSession(db, Number(session.lastInsertRowid), snapshot)

    const result = getChangesSinceLastSession(db, FIXTURE)
    expect(result).toContain('No changes')
  })

  it('detects deleted files', () => {
    // Save a session with an extra file that doesn't exist in current index
    const snapshot = buildFileSnapshot(db)
    snapshot['fake/deleted-file.ts'] = { hash: 'abc123', symbols: ['deletedFn'] }
    const session = startSession(db)
    endSession(db, Number(session.lastInsertRowid), snapshot)

    const result = getChangesSinceLastSession(db, FIXTURE)
    expect(result).toContain('Deleted')
    expect(result).toContain('fake/deleted-file.ts')
  })

  it('detects modified files with symbol diff', () => {
    // Save a session where auth.ts has a different hash
    const snapshot = buildFileSnapshot(db)
    const authKey = Object.keys(snapshot).find(k => k.includes('auth.ts'))!
    snapshot[authKey] = { hash: 'different-hash', symbols: ['login', 'oldFunction'] }
    const session = startSession(db)
    endSession(db, Number(session.lastInsertRowid), snapshot)

    const result = getChangesSinceLastSession(db, FIXTURE)
    expect(result).toContain('Modified')
    expect(result).toContain('auth.ts')
  })

  it('handles corrupted snapshot gracefully', () => {
    // Insert a session with invalid JSON in file_snapshot
    db.prepare('INSERT INTO sessions (started_at, ended_at, file_snapshot) VALUES (?, ?, ?)')
      .run(Date.now(), Date.now(), 'invalid json{{{')

    const result = getChangesSinceLastSession(db, FIXTURE)
    expect(result).toContain('Corrupted session snapshot')
  })
})

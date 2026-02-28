import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { openDatabase, type DB } from '../src/store/db.js'
import { initParser } from '../src/indexer/parser.js'
import { indexProject } from '../src/indexer/indexer.js'
import { getStats, getFile, getSymbolsByFile, getImportsByFile, getExportsByFile, getAllFiles } from '../src/store/queries.js'

const FIXTURE = join(import.meta.dir, 'fixtures', 'small-ts')
const DB_DIR = join(import.meta.dir, '.tmp-indexer-test')
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

describe('indexer', () => {
  it('indexes all fixture files', () => {
    const stats = getStats(db)
    expect(stats.files).toBe(5)
  })

  it('extracts symbols from auth.ts', () => {
    const file = getFile(db, 'src\\auth.ts') ?? getFile(db, 'src/auth.ts')
    expect(file).toBeTruthy()
    const syms = getSymbolsByFile(db, file!.id)
    const names = syms.map(s => s.name)
    expect(names).toContain('login')
    expect(names).toContain('register')
    expect(names).toContain('SECRET')
  })

  it('extracts imports from auth.ts', () => {
    const file = getFile(db, 'src\\auth.ts') ?? getFile(db, 'src/auth.ts')
    const imports = getImportsByFile(db, file!.id)
    const symbols = imports.map(i => i.symbol)
    expect(symbols).toContain('User')
    expect(symbols).toContain('hashPassword')
    expect(symbols).toContain('verifyPassword')
  })

  it('marks type-only imports', () => {
    const file = getFile(db, 'src\\auth.ts') ?? getFile(db, 'src/auth.ts')
    const imports = getImportsByFile(db, file!.id)
    const userImport = imports.find(i => i.symbol === 'User')
    expect(userImport?.is_type_only).toBe(1)
  })

  it('extracts exports from models/user.ts', () => {
    const file = getFile(db, 'src\\models\\user.ts') ?? getFile(db, 'src/models/user.ts')
    expect(file).toBeTruthy()
    const exports = getExportsByFile(db, file!.id)
    const names = exports.map(e => e.symbol)
    expect(names).toContain('User')
    expect(names).toContain('Session')
  })

  it('detects barrel re-exports from models/index.ts', () => {
    const file = getFile(db, 'src\\models\\index.ts') ?? getFile(db, 'src/models/index.ts')
    expect(file).toBeTruthy()
    const exports = getExportsByFile(db, file!.id)
    const reexports = exports.filter(e => e.is_reexport)
    expect(reexports.length).toBeGreaterThanOrEqual(2)
  })

  it('has non-zero call edges', () => {
    const stats = getStats(db)
    expect(stats.calls).toBeGreaterThan(0)
  })
})

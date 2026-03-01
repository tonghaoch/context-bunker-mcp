import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { openDatabase, type DB } from '../src/store/db.js'
import { initParser } from '../src/indexer/parser.js'
import { indexProject } from '../src/indexer/indexer.js'
import { getStats, getFile, getSymbolsByFile, getImportsByFile, getExportsByFile, getAllFiles } from '../src/store/queries.js'

const FIXTURE = join(import.meta.dir, 'fixtures', 'small-py')
const DB_DIR = join(import.meta.dir, '.tmp-python-test')
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

describe('python extractor', () => {
  it('indexes all Python fixture files', () => {
    const stats = getStats(db)
    expect(stats.files).toBe(5) // app.py, auth.py, utils/__init__.py, utils/hash.py, test_auth.py
  })

  it('extracts symbols from auth.py', () => {
    const file = getFile(db, 'auth.py')
    expect(file).toBeTruthy()
    const syms = getSymbolsByFile(db, file!.id)
    const names = syms.map(s => s.name)
    expect(names).toContain('User')
    expect(names).toContain('login')
    expect(names).toContain('register')
    expect(names).toContain('_validate_email')
  })

  it('marks private symbols as not exported', () => {
    const file = getFile(db, 'auth.py')
    const syms = getSymbolsByFile(db, file!.id)
    const validate = syms.find(s => s.name === '_validate_email')
    expect(validate?.is_exported).toBe(0)
    const login = syms.find(s => s.name === 'login')
    expect(login?.is_exported).toBe(1)
  })

  it('extracts class definitions', () => {
    const file = getFile(db, 'auth.py')
    const syms = getSymbolsByFile(db, file!.id)
    const user = syms.find(s => s.name === 'User')
    expect(user?.kind).toBe('class')
  })

  it('detects async functions', () => {
    const file = getFile(db, 'auth.py')
    const syms = getSymbolsByFile(db, file!.id)
    const reg = syms.find(s => s.name === 'register')
    expect(reg?.signature).toMatch(/^async /)
  })

  it('extracts imports from auth.py', () => {
    const file = getFile(db, 'auth.py')
    const imports = getImportsByFile(db, file!.id)
    const symbols = imports.map(i => i.symbol)
    expect(symbols).toContain('Optional')
    expect(symbols).toContain('hash_password')
    expect(symbols).toContain('verify_password')
  })

  it('extracts module-level variables from app.py', () => {
    const file = getFile(db, 'app.py')
    expect(file).toBeTruthy()
    const syms = getSymbolsByFile(db, file!.id)
    const names = syms.map(s => s.name)
    expect(names).toContain('MAX_RETRIES')
    expect(names).toContain('App')
    expect(names).toContain('main')
    // _internal_cache is private
    const cache = syms.find(s => s.name === '_internal_cache')
    expect(cache?.is_exported).toBe(0)
  })

  it('extracts docstrings', () => {
    const file = getFile(db, 'auth.py')
    const syms = getSymbolsByFile(db, file!.id)
    const login = syms.find(s => s.name === 'login')
    expect(login?.jsdoc).toContain('Authenticate a user')
  })

  it('has non-zero call edges', () => {
    const stats = getStats(db)
    expect(stats.calls).toBeGreaterThan(0)
  })
})

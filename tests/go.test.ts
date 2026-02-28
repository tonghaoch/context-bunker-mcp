import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { openDatabase, type DB } from '../src/store/db.js'
import { initParser } from '../src/indexer/parser.js'
import { indexProject } from '../src/indexer/indexer.js'
import { getStats, getFile, getSymbolsByFile, getImportsByFile, getExportsByFile, getAllFiles } from '../src/store/queries.js'

const FIXTURE = join(import.meta.dir, 'fixtures', 'small-go')
const DB_DIR = join(import.meta.dir, '.tmp-go-test')
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

describe('go extractor', () => {
  it('indexes all Go fixture files', () => {
    const stats = getStats(db)
    expect(stats.files).toBe(2) // main.go, auth/auth.go
  })

  it('extracts symbols from auth/auth.go', () => {
    const file = getFile(db, 'auth/auth.go') ?? getFile(db, 'auth\\auth.go')
    expect(file).toBeTruthy()
    const syms = getSymbolsByFile(db, file!.id)
    const names = syms.map(s => s.name)
    expect(names).toContain('User')
    expect(names).toContain('Authenticator')
    expect(names).toContain('Login')
    expect(names).toContain('User.FullName')
    expect(names).toContain('MaxRetries')
    expect(names).toContain('DefaultTimeout')
  })

  it('correctly classifies struct as class', () => {
    const file = getFile(db, 'auth/auth.go') ?? getFile(db, 'auth\\auth.go')
    const syms = getSymbolsByFile(db, file!.id)
    const user = syms.find(s => s.name === 'User')
    expect(user?.kind).toBe('class')
  })

  it('correctly classifies interface', () => {
    const file = getFile(db, 'auth/auth.go') ?? getFile(db, 'auth\\auth.go')
    const syms = getSymbolsByFile(db, file!.id)
    const auth = syms.find(s => s.name === 'Authenticator')
    expect(auth?.kind).toBe('interface')
  })

  it('correctly classifies type alias', () => {
    const file = getFile(db, 'auth/auth.go') ?? getFile(db, 'auth\\auth.go')
    const syms = getSymbolsByFile(db, file!.id)
    const role = syms.find(s => s.name === 'Role')
    expect(role?.kind).toBe('type')
  })

  it('marks uppercase symbols as exported', () => {
    const file = getFile(db, 'auth/auth.go') ?? getFile(db, 'auth\\auth.go')
    const syms = getSymbolsByFile(db, file!.id)
    const login = syms.find(s => s.name === 'Login')
    expect(login?.is_exported).toBe(1)
    const checkHealth = syms.find(s => s.name === 'checkHealth')
    expect(checkHealth?.is_exported).toBe(0)
  })

  it('extracts Go doc comments', () => {
    const file = getFile(db, 'auth/auth.go') ?? getFile(db, 'auth\\auth.go')
    const syms = getSymbolsByFile(db, file!.id)
    const login = syms.find(s => s.name === 'Login')
    expect(login?.jsdoc).toContain('authenticates a user')
  })

  it('extracts imports', () => {
    const file = getFile(db, 'auth/auth.go') ?? getFile(db, 'auth\\auth.go')
    const imports = getImportsByFile(db, file!.id)
    const symbols = imports.map(i => i.symbol)
    expect(symbols).toContain('fmt')
    expect(symbols).toContain('http')
  })

  it('resolves local Go imports via go.mod', () => {
    const file = getFile(db, 'main.go')
    expect(file).toBeTruthy()
    const imports = getImportsByFile(db, file!.id)
    const authImport = imports.find(i => i.symbol === 'auth')
    expect(authImport?.is_external).toBe(0)
    const fmtImport = imports.find(i => i.symbol === 'fmt')
    expect(fmtImport?.is_external).toBe(1)
  })

  it('has non-zero call edges', () => {
    const stats = getStats(db)
    expect(stats.calls).toBeGreaterThan(0)
  })
})

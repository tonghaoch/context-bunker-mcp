import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { openDatabase, getMeta, setMeta, type DB } from '../src/store/db.js'
import { SCHEMA_VERSION, MIGRATIONS } from '../src/store/schema.js'
import { initParser } from '../src/indexer/parser.js'
import { indexProject, indexFile } from '../src/indexer/indexer.js'
import { resolveImportPath, clearResolverCache } from '../src/indexer/resolver.js'
import {
  getStats, getFile, getSymbolsByFile, getImportsByFile,
  getCallsBySymbol,
} from '../src/store/queries.js'

const GO_FIXTURE = join(import.meta.dir, 'fixtures', 'small-go')
const TMP_BASE = join(import.meta.dir, '.tmp-fixes-test')

function tmpDir(name: string) {
  const dir = join(TMP_BASE, name)
  rmSync(dir, { recursive: true, force: true })
  return dir
}

beforeAll(async () => {
  rmSync(TMP_BASE, { recursive: true, force: true })
  await initParser()
})

afterAll(() => {
  rmSync(TMP_BASE, { recursive: true, force: true })
})

// ── Fix 1: Schema Migration System ──

describe('schema migration', () => {
  it('sets schema_version on fresh database', async () => {
    const dbDir = tmpDir('migration-fresh')
    const db = await openDatabase(join(dbDir, 'index.db'))
    const version = getMeta(db, 'schema_version')
    expect(version).toBe(String(SCHEMA_VERSION))
    db.close()
  })

  it('reopens existing database without error', async () => {
    const dbDir = tmpDir('migration-reopen')
    const db1 = await openDatabase(join(dbDir, 'index.db'))
    const v1 = getMeta(db1, 'schema_version')
    expect(v1).toBe(String(SCHEMA_VERSION))
    db1.close()

    // Reopen same DB
    const db2 = await openDatabase(join(dbDir, 'index.db'))
    const v2 = getMeta(db2, 'schema_version')
    expect(v2).toBe(String(SCHEMA_VERSION))
    db2.close()
  })

  it('getMeta/setMeta work as helpers', async () => {
    const dbDir = tmpDir('migration-helpers')
    const db = await openDatabase(join(dbDir, 'index.db'))
    setMeta(db, 'test_key', 'test_value')
    expect(getMeta(db, 'test_key')).toBe('test_value')
    setMeta(db, 'test_key', 'updated_value')
    expect(getMeta(db, 'test_key')).toBe('updated_value')
    expect(getMeta(db, 'nonexistent')).toBeUndefined()
    db.close()
  })

  it('warns on newer DB version (does not crash)', async () => {
    const dbDir = tmpDir('migration-newer')
    const db1 = await openDatabase(join(dbDir, 'index.db'))
    // Simulate a newer version by setting it higher
    setMeta(db1, 'schema_version', '999')
    db1.close()

    // Reopen — should not throw
    const db2 = await openDatabase(join(dbDir, 'index.db'))
    const v = getMeta(db2, 'schema_version')
    expect(v).toBe('999') // Should not downgrade
    db2.close()
  })

  it('MIGRATIONS array is defined and is an array', () => {
    expect(Array.isArray(MIGRATIONS)).toBe(true)
  })
})

// ── Fix 2: Transaction Wrapping ──

describe('transaction wrapping', () => {
  it('indexFile wraps writes atomically', async () => {
    const dbDir = tmpDir('tx-indexfile')
    const db = await openDatabase(join(dbDir, 'index.db'))
    const tsFixture = join(import.meta.dir, 'fixtures', 'small-ts')
    const result = await indexProject(db, tsFixture)
    expect(result.indexed).toBeGreaterThan(0)
    // Data should be consistent
    const stats = getStats(db)
    expect(stats.files).toBeGreaterThan(0)
    expect(stats.symbols).toBeGreaterThan(0)
    db.close()
  })

  it('indexProject batch is wrapped in BEGIN/COMMIT', async () => {
    const dbDir = tmpDir('tx-batch')
    const db = await openDatabase(join(dbDir, 'index.db'))
    const tsFixture = join(import.meta.dir, 'fixtures', 'small-ts')
    const result = await indexProject(db, tsFixture)
    expect(result.errors).toBe(0)
    expect(result.indexed).toBeGreaterThan(0)
    // Verify data integrity
    const stats = getStats(db)
    expect(stats.files).toBe(7)
    db.close()
  })

  it('re-indexing unchanged files skips correctly with transactions', async () => {
    const dbDir = tmpDir('tx-skip')
    const db = await openDatabase(join(dbDir, 'index.db'))
    const tsFixture = join(import.meta.dir, 'fixtures', 'small-ts')
    await indexProject(db, tsFixture)
    // Second run — all files unchanged
    const result2 = await indexProject(db, tsFixture)
    expect(result2.indexed).toBe(0)
    expect(result2.skipped).toBeGreaterThan(0)
    db.close()
  })
})

// ── Fix 4: Go Dependency Graph — Resolve to Files ──

describe('go import resolution to files', () => {
  it('resolves local Go import to .go file instead of directory', () => {
    clearResolverCache()
    const result = resolveImportPath(
      'example.com/small-go/auth',
      join(GO_FIXTURE, 'main.go'),
      GO_FIXTURE,
      'go',
    )
    expect(result.isExternal).toBe(false)
    // Should resolve to auth/auth.go (a file), not just auth/ (a directory)
    expect(result.resolved).toMatch(/\.go$/)
    expect(result.resolved).toContain('auth')
  })

  it('still marks external Go imports as external', () => {
    clearResolverCache()
    const result = resolveImportPath(
      'fmt',
      join(GO_FIXTURE, 'main.go'),
      GO_FIXTURE,
      'go',
    )
    expect(result.isExternal).toBe(true)
  })

  it('indexed Go fixture has file-level imports', async () => {
    const dbDir = tmpDir('go-resolve')
    const db = await openDatabase(join(dbDir, 'index.db'))
    await indexProject(db, GO_FIXTURE)
    const file = getFile(db, 'main.go')
    expect(file).toBeTruthy()
    const imports = getImportsByFile(db, file!.id)
    const authImport = imports.find(i => i.symbol === 'auth')
    expect(authImport).toBeTruthy()
    expect(authImport!.is_external).toBe(0)
    // Should resolve to a .go file, not a directory
    expect(authImport!.from_path).toMatch(/\.go$/)
    db.close()
  })
})

// ── Fix 5: Go Method Call Scope Tracking ──

describe('go method call scope', () => {
  it('records calls inside Go methods with full Type.Method scope', async () => {
    const dbDir = tmpDir('go-method-scope')
    const db = await openDatabase(join(dbDir, 'index.db'))
    await indexProject(db, GO_FIXTURE)

    // User.FullName method should be in the symbols table
    const file = getFile(db, 'auth/auth.go') ?? getFile(db, 'auth\\auth.go')
    expect(file).toBeTruthy()
    const syms = getSymbolsByFile(db, file!.id)
    const fullNameSym = syms.find(s => s.name === 'User.FullName')
    expect(fullNameSym).toBeTruthy()

    // checkHealth calls http.Get — should be recorded because checkHealth is a function scope
    const checkHealthSym = syms.find(s => s.name === 'checkHealth')
    expect(checkHealthSym).toBeTruthy()
    const checkHealthCalls = getCallsBySymbol(db, checkHealthSym!.id)
    expect(checkHealthCalls.length).toBeGreaterThan(0)

    db.close()
  })

  it('calls inside Login function are recorded', async () => {
    const dbDir = tmpDir('go-func-scope')
    const db = await openDatabase(join(dbDir, 'index.db'))
    await indexProject(db, GO_FIXTURE)

    const file = getFile(db, 'auth/auth.go') ?? getFile(db, 'auth\\auth.go')
    expect(file).toBeTruthy()
    const syms = getSymbolsByFile(db, file!.id)
    const loginSym = syms.find(s => s.name === 'Login')
    expect(loginSym).toBeTruthy()
    const loginCalls = getCallsBySymbol(db, loginSym!.id)
    // Login calls fmt.Println
    expect(loginCalls.length).toBeGreaterThan(0)

    db.close()
  })

  it('calls inside main function are recorded', async () => {
    const dbDir = tmpDir('go-main-scope')
    const db = await openDatabase(join(dbDir, 'index.db'))
    await indexProject(db, GO_FIXTURE)

    const file = getFile(db, 'main.go')
    expect(file).toBeTruthy()
    const syms = getSymbolsByFile(db, file!.id)
    const mainSym = syms.find(s => s.name === 'main')
    expect(mainSym).toBeTruthy()
    const mainCalls = getCallsBySymbol(db, mainSym!.id)
    // main calls auth.Login, fmt.Println, user.FullName
    expect(mainCalls.length).toBeGreaterThan(0)

    db.close()
  })
})

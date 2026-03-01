import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { openDatabase, type DB } from '../src/store/db.js'
import { initParser } from '../src/indexer/parser.js'
import { indexProject } from '../src/indexer/indexer.js'
import { getStats, getFile, getSymbolsByFile, getImportsByFile, getExportsByFile } from '../src/store/queries.js'
import { findSymbol } from '../src/tools/find-symbol.js'
import { findReferences } from '../src/tools/find-references.js'
import { getSmartContext } from '../src/tools/get-smart-context.js'
import { getDependencyGraph } from '../src/tools/get-dependency-graph.js'
import { getCallGraph } from '../src/tools/get-call-graph.js'
import { getSymbolSource } from '../src/tools/get-symbol-source.js'
import { getProjectMap } from '../src/tools/get-project-map.js'
import { searchByPattern } from '../src/tools/search-by-pattern.js'
import { searchCode } from '../src/tools/search-code.js'
import { findUnusedExports } from '../src/tools/find-unused-exports.js'

const FIXTURE = join(import.meta.dir, 'fixtures', 'small-rust')
const DB_DIR = join(import.meta.dir, '.tmp-rust-test')
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

// ── Indexer ─────────────────────────────────────────────────

describe('rust indexer', () => {
  it('indexes all Rust fixture files', () => {
    const stats = getStats(db)
    // lib.rs, auth.rs, utils.rs, tests/integration_test.rs = 4 files
    expect(stats.files).toBe(4)
  })

  it('extracts symbols from auth.rs', () => {
    const file = getFile(db, 'src/auth.rs')
    expect(file).toBeTruthy()
    const syms = getSymbolsByFile(db, file!.id)
    const names = syms.map(s => s.name)
    expect(names).toContain('User')
    expect(names).toContain('Role')
    expect(names).toContain('AuthProvider')
    expect(names).toContain('login')
    expect(names).toContain('register')
    expect(names).toContain('fetch_user')
    expect(names).toContain('User.new')
    expect(names).toContain('User.verify')
  })

  it('correctly classifies struct as class', () => {
    const file = getFile(db, 'src/auth.rs')
    const syms = getSymbolsByFile(db, file!.id)
    const user = syms.find(s => s.name === 'User')
    expect(user?.kind).toBe('class')
  })

  it('correctly classifies enum', () => {
    const file = getFile(db, 'src/auth.rs')
    const syms = getSymbolsByFile(db, file!.id)
    const role = syms.find(s => s.name === 'Role')
    expect(role?.kind).toBe('enum')
  })

  it('correctly classifies trait as interface', () => {
    const file = getFile(db, 'src/auth.rs')
    const syms = getSymbolsByFile(db, file!.id)
    const provider = syms.find(s => s.name === 'AuthProvider')
    expect(provider?.kind).toBe('interface')
  })

  it('marks pub symbols as exported', () => {
    const file = getFile(db, 'src/utils.rs')
    const syms = getSymbolsByFile(db, file!.id)
    const hashPw = syms.find(s => s.name === 'hash_password')
    expect(hashPw?.is_exported).toBe(1)
    const internal = syms.find(s => s.name === 'internal_helper')
    expect(internal?.is_exported).toBe(0)
  })

  it('extracts const and static as variables', () => {
    const file = getFile(db, 'src/utils.rs')
    const syms = getSymbolsByFile(db, file!.id)
    const maxAttempts = syms.find(s => s.name === 'MAX_ATTEMPTS')
    expect(maxAttempts?.kind).toBe('variable')
    expect(maxAttempts?.is_exported).toBe(1)
    const appName = syms.find(s => s.name === 'APP_NAME')
    expect(appName?.kind).toBe('variable')
    expect(appName?.is_exported).toBe(1)
  })

  it('extracts impl methods with Type.method naming', () => {
    const file = getFile(db, 'src/auth.rs')
    const syms = getSymbolsByFile(db, file!.id)
    const newMethod = syms.find(s => s.name === 'User.new')
    expect(newMethod?.kind).toBe('function')
    expect(newMethod?.is_exported).toBe(1)
    const verify = syms.find(s => s.name === 'User.verify')
    expect(verify?.kind).toBe('function')
  })

  it('detects async functions', () => {
    const file = getFile(db, 'src/auth.rs')
    const syms = getSymbolsByFile(db, file!.id)
    const login = syms.find(s => s.name === 'login')
    expect(login?.signature).toContain('async')
  })

  it('extracts doc comments', () => {
    const file = getFile(db, 'src/auth.rs')
    const syms = getSymbolsByFile(db, file!.id)
    const login = syms.find(s => s.name === 'login')
    expect(login?.jsdoc).toContain('Login a user')
  })

  it('extracts imports', () => {
    const file = getFile(db, 'src/auth.rs')
    const imports = getImportsByFile(db, file!.id)
    const symbols = imports.map(i => i.symbol)
    expect(symbols).toContain('HashMap')
    expect(symbols).toContain('hash_password')
  })

  it('resolves crate:: imports as local', () => {
    const file = getFile(db, 'src/auth.rs')
    const imports = getImportsByFile(db, file!.id)
    const hashImport = imports.find(i => i.symbol === 'hash_password')
    expect(hashImport?.is_external).toBe(0)
  })

  it('resolves std:: imports as external', () => {
    const file = getFile(db, 'src/auth.rs')
    const imports = getImportsByFile(db, file!.id)
    const hashMap = imports.find(i => i.symbol === 'HashMap')
    expect(hashMap?.is_external).toBe(1)
  })

  it('extracts exports', () => {
    const file = getFile(db, 'src/auth.rs')
    const exports = getExportsByFile(db, file!.id)
    const names = exports.map(e => e.symbol)
    expect(names).toContain('User')
    expect(names).toContain('login')
    expect(names).toContain('Role')
    expect(names).toContain('AuthProvider')
  })

  it('extracts re-exports from lib.rs', () => {
    const file = getFile(db, 'src/lib.rs')
    const exports = getExportsByFile(db, file!.id)
    const reexports = exports.filter(e => e.is_reexport)
    const names = reexports.map(e => e.symbol)
    expect(names).toContain('login')
    expect(names).toContain('User')
  })

  it('has non-zero call edges', () => {
    const stats = getStats(db)
    expect(stats.calls).toBeGreaterThan(0)
  })
})

// ── Tools ───────────────────────────────────────────────────

describe('rust tools', () => {
  it('find_symbol returns Rust symbols', () => {
    const result = findSymbol(db, 'login')
    expect(result).toContain('login')
    expect(result).toContain('function')
  })

  it('find_symbol with kind filter', () => {
    const result = findSymbol(db, '*', 'class')
    expect(result).toContain('User')
  })

  it('find_references shows imports and calls', () => {
    const result = findReferences(db, 'hash_password')
    expect(result).toContain('definition')
    expect(result).toContain('import')
  })

  it('get_smart_context shows file details', () => {
    const result = getSmartContext(db, 'src/auth.rs')
    expect(result).toContain('auth.rs')
    expect(result).toContain('Exports')
    expect(result).toContain('Imports')
    expect(result).toContain('login')
  })

  it('get_dependency_graph finds dependencies', () => {
    const result = getDependencyGraph(db, 'src/auth.rs', 'dependencies', 2)
    expect(result).toContain('Dependencies')
    expect(result).toContain('utils.rs')
  })

  it('get_call_graph traces calls', () => {
    const result = getCallGraph(db, 'login')
    expect(result).toContain('Call graph')
    expect(result).toContain('hash_password')
  })

  it('get_symbol_source extracts function source', () => {
    const result = getSymbolSource(db, FIXTURE, 'hash_password')
    expect(result).toContain('hash_password')
    expect(result).toContain('Hash a password')
  })

  it('get_project_map includes Rust files', () => {
    const result = getProjectMap(db)
    expect(result).toContain('auth.rs')
    expect(result).toContain('utils.rs')
    expect(result).toContain('lib.rs')
  })

  it('search_code finds relevant files', () => {
    const result = searchCode(db, 'password hash login')
    expect(result).toContain('Search results')
  })

  it('search_by_pattern test_files finds Rust integration tests', () => {
    const result = searchByPattern(db, 'test_files')
    expect(result).toContain('integration_test.rs')
  })

  it('search_by_pattern http_calls finds reqwest calls', () => {
    const result = searchByPattern(db, 'http_calls')
    expect(result).toContain('reqwest')
  })

  it('search_by_pattern env_access finds env::var', () => {
    const result = searchByPattern(db, 'env_access')
    expect(result).toContain('env::var')
  })

  it('search_by_pattern async_functions finds async Rust functions', () => {
    const result = searchByPattern(db, 'async_functions')
    expect(result).toContain('login')
  })

  it('search_by_pattern todos finds TODO comments', () => {
    const result = searchByPattern(db, 'todos')
    expect(result).toContain('integration_test.rs')
  })

  it('find_unused_exports detects unused Rust exports', () => {
    const result = findUnusedExports(db)
    // Some exports like Role, AuthProvider are never imported
    expect(result).toContain('unused')
  })
})

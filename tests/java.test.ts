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
import { getProjectMap } from '../src/tools/get-project-map.js'
import { searchByPattern } from '../src/tools/search-by-pattern.js'

const FIXTURE = join(import.meta.dir, 'fixtures', 'small-java')
const DB_DIR = join(import.meta.dir, '.tmp-java-test')
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

describe('java indexer', () => {
  it('indexes all Java fixture files', () => {
    const stats = getStats(db)
    expect(stats.files).toBe(3)
  })

  it('extracts class declaration', () => {
    const file = getFile(db, 'src/auth/User.java') ?? getFile(db, 'src\\auth\\User.java')
    expect(file).toBeTruthy()
    const syms = getSymbolsByFile(db, file!.id)
    const user = syms.find(s => s.name === 'User')
    expect(user).toBeTruthy()
    expect(user!.kind).toBe('class')
    expect(user!.is_exported).toBe(1)
  })

  it('extracts interface declaration', () => {
    const file = getFile(db, 'src/auth/User.java') ?? getFile(db, 'src\\auth\\User.java')
    const syms = getSymbolsByFile(db, file!.id)
    const auth = syms.find(s => s.name === 'Authenticator')
    expect(auth).toBeTruthy()
    expect(auth!.kind).toBe('interface')
    expect(auth!.is_exported).toBe(1)
  })

  it('extracts enum declaration', () => {
    const file = getFile(db, 'src/auth/User.java') ?? getFile(db, 'src\\auth\\User.java')
    const syms = getSymbolsByFile(db, file!.id)
    const role = syms.find(s => s.name === 'Role')
    expect(role).toBeTruthy()
    expect(role!.kind).toBe('enum')
    expect(role!.is_exported).toBe(1)
  })

  it('extracts methods with ClassName.method naming', () => {
    const file = getFile(db, 'src/auth/User.java') ?? getFile(db, 'src\\auth\\User.java')
    const syms = getSymbolsByFile(db, file!.id)
    const names = syms.map(s => s.name)
    expect(names).toContain('User.getDisplayName')
    expect(names).toContain('User.getId')
    expect(names).toContain('User.User') // constructor
  })

  it('marks public methods as exported and private as not', () => {
    const file = getFile(db, 'src/auth/User.java') ?? getFile(db, 'src\\auth\\User.java')
    const syms = getSymbolsByFile(db, file!.id)
    const getDisplay = syms.find(s => s.name === 'User.getDisplayName')
    expect(getDisplay!.is_exported).toBe(1)
    const validate = syms.find(s => s.name === 'User.validate')
    expect(validate!.is_exported).toBe(0)
  })

  it('extracts static final fields as variables', () => {
    const file = getFile(db, 'src/auth/User.java') ?? getFile(db, 'src\\auth\\User.java')
    const syms = getSymbolsByFile(db, file!.id)
    const maxLen = syms.find(s => s.name === 'User.MAX_NAME_LENGTH')
    expect(maxLen).toBeTruthy()
    expect(maxLen!.kind).toBe('variable')
  })

  it('extracts Javadoc comments', () => {
    const file = getFile(db, 'src/auth/User.java') ?? getFile(db, 'src\\auth\\User.java')
    const syms = getSymbolsByFile(db, file!.id)
    const user = syms.find(s => s.name === 'User')
    expect(user!.jsdoc).toContain('Represents a user')
    const getDisplay = syms.find(s => s.name === 'User.getDisplayName')
    expect(getDisplay!.jsdoc).toContain('display name')
  })

  it('extracts imports', () => {
    const file = getFile(db, 'src/auth/User.java') ?? getFile(db, 'src\\auth\\User.java')
    const imports = getImportsByFile(db, file!.id)
    const symbols = imports.map(i => i.symbol)
    expect(symbols).toContain('List')
    expect(symbols).toContain('Optional')
  })

  it('resolves local Java imports', () => {
    const file = getFile(db, 'src/Main.java') ?? getFile(db, 'src\\Main.java')
    expect(file).toBeTruthy()
    const imports = getImportsByFile(db, file!.id)
    const userImport = imports.find(i => i.symbol === 'User')
    expect(userImport).toBeTruthy()
    expect(userImport!.is_external).toBe(0)
  })

  it('marks stdlib imports as external', () => {
    const file = getFile(db, 'src/Main.java') ?? getFile(db, 'src\\Main.java')
    const imports = getImportsByFile(db, file!.id)
    const optImport = imports.find(i => i.symbol === 'Optional')
    expect(optImport).toBeTruthy()
    expect(optImport!.is_external).toBe(1)
  })

  it('has non-zero call edges', () => {
    const stats = getStats(db)
    expect(stats.calls).toBeGreaterThan(0)
  })

  it('extracts exports for public symbols', () => {
    const file = getFile(db, 'src/auth/User.java') ?? getFile(db, 'src\\auth\\User.java')
    const exports = getExportsByFile(db, file!.id)
    const names = exports.map(e => e.symbol)
    expect(names).toContain('User')
    expect(names).toContain('Authenticator')
    expect(names).toContain('Role')
  })
})

describe('java tools', () => {
  it('find_symbol finds Java classes', () => {
    const result = findSymbol(db, 'User', 'class')
    expect(result).toContain('User')
    expect(result).toContain('class')
  })

  it('find_symbol finds Java methods', () => {
    const result = findSymbol(db, 'AuthService.*')
    expect(result).toContain('AuthService')
  })

  it('get_project_map includes Java files', () => {
    const result = getProjectMap(db, 3)
    expect(result).toContain('.java')
  })

  it('get_smart_context works for Java files', () => {
    const result = getSmartContext(db, 'src/auth/User.java')
    expect(result).toContain('User')
  })
})

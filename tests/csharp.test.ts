import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { openDatabase, type DB } from '../src/store/db.js'
import { initParser } from '../src/indexer/parser.js'
import { indexProject } from '../src/indexer/indexer.js'
import { getStats, getFile, getSymbolsByFile, getImportsByFile, getExportsByFile } from '../src/store/queries.js'
import { findSymbol } from '../src/tools/find-symbol.js'
import { getSmartContext } from '../src/tools/get-smart-context.js'
import { getProjectMap } from '../src/tools/get-project-map.js'

const FIXTURE = join(import.meta.dir, 'fixtures', 'small-csharp')
const DB_DIR = join(import.meta.dir, '.tmp-csharp-test')
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

describe('csharp indexer', () => {
  it('indexes all C# fixture files', () => {
    const stats = getStats(db)
    expect(stats.files).toBe(3)
  })

  it('extracts class declaration', () => {
    const file = getFile(db, 'Auth/User.cs') ?? getFile(db, 'Auth\\User.cs')
    expect(file).toBeTruthy()
    const syms = getSymbolsByFile(db, file!.id)
    const user = syms.find(s => s.name === 'User')
    expect(user).toBeTruthy()
    expect(user!.kind).toBe('class')
    expect(user!.is_exported).toBe(1)
  })

  it('extracts interface declaration', () => {
    const file = getFile(db, 'Auth/User.cs') ?? getFile(db, 'Auth\\User.cs')
    const syms = getSymbolsByFile(db, file!.id)
    const auth = syms.find(s => s.name === 'IAuthenticator')
    expect(auth).toBeTruthy()
    expect(auth!.kind).toBe('interface')
    expect(auth!.is_exported).toBe(1)
  })

  it('extracts enum declaration', () => {
    const file = getFile(db, 'Auth/User.cs') ?? getFile(db, 'Auth\\User.cs')
    const syms = getSymbolsByFile(db, file!.id)
    const role = syms.find(s => s.name === 'Role')
    expect(role).toBeTruthy()
    expect(role!.kind).toBe('enum')
  })

  it('extracts struct declaration', () => {
    const file = getFile(db, 'Auth/User.cs') ?? getFile(db, 'Auth\\User.cs')
    const syms = getSymbolsByFile(db, file!.id)
    const point = syms.find(s => s.name === 'Point')
    expect(point).toBeTruthy()
    expect(point!.kind).toBe('class') // structs mapped to class
    expect(point!.is_exported).toBe(1)
  })

  it('extracts delegate declaration', () => {
    const file = getFile(db, 'Auth/User.cs') ?? getFile(db, 'Auth\\User.cs')
    const syms = getSymbolsByFile(db, file!.id)
    const handler = syms.find(s => s.name === 'AuthHandler')
    expect(handler).toBeTruthy()
    expect(handler!.kind).toBe('type')
  })

  it('extracts methods with ClassName.Method naming', () => {
    const file = getFile(db, 'Auth/User.cs') ?? getFile(db, 'Auth\\User.cs')
    const syms = getSymbolsByFile(db, file!.id)
    const names = syms.map(s => s.name)
    expect(names).toContain('User.GetDisplayName')
    expect(names).toContain('User.User') // constructor
  })

  it('marks public methods as exported and private as not', () => {
    const file = getFile(db, 'Auth/User.cs') ?? getFile(db, 'Auth\\User.cs')
    const syms = getSymbolsByFile(db, file!.id)
    const getDisplay = syms.find(s => s.name === 'User.GetDisplayName')
    expect(getDisplay!.is_exported).toBe(1)
    const validate = syms.find(s => s.name === 'User.Validate')
    expect(validate!.is_exported).toBe(0)
  })

  it('extracts properties', () => {
    const file = getFile(db, 'Auth/User.cs') ?? getFile(db, 'Auth\\User.cs')
    const syms = getSymbolsByFile(db, file!.id)
    const idProp = syms.find(s => s.name === 'User.Id')
    expect(idProp).toBeTruthy()
    expect(idProp!.kind).toBe('variable')
    expect(idProp!.is_exported).toBe(1)
  })

  it('extracts struct fields', () => {
    const file = getFile(db, 'Auth/User.cs') ?? getFile(db, 'Auth\\User.cs')
    const syms = getSymbolsByFile(db, file!.id)
    const x = syms.find(s => s.name === 'Point.X')
    expect(x).toBeTruthy()
    expect(x!.kind).toBe('variable')
  })

  it('extracts XML doc comments', () => {
    const file = getFile(db, 'Auth/User.cs') ?? getFile(db, 'Auth\\User.cs')
    const syms = getSymbolsByFile(db, file!.id)
    const user = syms.find(s => s.name === 'User')
    expect(user!.jsdoc).toContain('Represents a user')
  })

  it('extracts using directives', () => {
    const file = getFile(db, 'Auth/User.cs') ?? getFile(db, 'Auth\\User.cs')
    const imports = getImportsByFile(db, file!.id)
    const symbols = imports.map(i => i.symbol)
    expect(symbols).toContain('System')
  })

  it('marks C# using directives as external', () => {
    const file = getFile(db, 'Auth/User.cs') ?? getFile(db, 'Auth\\User.cs')
    const imports = getImportsByFile(db, file!.id)
    for (const imp of imports) {
      expect(imp.is_external).toBe(1)
    }
  })

  it('has non-zero call edges', () => {
    const stats = getStats(db)
    expect(stats.calls).toBeGreaterThan(0)
  })

  it('extracts exports for public symbols', () => {
    const file = getFile(db, 'Auth/User.cs') ?? getFile(db, 'Auth\\User.cs')
    const exports = getExportsByFile(db, file!.id)
    const names = exports.map(e => e.symbol)
    expect(names).toContain('User')
    expect(names).toContain('IAuthenticator')
    expect(names).toContain('Role')
    expect(names).toContain('Point')
  })
})

describe('csharp tools', () => {
  it('find_symbol finds C# classes', () => {
    const result = findSymbol(db, 'User', 'class')
    expect(result).toContain('User')
  })

  it('find_symbol finds C# interfaces', () => {
    const result = findSymbol(db, 'IAuthenticator')
    expect(result).toContain('IAuthenticator')
    expect(result).toContain('interface')
  })

  it('get_project_map includes C# files', () => {
    const result = getProjectMap(db, 3)
    expect(result).toContain('.cs')
  })

  it('get_smart_context works for C# files', () => {
    const result = getSmartContext(db, 'Auth/User.cs')
    expect(result).toContain('User')
  })
})

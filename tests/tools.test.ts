import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { openDatabase, type DB } from '../src/store/db.js'
import { initParser } from '../src/indexer/parser.js'
import { indexProject } from '../src/indexer/indexer.js'
import { findSymbol } from '../src/tools/find-symbol.js'
import { findReferences } from '../src/tools/find-references.js'
import { getSmartContext } from '../src/tools/get-smart-context.js'
import { getDependencyGraph } from '../src/tools/get-dependency-graph.js'
import { getCallGraph } from '../src/tools/get-call-graph.js'
import { getSymbolSource } from '../src/tools/get-symbol-source.js'
import { getProjectMap } from '../src/tools/get-project-map.js'
import { findUnusedExports } from '../src/tools/find-unused-exports.js'
import { getFileSummary } from '../src/tools/get-file-summary.js'
import { searchCode } from '../src/tools/search-code.js'
import { findUnusedCode } from '../src/tools/find-unused-code.js'

const FIXTURE = join(import.meta.dir, 'fixtures', 'small-ts')
const DB_DIR = join(import.meta.dir, '.tmp-tools-test')
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

describe('find_symbol', () => {
  it('finds symbols by name', () => {
    const result = findSymbol(db, 'login')
    expect(result).toContain('login')
    expect(result).toContain('function')
  })

  it('supports wildcards', () => {
    const result = findSymbol(db, 'handle*')
    expect(result).toContain('handleLogin')
    expect(result).toContain('handleRegister')
  })

  it('filters by kind', () => {
    const result = findSymbol(db, '*', 'interface')
    expect(result).toContain('User')
    expect(result).toContain('Session')
    expect(result).not.toContain('function')
  })
})

describe('find_references', () => {
  it('finds import references', () => {
    const result = findReferences(db, 'hashPassword')
    expect(result).toContain('auth.ts')
  })

  it('finds call references', () => {
    const result = findReferences(db, 'login')
    expect(result).toContain('call')
  })
})

describe('get_smart_context', () => {
  it('returns file context', () => {
    // Try both path separators
    const path = process.platform === 'win32' ? 'src\\auth.ts' : 'src/auth.ts'
    const result = getSmartContext(db, path)
    expect(result).toContain('auth.ts')
    expect(result).toContain('Exports')
    expect(result).toContain('Imports')
  })
})

describe('get_dependency_graph', () => {
  it('finds dependents', () => {
    const path = process.platform === 'win32' ? 'src\\auth.ts' : 'src/auth.ts'
    const result = getDependencyGraph(db, path, 'dependents', 2)
    expect(result).toContain('app.ts')
  })

  it('finds dependencies', () => {
    const path = process.platform === 'win32' ? 'src\\app.ts' : 'src/app.ts'
    const result = getDependencyGraph(db, path, 'dependencies', 2)
    expect(result).toContain('auth.ts')
  })
})

describe('get_call_graph', () => {
  it('shows function calls', () => {
    const result = getCallGraph(db, 'login')
    expect(result).toContain('verifyPassword')
  })
})

describe('get_symbol_source', () => {
  it('extracts function source', () => {
    const result = getSymbolSource(db, FIXTURE, 'login')
    expect(result).toContain('async function login')
    expect(result).toContain('verifyPassword')
  })
})

describe('get_project_map', () => {
  it('lists all directories', () => {
    const result = getProjectMap(db, 3)
    expect(result).toContain('src/')
    expect(result).toContain('models/')
    expect(result).toContain('utils/')
  })
})

describe('find_unused_exports', () => {
  it('detects unused exports', () => {
    const result = findUnusedExports(db)
    expect(result).toContain('unusedHelper')
  })
})

describe('get_file_summary', () => {
  it('returns compact summary', () => {
    const path = process.platform === 'win32' ? 'src\\auth.ts' : 'src/auth.ts'
    const result = getFileSummary(db, path)
    expect(result).toContain('auth.ts')
    expect(result).toContain('Exports')
    expect(result.split('\n').length).toBeLessThan(10)
  })
})

describe('search_code', () => {
  it('finds relevant files by query', () => {
    const result = searchCode(db, 'password hash verify')
    expect(result).toContain('hash.ts')
  })
})

describe('find_unused_code', () => {
  it('detects unused internal functions', () => {
    const result = findUnusedCode(db)
    expect(result).toContain('deadInternalHelper')
  })

  it('detects unused internal variables', () => {
    const result = findUnusedCode(db)
    expect(result).toContain('UNUSED_CONST')
  })

  it('does NOT report internal functions that are called', () => {
    const result = findUnusedCode(db)
    // formatEmail is called by login(), so it should not appear
    expect(result).not.toContain('formatEmail')
  })

  it('does NOT report exported symbols', () => {
    const result = findUnusedCode(db)
    // These are exported — even if never imported, find_unused_code only targets internals
    expect(result).not.toContain('handleLogin')
    expect(result).not.toContain('handleRegister')
    expect(result).not.toContain('SECRET')
  })

  it('filters by kind', () => {
    const result = findUnusedCode(db, undefined, 'function')
    expect(result).toContain('deadInternalHelper')
    expect(result).not.toContain('UNUSED_CONST')
  })

  it('filters by scope', () => {
    const result = findUnusedCode(db, 'src/auth')
    expect(result).toContain('deadInternalHelper')
  })

  it('scope filter excludes other files', () => {
    const result = findUnusedCode(db, 'src/models')
    // deadInternalHelper is in auth.ts, not models/
    expect(result).not.toContain('deadInternalHelper')
  })

  it('returns friendly message when nothing found', () => {
    // Use a scope with no unused code
    const result = findUnusedCode(db, 'nonexistent/')
    expect(result).toContain('No unused code found')
  })

  it('groups results by file', () => {
    const result = findUnusedCode(db)
    // Both deadInternalHelper and UNUSED_CONST are in auth.ts
    expect(result).toContain('auth.ts')
    // Should show line numbers
    expect(result).toMatch(/L\d+-\d+/)
  })

  it('includes limitation note', () => {
    const result = findUnusedCode(db)
    expect(result).toContain('Note:')
  })
})

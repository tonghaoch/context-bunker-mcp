import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { openDatabase, type DB } from '../src/store/db.js'
import { initParser } from '../src/indexer/parser.js'
import { indexProject } from '../src/indexer/indexer.js'
import { findSymbol } from '../src/tools/find-symbol.js'
import { findReferences } from '../src/tools/find-references.js'
import { getSmartContext } from '../src/tools/get-smart-context.js'
import { getCallGraph } from '../src/tools/get-call-graph.js'
import { getProjectMap } from '../src/tools/get-project-map.js'
import { getFileSummary } from '../src/tools/get-file-summary.js'
import { searchCode } from '../src/tools/search-code.js'
import { getSymbolSource } from '../src/tools/get-symbol-source.js'
import { getDependencyGraph } from '../src/tools/get-dependency-graph.js'

const PY_FIXTURE = join(import.meta.dir, 'fixtures', 'small-py')
const GO_FIXTURE = join(import.meta.dir, 'fixtures', 'small-go')

const PY_DB_DIR = join(import.meta.dir, '.tmp-py-tools-test')
const GO_DB_DIR = join(import.meta.dir, '.tmp-go-tools-test')

const p = (...segs: string[]) => segs.join(process.platform === 'win32' ? '\\' : '/')

let pyDb: DB
let goDb: DB

beforeAll(async () => {
  rmSync(PY_DB_DIR, { recursive: true, force: true })
  rmSync(GO_DB_DIR, { recursive: true, force: true })

  const [pyDbConn, goDbConn] = await Promise.all([
    openDatabase(join(PY_DB_DIR, 'index.db')),
    openDatabase(join(GO_DB_DIR, 'index.db')),
  ])
  pyDb = pyDbConn
  goDb = goDbConn

  await initParser()
  await Promise.all([
    indexProject(pyDb, PY_FIXTURE),
    indexProject(goDb, GO_FIXTURE),
  ])
})

afterAll(() => {
  pyDb.close()
  goDb.close()
})

// ── Python tools ─────────────────────────────────────────────

describe('tools against Python fixture', () => {
  describe('find_symbol', () => {
    it('finds Python classes', () => {
      const result = findSymbol(pyDb, 'User')
      expect(result).toContain('User')
      expect(result).toContain('class')
    })

    it('filters by kind for Python', () => {
      const result = findSymbol(pyDb, '*', 'function')
      expect(result).toContain('login')
      expect(result).toContain('register')
      expect(result).not.toContain('class')
    })

    it('finds Python variables', () => {
      const result = findSymbol(pyDb, 'MAX_RETRIES')
      expect(result).toContain('MAX_RETRIES')
    })

    it('finds Python underscore-prefixed symbols exactly', () => {
      // _validate_email has underscores which are SQL LIKE wildcards
      // The ESCAPE fix should make this an exact match
      const result = findSymbol(pyDb, '_validate_email')
      expect(result).toContain('_validate_email')
    })
  })

  describe('find_references', () => {
    it('finds import references for Python symbols', () => {
      const result = findReferences(pyDb, 'hash_password')
      expect(result).toContain('auth.py')
    })

    it('respects file filter parameter on definitions', () => {
      // hash_password is defined in utils/hash.py
      // When filtering to a non-matching file, 0 definitions should appear
      const result = findReferences(pyDb, 'hash_password', 'nonexistent.py')
      expect(result).toContain('0 definition(s)')
      // But call references are still found (file filter only scopes definitions)
      expect(result).toContain('reference(s)')
    })
  })

  describe('get_smart_context', () => {
    it('returns Python file context', () => {
      const result = getSmartContext(pyDb, 'auth.py')
      expect(result).toContain('auth.py')
      expect(result).toContain('Exports')
      expect(result).toContain('Imports')
    })

    it('detects Python test file (test_ prefix)', () => {
      const result = getSmartContext(pyDb, 'auth.py')
      expect(result).toContain('test_auth.py')
    })
  })

  describe('get_project_map', () => {
    it('lists Python files and directories', () => {
      const result = getProjectMap(pyDb, 3)
      expect(result).toContain('auth.py')
      expect(result).toContain('utils/')
    })
  })

  describe('get_file_summary', () => {
    it('returns compact Python file summary', () => {
      const result = getFileSummary(pyDb, 'auth.py')
      expect(result).toContain('auth.py')
      expect(result).toContain('Exports')
    })
  })

  describe('get_symbol_source', () => {
    it('extracts Python function source', () => {
      const result = getSymbolSource(pyDb, PY_FIXTURE, 'login')
      expect(result).toContain('def login')
      expect(result).toContain('hash_password')
    })
  })

  describe('get_dependency_graph', () => {
    it('finds Python dependents', () => {
      const result = getDependencyGraph(pyDb, p('utils', 'hash.py'), 'dependents', 2)
      expect(result).toContain('auth.py')
    })
  })

  describe('search_code', () => {
    it('finds Python files by query', () => {
      const result = searchCode(pyDb, 'password hash verify')
      expect(result).toContain('hash.py')
    })
  })
})

// ── Go tools ─────────────────────────────────────────────────

describe('tools against Go fixture', () => {
  describe('find_symbol', () => {
    it('finds Go structs as class', () => {
      const result = findSymbol(goDb, 'User')
      expect(result).toContain('User')
      expect(result).toContain('class')
    })

    it('finds Go interfaces', () => {
      const result = findSymbol(goDb, 'Authenticator')
      expect(result).toContain('Authenticator')
      expect(result).toContain('interface')
    })

    it('filters Go symbols by kind', () => {
      const result = findSymbol(goDb, '*', 'function')
      expect(result).toContain('Login')
      expect(result).not.toContain('interface')
    })
  })

  describe('find_references', () => {
    it('finds Go call references', () => {
      const result = findReferences(goDb, 'Login')
      // main.go calls auth.Login
      expect(result).toContain('call')
    })
  })

  describe('get_smart_context', () => {
    it('returns Go file context', () => {
      const result = getSmartContext(goDb, p('auth', 'auth.go'))
      expect(result).toContain('auth.go')
      expect(result).toContain('Exports')
    })

    it('detects Go test file (_test.go)', () => {
      const result = getSmartContext(goDb, p('auth', 'auth.go'))
      expect(result).toContain('auth_test.go')
    })
  })

  describe('get_call_graph', () => {
    it('shows Go function calls', () => {
      const result = getCallGraph(goDb, 'Login')
      expect(result).toContain('Login')
    })
  })

  describe('get_project_map', () => {
    it('lists Go files and directories', () => {
      const result = getProjectMap(goDb, 3)
      expect(result).toContain('main.go')
      expect(result).toContain('auth/')
    })
  })

  describe('get_file_summary', () => {
    it('returns compact Go file summary', () => {
      const result = getFileSummary(goDb, p('auth', 'auth.go'))
      expect(result).toContain('auth.go')
      expect(result).toContain('Exports')
    })
  })

  describe('get_symbol_source', () => {
    it('extracts Go function source with godoc comment', () => {
      const result = getSymbolSource(goDb, GO_FIXTURE, 'Login')
      expect(result).toContain('func Login')
      // Go uses // for doc comments — the backward walk should include them
      expect(result).toContain('authenticates a user')
    })
  })

  describe('get_dependency_graph', () => {
    it('returns no deps message for Go files with package imports', () => {
      // Go imports resolve to package dir ('auth') not file ('auth/auth.go')
      // so dependency graph can't link them — this is a known limitation
      const result = getDependencyGraph(goDb, 'main.go', 'dependencies', 2)
      expect(result).toContain('No dependencies found')
    })
  })
})

import { describe, it, expect, beforeEach } from 'bun:test'
import { join, resolve } from 'node:path'
import { tokenize } from '../src/indexer/tfidf.js'
import { matchGlob, matchesAny } from '../src/indexer/indexer.js'
import { normalizePath } from '../src/utils/paths.js'
import { resolveImportPath, clearResolverCache } from '../src/indexer/resolver.js'

const TS_FIXTURE = join(import.meta.dir, 'fixtures', 'small-ts')
const PY_FIXTURE = join(import.meta.dir, 'fixtures', 'small-py')
const GO_FIXTURE = join(import.meta.dir, 'fixtures', 'small-go')

describe('tokenize', () => {
  it('splits camelCase', () => {
    expect(tokenize('handleLogin')).toEqual(['handle', 'login'])
  })

  it('splits PascalCase', () => {
    expect(tokenize('MyComponent')).toEqual(['my', 'component'])
  })

  it('splits snake_case', () => {
    expect(tokenize('hash_password')).toEqual(['hash', 'password'])
  })

  it('splits SCREAMING_CASE', () => {
    const result = tokenize('MAX_RETRIES')
    expect(result).toContain('max')
    expect(result).toContain('retries')
  })

  it('drops single-character tokens', () => {
    expect(tokenize('a b c')).toEqual([])
  })

  it('handles empty string', () => {
    expect(tokenize('')).toEqual([])
  })

  it('handles mixed conventions', () => {
    const result = tokenize('getUserById')
    expect(result).toContain('get')
    expect(result).toContain('user')
  })
})

describe('normalizePath', () => {
  it('normalizes path separators', () => {
    // On unix, backslashes should become forward slashes
    if (process.platform !== 'win32') {
      expect(normalizePath('src\\auth.ts')).toBe('src/auth.ts')
    }
  })

  it('preserves already-correct paths', () => {
    const expected = process.platform === 'win32' ? 'src\\auth.ts' : 'src/auth.ts'
    expect(normalizePath(expected)).toBe(expected)
  })
})

describe('matchGlob', () => {
  it('matches simple wildcard *', () => {
    expect(matchGlob('*.ts', 'foo.ts')).toBe(true)
    expect(matchGlob('*.ts', 'bar.ts')).toBe(true)
  })

  it('does not match path separators with *', () => {
    expect(matchGlob('*.ts', 'src/foo.ts')).toBe(false)
  })

  it('matches globstar **', () => {
    expect(matchGlob('**/*.ts', 'src/foo.ts')).toBe(true)
    expect(matchGlob('**/*.ts', 'src/deep/nested/foo.ts')).toBe(true)
  })

  it('matches question mark ?', () => {
    expect(matchGlob('?.ts', 'a.ts')).toBe(true)
    expect(matchGlob('?.ts', 'ab.ts')).toBe(false)
  })

  it('escapes dots correctly', () => {
    expect(matchGlob('*.d.ts', 'foo.d.ts')).toBe(true)
    expect(matchGlob('*.d.ts', 'fooXdXts')).toBe(false)
  })

  it('matches __tests__ pattern', () => {
    expect(matchGlob('**/__tests__/**', 'src/__tests__/auth.test.ts')).toBe(true)
  })

  it('matches test file patterns', () => {
    expect(matchGlob('**/*.test.ts', 'src/auth.test.ts')).toBe(true)
    expect(matchGlob('**/*.spec.tsx', 'components/Button.spec.tsx')).toBe(true)
    expect(matchGlob('**/test_*.py', 'tests/test_auth.py')).toBe(true)
    expect(matchGlob('**/*_test.go', 'auth/auth_test.go')).toBe(true)
    expect(matchGlob('**/*_test.py', 'utils/hash_test.py')).toBe(true)
  })

  it('does not match non-matching patterns', () => {
    expect(matchGlob('**/*.test.ts', 'src/auth.ts')).toBe(false)
    expect(matchGlob('**/test_*.py', 'auth.py')).toBe(false)
  })
})

describe('matchesAny', () => {
  it('returns true when any pattern matches', () => {
    expect(matchesAny(['*.ts', '*.js'], 'foo.ts')).toBe(true)
  })

  it('returns false when no pattern matches', () => {
    expect(matchesAny(['*.py'], 'foo.ts')).toBe(false)
  })

  it('matches multi-language exclude patterns', () => {
    const excludes = ['**/*.test.ts', '**/*.spec.ts', '**/test_*.py', '**/*_test.go']
    expect(matchesAny(excludes, 'src/auth.test.ts')).toBe(true)
    expect(matchesAny(excludes, 'tests/test_auth.py')).toBe(true)
    expect(matchesAny(excludes, 'auth/auth_test.go')).toBe(true)
    expect(matchesAny(excludes, 'src/auth.ts')).toBe(false)
  })
})

describe('resolveImportPath', () => {
  beforeEach(() => {
    clearResolverCache()
  })

  it('resolves relative TS import', () => {
    const importing = resolve(TS_FIXTURE, 'src/auth.ts')
    const result = resolveImportPath('./utils/hash.js', importing, TS_FIXTURE)
    expect(result.isExternal).toBe(false)
    expect(result.resolved).toContain('hash')
  })

  it('marks external TS package as external', () => {
    const importing = resolve(TS_FIXTURE, 'src/auth.ts')
    const result = resolveImportPath('react', importing, TS_FIXTURE)
    expect(result.isExternal).toBe(true)
    expect(result.resolved).toBe('react')
  })

  it('resolves Python relative import', () => {
    const importing = resolve(PY_FIXTURE, 'auth.py')
    const result = resolveImportPath('.utils.hash', importing, PY_FIXTURE, 'python')
    expect(result.isExternal).toBe(false)
    expect(result.resolved).toContain('hash')
  })

  it('marks Python stdlib as external', () => {
    const importing = resolve(PY_FIXTURE, 'app.py')
    const result = resolveImportPath('typing', importing, PY_FIXTURE, 'python')
    expect(result.isExternal).toBe(true)
  })

  it('resolves Go local import via go.mod to .go file', () => {
    const importing = resolve(GO_FIXTURE, 'main.go')
    const result = resolveImportPath('example.com/small-go/auth', importing, GO_FIXTURE, 'go')
    expect(result.isExternal).toBe(false)
    expect(result.resolved).toBe('auth/auth.go')
  })

  it('marks Go stdlib as external', () => {
    const importing = resolve(GO_FIXTURE, 'main.go')
    const result = resolveImportPath('fmt', importing, GO_FIXTURE, 'go')
    expect(result.isExternal).toBe(true)
  })

  it('resolves TS barrel import (index.ts)', () => {
    const importing = resolve(TS_FIXTURE, 'src/auth.ts')
    const result = resolveImportPath('./models/index.js', importing, TS_FIXTURE)
    expect(result.isExternal).toBe(false)
    expect(result.resolved).toContain('models')
  })
})

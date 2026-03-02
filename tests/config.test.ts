import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { openDatabase, type DB } from '../src/store/db.js'

/** Best-effort cleanup — ignores EBUSY from lingering SQLite locks on Windows */
function safeRmSync(path: string) {
  try { rmSync(path, { recursive: true, force: true }) } catch {}
}
import { initParser } from '../src/indexer/parser.js'
import { indexProject } from '../src/indexer/indexer.js'
import { getFile, getStats } from '../src/store/queries.js'
import { loadConfig, DEFAULT_CONFIG, getDbPath, encodeProjectPath } from '../src/config.js'

const TS_FIXTURE = join(import.meta.dir, 'fixtures', 'small-ts')

// ── loadConfig ───────────────────────────────────────────────

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    const config = loadConfig('/tmp/nonexistent-path-12345')
    expect(config.languages).toEqual(DEFAULT_CONFIG.languages)
    expect(config.maxFileSize).toBe(DEFAULT_CONFIG.maxFileSize)
  })

  it('reads config from .context-bunker.json', () => {
    const tmpDir = join(import.meta.dir, '.tmp-config-load-test')
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, '.context-bunker.json'), JSON.stringify({
      languages: ['python'],
      maxFileSize: 500,
    }))
    const config = loadConfig(tmpDir)
    expect(config.languages).toEqual(['python'])
    expect(config.maxFileSize).toBe(500)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('falls back to defaults on invalid JSON', () => {
    const tmpDir = join(import.meta.dir, '.tmp-config-invalid-test')
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, '.context-bunker.json'), 'not valid json {{{')
    const config = loadConfig(tmpDir)
    expect(config.languages).toEqual(DEFAULT_CONFIG.languages)
    rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ── Indexer filtering ────────────────────────────────────────

describe('indexer filtering', () => {
  let db: DB
  const DB_DIR = join(import.meta.dir, '.tmp-config-filter-test')

  afterAll(() => {
    if (db) db.close()
  })

  it('.d.ts files are excluded by IGNORED_SUFFIXES', async () => {
    rmSync(DB_DIR, { recursive: true, force: true })
    db = await openDatabase(join(DB_DIR, 'index.db'))
    await initParser()
    await indexProject(db, TS_FIXTURE)

    // types.d.ts should NOT be indexed
    const dtsFile = getFile(db, 'src/types.d.ts') ?? getFile(db, 'src\\types.d.ts')
    expect(dtsFile).toBeFalsy()
  })

  it('TSX files are indexed correctly', () => {
    const tsxFile = getFile(db, 'src/components/Button.tsx') ?? getFile(db, 'src\\components\\Button.tsx')
    expect(tsxFile).toBeTruthy()
  })

  it('maxFileSize excludes large files', async () => {
    const tmpFixture = join(import.meta.dir, '.tmp-maxsize-fixture')
    const tmpDbDir = join(import.meta.dir, '.tmp-maxsize-test')
    rmSync(tmpFixture, { recursive: true, force: true })
    rmSync(tmpDbDir, { recursive: true, force: true })
    mkdirSync(tmpFixture, { recursive: true })
    // Create a small file and a large file
    writeFileSync(join(tmpFixture, 'small.ts'), 'export const x = 1')
    writeFileSync(join(tmpFixture, 'large.ts'), 'export const y = ' + 'x'.repeat(500))

    const sizeDb = await openDatabase(join(tmpDbDir, 'index.db'))
    await indexProject(sizeDb, tmpFixture, undefined, {
      ...DEFAULT_CONFIG,
      include: [],
      exclude: [],
      maxFileSize: 100,
    })

    const small = getFile(sizeDb, 'small.ts')
    const large = getFile(sizeDb, 'large.ts')
    expect(small).toBeTruthy()
    expect(large).toBeFalsy()

    sizeDb.close()
    safeRmSync(tmpFixture)
    safeRmSync(join(import.meta.dir, '.tmp-maxsize-test'))
  })

  it('exclude patterns filter out matching files', async () => {
    const exclDb = await openDatabase(join(import.meta.dir, '.tmp-exclude-test', 'index.db'))
    await indexProject(exclDb, TS_FIXTURE, undefined, {
      ...DEFAULT_CONFIG,
      include: [],
      exclude: ['**/utils/**'],
    })

    // hash.ts is in utils/ — should be excluded
    const hash = getFile(exclDb, 'src/utils/hash.ts') ?? getFile(exclDb, 'src\\utils\\hash.ts')
    expect(hash).toBeFalsy()

    // auth.ts is NOT in utils/ — should be included
    const auth = getFile(exclDb, 'src/auth.ts') ?? getFile(exclDb, 'src\\auth.ts')
    expect(auth).toBeTruthy()

    exclDb.close()
    safeRmSync(join(import.meta.dir, '.tmp-exclude-test'))
  })

  it('language filter restricts indexed file types', async () => {
    const langDb = await openDatabase(join(import.meta.dir, '.tmp-lang-filter-test', 'index.db'))
    await indexProject(langDb, TS_FIXTURE, undefined, {
      ...DEFAULT_CONFIG,
      include: [],
      exclude: [],
      languages: ['typescript'],  // Exclude tsx
    })

    const stats = getStats(langDb)
    // Should have fewer files since TSX is excluded
    const tsxFile = getFile(langDb, 'src/components/Button.tsx') ?? getFile(langDb, 'src\\components\\Button.tsx')
    expect(tsxFile).toBeFalsy()

    langDb.close()
    safeRmSync(join(import.meta.dir, '.tmp-lang-filter-test'))
  })
})

// ── encodeProjectPath ───────────────────────────────────────

describe('encodeProjectPath', () => {
  it('encodes Unix absolute path', () => {
    expect(encodeProjectPath('/Users/toc/Desktop/project')).toBe('Users-toc-Desktop-project')
  })

  it('strips leading dash after replacing separator', () => {
    expect(encodeProjectPath('/foo/bar')).toBe('foo-bar')
    expect(encodeProjectPath('/foo/bar')[0]).not.toBe('-')
  })

  it('encodes Windows path with backslashes and drive letter', () => {
    expect(encodeProjectPath('C:\\Users\\toc\\project')).toBe('C-Users-toc-project')
  })

  it('handles path with mixed separators', () => {
    const result = encodeProjectPath('/home/user\\mixed/path')
    expect(result).toBe('home-user-mixed-path')
  })

  it('handles single segment path', () => {
    expect(encodeProjectPath('/project')).toBe('project')
  })
})

// ── getDbPath ───────────────────────────────────────────────

describe('getDbPath', () => {
  it('returns local path when storage is "local"', () => {
    const result = getDbPath('/my/project', 'local')
    expect(result).toBe(join('/my/project', '.context-bunker', 'index.db'))
  })

  it('returns global cache path when storage is "global"', () => {
    const result = getDbPath('/my/project', 'global')
    // Should NOT be inside the project directory
    expect(result).not.toContain('/my/project/.context-bunker')
    // Should end with index.db
    expect(result).toEndWith('index.db')
    // Should contain the encoded project path
    expect(result).toContain('context-bunker')
    expect(result).toContain('my-project')
  })

  it('defaults to global when storage is not specified', () => {
    const result = getDbPath('/my/project')
    expect(result).not.toContain('/my/project/.context-bunker')
    expect(result).toEndWith('index.db')
  })

  it('global path is platform-specific cache directory', () => {
    const result = getDbPath('/test/path', 'global')
    if (process.platform === 'darwin') {
      expect(result).toContain('Library/Caches')
    } else if (process.platform === 'win32') {
      expect(result).toContain('AppData')
    } else {
      // Linux — either XDG_CACHE_HOME or ~/.cache
      expect(result).toContain('.cache')
    }
  })

  it('different projects get different global paths', () => {
    const path1 = getDbPath('/project/one', 'global')
    const path2 = getDbPath('/project/two', 'global')
    expect(path1).not.toBe(path2)
  })
})

// ── loadConfig storage option ───────────────────────────────

describe('loadConfig storage option', () => {
  it('defaults storage to "global"', () => {
    const config = loadConfig('/tmp/nonexistent-path-99999')
    expect(config.storage).toBe('global')
  })

  it('reads storage: "local" from config file', () => {
    const tmpDir = join(import.meta.dir, '.tmp-config-storage-test')
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, '.context-bunker.json'), JSON.stringify({
      storage: 'local',
    }))
    const config = loadConfig(tmpDir)
    expect(config.storage).toBe('local')
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('falls back to "global" for invalid storage value', () => {
    const tmpDir = join(import.meta.dir, '.tmp-config-storage-invalid')
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, '.context-bunker.json'), JSON.stringify({
      storage: 'cloud',
    }))
    const config = loadConfig(tmpDir)
    expect(config.storage).toBe('global')
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('DEFAULT_CONFIG has storage: "global"', () => {
    expect(DEFAULT_CONFIG.storage).toBe('global')
  })
})

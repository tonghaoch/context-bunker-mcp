import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { openDatabase, type DB } from '../src/store/db.js'
import { initParser } from '../src/indexer/parser.js'
import { indexProject } from '../src/indexer/indexer.js'
import { getFile, getStats } from '../src/store/queries.js'
import { loadConfig, DEFAULT_CONFIG } from '../src/config.js'

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
    rmSync(tmpFixture, { recursive: true, force: true })
    mkdirSync(tmpFixture, { recursive: true })
    // Create a small file and a large file
    writeFileSync(join(tmpFixture, 'small.ts'), 'export const x = 1')
    writeFileSync(join(tmpFixture, 'large.ts'), 'export const y = ' + 'x'.repeat(500))

    const sizeDb = await openDatabase(join(import.meta.dir, '.tmp-maxsize-test', 'index.db'))
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
    rmSync(tmpFixture, { recursive: true, force: true })
    rmSync(join(import.meta.dir, '.tmp-maxsize-test'), { recursive: true, force: true })
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
    rmSync(join(import.meta.dir, '.tmp-exclude-test'), { recursive: true, force: true })
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
    rmSync(join(import.meta.dir, '.tmp-lang-filter-test'), { recursive: true, force: true })
  })
})

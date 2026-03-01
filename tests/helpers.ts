import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { openDatabase, type DB } from '../src/store/db.js'
import { initParser } from '../src/indexer/parser.js'
import { indexProject } from '../src/indexer/indexer.js'
import type { Config } from '../src/config.js'

/** Set up a test database by indexing a fixture directory */
export async function setupTestDb(
  fixtureDir: string,
  tmpDirName: string,
  config?: Config
): Promise<{ db: DB; fixture: string; dbDir: string }> {
  const dbDir = join(import.meta.dir, tmpDirName)
  const dbPath = join(dbDir, 'index.db')
  rmSync(dbDir, { recursive: true, force: true })
  const db = await openDatabase(dbPath)
  await initParser()
  await indexProject(db, fixtureDir, undefined, config)
  return { db, fixture: fixtureDir, dbDir }
}

/** Cross-platform path builder for DB-stored paths */
export function p(...segments: string[]): string {
  return segments.join(process.platform === 'win32' ? '\\' : '/')
}

/** Fixture path builder */
export function fixture(name: string): string {
  return join(import.meta.dir, 'fixtures', name)
}

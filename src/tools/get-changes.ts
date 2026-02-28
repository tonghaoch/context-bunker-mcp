import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { DB } from '../store/db.js'
import { getLastSession, getAllFiles, getSymbolsByFile, getFile } from '../store/queries.js'

function hashFile(fullPath: string): string | null {
  try {
    const content = readFileSync(fullPath, 'utf-8')
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  } catch { return null }
}

export function getChangesSinceLastSession(db: DB, projectRoot: string) {
  const session = getLastSession(db)
  if (!session?.file_snapshot) {
    return 'No previous session found. This is the first run — all files are new.'
  }

  let snapshot: Record<string, string>
  try { snapshot = JSON.parse(session.file_snapshot) } catch { return 'Corrupted session snapshot.' }

  const currentFiles = getAllFiles(db)
  const currentMap = new Map(currentFiles.map(f => [f.path, f.hash]))

  const added: { file: string; symbols: string[] }[] = []
  const modified: { file: string; symbolsAdded: string[]; symbolsRemoved: string[] }[] = []
  const deleted: string[] = []

  // Files in current index but not in snapshot → added
  for (const f of currentFiles) {
    if (!(f.path in snapshot)) {
      const syms = getSymbolsByFile(db, f.id)
      added.push({ file: f.path, symbols: syms.filter(s => s.is_exported).map(s => s.name) })
    }
  }

  // Files in both but hash changed → modified
  for (const [path, oldHash] of Object.entries(snapshot)) {
    const currentHash = currentMap.get(path)
    if (currentHash && currentHash !== oldHash) {
      // Compare symbols — we only have current symbols in DB
      // For a simple diff, just report the file as modified with current exports
      const fileRow = getFile(db, path)
      if (fileRow) {
        const syms = getSymbolsByFile(db, fileRow.id).filter(s => s.is_exported).map(s => s.name)
        modified.push({ file: path, symbolsAdded: syms, symbolsRemoved: [] })
      }
    }
  }

  // Files in snapshot but not in current → deleted
  for (const path of Object.keys(snapshot)) {
    if (!currentMap.has(path)) deleted.push(path)
  }

  const sessionTime = session.ended_at ? new Date(session.ended_at).toISOString() : 'unknown'
  const totalChanges = added.length + modified.length + deleted.length

  if (totalChanges === 0) return `No changes since last session (${sessionTime}).`

  const lines: string[] = [
    `Changes since last session (${sessionTime}):`,
    `  ${added.length} added, ${modified.length} modified, ${deleted.length} deleted`,
    '',
  ]

  if (added.length > 0) {
    lines.push('Added:')
    for (const a of added) {
      const syms = a.symbols.length > 0 ? ` [${a.symbols.join(', ')}]` : ''
      lines.push(`  + ${a.file}${syms}`)
    }
    lines.push('')
  }

  if (modified.length > 0) {
    lines.push('Modified:')
    for (const m of modified) {
      const syms = m.symbolsAdded.length > 0 ? ` [exports: ${m.symbolsAdded.join(', ')}]` : ''
      lines.push(`  ~ ${m.file}${syms}`)
    }
    lines.push('')
  }

  if (deleted.length > 0) {
    lines.push('Deleted:')
    for (const d of deleted) lines.push(`  - ${d}`)
  }

  return lines.join('\n')
}

// Build a snapshot of current file hashes for saving at session end
export function buildFileSnapshot(db: DB): Record<string, string> {
  const files = getAllFiles(db)
  const snapshot: Record<string, string> = {}
  for (const f of files) snapshot[f.path] = f.hash
  return snapshot
}

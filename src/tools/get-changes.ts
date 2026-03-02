import type { DB } from '../store/db.js'
import { getLastSession } from '../store/queries.js'

type SnapshotEntry = string | { hash: string; symbols: string[] }

/** Batch query: get all files with their exported symbol names */
function getFilesWithSymbols(db: DB) {
  const rows = db.prepare(`
    SELECT f.id, f.path, f.hash, s.name as sym_name
    FROM files f
    LEFT JOIN symbols s ON s.file_id = f.id AND s.is_exported = 1
    ORDER BY f.path
  `).all() as { id: number; path: string; hash: string; sym_name: string | null }[]

  const files = new Map<string, { hash: string; symbols: string[] }>()
  for (const row of rows) {
    if (!files.has(row.path)) files.set(row.path, { hash: row.hash, symbols: [] })
    if (row.sym_name) files.get(row.path)!.symbols.push(row.sym_name)
  }
  return files
}

export function getChangesSinceLastSession(db: DB, _projectRoot: string) {
  const session = getLastSession(db)
  if (!session?.file_snapshot) {
    return 'No previous session found. This is the first run — all files are new.'
  }

  let rawSnapshot: Record<string, SnapshotEntry>
  try { rawSnapshot = JSON.parse(session.file_snapshot) } catch { return 'Corrupted session snapshot.' }

  const getHash = (entry: SnapshotEntry) => typeof entry === 'string' ? entry : entry.hash
  const getSymbols = (entry: SnapshotEntry) => typeof entry === 'string' ? null : entry.symbols

  const currentFiles = getFilesWithSymbols(db)

  const added: { file: string; symbols: string[] }[] = []
  const modified: { file: string; symbolsAdded: string[]; symbolsRemoved: string[] }[] = []
  const deleted: string[] = []

  // Files in current index but not in snapshot → added
  for (const [path, data] of currentFiles) {
    if (!(path in rawSnapshot)) {
      added.push({ file: path, symbols: data.symbols })
    }
  }

  // Files in both but hash changed → modified
  for (const [path, entry] of Object.entries(rawSnapshot)) {
    const current = currentFiles.get(path)
    if (current && current.hash !== getHash(entry)) {
      const oldSyms = getSymbols(entry)
      const symbolsAdded = oldSyms ? current.symbols.filter(s => !oldSyms.includes(s)) : current.symbols
      const symbolsRemoved = oldSyms ? oldSyms.filter(s => !current.symbols.includes(s)) : []
      modified.push({ file: path, symbolsAdded, symbolsRemoved })
    }
  }

  // Files in snapshot but not in current → deleted
  for (const path of Object.keys(rawSnapshot)) {
    if (!currentFiles.has(path)) deleted.push(path)
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
      const parts: string[] = []
      if (m.symbolsAdded.length > 0) parts.push(`+${m.symbolsAdded.join(', ')}`)
      if (m.symbolsRemoved.length > 0) parts.push(`-${m.symbolsRemoved.join(', ')}`)
      const detail = parts.length > 0 ? ` [${parts.join('; ')}]` : ''
      lines.push(`  ~ ${m.file}${detail}`)
    }
    lines.push('')
  }

  if (deleted.length > 0) {
    lines.push('Deleted:')
    for (const d of deleted) lines.push(`  - ${d}`)
  }

  return lines.join('\n')
}

// Build a snapshot of current file hashes + symbols for saving at session end
export function buildFileSnapshot(db: DB): Record<string, { hash: string; symbols: string[] }> {
  const files = getFilesWithSymbols(db)
  const snapshot: Record<string, { hash: string; symbols: string[] }> = {}
  for (const [path, data] of files) {
    snapshot[path] = data
  }
  return snapshot
}

import type { DB } from '../store/db.js'
import { getLastSession, getAllFiles, getSymbolsByFile, getFile } from '../store/queries.js'

type SnapshotEntry = string | { hash: string; symbols: string[] }

export function getChangesSinceLastSession(db: DB, _projectRoot: string) {
  const session = getLastSession(db)
  if (!session?.file_snapshot) {
    return 'No previous session found. This is the first run — all files are new.'
  }

  let rawSnapshot: Record<string, SnapshotEntry>
  try { rawSnapshot = JSON.parse(session.file_snapshot) } catch { return 'Corrupted session snapshot.' }

  // Normalize: support both old format (string hash) and new format ({ hash, symbols })
  const getHash = (entry: SnapshotEntry) => typeof entry === 'string' ? entry : entry.hash
  const getSymbols = (entry: SnapshotEntry) => typeof entry === 'string' ? null : entry.symbols

  const currentFiles = getAllFiles(db)
  const currentMap = new Map(currentFiles.map(f => [f.path, f.hash]))

  const added: { file: string; symbols: string[] }[] = []
  const modified: { file: string; symbolsAdded: string[]; symbolsRemoved: string[] }[] = []
  const deleted: string[] = []

  // Files in current index but not in snapshot → added
  for (const f of currentFiles) {
    if (!(f.path in rawSnapshot)) {
      const syms = getSymbolsByFile(db, f.id)
      added.push({ file: f.path, symbols: syms.filter(s => s.is_exported).map(s => s.name) })
    }
  }

  // Files in both but hash changed → modified
  for (const [path, entry] of Object.entries(rawSnapshot)) {
    const currentHash = currentMap.get(path)
    if (currentHash && currentHash !== getHash(entry)) {
      const fileRow = getFile(db, path)
      if (fileRow) {
        const currentSyms = getSymbolsByFile(db, fileRow.id).filter(s => s.is_exported).map(s => s.name)
        const oldSyms = getSymbols(entry)
        const symbolsAdded = oldSyms ? currentSyms.filter(s => !oldSyms.includes(s)) : currentSyms
        const symbolsRemoved = oldSyms ? oldSyms.filter(s => !currentSyms.includes(s)) : []
        modified.push({ file: path, symbolsAdded, symbolsRemoved })
      }
    }
  }

  // Files in snapshot but not in current → deleted
  for (const path of Object.keys(rawSnapshot)) {
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
  const files = getAllFiles(db)
  const snapshot: Record<string, { hash: string; symbols: string[] }> = {}
  for (const f of files) {
    const syms = getSymbolsByFile(db, f.id).filter(s => s.is_exported).map(s => s.name)
    snapshot[f.path] = { hash: f.hash, symbols: syms }
  }
  return snapshot
}

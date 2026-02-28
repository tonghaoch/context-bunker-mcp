import type { DB } from '../store/db.js'
import { getFile, getImportsByFile, getImportersOf, getAllFiles } from '../store/queries.js'
import { normalizePath } from '../utils/paths.js'

interface GraphNode {
  file: string
  depth: number
  imports: string[]
  via?: string
}

export function getDependencyGraph(
  db: DB,
  filePath: string,
  direction: 'dependencies' | 'dependents' = 'dependents',
  maxDepth: number = 3,
) {
  filePath = normalizePath(filePath)
  const root = getFile(db, filePath)
  if (!root) return `File not found in index: ${filePath}`

  const visited = new Set<string>()
  const result: GraphNode[] = []

  // BFS
  const queue: { file: string; depth: number; via?: string }[] = [{ file: filePath, depth: 0 }]
  visited.add(filePath)

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.depth > maxDepth) continue

    const fileRow = getFile(db, current.file)
    if (!fileRow) continue

    if (direction === 'dependencies') {
      // What does this file import?
      const imports = getImportsByFile(db, fileRow.id)
      const internalImports = imports.filter(i => !i.is_external)
      const importPaths = [...new Set(internalImports.map(i => i.from_path))]

      if (current.depth > 0) {
        result.push({
          file: current.file,
          depth: current.depth,
          imports: internalImports.map(i => i.symbol),
          via: current.via,
        })
      }

      for (const dep of importPaths) {
        if (!visited.has(dep) && current.depth < maxDepth) {
          visited.add(dep)
          queue.push({ file: dep, depth: current.depth + 1, via: current.file })
        }
      }
    } else {
      // What files import this file?
      const importers = getImportersOf(db, current.file)
      // Group by file
      const byFile = new Map<string, string[]>()
      for (const imp of importers) {
        const existing = byFile.get(imp.file_path) ?? []
        existing.push(imp.symbol)
        byFile.set(imp.file_path, existing)
      }

      if (current.depth > 0) {
        result.push({
          file: current.file,
          depth: current.depth,
          imports: [],
          via: current.via,
        })
      }

      for (const [depFile, syms] of byFile) {
        if (!visited.has(depFile) && current.depth < maxDepth) {
          visited.add(depFile)
          queue.push({ file: depFile, depth: current.depth + 1, via: current.file })
        }
      }
    }
  }

  if (result.length === 0) {
    return `No ${direction} found for ${filePath} (depth ${maxDepth})`
  }

  // Format
  const lines = [
    `${direction === 'dependents' ? 'Dependents' : 'Dependencies'} of ${filePath} (depth ${maxDepth}):`,
    '',
  ]
  for (const node of result) {
    const indent = '  '.repeat(node.depth)
    const via = node.via ? ` (via ${node.via})` : ''
    lines.push(`${indent}${node.file}${via}`)
  }
  lines.push('')
  lines.push(`Total: ${result.length} files affected`)

  return lines.join('\n')
}

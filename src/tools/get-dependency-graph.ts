import type { DB } from '../store/db.js'
import { getFile } from '../store/queries.js'
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

  // Preload all edges in 1 query instead of N+1 per BFS node
  const allImports = db.prepare(
    `SELECT i.symbol, i.from_path, i.is_external, f.path as file_path
     FROM imports i JOIN files f ON i.file_id = f.id
     WHERE i.is_external = 0`
  ).all() as { symbol: string; from_path: string; is_external: number; file_path: string }[]

  // Build lookup maps for both directions
  // dependencies: file_path -> [{from_path, symbol}]  (what does this file import?)
  // dependents:   from_path -> [{file_path, symbol}]  (who imports this path?)
  const depsByFile = new Map<string, { from_path: string; symbol: string }[]>()
  const importersByPath = new Map<string, { file_path: string; symbol: string }[]>()

  for (const imp of allImports) {
    let deps = depsByFile.get(imp.file_path)
    if (!deps) { deps = []; depsByFile.set(imp.file_path, deps) }
    deps.push({ from_path: imp.from_path, symbol: imp.symbol })

    let importers = importersByPath.get(imp.from_path)
    if (!importers) { importers = []; importersByPath.set(imp.from_path, importers) }
    importers.push({ file_path: imp.file_path, symbol: imp.symbol })
  }

  const visited = new Set<string>()
  const result: GraphNode[] = []

  // BFS with index pointer instead of queue.shift()
  const queue: { file: string; depth: number; via?: string }[] = [{ file: filePath, depth: 0 }]
  visited.add(filePath)
  let qi = 0

  while (qi < queue.length) {
    const current = queue[qi++]
    if (current.depth > maxDepth) continue

    if (direction === 'dependencies') {
      const imports = depsByFile.get(current.file) ?? []
      const importPaths = [...new Set(imports.map(i => i.from_path))]

      if (current.depth > 0) {
        result.push({
          file: current.file,
          depth: current.depth,
          imports: imports.map(i => i.symbol),
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
      const importers = importersByPath.get(current.file) ?? []
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

      for (const [depFile] of byFile) {
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

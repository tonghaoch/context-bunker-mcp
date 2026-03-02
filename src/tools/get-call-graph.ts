import type { DB } from '../store/db.js'
import { findSymbolsByName, getCallsBySymbol } from '../store/queries.js'

interface CallNode {
  name: string
  file: string
  line: number
  children: CallNode[]
}

export function getCallGraph(db: DB, functionName: string, file?: string, maxDepth: number = 2) {
  const syms = findSymbolsByName(db, functionName)
  const matches = file ? syms.filter(s => s.file_path === file) : syms
  const funcSyms = matches.filter(s => s.kind === 'function' || s.kind === 'variable')

  if (funcSyms.length === 0) {
    return `No function found matching "${functionName}"${file ? ` in ${file}` : ''}`
  }

  const sym = funcSyms[0]
  const visited = new Set<string>()

  // Batch resolve: given a list of callee names, resolve them all in one query
  function batchResolveCallees(names: string[]): Map<string, { id: number; name: string; file_path: string; kind: string }> {
    const result = new Map<string, { id: number; name: string; file_path: string; kind: string }>()
    if (names.length === 0) return result
    const unique = [...new Set(names)]
    const placeholders = unique.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT s.id, s.name, s.kind, f.path as file_path
       FROM symbols s JOIN files f ON s.file_id = f.id
       WHERE s.name IN (${placeholders}) AND (s.kind = 'function' OR s.kind = 'variable')
       ORDER BY s.name`
    ).all(...unique) as { id: number; name: string; kind: string; file_path: string }[]
    for (const row of rows) {
      if (!result.has(row.name)) result.set(row.name, row)
    }
    return result
  }

  function buildTree(symbolId: number, name: string, filePath: string, depth: number): CallNode {
    const node: CallNode = { name, file: filePath, line: 0, children: [] }
    if (depth >= maxDepth) return node

    const key = `${symbolId}`
    if (visited.has(key)) return node
    visited.add(key)

    const calls = getCallsBySymbol(db, symbolId)
    if (calls.length === 0) return node

    // Batch resolve all callee names at once
    const calleeMap = batchResolveCallees(calls.map(c => c.callee_name))

    for (const call of calls) {
      const calleeSym = calleeMap.get(call.callee_name)
      const calleeFile = calleeSym ? calleeSym.file_path : '(unresolved)'
      const child: CallNode = { name: call.callee_name, file: calleeFile, line: call.line, children: [] }

      if (calleeSym && depth + 1 < maxDepth) {
        const subtree = buildTree(calleeSym.id, calleeSym.name, calleeSym.file_path, depth + 1)
        child.children = subtree.children
      }

      node.children.push(child)
    }

    return node
  }

  const tree = buildTree(sym.id, sym.name, sym.file_path, 0)

  function formatTree(node: CallNode, prefix = '', isLast = true, isRoot = true): string[] {
    const lines: string[] = []
    const connector = isRoot ? '' : (isLast ? '└── ' : '├── ')
    const childPrefix = isRoot ? '' : (isLast ? '    ' : '│   ')
    const loc = node.file !== '(unresolved)' ? `  → ${node.file}${node.line ? ':' + node.line : ''}` : ''
    lines.push(`${prefix}${connector}${node.name}()${loc}`)

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]
      const last = i === node.children.length - 1
      lines.push(...formatTree(child, prefix + childPrefix, last, false))
    }
    return lines
  }

  const output = formatTree(tree)
  return `Call graph for ${functionName} (depth ${maxDepth}):\n\n${output.join('\n')}`
}

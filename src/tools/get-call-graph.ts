import type { DB } from '../store/db.js'
import { findSymbolsByName, getCallsBySymbol } from '../store/queries.js'

interface CallNode {
  name: string
  file: string
  line: number
  children: CallNode[]
}

export function getCallGraph(db: DB, functionName: string, file?: string, maxDepth: number = 2) {
  // Find the function symbol
  const syms = findSymbolsByName(db, functionName)
  const matches = file ? syms.filter(s => s.file_path === file) : syms
  const funcSyms = matches.filter(s => s.kind === 'function' || s.kind === 'variable')

  if (funcSyms.length === 0) {
    return `No function found matching "${functionName}"${file ? ` in ${file}` : ''}`
  }

  const sym = funcSyms[0]
  const visited = new Set<string>()

  function buildTree(symbolId: number, name: string, filePath: string, depth: number): CallNode {
    const node: CallNode = { name, file: filePath, line: 0, children: [] }
    if (depth >= maxDepth) return node

    const key = `${symbolId}`
    if (visited.has(key)) return node
    visited.add(key)

    const calls = getCallsBySymbol(db, symbolId)
    for (const call of calls) {
      // Try to resolve callee to a symbol
      const calleeSym = findSymbolsByName(db, call.callee_name)
        .filter(s => s.kind === 'function' || s.kind === 'variable')[0]

      const calleeFile = calleeSym ? calleeSym.file_path : '(unresolved)'
      const child: CallNode = {
        name: call.callee_name,
        file: calleeFile,
        line: call.line,
        children: [],
      }

      if (calleeSym && depth + 1 < maxDepth) {
        const subtree = buildTree(calleeSym.id, calleeSym.name, calleeSym.file_path, depth + 1)
        child.children = subtree.children
      }

      node.children.push(child)
    }

    return node
  }

  const tree = buildTree(sym.id, sym.name, sym.file_path, 0)

  // Format as text tree
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

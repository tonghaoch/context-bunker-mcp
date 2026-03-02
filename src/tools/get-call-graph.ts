import type { DB } from '../store/db.js'
import { findSymbolsByName } from '../store/queries.js'

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

  // Preload all calls and symbols in 2 queries instead of 2 per BFS node
  const allCalls = db.prepare(
    'SELECT caller_symbol_id, callee_name, line FROM calls'
  ).all() as { caller_symbol_id: number; callee_name: string; line: number }[]

  const allFuncSymbols = db.prepare(
    `SELECT s.id, s.name, s.kind, f.path as file_path
     FROM symbols s JOIN files f ON s.file_id = f.id
     WHERE s.kind = 'function' OR s.kind = 'variable'`
  ).all() as { id: number; name: string; kind: string; file_path: string }[]

  // Build lookup maps
  const callsByCaller = new Map<number, { callee_name: string; line: number }[]>()
  for (const c of allCalls) {
    let list = callsByCaller.get(c.caller_symbol_id)
    if (!list) { list = []; callsByCaller.set(c.caller_symbol_id, list) }
    list.push({ callee_name: c.callee_name, line: c.line })
  }

  // name -> first matching symbol (same as original behavior)
  const symbolByName = new Map<string, { id: number; name: string; file_path: string }>()
  for (const s of allFuncSymbols) {
    if (!symbolByName.has(s.name)) symbolByName.set(s.name, s)
  }

  const visited = new Set<number>()

  function buildTree(symbolId: number, name: string, filePath: string, depth: number): CallNode {
    const node: CallNode = { name, file: filePath, line: 0, children: [] }
    if (depth >= maxDepth) return node

    if (visited.has(symbolId)) return node
    visited.add(symbolId)

    const calls = callsByCaller.get(symbolId) ?? []
    if (calls.length === 0) return node

    for (const call of calls) {
      const calleeSym = symbolByName.get(call.callee_name)
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

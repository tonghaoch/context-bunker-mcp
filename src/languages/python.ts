import type { SyntaxNode } from '../indexer/parser.js'
import type { ExtractionResult, ExtractedSymbol, ExtractedImport, ExtractedExport, ExtractedCall } from './typescript.js'
import { extractRefsGeneric } from '../indexer/extractor.js'

// ── Helpers ──

function getTextOf(node: SyntaxNode | null): string {
  return node?.text ?? ''
}

function findChild(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)!
    if (c.type === type) return c
  }
  return null
}

function findChildren(node: SyntaxNode, type: string): SyntaxNode[] {
  const result: SyntaxNode[] = []
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)!
    if (c.type === type) result.push(c)
  }
  return result
}

function getDocstring(node: SyntaxNode): string | undefined {
  const body = findChild(node, 'block')
  if (!body || body.childCount === 0) return undefined
  const first = body.child(0)
  if (first?.type === 'expression_statement') {
    const str = findChild(first, 'string')
    if (str) {
      const content = findChild(str, 'string_content')
      return content ? getTextOf(content).trim() : undefined
    }
  }
  return undefined
}

function getDecorators(node: SyntaxNode): string[] {
  return findChildren(node, 'decorator').map(d => getTextOf(d))
}

// ── Extraction ──

function extractFunctionDef(node: SyntaxNode, exported: boolean): ExtractedSymbol | null {
  const name = findChild(node, 'identifier')
  if (!name) return null
  const nameText = getTextOf(name)
  const params = findChild(node, 'parameters')
  const retType = findChild(node, 'type')
  const isAsync = node.children.some(c => c.type === 'async')
  const sig = params
    ? (isAsync ? 'async ' : '') + getTextOf(params) + (retType ? ` -> ${getTextOf(retType)}` : '')
    : undefined
  return {
    name: nameText,
    kind: 'function',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: exported && !nameText.startsWith('_'),
    signature: sig,
    jsdoc: getDocstring(node),
  }
}

function extractClassDef(node: SyntaxNode, exported: boolean): ExtractedSymbol | null {
  const name = findChild(node, 'identifier')
  if (!name) return null
  const nameText = getTextOf(name)
  return {
    name: nameText,
    kind: 'class',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: exported && !nameText.startsWith('_'),
    jsdoc: getDocstring(node),
  }
}

function extractAssignment(exprStmt: SyntaxNode, exported: boolean): ExtractedSymbol | null {
  const assign = findChild(exprStmt, 'assignment')
  if (!assign) return null
  // Only simple identifier assignments (not attr or subscript)
  const target = assign.child(0)
  if (!target || target.type !== 'identifier') return null
  const nameText = getTextOf(target)
  return {
    name: nameText,
    kind: 'variable',
    startLine: exprStmt.startPosition.row + 1,
    endLine: exprStmt.endPosition.row + 1,
    isExported: exported && !nameText.startsWith('_'),
  }
}

function extractImportStatement(node: SyntaxNode): ExtractedImport[] {
  // import os / import os, sys
  const result: ExtractedImport[] = []
  for (const dn of findChildren(node, 'dotted_name')) {
    const name = getTextOf(dn)
    result.push({ symbol: name, fromPath: name, isTypeOnly: false })
  }
  // Also handle aliased: import os as operating_system
  for (const alias of findChildren(node, 'aliased_import')) {
    const dn = findChild(alias, 'dotted_name')
    const id = findChild(alias, 'identifier')
    if (dn) {
      result.push({ symbol: id ? getTextOf(id) : getTextOf(dn), fromPath: getTextOf(dn), isTypeOnly: false })
    }
  }
  return result
}

function extractImportFromStatement(node: SyntaxNode): ExtractedImport[] {
  const result: ExtractedImport[] = []
  // Module path: dotted_name or relative_import
  let fromPath = ''
  const relImport = findChild(node, 'relative_import')
  if (relImport) {
    const prefix = findChild(relImport, 'import_prefix')
    const dn = findChild(relImport, 'dotted_name')
    fromPath = (prefix ? getTextOf(prefix) : '') + (dn ? getTextOf(dn) : '')
  } else {
    const dn = findChild(node, 'dotted_name')
    if (dn) fromPath = getTextOf(dn)
  }

  // Imported names: can be dotted_name children after 'import' keyword, or aliased_import, or wildcard_import
  const wildcard = findChild(node, 'wildcard_import')
  if (wildcard) {
    result.push({ symbol: '*', fromPath, isTypeOnly: false })
    return result
  }

  // Named imports — direct dotted_name children after the 'import' keyword
  let pastImport = false
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)!
    if (c.type === 'import') { pastImport = true; continue }
    if (!pastImport) continue
    if (c.type === 'dotted_name') {
      result.push({ symbol: getTextOf(c), fromPath, isTypeOnly: false })
    } else if (c.type === 'aliased_import') {
      const dn = findChild(c, 'dotted_name')
      const id = findChild(c, 'identifier')
      if (dn) result.push({ symbol: id ? getTextOf(id) : getTextOf(dn), fromPath, isTypeOnly: false })
    }
  }
  return result
}

function extractCalls(node: SyntaxNode, parentSymbol?: string, calls: ExtractedCall[] = []): ExtractedCall[] {

  if (node.type === 'call') {
    const fn = node.child(0)
    let calleeName = ''
    if (fn?.type === 'identifier') {
      calleeName = getTextOf(fn)
    } else if (fn?.type === 'attribute') {
      calleeName = getTextOf(fn)
    }
    if (calleeName) {
      calls.push({ calleeName, line: node.startPosition.row + 1, parentSymbol })
    }
  }

  // Track scope
  let newParent = parentSymbol
  if (node.type === 'function_definition') {
    const name = findChild(node, 'identifier')
    if (name) newParent = getTextOf(name)
  }

  for (let i = 0; i < node.childCount; i++) {
    extractCalls(node.child(i)!, newParent, calls)
  }
  return calls
}

// ── Main entry ──

export function extractPython(root: SyntaxNode): ExtractionResult {
  const symbols: ExtractedSymbol[] = []
  const imports: ExtractedImport[] = []
  const exports: ExtractedExport[] = []

  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i)!

    switch (node.type) {
      case 'function_definition': {
        const sym = extractFunctionDef(node, true)
        if (sym) symbols.push(sym)
        break
      }
      case 'class_definition': {
        const sym = extractClassDef(node, true)
        if (sym) symbols.push(sym)
        break
      }
      case 'decorated_definition': {
        // Unwrap: find inner function_definition or class_definition
        const inner = findChild(node, 'function_definition') ?? findChild(node, 'class_definition')
        if (inner?.type === 'function_definition') {
          const sym = extractFunctionDef(inner, true)
          if (sym) {
            sym.startLine = node.startPosition.row + 1 // include decorator
            sym.jsdoc = getDecorators(node).join('\n') + (sym.jsdoc ? '\n' + sym.jsdoc : '')
            symbols.push(sym)
          }
        } else if (inner?.type === 'class_definition') {
          const sym = extractClassDef(inner, true)
          if (sym) {
            sym.startLine = node.startPosition.row + 1
            sym.jsdoc = getDecorators(node).join('\n') + (sym.jsdoc ? '\n' + sym.jsdoc : '')
            symbols.push(sym)
          }
        }
        break
      }
      case 'expression_statement': {
        const sym = extractAssignment(node, true)
        if (sym) symbols.push(sym)
        break
      }
      case 'import_statement':
        imports.push(...extractImportStatement(node))
        break
      case 'import_from_statement':
        imports.push(...extractImportFromStatement(node))
        break
    }
  }

  // Register exported symbols as exports
  for (const sym of symbols) {
    if (sym.isExported) {
      exports.push({ symbol: sym.name, kind: sym.kind, isReexport: false })
    }
  }

  const calls = extractCalls(root)
  const refs = extractRefsGeneric(root, new Set([
    'function_definition', 'class_definition', 'parameter', 'import_from_statement',
    'dotted_name', 'aliased_import',
  ]), ['identifier'])
  return { symbols, imports, exports, calls, refs }
}

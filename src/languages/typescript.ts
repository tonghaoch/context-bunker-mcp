import type { SyntaxNode } from '../indexer/parser.js'

// ── Extracted data types ──

export interface ExtractedSymbol {
  name: string
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable'
  startLine: number
  endLine: number
  isExported: boolean
  signature?: string
  jsdoc?: string
}

export interface ExtractedImport {
  symbol: string
  fromPath: string
  isTypeOnly: boolean
}

export interface ExtractedExport {
  symbol: string
  kind: string
  isReexport: boolean
  originalPath?: string
}

export interface ExtractedCall {
  calleeName: string
  line: number
  parentSymbol?: string // which function/method contains this call
}

export interface ExtractionResult {
  symbols: ExtractedSymbol[]
  imports: ExtractedImport[]
  exports: ExtractedExport[]
  calls: ExtractedCall[]
}

// ── Helpers ──

function getJsDoc(node: SyntaxNode): string | undefined {
  const prev = node.previousNamedSibling
  if (prev?.type === 'comment' && prev.text.startsWith('/**')) return prev.text
  // Check parent (export_statement) previous sibling
  if (node.parent?.type === 'export_statement') {
    const pp = node.parent.previousNamedSibling
    if (pp?.type === 'comment' && pp.text.startsWith('/**')) return pp.text
  }
  return undefined
}

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

function isExported(node: SyntaxNode): boolean {
  return node.parent?.type === 'export_statement'
}

function buildSignature(params: SyntaxNode | null, returnType: SyntaxNode | null): string | undefined {
  if (!params) return undefined
  const ret = returnType ? `: ${getTextOf(returnType).replace(/^:\s*/, '')}` : ''
  return `${getTextOf(params)}${ret}`
}

// ── Extraction ──

function extractFunctionDecl(node: SyntaxNode): ExtractedSymbol | null {
  const name = findChild(node, 'identifier')
  if (!name) return null
  const params = findChild(node, 'formal_parameters')
  const retType = findChild(node, 'type_annotation')
  const isAsync = node.children.some(c => c.text === 'async')
  const sig = buildSignature(params, retType)
  return {
    name: getTextOf(name),
    kind: 'function',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: isExported(node),
    signature: isAsync && sig ? `async ${sig}` : sig,
    jsdoc: getJsDoc(node),
  }
}

function extractArrowInVariable(varDecl: SyntaxNode, lexDecl: SyntaxNode): ExtractedSymbol | null {
  const nameNode = findChild(varDecl, 'identifier')
  const arrow = findChild(varDecl, 'arrow_function')
  if (!nameNode || !arrow) return null
  const params = findChild(arrow, 'formal_parameters')
  const retType = findChild(arrow, 'type_annotation')
  const isAsync = arrow.children.some(c => c.text === 'async')
  const sig = buildSignature(params, retType)
  return {
    name: getTextOf(nameNode),
    kind: 'function',
    startLine: lexDecl.startPosition.row + 1,
    endLine: lexDecl.endPosition.row + 1,
    isExported: isExported(lexDecl),
    signature: isAsync && sig ? `async ${sig}` : sig,
    jsdoc: getJsDoc(lexDecl),
  }
}

function extractVariableDecl(varDecl: SyntaxNode, lexDecl: SyntaxNode): ExtractedSymbol | null {
  // Skip arrow functions — handled separately
  if (findChild(varDecl, 'arrow_function')) return null
  const nameNode = findChild(varDecl, 'identifier')
  if (!nameNode) return null
  return {
    name: getTextOf(nameNode),
    kind: 'variable',
    startLine: lexDecl.startPosition.row + 1,
    endLine: lexDecl.endPosition.row + 1,
    isExported: isExported(lexDecl),
    jsdoc: getJsDoc(lexDecl),
  }
}

function extractClassDecl(node: SyntaxNode): ExtractedSymbol {
  const name = findChild(node, 'type_identifier') ?? findChild(node, 'identifier')
  return {
    name: getTextOf(name),
    kind: 'class',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: isExported(node),
    jsdoc: getJsDoc(node),
  }
}

function extractInterfaceDecl(node: SyntaxNode): ExtractedSymbol {
  const name = findChild(node, 'type_identifier')
  return {
    name: getTextOf(name),
    kind: 'interface',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: isExported(node),
    jsdoc: getJsDoc(node),
  }
}

function extractTypeAlias(node: SyntaxNode): ExtractedSymbol {
  const name = findChild(node, 'type_identifier')
  return {
    name: getTextOf(name),
    kind: 'type',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: isExported(node),
    jsdoc: getJsDoc(node),
  }
}

function extractEnumDecl(node: SyntaxNode): ExtractedSymbol {
  const name = findChild(node, 'identifier')
  return {
    name: getTextOf(name),
    kind: 'enum',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: isExported(node),
    jsdoc: getJsDoc(node),
  }
}

function extractImportStatement(node: SyntaxNode): ExtractedImport[] {
  const result: ExtractedImport[] = []
  const isTypeOnly = node.children.some(c => c.type === 'type' && c.text === 'type')
  const sourceNode = findChild(node, 'string')
  const fromPath = sourceNode ? getTextOf(findChild(sourceNode, 'string_fragment')) : ''

  const clause = findChild(node, 'import_clause')
  if (!clause) return result

  // import Foo from '...' (default import)
  const defaultId = findChild(clause, 'identifier')
  if (defaultId) {
    result.push({ symbol: getTextOf(defaultId), fromPath, isTypeOnly })
  }

  // import { A, B } from '...'
  const named = findChild(clause, 'named_imports')
  if (named) {
    for (const spec of findChildren(named, 'import_specifier')) {
      const alias = findChild(spec, 'identifier')
      result.push({ symbol: getTextOf(alias), fromPath, isTypeOnly })
    }
  }

  // import * as Ns from '...'
  const ns = findChild(clause, 'namespace_import')
  if (ns) {
    const id = findChild(ns, 'identifier')
    if (id) result.push({ symbol: `* as ${getTextOf(id)}`, fromPath, isTypeOnly })
  }

  return result
}

function extractExportStatement(node: SyntaxNode): ExtractedExport[] {
  const result: ExtractedExport[] = []

  // Re-export: export { X } from './foo'
  const exportClause = findChild(node, 'export_clause')
  const sourceNode = findChild(node, 'string')
  if (exportClause && sourceNode) {
    const fromPath = getTextOf(findChild(sourceNode, 'string_fragment'))
    for (const spec of findChildren(exportClause, 'export_specifier')) {
      const id = findChild(spec, 'identifier')
      result.push({ symbol: getTextOf(id), kind: 'reexport', isReexport: true, originalPath: fromPath })
    }
    return result
  }

  // export default X
  const hasDefault = node.children.some(c => c.text === 'default')
  if (hasDefault) {
    const id = findChild(node, 'identifier')
    result.push({ symbol: id ? getTextOf(id) : 'default', kind: 'default', isReexport: false })
    return result
  }

  // Inline exports (export function/class/const/etc) are handled in symbol extraction
  // via isExported flag, so we don't duplicate them here
  return result
}

function extractCalls(node: SyntaxNode, parentSymbol?: string): ExtractedCall[] {
  const calls: ExtractedCall[] = []

  if (node.type === 'call_expression') {
    const fn = node.child(0)
    let calleeName = ''
    if (fn?.type === 'identifier') {
      calleeName = getTextOf(fn)
    } else if (fn?.type === 'member_expression') {
      calleeName = getTextOf(fn)
    }
    if (calleeName) {
      calls.push({ calleeName, line: node.startPosition.row + 1, parentSymbol })
    }
  }

  // Determine if this node defines a new scope (function/method)
  let newParent = parentSymbol
  if (node.type === 'function_declaration') {
    newParent = getTextOf(findChild(node, 'identifier'))
  } else if (node.type === 'method_definition') {
    newParent = getTextOf(findChild(node, 'property_identifier'))
  } else if (node.type === 'arrow_function' && node.parent?.type === 'variable_declarator') {
    newParent = getTextOf(findChild(node.parent, 'identifier'))
  }

  for (let i = 0; i < node.childCount; i++) {
    calls.push(...extractCalls(node.child(i)!, newParent))
  }
  return calls
}

// ── Main entry ──

export function extractTypeScript(root: SyntaxNode): ExtractionResult {
  const symbols: ExtractedSymbol[] = []
  const imports: ExtractedImport[] = []
  const exports: ExtractedExport[] = []

  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i)!

    // Unwrap export_statement to get the inner declaration
    let inner = node
    if (node.type === 'export_statement') {
      // Handle re-exports and default exports
      const expResult = extractExportStatement(node)
      exports.push(...expResult)

      // Find the inner declaration
      const decl = node.children.find(c =>
        c.type === 'function_declaration' ||
        c.type === 'class_declaration' ||
        c.type === 'interface_declaration' ||
        c.type === 'type_alias_declaration' ||
        c.type === 'enum_declaration' ||
        c.type === 'lexical_declaration'
      )
      if (!decl) continue
      inner = decl
    }

    switch (inner.type) {
      case 'function_declaration': {
        const sym = extractFunctionDecl(inner)
        if (sym) symbols.push(sym)
        break
      }
      case 'lexical_declaration': {
        for (const vd of findChildren(inner, 'variable_declarator')) {
          if (findChild(vd, 'arrow_function')) {
            const sym = extractArrowInVariable(vd, inner)
            if (sym) symbols.push(sym)
          } else {
            const sym = extractVariableDecl(vd, inner)
            if (sym) symbols.push(sym)
          }
        }
        break
      }
      case 'class_declaration':
        symbols.push(extractClassDecl(inner))
        break
      case 'interface_declaration':
        symbols.push(extractInterfaceDecl(inner))
        break
      case 'type_alias_declaration':
        symbols.push(extractTypeAlias(inner))
        break
      case 'enum_declaration':
        symbols.push(extractEnumDecl(inner))
        break
      case 'import_statement':
        imports.push(...extractImportStatement(inner))
        break
    }
  }

  // Also register exported symbols as exports
  for (const sym of symbols) {
    if (sym.isExported) {
      exports.push({ symbol: sym.name, kind: sym.kind, isReexport: false })
    }
  }

  // Extract call expressions from the entire tree
  const calls = extractCalls(root)

  return { symbols, imports, exports, calls }
}

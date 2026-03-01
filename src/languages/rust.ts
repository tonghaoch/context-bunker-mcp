import type { SyntaxNode } from '../indexer/parser.js'
import type { ExtractionResult, ExtractedSymbol, ExtractedImport, ExtractedExport, ExtractedCall } from './typescript.js'

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

function getRustDoc(node: SyntaxNode): string | undefined {
  // Collect consecutive /// doc comments above the node
  const comments: string[] = []
  let prev = node.previousNamedSibling
  while (prev?.type === 'line_comment' && prev.text.startsWith('///')) {
    comments.unshift(prev.text)
    prev = prev.previousNamedSibling
  }
  if (comments.length > 0) return comments.join('\n')
  // Also check for block doc comments /** ... */
  const blockPrev = node.previousNamedSibling
  if (blockPrev?.type === 'block_comment' && blockPrev.text.startsWith('/**')) {
    return blockPrev.text
  }
  return undefined
}

function hasPubVisibility(node: SyntaxNode): boolean {
  const vis = findChild(node, 'visibility_modifier')
  return vis !== null && vis.text.startsWith('pub')
}

// ── Extraction ──

function extractFunctionItem(node: SyntaxNode, implType?: string): ExtractedSymbol | null {
  const nameNode = findChild(node, 'identifier')
  if (!nameNode) return null
  const nameText = getTextOf(nameNode)

  const params = findChild(node, 'parameters')
  const isAsync = findChild(node, 'function_modifiers')?.text.includes('async') ?? false

  // Return type: type_identifier, primitive_type, generic_type, reference_type
  let retType: SyntaxNode | null = null
  const arrow = findChild(node, '->')
  if (arrow) {
    // Return type is the sibling after ->
    const arrowIdx = Array.from({ length: node.childCount }, (_, i) => node.child(i)!)
      .findIndex(c => c.type === '->')
    if (arrowIdx >= 0 && arrowIdx + 1 < node.childCount) {
      const next = node.child(arrowIdx + 1)!
      if (next.type !== 'block') retType = next
    }
  }

  const sig = isAsync
    ? `async ${getTextOf(params)}${retType ? ' -> ' + getTextOf(retType) : ''}`
    : `${getTextOf(params)}${retType ? ' -> ' + getTextOf(retType) : ''}`

  const fullName = implType ? `${implType}.${nameText}` : nameText

  return {
    name: fullName,
    kind: 'function',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: hasPubVisibility(node),
    signature: sig || undefined,
    jsdoc: implType ? undefined : getRustDoc(node),
  }
}

function extractStructItem(node: SyntaxNode): ExtractedSymbol | null {
  const nameNode = findChild(node, 'type_identifier')
  if (!nameNode) return null
  const name = getTextOf(nameNode)
  return {
    name,
    kind: 'class',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: hasPubVisibility(node),
    jsdoc: getRustDoc(node),
  }
}

function extractEnumItem(node: SyntaxNode): ExtractedSymbol | null {
  const nameNode = findChild(node, 'type_identifier')
  if (!nameNode) return null
  const name = getTextOf(nameNode)
  return {
    name,
    kind: 'enum',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: hasPubVisibility(node),
    jsdoc: getRustDoc(node),
  }
}

function extractTraitItem(node: SyntaxNode): ExtractedSymbol | null {
  const nameNode = findChild(node, 'type_identifier')
  if (!nameNode) return null
  const name = getTextOf(nameNode)
  return {
    name,
    kind: 'interface',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: hasPubVisibility(node),
    jsdoc: getRustDoc(node),
  }
}

function extractTypeItem(node: SyntaxNode): ExtractedSymbol | null {
  const nameNode = findChild(node, 'type_identifier')
  if (!nameNode) return null
  const name = getTextOf(nameNode)
  return {
    name,
    kind: 'type',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: hasPubVisibility(node),
    jsdoc: getRustDoc(node),
  }
}

function extractConstOrStatic(node: SyntaxNode): ExtractedSymbol | null {
  const nameNode = findChild(node, 'identifier')
  if (!nameNode) return null
  const name = getTextOf(nameNode)
  return {
    name,
    kind: 'variable',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: hasPubVisibility(node),
    jsdoc: getRustDoc(node),
  }
}

function extractImplItem(node: SyntaxNode): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []
  const typeNode = findChild(node, 'type_identifier')
  const implType = typeNode ? getTextOf(typeNode) : undefined

  const declList = findChild(node, 'declaration_list')
  if (!declList) return symbols

  for (let i = 0; i < declList.childCount; i++) {
    const child = declList.child(i)!
    if (child.type === 'function_item') {
      const sym = extractFunctionItem(child, implType)
      if (sym) symbols.push(sym)
    }
  }
  return symbols
}

function extractUseDeclaration(node: SyntaxNode): ExtractedImport[] {
  const result: ExtractedImport[] = []

  // Find the use path — could be scoped_identifier, use_list, use_wildcard, identifier
  const scopedId = findChild(node, 'scoped_identifier')
  const useList = findChild(node, 'use_list') ?? findChild(node, 'scoped_use_list')
  const identifier = findChild(node, 'identifier')

  if (scopedId) {
    // Simple: `use crate::utils::hash_password;`
    const fullPath = getTextOf(scopedId)
    const parts = fullPath.split('::')
    const symbol = parts[parts.length - 1]
    const fromPath = parts.slice(0, -1).join('::')
    result.push({ symbol, fromPath: fromPath || fullPath, isTypeOnly: false })
  } else if (useList) {
    // Grouped: `use crate::auth::{login, register};`
    extractUseList(node, useList, '', result)
  } else if (identifier) {
    // Simple: `use something;`
    const name = getTextOf(identifier)
    result.push({ symbol: name, fromPath: name, isTypeOnly: false })
  }

  return result
}

function extractUseList(parent: SyntaxNode, listNode: SyntaxNode, prefix: string, result: ExtractedImport[]): void {
  // Find the prefix (scoped_identifier before the use_list)
  let pathPrefix = prefix
  if (!pathPrefix) {
    // Look for scoped_identifier as sibling before the use_list in the parent
    for (let i = 0; i < parent.childCount; i++) {
      const c = parent.child(i)!
      if (c.type === 'scoped_identifier') {
        pathPrefix = getTextOf(c)
        break
      }
    }
  }

  for (let i = 0; i < listNode.childCount; i++) {
    const child = listNode.child(i)!
    if (child.type === 'identifier') {
      const symbol = getTextOf(child)
      result.push({ symbol, fromPath: pathPrefix || symbol, isTypeOnly: false })
    } else if (child.type === 'scoped_identifier') {
      const fullPath = getTextOf(child)
      const parts = fullPath.split('::')
      const symbol = parts[parts.length - 1]
      const fromPath = pathPrefix ? `${pathPrefix}::${parts.slice(0, -1).join('::')}` : parts.slice(0, -1).join('::')
      result.push({ symbol, fromPath: fromPath || fullPath, isTypeOnly: false })
    } else if (child.type === 'use_as_clause') {
      const orig = findChild(child, 'identifier')
      if (orig) {
        result.push({ symbol: getTextOf(orig), fromPath: pathPrefix, isTypeOnly: false })
      }
    } else if (child.type === 'use_wildcard') {
      result.push({ symbol: '*', fromPath: pathPrefix, isTypeOnly: false })
    }
  }
}

function extractCalls(node: SyntaxNode, parentSymbol?: string): ExtractedCall[] {
  const calls: ExtractedCall[] = []

  if (node.type === 'call_expression') {
    const fn = node.child(0)
    let calleeName = ''
    if (fn?.type === 'identifier') {
      calleeName = getTextOf(fn)
    } else if (fn?.type === 'scoped_identifier') {
      calleeName = getTextOf(fn)
    } else if (fn?.type === 'field_expression') {
      calleeName = getTextOf(fn)
    }
    if (calleeName) {
      calls.push({ calleeName, line: node.startPosition.row + 1, parentSymbol })
    }
  }

  // Also capture macro invocations (e.g., format!, println!, vec!)
  if (node.type === 'macro_invocation') {
    const macroName = node.child(0)
    if (macroName) {
      calls.push({ calleeName: getTextOf(macroName) + '!', line: node.startPosition.row + 1, parentSymbol })
    }
  }

  // Track scope
  let newParent = parentSymbol
  if (node.type === 'function_item') {
    const name = findChild(node, 'identifier')
    if (name) newParent = getTextOf(name)
  }

  for (let i = 0; i < node.childCount; i++) {
    calls.push(...extractCalls(node.child(i)!, newParent))
  }
  return calls
}

// ── Main entry ──

export function extractRust(root: SyntaxNode): ExtractionResult {
  const symbols: ExtractedSymbol[] = []
  const imports: ExtractedImport[] = []
  const exports: ExtractedExport[] = []

  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i)!

    switch (node.type) {
      case 'function_item': {
        const sym = extractFunctionItem(node)
        if (sym) symbols.push(sym)
        break
      }
      case 'struct_item': {
        const sym = extractStructItem(node)
        if (sym) symbols.push(sym)
        break
      }
      case 'enum_item': {
        const sym = extractEnumItem(node)
        if (sym) symbols.push(sym)
        break
      }
      case 'trait_item': {
        const sym = extractTraitItem(node)
        if (sym) symbols.push(sym)
        break
      }
      case 'type_item': {
        const sym = extractTypeItem(node)
        if (sym) symbols.push(sym)
        break
      }
      case 'const_item':
      case 'static_item': {
        const sym = extractConstOrStatic(node)
        if (sym) symbols.push(sym)
        break
      }
      case 'impl_item':
        symbols.push(...extractImplItem(node))
        break
      case 'use_declaration':
        imports.push(...extractUseDeclaration(node))
        break
    }
  }

  // Register exported symbols as exports
  for (const sym of symbols) {
    if (sym.isExported) {
      exports.push({ symbol: sym.name, kind: sym.kind, isReexport: false })
    }
  }

  // Handle pub use as re-exports
  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i)!
    if (node.type === 'use_declaration' && hasPubVisibility(node)) {
      const scopedId = findChild(node, 'scoped_identifier')
      if (scopedId) {
        const fullPath = getTextOf(scopedId)
        const parts = fullPath.split('::')
        const symbol = parts[parts.length - 1]
        const fromPath = parts.slice(0, -1).join('::')
        exports.push({ symbol, kind: 'function', isReexport: true, originalPath: fromPath })
      }
    }
  }

  const calls = extractCalls(root)
  return { symbols, imports, exports, calls }
}

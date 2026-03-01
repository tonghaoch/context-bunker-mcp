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

function findChildren(node: SyntaxNode, type: string): SyntaxNode[] {
  const result: SyntaxNode[] = []
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)!
    if (c.type === type) result.push(c)
  }
  return result
}

function getGoDoc(node: SyntaxNode): string | undefined {
  const prev = node.previousNamedSibling
  if (prev?.type === 'comment') return prev.text
  return undefined
}

function isGoExported(name: string): boolean {
  return /^[A-Z]/.test(name)
}

// ── Extraction ──

function extractFunctionDecl(node: SyntaxNode): ExtractedSymbol | null {
  const name = findChild(node, 'identifier')
  if (!name) return null
  const nameText = getTextOf(name)
  const paramLists = findChildren(node, 'parameter_list')
  const params = paramLists[0] // first = params
  const result = paramLists[1] // second = return types (if present)
  // Also check for single return type (not in parameter_list)
  const retType = result ?? findChild(node, 'type_identifier') ?? findChild(node, 'pointer_type')
  const sig = params
    ? getTextOf(params) + (retType ? ' ' + getTextOf(retType) : '')
    : undefined
  return {
    name: nameText,
    kind: 'function',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: isGoExported(nameText),
    signature: sig,
    jsdoc: getGoDoc(node),
  }
}

function extractMethodDecl(node: SyntaxNode): ExtractedSymbol | null {
  const fieldId = findChild(node, 'field_identifier')
  if (!fieldId) return null
  const methodName = getTextOf(fieldId)

  // Receiver: first parameter_list
  const paramLists = findChildren(node, 'parameter_list')
  const receiver = paramLists[0] // (r *Type)
  const params = paramLists[1]   // method params
  const result = paramLists[2]   // return types

  // Extract receiver type name
  let receiverType = ''
  if (receiver) {
    const paramDecl = findChild(receiver, 'parameter_declaration')
    if (paramDecl) {
      const typeId = findChild(paramDecl, 'type_identifier')
      const ptrType = findChild(paramDecl, 'pointer_type')
      if (typeId) receiverType = getTextOf(typeId)
      else if (ptrType) {
        const inner = findChild(ptrType, 'type_identifier')
        if (inner) receiverType = getTextOf(inner)
      }
    }
  }

  const fullName = receiverType ? `${receiverType}.${methodName}` : methodName
  const retType = result ?? findChild(node, 'type_identifier')
  const sig = params
    ? getTextOf(params) + (retType ? ' ' + getTextOf(retType) : '')
    : undefined

  return {
    name: fullName,
    kind: 'function',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: isGoExported(methodName),
    signature: sig,
    jsdoc: getGoDoc(node),
  }
}

function extractTypeDecl(node: SyntaxNode): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []

  // type_spec: `type Foo struct{}`
  for (const spec of findChildren(node, 'type_spec')) {
    const nameNode = findChild(spec, 'type_identifier')
    if (!nameNode) continue
    const name = getTextOf(nameNode)
    // Determine kind from the type body (last named child)
    let kind: ExtractedSymbol['kind'] = 'type'
    const structType = findChild(spec, 'struct_type')
    const ifaceType = findChild(spec, 'interface_type')
    if (structType) kind = 'class'
    else if (ifaceType) kind = 'interface'
    symbols.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      isExported: isGoExported(name),
      jsdoc: getGoDoc(node),
    })
  }

  // type_alias: `type Role = string`
  for (const alias of findChildren(node, 'type_alias')) {
    const nameNode = findChild(alias, 'type_identifier')
    if (!nameNode) continue
    const name = getTextOf(nameNode)
    symbols.push({
      name,
      kind: 'type',
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      isExported: isGoExported(name),
      jsdoc: getGoDoc(node),
    })
  }

  return symbols
}

function extractVarOrConst(node: SyntaxNode): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []
  const specType = node.type === 'var_declaration' ? 'var_spec' : 'const_spec'
  for (const spec of findChildren(node, specType)) {
    const nameNode = findChild(spec, 'identifier')
    if (!nameNode) continue
    const name = getTextOf(nameNode)
    symbols.push({
      name,
      kind: 'variable',
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      isExported: isGoExported(name),
      jsdoc: getGoDoc(node),
    })
  }
  return symbols
}

function extractImportDecl(node: SyntaxNode): ExtractedImport[] {
  const result: ExtractedImport[] = []
  const specs: SyntaxNode[] = []

  // Single import or import block
  const specList = findChild(node, 'import_spec_list')
  if (specList) {
    specs.push(...findChildren(specList, 'import_spec'))
  } else {
    const single = findChild(node, 'import_spec')
    if (single) specs.push(single)
  }

  for (const spec of specs) {
    const pathNode = findChild(spec, 'interpreted_string_literal')
    if (!pathNode) continue
    const raw = getTextOf(pathNode).replace(/"/g, '')
    const alias = findChild(spec, 'package_identifier')
    const symbol = alias ? getTextOf(alias) : raw.split('/').pop()!
    result.push({ symbol, fromPath: raw, isTypeOnly: false })
  }
  return result
}

function extractCalls(node: SyntaxNode, parentSymbol?: string): ExtractedCall[] {
  const calls: ExtractedCall[] = []

  if (node.type === 'call_expression') {
    const fn = node.child(0)
    let calleeName = ''
    if (fn?.type === 'identifier') {
      calleeName = getTextOf(fn)
    } else if (fn?.type === 'selector_expression') {
      calleeName = getTextOf(fn)
    }
    if (calleeName) {
      calls.push({ calleeName, line: node.startPosition.row + 1, parentSymbol })
    }
  }

  // Track scope
  let newParent = parentSymbol
  if (node.type === 'function_declaration') {
    const name = findChild(node, 'identifier')
    if (name) newParent = getTextOf(name)
  } else if (node.type === 'method_declaration') {
    const fieldId = findChild(node, 'field_identifier')
    if (fieldId) {
      const methodName = getTextOf(fieldId)
      // Extract receiver type for full Type.Method name
      const paramLists = findChildren(node, 'parameter_list')
      const receiver = paramLists[0]
      let receiverType = ''
      if (receiver) {
        const paramDecl = findChild(receiver, 'parameter_declaration')
        if (paramDecl) {
          const typeId = findChild(paramDecl, 'type_identifier')
          const ptrType = findChild(paramDecl, 'pointer_type')
          if (typeId) receiverType = getTextOf(typeId)
          else if (ptrType) {
            const inner = findChild(ptrType, 'type_identifier')
            if (inner) receiverType = getTextOf(inner)
          }
        }
      }
      newParent = receiverType ? `${receiverType}.${methodName}` : methodName
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    calls.push(...extractCalls(node.child(i)!, newParent))
  }
  return calls
}

// ── Main entry ──

export function extractGo(root: SyntaxNode): ExtractionResult {
  const symbols: ExtractedSymbol[] = []
  const imports: ExtractedImport[] = []
  const exports: ExtractedExport[] = []

  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i)!

    switch (node.type) {
      case 'function_declaration': {
        const sym = extractFunctionDecl(node)
        if (sym) symbols.push(sym)
        break
      }
      case 'method_declaration': {
        const sym = extractMethodDecl(node)
        if (sym) symbols.push(sym)
        break
      }
      case 'type_declaration':
        symbols.push(...extractTypeDecl(node))
        break
      case 'var_declaration':
      case 'const_declaration':
        symbols.push(...extractVarOrConst(node))
        break
      case 'import_declaration':
        imports.push(...extractImportDecl(node))
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
  return { symbols, imports, exports, calls }
}

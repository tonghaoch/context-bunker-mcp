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

function hasModifier(node: SyntaxNode, mod: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)!
    if (c.type === 'modifier' && c.text === mod) return true
  }
  return false
}

function isPublic(node: SyntaxNode): boolean {
  return hasModifier(node, 'public')
}

function getXmlDoc(node: SyntaxNode): string | undefined {
  const prev = node.previousNamedSibling
  if (prev?.type === 'comment' && prev.text.startsWith('///')) {
    // Collect consecutive /// comments
    const lines: string[] = [prev.text]
    let cur = prev.previousNamedSibling
    while (cur?.type === 'comment' && cur.text.startsWith('///')) {
      lines.unshift(cur.text)
      cur = cur.previousNamedSibling
    }
    return lines.join('\n')
  }
  return undefined
}

function flattenQualifiedName(node: SyntaxNode): string {
  if (node.type === 'identifier') return node.text
  if (node.type === 'qualified_name') {
    const parts: string[] = []
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i)!
      if (c.type === 'identifier' || c.type === 'qualified_name') {
        parts.push(flattenQualifiedName(c))
      }
    }
    return parts.join('.')
  }
  return node.text
}

// ── Extraction ──

function extractClassDecl(node: SyntaxNode): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []
  const nameNode = findChild(node, 'identifier')
  if (!nameNode) return symbols
  const className = getTextOf(nameNode)

  symbols.push({
    name: className,
    kind: 'class',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: isPublic(node),
    jsdoc: getXmlDoc(node),
  })

  const body = findChild(node, 'declaration_list')
  if (body) symbols.push(...extractMembers(body, className))

  return symbols
}

function extractStructDecl(node: SyntaxNode): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []
  const nameNode = findChild(node, 'identifier')
  if (!nameNode) return symbols
  const name = getTextOf(nameNode)

  symbols.push({
    name,
    kind: 'class',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: isPublic(node),
    jsdoc: getXmlDoc(node),
  })

  const body = findChild(node, 'declaration_list')
  if (body) symbols.push(...extractMembers(body, name))

  return symbols
}

function extractInterfaceDecl(node: SyntaxNode): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []
  const nameNode = findChild(node, 'identifier')
  if (!nameNode) return symbols
  const name = getTextOf(nameNode)

  symbols.push({
    name,
    kind: 'interface',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: isPublic(node),
    jsdoc: getXmlDoc(node),
  })

  const body = findChild(node, 'declaration_list')
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i)!
      if (child.type === 'method_declaration') {
        const methodName = findChild(child, 'identifier')
        if (methodName) {
          const params = findChild(child, 'parameter_list')
          symbols.push({
            name: `${name}.${getTextOf(methodName)}`,
            kind: 'function',
            startLine: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
            isExported: isPublic(node),
            signature: params ? getTextOf(params) : undefined,
            jsdoc: getXmlDoc(child),
          })
        }
      }
    }
  }

  return symbols
}

function extractEnumDecl(node: SyntaxNode): ExtractedSymbol | null {
  const nameNode = findChild(node, 'identifier')
  if (!nameNode) return null
  return {
    name: getTextOf(nameNode),
    kind: 'enum',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: isPublic(node),
    jsdoc: getXmlDoc(node),
  }
}

function extractDelegateDecl(node: SyntaxNode): ExtractedSymbol | null {
  const nameNode = findChild(node, 'identifier')
  if (!nameNode) return null
  return {
    name: getTextOf(nameNode),
    kind: 'type',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: isPublic(node),
    jsdoc: getXmlDoc(node),
  }
}

function extractMembers(body: SyntaxNode, className: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []

  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i)!

    if (child.type === 'method_declaration') {
      // In C#, method_declaration can have two identifiers: return type and method name
      // The method name is the last identifier before parameter_list
      const identifiers = findChildren(child, 'identifier')
      const params = findChild(child, 'parameter_list')
      // Method name is the identifier right before parameter_list
      let methodName: SyntaxNode | null = null
      for (const id of identifiers) {
        if (params && id.startPosition.column < params.startPosition.column) {
          methodName = id
        }
      }
      if (!methodName && identifiers.length > 0) methodName = identifiers[identifiers.length - 1]
      if (methodName) {
        symbols.push({
          name: `${className}.${getTextOf(methodName)}`,
          kind: 'function',
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          isExported: isPublic(child),
          signature: params ? getTextOf(params) : undefined,
          jsdoc: getXmlDoc(child),
        })
      }
    } else if (child.type === 'constructor_declaration') {
      const nameNode = findChild(child, 'identifier')
      if (nameNode) {
        const params = findChild(child, 'parameter_list')
        symbols.push({
          name: `${className}.${getTextOf(nameNode)}`,
          kind: 'function',
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          isExported: isPublic(child),
          signature: params ? getTextOf(params) : undefined,
          jsdoc: getXmlDoc(child),
        })
      }
    } else if (child.type === 'property_declaration') {
      const nameNode = findChild(child, 'identifier')
      if (nameNode) {
        symbols.push({
          name: `${className}.${getTextOf(nameNode)}`,
          kind: 'variable',
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          isExported: isPublic(child),
          jsdoc: getXmlDoc(child),
        })
      }
    } else if (child.type === 'field_declaration') {
      const varDecl = findChild(child, 'variable_declaration')
      if (varDecl) {
        const declarator = findChild(varDecl, 'variable_declarator')
        if (declarator) {
          const nameNode = findChild(declarator, 'identifier')
          if (nameNode) {
            symbols.push({
              name: `${className}.${getTextOf(nameNode)}`,
              kind: 'variable',
              startLine: child.startPosition.row + 1,
              endLine: child.endPosition.row + 1,
              isExported: isPublic(child),
              jsdoc: getXmlDoc(child),
            })
          }
        }
      }
    }
  }

  return symbols
}

function extractUsingDirective(node: SyntaxNode): ExtractedImport | null {
  // using_directive: using (identifier | qualified_name) ;
  const qualName = findChild(node, 'qualified_name')
  if (qualName) {
    const fullPath = flattenQualifiedName(qualName)
    return { symbol: fullPath.split('.').pop()!, fromPath: fullPath, isTypeOnly: false }
  }
  const ident = findChild(node, 'identifier')
  if (ident) {
    const name = getTextOf(ident)
    return { symbol: name, fromPath: name, isTypeOnly: false }
  }
  return null
}

function extractCalls(node: SyntaxNode, parentSymbol?: string): ExtractedCall[] {
  const calls: ExtractedCall[] = []

  if (node.type === 'invocation_expression') {
    const fn = node.child(0)
    let calleeName = ''
    if (fn?.type === 'identifier') {
      calleeName = getTextOf(fn)
    } else if (fn?.type === 'member_access_expression') {
      calleeName = getTextOf(fn)
    }
    if (calleeName) {
      calls.push({ calleeName, line: node.startPosition.row + 1, parentSymbol })
    }
  } else if (node.type === 'object_creation_expression') {
    const typeId = findChild(node, 'identifier')
    if (typeId) {
      calls.push({
        calleeName: `new ${getTextOf(typeId)}`,
        line: node.startPosition.row + 1,
        parentSymbol,
      })
    }
  }

  // Track scope
  let newParent = parentSymbol
  if (node.type === 'method_declaration') {
    const identifiers = findChildren(node, 'identifier')
    const params = findChild(node, 'parameter_list')
    let methodName: SyntaxNode | null = null
    for (const id of identifiers) {
      if (params && id.startPosition.column < params.startPosition.column) {
        methodName = id
      }
    }
    if (!methodName && identifiers.length > 0) methodName = identifiers[identifiers.length - 1]
    if (methodName) {
      const parent = node.parent
      if (parent?.type === 'declaration_list') {
        const classNode = parent.parent
        if (classNode && (classNode.type === 'class_declaration' || classNode.type === 'struct_declaration')) {
          const classNameNode = findChild(classNode, 'identifier')
          if (classNameNode) {
            newParent = `${getTextOf(classNameNode)}.${getTextOf(methodName)}`
          } else {
            newParent = getTextOf(methodName)
          }
        } else {
          newParent = getTextOf(methodName)
        }
      } else {
        newParent = getTextOf(methodName)
      }
    }
  } else if (node.type === 'constructor_declaration') {
    const nameNode = findChild(node, 'identifier')
    if (nameNode) {
      const parent = node.parent
      if (parent?.type === 'declaration_list') {
        const classNode = parent.parent
        if (classNode) {
          const classNameNode = findChild(classNode, 'identifier')
          if (classNameNode) {
            newParent = `${getTextOf(classNameNode)}.${getTextOf(nameNode)}`
          } else {
            newParent = getTextOf(nameNode)
          }
        }
      } else {
        newParent = getTextOf(nameNode)
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    calls.push(...extractCalls(node.child(i)!, newParent))
  }
  return calls
}

// ── Walk declarations recursively (handles namespace nesting) ──

function walkDeclarations(
  node: SyntaxNode,
  symbols: ExtractedSymbol[],
  imports: ExtractedImport[],
) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!

    switch (child.type) {
      case 'using_directive': {
        const imp = extractUsingDirective(child)
        if (imp) imports.push(imp)
        break
      }
      case 'namespace_declaration': {
        const body = findChild(child, 'declaration_list')
        if (body) walkDeclarations(body, symbols, imports)
        break
      }
      case 'class_declaration':
        symbols.push(...extractClassDecl(child))
        break
      case 'struct_declaration':
        symbols.push(...extractStructDecl(child))
        break
      case 'interface_declaration':
        symbols.push(...extractInterfaceDecl(child))
        break
      case 'enum_declaration': {
        const sym = extractEnumDecl(child)
        if (sym) symbols.push(sym)
        break
      }
      case 'delegate_declaration': {
        const sym = extractDelegateDecl(child)
        if (sym) symbols.push(sym)
        break
      }
    }
  }
}

// ── Main entry ──

export function extractCSharp(root: SyntaxNode): ExtractionResult {
  const symbols: ExtractedSymbol[] = []
  const imports: ExtractedImport[] = []
  const exports: ExtractedExport[] = []

  walkDeclarations(root, symbols, imports)

  // Public symbols are exports
  for (const sym of symbols) {
    if (sym.isExported) {
      exports.push({ symbol: sym.name, kind: sym.kind, isReexport: false })
    }
  }

  const calls = extractCalls(root)
  const refs = extractRefsGeneric(root, new Set([
    'class_declaration', 'interface_declaration', 'enum_declaration', 'struct_declaration',
    'method_declaration', 'constructor_declaration', 'parameter',
    'variable_declaration', 'using_directive',
  ]), ['identifier'])
  return { symbols, imports, exports, calls, refs }
}

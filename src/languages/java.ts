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

function hasModifier(node: SyntaxNode, modifier: string): boolean {
  const mods = findChild(node, 'modifiers')
  if (!mods) return false
  for (let i = 0; i < mods.childCount; i++) {
    if (mods.child(i)!.type === modifier) return true
  }
  return false
}

function isPublic(node: SyntaxNode): boolean {
  return hasModifier(node, 'public')
}

function getJavadoc(node: SyntaxNode): string | undefined {
  const prev = node.previousNamedSibling
  if (prev?.type === 'block_comment' && prev.text.startsWith('/**')) {
    return prev.text
  }
  return undefined
}

function flattenScopedIdentifier(node: SyntaxNode): string {
  if (node.type === 'identifier') return node.text
  if (node.type === 'scoped_identifier') {
    const parts: string[] = []
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i)!
      if (c.type === 'scoped_identifier' || c.type === 'identifier') {
        parts.push(flattenScopedIdentifier(c))
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
    jsdoc: getJavadoc(node),
  })

  // Extract members from class_body
  const body = findChild(node, 'class_body')
  if (body) {
    symbols.push(...extractMembers(body, className))
  }

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
    jsdoc: getJavadoc(node),
  })

  // Extract interface method declarations
  const body = findChild(node, 'interface_body')
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i)!
      if (child.type === 'method_declaration') {
        const methodName = findChild(child, 'identifier')
        if (methodName) {
          const params = findChild(child, 'formal_parameters')
          symbols.push({
            name: `${name}.${getTextOf(methodName)}`,
            kind: 'function',
            startLine: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
            isExported: isPublic(node), // interface methods inherit interface visibility
            signature: params ? getTextOf(params) : undefined,
            jsdoc: getJavadoc(child),
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
    jsdoc: getJavadoc(node),
  }
}

function extractMembers(body: SyntaxNode, className: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []

  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i)!

    if (child.type === 'method_declaration') {
      const nameNode = findChild(child, 'identifier')
      if (nameNode) {
        const params = findChild(child, 'formal_parameters')
        symbols.push({
          name: `${className}.${getTextOf(nameNode)}`,
          kind: 'function',
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          isExported: isPublic(child),
          signature: params ? getTextOf(params) : undefined,
          jsdoc: getJavadoc(child),
        })
      }
    } else if (child.type === 'constructor_declaration') {
      const nameNode = findChild(child, 'identifier')
      if (nameNode) {
        const params = findChild(child, 'formal_parameters')
        symbols.push({
          name: `${className}.${getTextOf(nameNode)}`,
          kind: 'function',
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          isExported: isPublic(child),
          signature: params ? getTextOf(params) : undefined,
          jsdoc: getJavadoc(child),
        })
      }
    } else if (child.type === 'field_declaration') {
      // Only extract static final fields as notable variables
      if (hasModifier(child, 'static') && hasModifier(child, 'final')) {
        const declarator = findChild(child, 'variable_declarator')
        if (declarator) {
          const nameNode = findChild(declarator, 'identifier')
          if (nameNode) {
            symbols.push({
              name: `${className}.${getTextOf(nameNode)}`,
              kind: 'variable',
              startLine: child.startPosition.row + 1,
              endLine: child.endPosition.row + 1,
              isExported: isPublic(child),
            })
          }
        }
      }
    }
  }

  return symbols
}

function extractImportDecl(node: SyntaxNode): ExtractedImport | null {
  // import_declaration: import [static] scoped_identifier ;
  // or: import scoped_identifier . * ;  (asterisk_import)
  const scoped = findChild(node, 'scoped_identifier')
  if (!scoped) return null

  const fullPath = flattenScopedIdentifier(scoped)
  // Check for wildcard import (import com.example.*)
  const hasAsterisk = findChild(node, 'asterisk')
  const symbol = hasAsterisk ? '*' : fullPath.split('.').pop()!

  return {
    symbol,
    fromPath: hasAsterisk ? fullPath + '.*' : fullPath,
    isTypeOnly: false,
  }
}

function extractCalls(node: SyntaxNode, parentSymbol?: string): ExtractedCall[] {
  const calls: ExtractedCall[] = []

  if (node.type === 'method_invocation') {
    // Method invocation: [object.]method(args)
    // Children: optional object, '.', identifier (method name), argument_list
    let calleeName = ''
    const children: SyntaxNode[] = []
    for (let i = 0; i < node.childCount; i++) children.push(node.child(i)!)

    // Find the method name identifier (last identifier before argument_list)
    const methodIdent = children.filter(c => c.type === 'identifier').pop()
    const fieldAccess = findChild(node, 'field_access')

    if (fieldAccess && methodIdent) {
      calleeName = `${getTextOf(fieldAccess)}.${getTextOf(methodIdent)}`
    } else if (children[0]?.type === 'identifier' && children[1]?.type === '.' && methodIdent && children[0] !== methodIdent) {
      calleeName = `${getTextOf(children[0])}.${getTextOf(methodIdent)}`
    } else if (methodIdent) {
      calleeName = getTextOf(methodIdent)
    }

    if (calleeName) {
      calls.push({ calleeName, line: node.startPosition.row + 1, parentSymbol })
    }
  } else if (node.type === 'object_creation_expression') {
    // new ClassName(args)
    const typeId = findChild(node, 'type_identifier')
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
  if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
    const nameNode = findChild(node, 'identifier')
    if (nameNode) {
      // Check if inside a class
      const parent = node.parent
      if (parent?.type === 'class_body') {
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

// ── Main entry ──

export function extractJava(root: SyntaxNode): ExtractionResult {
  const symbols: ExtractedSymbol[] = []
  const imports: ExtractedImport[] = []
  const exports: ExtractedExport[] = []

  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i)!

    switch (node.type) {
      case 'class_declaration':
        symbols.push(...extractClassDecl(node))
        break
      case 'interface_declaration':
        symbols.push(...extractInterfaceDecl(node))
        break
      case 'enum_declaration': {
        const sym = extractEnumDecl(node)
        if (sym) symbols.push(sym)
        break
      }
      case 'import_declaration': {
        const imp = extractImportDecl(node)
        if (imp) imports.push(imp)
        break
      }
    }
  }

  // Public symbols are exports
  for (const sym of symbols) {
    if (sym.isExported) {
      exports.push({ symbol: sym.name, kind: sym.kind, isReexport: false })
    }
  }

  const calls = extractCalls(root)
  return { symbols, imports, exports, calls }
}

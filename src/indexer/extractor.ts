import type { Tree, SyntaxNode } from './parser.js'
import { getLanguageName } from './parser.js'
import { extractTypeScript } from '../languages/typescript.js'
import { extractJavaScript } from '../languages/javascript.js'
import { extractPython } from '../languages/python.js'
import { extractGo } from '../languages/go.js'
import { extractRust } from '../languages/rust.js'
import { extractJava } from '../languages/java.js'
import { extractCSharp } from '../languages/csharp.js'
import type { ExtractionResult } from '../languages/typescript.js'

export type { ExtractionResult, ExtractedSymbol, ExtractedImport, ExtractedExport, ExtractedCall } from '../languages/typescript.js'

/** Generic identifier reference extraction — works for all languages.
 *  Collects all identifier/type_identifier nodes except definition names. */
export function extractRefsGeneric(root: SyntaxNode, defParents: Set<string>, idTypes = ['identifier', 'type_identifier']): string[] {
  const refs = new Set<string>()
  const idSet = new Set(idTypes)
  function walk(node: SyntaxNode) {
    if (idSet.has(node.type) && node.parent && !defParents.has(node.parent.type)) {
      refs.add(node.text)
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i)!)
  }
  walk(root)
  return [...refs]
}

const extractors: Record<string, (root: any) => ExtractionResult> = {
  typescript: extractTypeScript,
  tsx: extractTypeScript,
  javascript: extractJavaScript,
  python: extractPython,
  go: extractGo,
  rust: extractRust,
  java: extractJava,
  c_sharp: extractCSharp,
}

export function extract(tree: Tree, filePath: string): ExtractionResult | null {
  const lang = getLanguageName(filePath)
  if (!lang) return null
  const fn = extractors[lang]
  if (!fn) return null
  return fn(tree.rootNode)
}

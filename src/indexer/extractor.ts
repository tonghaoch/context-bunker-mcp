import type { Tree } from './parser.js'
import { getLanguageName } from './parser.js'
import { extractTypeScript } from '../languages/typescript.js'
import { extractJavaScript } from '../languages/javascript.js'
import { extractPython } from '../languages/python.js'
import { extractGo } from '../languages/go.js'
import { extractRust } from '../languages/rust.js'
import type { ExtractionResult } from '../languages/typescript.js'

export type { ExtractionResult, ExtractedSymbol, ExtractedImport, ExtractedExport, ExtractedCall } from '../languages/typescript.js'

const extractors: Record<string, (root: any) => ExtractionResult> = {
  typescript: extractTypeScript,
  tsx: extractTypeScript,
  javascript: extractJavaScript,
  python: extractPython,
  go: extractGo,
  rust: extractRust,
}

export function extract(tree: Tree, filePath: string): ExtractionResult | null {
  const lang = getLanguageName(filePath)
  if (!lang) return null
  const fn = extractors[lang]
  if (!fn) return null
  return fn(tree.rootNode)
}

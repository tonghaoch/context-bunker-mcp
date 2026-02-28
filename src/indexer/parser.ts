import { join, extname } from 'node:path'
import { readFileSync } from 'node:fs'
import TreeSitter from 'web-tree-sitter'

type Language = TreeSitter.Language
type Tree = TreeSitter.Tree

const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
}

const SUPPORTED_EXTENSIONS = new Set(Object.keys(LANG_MAP))

let parser: TreeSitter | null = null
const languageCache = new Map<string, Language>()

function getWasmPath(langName: string): string {
  // Resolve from tree-sitter-wasms package
  const wasmDir = join(
    import.meta.dirname ?? __dirname,
    '..', '..', 'node_modules', 'tree-sitter-wasms', 'out'
  )
  return join(wasmDir, `tree-sitter-${langName}.wasm`)
}

export async function initParser(): Promise<void> {
  if (parser) return
  await TreeSitter.init()
  parser = new TreeSitter()
}

async function loadLanguage(langName: string): Promise<Language> {
  const cached = languageCache.get(langName)
  if (cached) return cached

  const wasmPath = getWasmPath(langName)
  const wasmBuf = readFileSync(wasmPath)
  const lang = await TreeSitter.Language.load(wasmBuf)
  languageCache.set(langName, lang)
  return lang
}

export function isSupportedFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(filePath))
}

export function getLanguageName(filePath: string): string | null {
  return LANG_MAP[extname(filePath)] ?? null
}

export async function parseFile(content: string, filePath: string): Promise<Tree | null> {
  if (!parser) throw new Error('Parser not initialized. Call initParser() first.')

  const langName = getLanguageName(filePath)
  if (!langName) return null

  const language = await loadLanguage(langName)
  parser.setLanguage(language)
  return parser.parse(content)
}

export { type Tree, type Language }
export type SyntaxNode = TreeSitter.SyntaxNode

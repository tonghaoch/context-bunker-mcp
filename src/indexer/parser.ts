import { join, dirname, extname } from 'node:path'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import TreeSitter from 'web-tree-sitter'

type Language = TreeSitter.Language
type Tree = TreeSitter.Tree

const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'c_sharp',
}

const SUPPORTED_EXTENSIONS = new Set(Object.keys(LANG_MAP))

let parser: TreeSitter | null = null
const languageCache = new Map<string, Language>()

function getWasmPath(langName: string): string {
  // Use createRequire to resolve at runtime (not baked-in __dirname)
  const req = createRequire(import.meta.url)
  const wasmDir = join(dirname(req.resolve('tree-sitter-wasms/package.json')), 'out')
  return join(wasmDir, `tree-sitter-${langName}.wasm`)
}

export async function initParser(): Promise<void> {
  if (parser) return
  try {
    await TreeSitter.init()
    parser = new TreeSitter()
  } catch (err) {
    throw new Error(`Failed to initialize tree-sitter: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
}

async function loadLanguage(langName: string): Promise<Language> {
  const cached = languageCache.get(langName)
  if (cached) return cached

  const wasmPath = getWasmPath(langName)
  let wasmBuf: Buffer
  try {
    wasmBuf = readFileSync(wasmPath)
  } catch (err) {
    throw new Error(`Failed to load WASM for ${langName} at ${wasmPath}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
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

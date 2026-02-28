import { resolve, dirname, join, relative, isAbsolute } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

interface TsConfigPaths {
  baseUrl?: string
  paths?: Record<string, string[]>
}

let cachedTsConfig: TsConfigPaths | null = null
let cachedProjectRoot: string | null = null

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

function loadTsConfig(projectRoot: string): TsConfigPaths {
  if (cachedProjectRoot === projectRoot && cachedTsConfig) return cachedTsConfig
  cachedProjectRoot = projectRoot

  const tsConfigPath = join(projectRoot, 'tsconfig.json')
  if (!existsSync(tsConfigPath)) {
    cachedTsConfig = {}
    return cachedTsConfig
  }
  try {
    // Strip comments (simple: remove // and /* */ style)
    const raw = readFileSync(tsConfigPath, 'utf-8')
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    const config = JSON.parse(raw)
    cachedTsConfig = {
      baseUrl: config.compilerOptions?.baseUrl,
      paths: config.compilerOptions?.paths,
    }
  } catch {
    cachedTsConfig = {}
  }
  return cachedTsConfig
}

function stripJsExtension(p: string): string {
  // TS projects import with .js extension targeting compiled output
  // Strip it so we can find the actual .ts source file
  return p.replace(/\.(js|mjs|cjs|jsx)$/, '')
}

function tryResolveFile(basePath: string): string | null {
  // Exact file exists
  if (existsSync(basePath)) return basePath

  // Strip .js extension (TS imports use .js for compiled output)
  const stripped = stripJsExtension(basePath)

  // Try extensions on stripped path
  for (const ext of EXTENSIONS) {
    const withExt = stripped + ext
    if (existsSync(withExt)) return withExt
  }

  // Try extensions on original path (in case basePath has no extension)
  if (stripped === basePath) {
    // Already tried above, skip
  } else {
    // Also try index files on stripped
    for (const ext of EXTENSIONS) {
      const indexFile = join(stripped, `index${ext}`)
      if (existsSync(indexFile)) return indexFile
    }
  }

  // Try index files (barrel) on original
  for (const ext of EXTENSIONS) {
    const indexFile = join(basePath, `index${ext}`)
    if (existsSync(indexFile)) return indexFile
  }

  return null
}

export function resolveImportPath(
  fromPath: string,
  importingFile: string,
  projectRoot: string
): { resolved: string; isExternal: boolean } {
  // External module (no relative path prefix, no alias match)
  if (!fromPath.startsWith('.') && !fromPath.startsWith('/')) {
    // Check tsconfig paths first
    const tsConfig = loadTsConfig(projectRoot)
    if (tsConfig.paths) {
      for (const [pattern, targets] of Object.entries(tsConfig.paths)) {
        const prefix = pattern.replace(/\*$/, '')
        if (fromPath.startsWith(prefix)) {
          const rest = fromPath.slice(prefix.length)
          for (const target of targets) {
            const targetPrefix = target.replace(/\*$/, '')
            const base = tsConfig.baseUrl
              ? resolve(projectRoot, tsConfig.baseUrl, targetPrefix, rest)
              : resolve(projectRoot, targetPrefix, rest)
            const resolved = tryResolveFile(base)
            if (resolved) {
              return { resolved: relative(projectRoot, resolved), isExternal: false }
            }
          }
        }
      }
    }

    // Check baseUrl
    if (tsConfig.baseUrl) {
      const base = resolve(projectRoot, tsConfig.baseUrl, fromPath)
      const resolved = tryResolveFile(base)
      if (resolved) {
        return { resolved: relative(projectRoot, resolved), isExternal: false }
      }
    }

    // External package
    return { resolved: fromPath, isExternal: true }
  }

  // Relative path
  const dir = dirname(importingFile)
  const absBase = isAbsolute(fromPath) ? fromPath : resolve(dir, fromPath)
  const resolved = tryResolveFile(absBase)
  if (resolved) {
    return { resolved: relative(projectRoot, resolved), isExternal: false }
  }

  // Fallback: return as-is relative to project root
  return { resolved: relative(projectRoot, absBase), isExternal: false }
}

export function clearResolverCache() {
  cachedTsConfig = null
  cachedProjectRoot = null
}

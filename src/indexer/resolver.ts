import { resolve, dirname, join, relative, isAbsolute } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const toForward = (p: string) => p.replace(/\\/g, '/')

interface TsConfigPaths {
  baseUrl?: string
  paths?: Record<string, string[]>
}

let cachedTsConfig: TsConfigPaths | null = null
let cachedProjectRoot: string | null = null
let cachedGoModule: string | null = null
let cachedGoModRoot: string | null = null
let resolveCache: Map<string, string | null> | null = null
let dirCache: Map<string, Set<string>> | null = null

export function enableResolveCache() {
  resolveCache = new Map()
  dirCache = new Map()
}

export function disableResolveCache() {
  resolveCache = null
  dirCache = null
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const PY_EXTENSIONS = ['.py']

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

function fileExists(filePath: string): boolean {
  if (dirCache) {
    const dir = dirname(filePath)
    const base = filePath.slice(dir.length + 1)
    let entries = dirCache.get(dir)
    if (!entries) {
      try {
        entries = new Set(readdirSync(dir))
      } catch {
        entries = new Set()
      }
      dirCache.set(dir, entries)
    }
    return entries.has(base)
  }
  return existsSync(filePath)
}

function tryResolveFileUncached(basePath: string): string | null {
  // Exact file exists
  if (fileExists(basePath)) return basePath

  // Strip .js extension (TS imports use .js for compiled output)
  const stripped = stripJsExtension(basePath)

  // Try extensions on stripped path
  for (const ext of EXTENSIONS) {
    const withExt = stripped + ext
    if (fileExists(withExt)) return withExt
  }

  // Try extensions on original path (in case basePath has no extension)
  if (stripped === basePath) {
    // Already tried above, skip
  } else {
    // Also try index files on stripped
    for (const ext of EXTENSIONS) {
      const indexFile = join(stripped, `index${ext}`)
      if (fileExists(indexFile)) return indexFile
    }
  }

  // Try index files (barrel) on original
  for (const ext of EXTENSIONS) {
    const indexFile = join(basePath, `index${ext}`)
    if (fileExists(indexFile)) return indexFile
  }

  return null
}

function tryResolveFile(basePath: string): string | null {
  if (resolveCache) {
    const cached = resolveCache.get(basePath)
    if (cached !== undefined) return cached
  }
  const result = tryResolveFileUncached(basePath)
  resolveCache?.set(basePath, result)
  return result
}

function loadGoModule(projectRoot: string): string | null {
  if (cachedGoModRoot === projectRoot) return cachedGoModule
  cachedGoModRoot = projectRoot
  const goModPath = join(projectRoot, 'go.mod')
  if (!existsSync(goModPath)) { cachedGoModule = null; return null }
  try {
    const raw = readFileSync(goModPath, 'utf-8')
    const match = raw.match(/^module\s+(\S+)/m)
    cachedGoModule = match?.[1] ?? null
  } catch { cachedGoModule = null }
  return cachedGoModule
}

function tryResolvePython(basePath: string): string | null {
  for (const ext of PY_EXTENSIONS) {
    if (existsSync(basePath + ext)) return basePath + ext
  }
  // Check __init__.py (package directory)
  const initPath = join(basePath, '__init__.py')
  if (existsSync(initPath)) return initPath
  return null
}

function resolvePythonImport(
  fromPath: string,
  importingFile: string,
  projectRoot: string,
): { resolved: string; isExternal: boolean } {
  // Relative import: starts with dots
  if (fromPath.startsWith('.')) {
    const dots = fromPath.match(/^(\.+)/)![1]
    const rest = fromPath.slice(dots.length).replace(/\./g, '/')
    const dir = dirname(importingFile)
    // Each dot beyond the first goes up one directory
    let base = dir
    for (let i = 1; i < dots.length; i++) base = dirname(base)
    const absBase = rest ? join(base, rest) : base
    const resolved = tryResolvePython(absBase)
    if (resolved) return { resolved: toForward(relative(projectRoot, resolved)), isExternal: false }
    return { resolved: toForward(relative(projectRoot, absBase)), isExternal: false }
  }
  // Absolute import: check if it maps to a local file
  const asPath = fromPath.replace(/\./g, '/')
  const absBase = join(projectRoot, asPath)
  const resolved = tryResolvePython(absBase)
  if (resolved) return { resolved: toForward(relative(projectRoot, resolved)), isExternal: false }
  return { resolved: fromPath, isExternal: true }
}

function resolveGoImport(
  fromPath: string,
  projectRoot: string,
): { resolved: string; isExternal: boolean } {
  const moduleName = loadGoModule(projectRoot)
  if (moduleName && fromPath.startsWith(moduleName + '/')) {
    const localPath = fromPath.slice(moduleName.length + 1)
    // Go imports resolve to package directories — try to find actual .go files
    const dirPath = join(projectRoot, localPath)
    if (existsSync(dirPath)) {
      try {
        const files = readdirSync(dirPath).filter(f => f.endsWith('.go') && !f.endsWith('_test.go'))
        if (files.length > 0) {
          return { resolved: toForward(join(localPath, files[0])), isExternal: false }
        }
      } catch { /* fallthrough */ }
    }
    return { resolved: toForward(localPath), isExternal: false }
  }
  return { resolved: fromPath, isExternal: true }
}

function resolveRustImport(
  fromPath: string,
  importingFile: string,
  projectRoot: string,
): { resolved: string; isExternal: boolean } {
  // crate:: → local, resolve to src/ path
  if (fromPath.startsWith('crate::')) {
    const rest = fromPath.slice('crate::'.length).replace(/::/g, '/')
    // Try src/{rest}.rs or src/{rest}/mod.rs
    const base = join(projectRoot, 'src', rest)
    if (existsSync(base + '.rs')) return { resolved: toForward(relative(projectRoot, base + '.rs')), isExternal: false }
    const modPath = join(base, 'mod.rs')
    if (existsSync(modPath)) return { resolved: toForward(relative(projectRoot, modPath)), isExternal: false }
    return { resolved: 'src/' + rest.replace(/\//g, '/') + '.rs', isExternal: false }
  }
  // super:: → relative parent module
  if (fromPath.startsWith('super::')) {
    const rest = fromPath.slice('super::'.length).replace(/::/g, '/')
    const dir = dirname(importingFile)
    const parent = dirname(dir)
    const base = join(parent, rest)
    if (existsSync(base + '.rs')) return { resolved: toForward(relative(projectRoot, base + '.rs')), isExternal: false }
    return { resolved: toForward(relative(projectRoot, base)) + '.rs', isExternal: false }
  }
  // self:: → current module
  if (fromPath.startsWith('self::')) {
    const rest = fromPath.slice('self::'.length).replace(/::/g, '/')
    const dir = dirname(importingFile)
    const base = join(dir, rest)
    if (existsSync(base + '.rs')) return { resolved: toForward(relative(projectRoot, base + '.rs')), isExternal: false }
    return { resolved: toForward(relative(projectRoot, base)) + '.rs', isExternal: false }
  }
  // External crate
  return { resolved: fromPath, isExternal: true }
}

const JAVA_SOURCE_ROOTS = ['src/main/java', 'src']

function resolveJavaImport(
  fromPath: string,
  projectRoot: string,
): { resolved: string; isExternal: boolean } {
  // Convert dots to path separators: com.example.User → com/example/User
  const asPath = fromPath.replace(/\.\*/g, '').replace(/\./g, '/')
  // Try common source roots
  for (const srcRoot of JAVA_SOURCE_ROOTS) {
    const candidate = join(projectRoot, srcRoot, asPath + '.java')
    if (existsSync(candidate)) {
      return { resolved: toForward(relative(projectRoot, candidate)), isExternal: false }
    }
    // Try as directory (package import)
    const dirCandidate = join(projectRoot, srcRoot, asPath)
    if (existsSync(dirCandidate)) {
      try {
        const files = readdirSync(dirCandidate).filter(f => f.endsWith('.java'))
        if (files.length > 0) {
          return { resolved: toForward(join(relative(projectRoot, dirCandidate), files[0])), isExternal: false }
        }
      } catch { /* fallthrough */ }
    }
  }
  // Try project root directly
  const directCandidate = join(projectRoot, asPath + '.java')
  if (existsSync(directCandidate)) {
    return { resolved: toForward(relative(projectRoot, directCandidate)), isExternal: false }
  }
  return { resolved: fromPath, isExternal: true }
}

function resolveCSharpImport(
  fromPath: string,
): { resolved: string; isExternal: boolean } {
  // C# namespaces don't map to filesystem — mark all as external
  return { resolved: fromPath, isExternal: true }
}

export function resolveImportPath(
  fromPath: string,
  importingFile: string,
  projectRoot: string,
  language?: string,
): { resolved: string; isExternal: boolean } {
  if (language === 'python') return resolvePythonImport(fromPath, importingFile, projectRoot)
  if (language === 'go') return resolveGoImport(fromPath, projectRoot)
  if (language === 'rust') return resolveRustImport(fromPath, importingFile, projectRoot)
  if (language === 'java') return resolveJavaImport(fromPath, projectRoot)
  if (language === 'c_sharp') return resolveCSharpImport(fromPath)
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
              return { resolved: toForward(relative(projectRoot, resolved)), isExternal: false }
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
        return { resolved: toForward(relative(projectRoot, resolved)), isExternal: false }
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
    return { resolved: toForward(relative(projectRoot, resolved)), isExternal: false }
  }

  // Fallback: return as-is relative to project root
  return { resolved: toForward(relative(projectRoot, absBase)), isExternal: false }
}

export function clearResolverCache() {
  cachedTsConfig = null
  cachedProjectRoot = null
  cachedGoModule = null
  cachedGoModRoot = null
  resolveCache = null
  dirCache = null
}

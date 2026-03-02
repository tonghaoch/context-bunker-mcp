import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface Config {
  include: string[]
  exclude: string[]
  languages: string[]
  maxFileSize: number
  storage: 'global' | 'local'
}

const CONFIG_FILE = '.context-bunker.json'

export const SUPPORTED_LANGUAGES = new Set(['typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'java', 'c_sharp'])

const DEFAULT_CONFIG: Config = {
  include: ['src/', 'lib/', 'app/', 'packages/'],
  exclude: [
    '**/*.test.ts', '**/*.spec.ts', '**/*.test.tsx', '**/*.spec.tsx',
    '**/*.test.js', '**/*.spec.js', '**/*.test.jsx', '**/*.spec.jsx',
    '**/*.test.mts', '**/*.spec.mts',
    '**/__tests__/**', '**/__mocks__/**',
    '**/test_*.py',  // Python prefix convention
    '**/*_test.py',  // Python suffix convention
    '**/*_test.go',  // Go convention
    '**/*_test.rs',  // Rust convention
    '**/tests/**/*.rs',  // Rust integration tests
    '**/*Test.java',  // Java convention
    '**/test/**/*.java',  // Java test directory
    '**/Tests/**/*.cs',  // C# test directory
  ],
  languages: ['typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'java', 'c_sharp'],
  maxFileSize: 1_048_576, // 1MB
  storage: 'global',
}

export function loadConfig(projectRoot: string): Config {
  const configPath = join(projectRoot, CONFIG_FILE)
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG }

  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw)
    const config: Config = {
      include: parsed.include ?? DEFAULT_CONFIG.include,
      exclude: parsed.exclude ?? DEFAULT_CONFIG.exclude,
      languages: parsed.languages ?? DEFAULT_CONFIG.languages,
      maxFileSize: parsed.maxFileSize ?? DEFAULT_CONFIG.maxFileSize,
      storage: parsed.storage === 'local' ? 'local' : DEFAULT_CONFIG.storage,
    }
    // Warn on unsupported languages
    const invalid = config.languages.filter((l: string) => !SUPPORTED_LANGUAGES.has(l))
    if (invalid.length > 0) {
      console.error(`[context-bunker] Warning: unsupported languages: ${invalid.join(', ')}. Supported: ${[...SUPPORTED_LANGUAGES].join(', ')}`)
    }
    return config
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function initConfig(projectRoot: string): string {
  const configPath = join(projectRoot, CONFIG_FILE)
  if (existsSync(configPath)) return `Config already exists: ${configPath}`

  writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n')
  return `Created ${configPath}`
}

export { CONFIG_FILE, DEFAULT_CONFIG }

// ── DB path resolution ──

export function getCacheDir(): string {
  if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches')
  if (process.platform === 'win32') return process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return join(homedir(), '.cache')
}

export function encodeProjectPath(absPath: string): string {
  return absPath.replace(/[\\/]/g, '-').replace(/^-/, '').replace(/:/, '')
}

export function getDbPath(projectRoot: string, storage: 'global' | 'local' = 'global'): string {
  if (storage === 'local') {
    return join(projectRoot, '.context-bunker', 'index.db')
  }
  const cacheDir = getCacheDir()
  const encoded = encodeProjectPath(projectRoot)
  return join(cacheDir, 'context-bunker', encoded, 'index.db')
}

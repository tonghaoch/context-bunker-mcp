import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Config {
  include: string[]
  exclude: string[]
  languages: string[]
  maxFileSize: number
}

const CONFIG_FILE = '.context-bunker.json'

const DEFAULT_CONFIG: Config = {
  include: ['src/', 'lib/', 'app/', 'packages/'],
  exclude: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**', '**/__mocks__/**'],
  languages: ['typescript', 'javascript'],
  maxFileSize: 1_048_576, // 1MB
}

export function loadConfig(projectRoot: string): Config {
  const configPath = join(projectRoot, CONFIG_FILE)
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG }

  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw)
    return {
      include: parsed.include ?? DEFAULT_CONFIG.include,
      exclude: parsed.exclude ?? DEFAULT_CONFIG.exclude,
      languages: parsed.languages ?? DEFAULT_CONFIG.languages,
      maxFileSize: parsed.maxFileSize ?? DEFAULT_CONFIG.maxFileSize,
    }
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

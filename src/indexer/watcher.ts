import { watch } from 'chokidar'
import { isSupportedFile } from './parser.js'

interface WatcherCallbacks {
  onAdd(filePath: string): void | Promise<void>
  onChange(filePath: string): void | Promise<void>
  onUnlink(filePath: string): void | Promise<void>
  onError?(err: Error): void
}

const IGNORED = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.context-bunker/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.svelte-kit/**',
  '**/out/**',
  '**/*.d.ts',
  '**/*.d.mts',
  '**/*.d.cts',
  // Python
  '**/__pycache__/**',
  '**/venv/**',
  '**/env/**',
  '**/.venv/**',
  '**/.mypy_cache/**',
  '**/.pytest_cache/**',
  '**/.ruff_cache/**',
  '**/.tox/**',
  '**/*.egg-info/**',
  // Go
  '**/vendor/**',
  // Rust
  '**/target/**',
  // General dot-directories (IDE, caches, etc.)
  '**/.turbo/**',
  '**/.parcel-cache/**',
  '**/.cache/**',
  '**/.idea/**',
  '**/.vscode/**',
]

export function startWatcher(projectRoot: string, callbacks: WatcherCallbacks) {
  const watcher = watch(projectRoot, {
    ignored: IGNORED,
    persistent: true,
    ignoreInitial: true, // we do full index on startup
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  })

  watcher.on('add', (path) => {
    if (isSupportedFile(path)) callbacks.onAdd(path)
  })

  watcher.on('change', (path) => {
    if (isSupportedFile(path)) callbacks.onChange(path)
  })

  watcher.on('unlink', (path) => {
    if (isSupportedFile(path)) callbacks.onUnlink(path)
  })

  watcher.on('error', (err: unknown) => {
    callbacks.onError?.(err instanceof Error ? err : new Error(String(err)))
  })

  return {
    close: () => watcher.close(),
  }
}

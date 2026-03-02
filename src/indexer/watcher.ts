import { watch } from 'chokidar'
import { isSupportedFile } from './parser.js'

interface WatcherCallbacks {
  onAdd(filePath: string): void | Promise<void>
  onChange(filePath: string): void | Promise<void>
  onUnlink(filePath: string): void | Promise<void>
  /** Called when a watcher system error occurs (e.g., ENOSPC). Watcher may stop working. */
  onError?(err: Error): void
  /** Called when an async callback (onAdd/onChange/onUnlink) rejects. Watcher keeps running. */
  onCallbackError?(err: Error, filePath: string, event: string): void
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

  const toError = (e: unknown) => e instanceof Error ? e : new Error(String(e))

  watcher.on('add', (path) => {
    if (isSupportedFile(path)) Promise.resolve(callbacks.onAdd(path)).catch(e => callbacks.onCallbackError?.(toError(e), path, 'add'))
  })

  watcher.on('change', (path) => {
    if (isSupportedFile(path)) Promise.resolve(callbacks.onChange(path)).catch(e => callbacks.onCallbackError?.(toError(e), path, 'change'))
  })

  watcher.on('unlink', (path) => {
    if (isSupportedFile(path)) Promise.resolve(callbacks.onUnlink(path)).catch(e => callbacks.onCallbackError?.(toError(e), path, 'unlink'))
  })

  watcher.on('error', (err: unknown) => {
    callbacks.onError?.(toError(err))
  })

  return {
    close: () => watcher.close(),
  }
}

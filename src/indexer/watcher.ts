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

const DEBOUNCE_MS = 300

export function startWatcher(projectRoot: string, callbacks: WatcherCallbacks) {
  const pendingChanges = new Map<string, 'add' | 'change'>()
  const pendingUnlinks = new Set<string>()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const toError = (e: unknown) => e instanceof Error ? e : new Error(String(e))

  function flush() {
    debounceTimer = null
    const changes = new Map(pendingChanges)
    const unlinks = new Set(pendingUnlinks)
    pendingChanges.clear()
    pendingUnlinks.clear()

    for (const path of unlinks) {
      if (!changes.has(path)) {
        Promise.resolve(callbacks.onUnlink(path))
          .catch(e => callbacks.onCallbackError?.(toError(e), path, 'unlink'))
      }
    }
    for (const [path, event] of changes) {
      const cb = event === 'add' ? callbacks.onAdd : callbacks.onChange
      Promise.resolve(cb(path))
        .catch(e => callbacks.onCallbackError?.(toError(e), path, event))
    }
  }

  function schedule() {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(flush, DEBOUNCE_MS)
  }

  const watcher = watch(projectRoot, {
    ignored: IGNORED,
    persistent: true,
    ignoreInitial: true, // we do full index on startup
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    depth: 20, // limit depth to avoid excessive inotify watches in large projects
  })

  watcher.on('add', (path) => {
    if (isSupportedFile(path)) {
      pendingChanges.set(path, 'add')
      pendingUnlinks.delete(path)
      schedule()
    }
  })

  watcher.on('change', (path) => {
    if (isSupportedFile(path)) {
      pendingChanges.set(path, pendingChanges.get(path) ?? 'change')
      schedule()
    }
  })

  watcher.on('unlink', (path) => {
    if (isSupportedFile(path)) {
      pendingUnlinks.add(path)
      pendingChanges.delete(path)
      schedule()
    }
  })

  watcher.on('error', (err: unknown) => {
    callbacks.onError?.(toError(err))
  })

  return {
    close: () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      return watcher.close()
    },
  }
}

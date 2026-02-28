import { watch } from 'chokidar'
import { isSupportedFile } from './parser.js'

export interface WatcherCallbacks {
  onAdd(filePath: string): void | Promise<void>
  onChange(filePath: string): void | Promise<void>
  onUnlink(filePath: string): void | Promise<void>
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

  return {
    close: () => watcher.close(),
  }
}

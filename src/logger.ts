import { mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getCacheDir } from './config.js'

export interface Logger {
  info(...msg: unknown[]): void
  warn(...msg: unknown[]): void
  error(...msg: unknown[]): void
  fatal(context: string, err: unknown, state?: Record<string, unknown>): void
  flush(): void
  logPath: string
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    const parts = [`${err.name}: ${err.message}`]
    if ((err as any).code) parts[0] += ` (code: ${(err as any).code})`
    if (err.stack) {
      const stackLines = err.stack.split('\n').slice(1) // skip first line (already in message)
      parts.push(...stackLines)
    }
    if (err.cause) parts.push(`  caused by: ${formatError(err.cause)}`)
    return parts.join('\n')
  }
  return String(err)
}

function formatArgs(msg: unknown[]): string {
  return msg.map(m => {
    if (typeof m === 'string') return m
    if (m instanceof Error) return formatError(m)
    try { return JSON.stringify(m) } catch { return String(m) }
  }).join(' ')
}

function ts(): string {
  return new Date().toISOString()
}

function cleanOldLogs(logDir: string, maxAgeDays: number) {
  try {
    const cutoff = Date.now() - maxAgeDays * 86_400_000
    for (const f of readdirSync(logDir)) {
      if (!f.startsWith('session-') || !f.endsWith('.log')) continue
      const fp = join(logDir, f)
      try {
        if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp)
      } catch { /* ignore per-file errors */ }
    }
  } catch { /* dir may not exist yet */ }
}

export function createLogger(verbose: boolean): Logger {
  const logDir = join(getCacheDir(), 'context-bunker', 'logs')
  let canWriteFile = true
  let logPath = ''

  try {
    mkdirSync(logDir, { recursive: true })
    const now = new Date()
    const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
    logPath = join(logDir, `session-${stamp}.log`)

    cleanOldLogs(logDir, 7)

    const header = [
      `=== context-bunker MCP server ===`,
      `Session started: ${now.toISOString()}`,
      `PID: ${process.pid}`,
      `Node: ${process.version}`,
      `Platform: ${process.platform} ${process.arch}`,
      `---`,
      '',
    ].join('\n')
    appendFileSync(logPath, header)
  } catch {
    canWriteFile = false
    console.error('[context-bunker] WARN: Could not create log file, falling back to stderr only')
  }

  function write(level: string, msg: string) {
    const line = `[${ts()}] [${level}] ${msg}\n`
    if (canWriteFile) {
      try { appendFileSync(logPath, line) } catch { canWriteFile = false }
    }
  }

  const logger: Logger = {
    logPath,

    info(...msg: unknown[]) {
      const text = formatArgs(msg)
      write('INFO ', text)
      if (verbose) console.error(`[context-bunker] ${text}`)
    },

    warn(...msg: unknown[]) {
      const text = formatArgs(msg)
      write('WARN ', text)
      console.error(`[context-bunker] WARN: ${text}`)
    },

    error(...msg: unknown[]) {
      const text = formatArgs(msg)
      write('ERROR', text)
      console.error(`[context-bunker] ERROR: ${text}`)
    },

    fatal(context: string, err: unknown, state?: Record<string, unknown>) {
      const parts = [`[${ts()}] [FATAL] ${context}: ${formatError(err)}`]
      if (state && Object.keys(state).length > 0) {
        parts.push('  --- server state ---')
        for (const [k, v] of Object.entries(state)) {
          if (v !== undefined) parts.push(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        }
      }
      parts.push('')
      const block = parts.join('\n')
      try { appendFileSync(logPath, block) } catch { /* last resort */ }
      console.error(`[context-bunker] FATAL: ${context}: ${err instanceof Error ? err.message : String(err)}`)
      console.error(`[context-bunker] Log file: ${logPath}`)
    },

    flush() {
      // appendFileSync is already synchronous — nothing buffered to flush.
      // This method exists so callers have a consistent shutdown API.
      write('INFO ', 'Logger flushed — session ending')
    },
  }

  return logger
}

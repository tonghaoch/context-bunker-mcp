import type { DB } from '../store/db.js'

type PatternType = 'http_calls' | 'env_access' | 'error_handlers' | 'async_functions' | 'todos' | 'test_files'

const PATTERN_DESCRIPTIONS: Record<PatternType, string> = {
  http_calls: 'Functions that make HTTP calls (fetch, axios, http, requests, httpx, aiohttp)',
  env_access: 'Code accessing environment variables (process.env, os.environ, os.Getenv)',
  error_handlers: 'Functions containing error handling (try/catch, except, recover)',
  async_functions: 'All async function definitions (TS/JS/Python)',
  todos: 'Functions containing TODO or FIXME comments',
  test_files: 'Test files (*.test.*, *.spec.*, *_test.go, test_*.py)',
}

export function searchByPattern(db: DB, pattern: string): string {
  if (!(pattern in PATTERN_DESCRIPTIONS)) {
    const available = Object.entries(PATTERN_DESCRIPTIONS)
      .map(([k, v]) => `  ${k} — ${v}`)
      .join('\n')
    return `Unknown pattern "${pattern}". Available patterns:\n${available}`
  }

  const p = pattern as PatternType

  switch (p) {
    case 'http_calls': {
      const rows = db.prepare(`
        SELECT DISTINCT c.callee_name, s.name as caller, f.path, c.line
        FROM calls c
        JOIN symbols s ON c.caller_symbol_id = s.id
        JOIN files f ON c.file_id = f.id
        WHERE c.callee_name LIKE 'fetch%'
           OR c.callee_name LIKE 'axios%'
           OR c.callee_name LIKE 'http.%'
           OR c.callee_name LIKE 'https.%'
           OR c.callee_name LIKE 'requests.%'
           OR c.callee_name LIKE 'urllib%'
           OR c.callee_name LIKE 'httpx.%'
           OR c.callee_name LIKE 'aiohttp.%'
           OR c.callee_name LIKE 'http.Get%'
           OR c.callee_name LIKE 'http.Post%'
           OR c.callee_name LIKE 'http.Do%'
           OR c.callee_name LIKE 'http.NewRequest%'
        ORDER BY f.path
      `).all() as { callee_name: string; caller: string; path: string; line: number }[]
      if (rows.length === 0) return 'No HTTP calls found.'
      return `HTTP calls (${rows.length}):\n` + rows.map(r =>
        `  ${r.caller} calls ${r.callee_name}  → ${r.path}:${r.line}`
      ).join('\n')
    }

    case 'env_access': {
      const rows = db.prepare(`
        SELECT DISTINCT c.callee_name, s.name as caller, f.path, c.line
        FROM calls c
        JOIN symbols s ON c.caller_symbol_id = s.id
        JOIN files f ON c.file_id = f.id
        WHERE c.callee_name LIKE 'process.env%'
           OR c.callee_name LIKE 'os.environ%'
           OR c.callee_name LIKE 'os.getenv%'
           OR c.callee_name LIKE 'os.Getenv%'
           OR c.callee_name LIKE 'os.LookupEnv%'
        ORDER BY f.path
      `).all() as { callee_name: string; caller: string; path: string; line: number }[]
      if (rows.length === 0) return 'No environment variable access found.'
      return `Environment variable access (${rows.length}):\n` + rows.map(r =>
        `  ${r.caller} accesses ${r.callee_name}  → ${r.path}:${r.line}`
      ).join('\n')
    }

    case 'async_functions': {
      const rows = db.prepare(`
        SELECT s.name, s.kind, s.is_exported, f.path, s.start_line
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE s.kind = 'function'
          AND s.signature LIKE 'async %'
        ORDER BY f.path
      `).all() as { name: string; kind: string; is_exported: number; path: string; start_line: number }[]

      if (rows.length === 0) return 'No async functions found.'
      return `Async functions (${rows.length}):\n` + rows.map(r => {
        const exp = r.is_exported ? 'export ' : ''
        return `  ${exp}${r.name}  → ${r.path}:${r.start_line}`
      }).join('\n')
    }

    case 'error_handlers': {
      // Find functions that call .catch() or console.error
      const callRows = db.prepare(`
        SELECT DISTINCT s.name, f.path, s.start_line
        FROM calls c
        JOIN symbols s ON c.caller_symbol_id = s.id
        JOIN files f ON c.file_id = f.id
        WHERE c.callee_name LIKE '%.catch%'
           OR c.callee_name LIKE 'console.error%'
        ORDER BY f.path
      `).all() as { name: string; path: string; start_line: number }[]

      // Also find files with try/catch/except/recover via TF-IDF
      const trycatchRows = db.prepare(`
        SELECT DISTINCT f.path
        FROM tfidf t
        JOIN files f ON t.file_id = f.id
        WHERE t.term IN ('catch', 'except', 'recover')
        ORDER BY f.path
      `).all() as { path: string }[]

      const seen = new Set<string>()
      const lines: string[] = []
      for (const r of callRows) {
        const key = `${r.path}:${r.name}`
        if (!seen.has(key)) { seen.add(key); lines.push(`  ${r.name}  → ${r.path}:${r.start_line}`) }
      }
      const callPaths = new Set(callRows.map(r => r.path))
      for (const r of trycatchRows) {
        if (!callPaths.has(r.path)) lines.push(`  (try/catch)  → ${r.path}`)
      }

      if (lines.length === 0) return 'No error handling patterns found.'
      return `Error handling patterns (${lines.length}):\n` + lines.join('\n')
    }

    case 'todos': {
      // Search TF-IDF index for TODO/FIXME terms
      const rows = db.prepare(`
        SELECT DISTINCT f.path
        FROM tfidf t
        JOIN files f ON t.file_id = f.id
        WHERE t.term IN ('todo', 'fixme', 'hack', 'xxx')
        ORDER BY f.path
      `).all() as { path: string }[]
      if (rows.length === 0) return 'No TODO/FIXME comments found.'
      return `Files with TODO/FIXME (${rows.length}):\n` + rows.map(r => `  ${r.path}`).join('\n')
    }

    case 'test_files': {
      const rows = db.prepare(`
        SELECT path, lines FROM files
        WHERE path LIKE '%.test.%'
           OR path LIKE '%.spec.%'
           OR path LIKE '%__tests__%'
           OR path LIKE '%test/%'
           OR path LIKE '%!_test.go' ESCAPE '!'
           OR path LIKE '%!_test.py' ESCAPE '!'
           OR path LIKE '%/test!_%' ESCAPE '!'
           OR path LIKE 'test!_%' ESCAPE '!'
        ORDER BY path
      `).all() as { path: string; lines: number }[]
      if (rows.length === 0) return 'No test files found.'
      return `Test files (${rows.length}):\n` + rows.map(r => `  ${r.path} (${r.lines} lines)`).join('\n')
    }
  }
}

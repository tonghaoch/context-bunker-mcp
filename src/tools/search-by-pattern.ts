import type { DB } from '../store/db.js'

type PatternType = 'http_calls' | 'env_access' | 'error_handlers' | 'async_functions' | 'todos' | 'test_files'

const PATTERN_DESCRIPTIONS: Record<PatternType, string> = {
  http_calls: 'Functions that make HTTP calls (fetch, axios, http)',
  env_access: 'Code accessing process.env',
  error_handlers: 'Functions containing try/catch blocks',
  async_functions: 'All async function definitions',
  todos: 'Functions containing TODO or FIXME comments',
  test_files: 'Test files (*.test.*, *.spec.*)',
}

export function searchByPattern(db: DB, pattern: string) {
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
        ORDER BY f.path
      `).all() as { callee_name: string; caller: string; path: string; line: number }[]
      if (rows.length === 0) return 'No process.env access found.'
      return `Environment variable access (${rows.length}):\n` + rows.map(r =>
        `  ${r.caller} accesses ${r.callee_name}  → ${r.path}:${r.line}`
      ).join('\n')
    }

    case 'async_functions': {
      const rows = db.prepare(`
        SELECT s.name, s.kind, s.is_exported, f.path, s.start_line, s.signature
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE (s.kind = 'function' OR s.kind = 'variable')
          AND s.signature LIKE '%async%'
        ORDER BY f.path
      `).all() as { name: string; kind: string; is_exported: number; path: string; start_line: number; signature: string }[]

      // Also check by looking at functions whose source starts with 'async'
      // (arrow functions stored as variables may not have async in signature)
      const rows2 = db.prepare(`
        SELECT s.name, s.kind, s.is_exported, f.path, s.start_line, s.signature
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE s.kind = 'function'
        ORDER BY f.path
      `).all() as { name: string; kind: string; is_exported: number; path: string; start_line: number; signature: string | null }[]

      // Merge and deduplicate
      const seen = new Set<string>()
      const all = [...rows, ...rows2.filter(r => r.signature?.includes('async'))].filter(r => {
        const key = `${r.path}:${r.name}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      if (all.length === 0) return 'No async functions found.'
      return `Async functions (${all.length}):\n` + all.map(r => {
        const exp = r.is_exported ? 'export ' : ''
        return `  ${exp}${r.name}  → ${r.path}:${r.start_line}`
      }).join('\n')
    }

    case 'error_handlers': {
      // We don't index try/catch directly, but we can find functions that call common error patterns
      const rows = db.prepare(`
        SELECT DISTINCT s.name, f.path, s.start_line
        FROM calls c
        JOIN symbols s ON c.caller_symbol_id = s.id
        JOIN files f ON c.file_id = f.id
        WHERE c.callee_name LIKE '%.catch%'
           OR c.callee_name LIKE 'console.error%'
        ORDER BY f.path
      `).all() as { name: string; path: string; start_line: number }[]
      if (rows.length === 0) return 'No error handling patterns found (searching for .catch() and console.error calls).'
      return `Error handling patterns (${rows.length}):\n` + rows.map(r =>
        `  ${r.name}  → ${r.path}:${r.start_line}`
      ).join('\n')
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
        ORDER BY path
      `).all() as { path: string; lines: number }[]
      if (rows.length === 0) return 'No test files found.'
      return `Test files (${rows.length}):\n` + rows.map(r => `  ${r.path} (${r.lines} lines)`).join('\n')
    }
  }
}

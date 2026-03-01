import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
import type { DB } from './store/db.js'
import { openDatabase } from './store/db.js'
import { getStats, startSession, endSession } from './store/queries.js'
import { indexProject, indexFile, removeFile } from './indexer/indexer.js'
import { initParser } from './indexer/parser.js'
import { startWatcher } from './indexer/watcher.js'
import { loadConfig, type Config } from './config.js'
import { buildFileSnapshot } from './tools/get-changes.js'
import { findSymbol } from './tools/find-symbol.js'
import { findReferences } from './tools/find-references.js'
import { getSmartContext } from './tools/get-smart-context.js'
import { getDependencyGraph } from './tools/get-dependency-graph.js'
import { getCallGraph } from './tools/get-call-graph.js'
import { getSymbolSource } from './tools/get-symbol-source.js'
import { getProjectMap } from './tools/get-project-map.js'
import { getChangesSinceLastSession } from './tools/get-changes.js'
import { findUnusedExports } from './tools/find-unused-exports.js'
import { searchByPattern } from './tools/search-by-pattern.js'
import { getFileSummary } from './tools/get-file-summary.js'
import { searchCode } from './tools/search-code.js'

// Mutable state — allows set_project to swap project at runtime
export interface ServerState {
  db: DB
  projectRoot: string
  config?: Config
  stopWatcher?: () => Promise<void>
  sessionId?: number
}

export function createServer(state: ServerState) {
  const server = new McpServer({
    name: 'context-bunker',
    version: '0.1.0',
  })

  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

  const requireProject = () => {
    if (!state.projectRoot || !state.db) {
      return 'No project set. Call set_project first with the path to your project.'
    }
    return null
  }

  // ── set_project ──
  server.tool(
    'set_project',
    'Set the project directory to index and analyze. Call this first if no project was specified at startup. Re-indexes automatically.',
    {
      path: z.string().describe('Absolute path to the project root directory'),
    },
    async ({ path: projectPath }) => {
      const absPath = resolve(projectPath)
      if (!existsSync(absPath)) return text(`Directory not found: ${absPath}`)

      // Stop old watcher and end old session before switching
      if (state.stopWatcher) {
        await state.stopWatcher()
        state.stopWatcher = undefined
      }
      if (state.sessionId != null && state.db) {
        endSession(state.db, state.sessionId, buildFileSnapshot(state.db))
        state.sessionId = undefined
      }

      // Close old DB if switching projects
      if (state.db && state.projectRoot !== absPath) {
        try { state.db.close() } catch { /* ignore */ }
      }

      // Open new DB
      const dbPath = join(absPath, '.context-bunker', 'index.db')
      state.db = await openDatabase(dbPath)
      state.projectRoot = absPath

      // Load config and index
      await initParser()
      const config = loadConfig(absPath)
      state.config = config
      const result = await indexProject(state.db, absPath, undefined, config)

      // Start new watcher
      const watcher = startWatcher(absPath, {
        onAdd: async (path) => { await indexFile(state.db, path, absPath, config) },
        onChange: async (path) => { await indexFile(state.db, path, absPath, config) },
        onUnlink: async (path) => { await removeFile(state.db, path, absPath) },
      })
      state.stopWatcher = () => watcher.close()

      // Start session
      const sr = startSession(state.db)
      state.sessionId = Number(sr.lastInsertRowid)

      return text([
        `Project set: ${absPath}`,
        `Indexed: ${result.indexed} files, ${result.skipped} unchanged, ${result.removed} removed (${result.timeMs}ms)`,
        '',
        'All tools are now ready. Try get_status or get_project_map.',
      ].join('\n'))
    }
  )

  // ── get_status ──
  server.tool(
    'get_status',
    'Get index health, stats, and current project info.',
    {},
    async () => {
      const err = requireProject()
      if (err) return text(err)
      const stats = getStats(state.db)
      return text([
        `context-bunker index status`,
        `  Project: ${state.projectRoot}`,
        `  Indexed files: ${stats.files}`,
        `  Symbols: ${stats.symbols}`,
        `  Imports tracked: ${stats.imports}`,
        `  Exports tracked: ${stats.exports}`,
        `  Call edges: ${stats.calls}`,
      ].join('\n'))
    }
  )

  // ── reindex ──
  server.tool(
    'reindex',
    'Force re-index of the codebase or a single file.',
    { file_path: z.string().optional().describe('Relative path to a specific file. Omit for full re-index.') },
    async ({ file_path }) => {
      const err = requireProject()
      if (err) return text(err)
      if (file_path) {
        const fullPath = resolve(state.projectRoot, file_path)
        const changed = await indexFile(state.db, fullPath, state.projectRoot, state.config)
        return text(changed ? `Re-indexed: ${file_path}` : `No changes: ${file_path}`)
      }
      const result = await indexProject(state.db, state.projectRoot, undefined, state.config)
      return text(`Full re-index: ${result.indexed} indexed, ${result.skipped} unchanged, ${result.removed} removed (${result.timeMs}ms)`)
    }
  )

  // ── find_symbol ──
  server.tool(
    'find_symbol',
    'Find symbol definitions by name (supports wildcards). AST-aware — returns definitions, not text matches.',
    {
      query: z.string().describe('Symbol name to search for. Supports * wildcards (e.g. "handle*", "*Service")'),
      kind: z.enum(['function', 'class', 'interface', 'type', 'enum', 'variable']).optional().describe('Filter by symbol kind'),
      scope: z.string().optional().describe('Filter by file path prefix (e.g. "src/routes/")'),
    },
    async ({ query, kind, scope }) => {
      const err = requireProject()
      if (err) return text(err)
      return text(findSymbol(state.db, query, kind, scope))
    }
  )

  // ── find_references ──
  server.tool(
    'find_references',
    'Find where a symbol is used across the codebase — imports, calls, and type references.',
    {
      symbol: z.string().describe('Symbol name to find references for'),
      file: z.string().optional().describe('Limit to references of the symbol defined in this file'),
    },
    async ({ symbol, file }) => {
      const err = requireProject()
      if (err) return text(err)
      return text(findReferences(state.db, symbol, file))
    }
  )

  // ── get_smart_context ──
  server.tool(
    'get_smart_context',
    'Get full context for a file in one call: exports, imports with signatures, dependents, test file, and dependencies. Replaces 8-16 manual Read/Grep calls.',
    {
      file_path: z.string().describe('Relative path to the file (e.g. "src/auth/middleware.ts")'),
    },
    async ({ file_path }) => {
      const err = requireProject()
      if (err) return text(err)
      return text(getSmartContext(state.db, file_path))
    }
  )

  // ── get_dependency_graph ──
  server.tool(
    'get_dependency_graph',
    'Get the transitive import graph for a file. "dependents" = what breaks if I change this. "dependencies" = what this file needs.',
    {
      file_path: z.string().describe('Relative path to the file'),
      direction: z.enum(['dependencies', 'dependents']).default('dependents').describe('"dependents" = files that import this, "dependencies" = files this imports'),
      depth: z.number().min(1).max(10).default(3).describe('How many levels deep to traverse'),
    },
    async ({ file_path, direction, depth }) => {
      const err = requireProject()
      if (err) return text(err)
      return text(getDependencyGraph(state.db, file_path, direction, depth))
    }
  )

  // ── get_call_graph ──
  server.tool(
    'get_call_graph',
    'Get what a function calls recursively, rendered as a tree. Shows the execution flow from a function.',
    {
      function_name: z.string().describe('Function name to trace calls from'),
      file: z.string().optional().describe('File where the function is defined (disambiguates if multiple matches)'),
      depth: z.number().min(1).max(5).default(2).describe('How many levels deep to trace'),
    },
    async ({ function_name, file, depth }) => {
      const err = requireProject()
      if (err) return text(err)
      return text(getCallGraph(state.db, function_name, file, depth))
    }
  )

  // ── get_symbol_source ──
  server.tool(
    'get_symbol_source',
    'Extract the source code of a single function/class/interface — not the whole file. Includes JSDoc. ~80% fewer tokens than reading the full file.',
    {
      symbol: z.string().describe('Symbol name to extract'),
      file: z.string().optional().describe('File where the symbol is defined (disambiguates if multiple matches)'),
    },
    async ({ symbol, file }) => {
      const err = requireProject()
      if (err) return text(err)
      return text(getSymbolSource(state.db, state.projectRoot, symbol, file))
    }
  )

  // ── get_project_map ──
  server.tool(
    'get_project_map',
    'Get a high-level architecture overview: directories, files, and their exported symbols. Understand the project structure in one call.',
    {
      depth: z.number().min(1).max(5).default(3).describe('How many directory levels deep to show'),
    },
    async ({ depth }) => {
      const err = requireProject()
      if (err) return text(err)
      return text(getProjectMap(state.db, depth))
    }
  )

  // ── get_changes_since_last_session ──
  server.tool(
    'get_changes_since_last_session',
    'What changed in the codebase since the AI last interacted with it. Shows added, modified, and deleted files with their symbols.',
    {},
    async () => {
      const err = requireProject()
      if (err) return text(err)
      return text(getChangesSinceLastSession(state.db, state.projectRoot))
    }
  )

  // ── find_unused_exports ──
  server.tool(
    'find_unused_exports',
    'Dead code detection: find exported symbols that are never imported anywhere in the codebase.',
    {
      scope: z.string().optional().describe('Limit to exports in files matching this path prefix (e.g. "src/utils/")'),
    },
    async ({ scope }) => {
      const err = requireProject()
      if (err) return text(err)
      return text(findUnusedExports(state.db, scope))
    }
  )

  // ── search_by_pattern ──
  server.tool(
    'search_by_pattern',
    'Find code by structural pattern. Available: http_calls, env_access, error_handlers, async_functions, todos, test_files.',
    {
      pattern: z.enum(['http_calls', 'env_access', 'error_handlers', 'async_functions', 'todos', 'test_files'])
        .describe('Pattern to search for'),
    },
    async ({ pattern }) => {
      const err = requireProject()
      if (err) return text(err)
      return text(searchByPattern(state.db, pattern))
    }
  )

  // ── get_file_summary ──
  server.tool(
    'get_file_summary',
    'Token-efficient file overview (~50 tokens). Shows imports, exports, and dependents in compact format. Use to scan multiple files cheaply.',
    {
      file_path: z.string().describe('Relative path to the file'),
    },
    async ({ file_path }) => {
      const err = requireProject()
      if (err) return text(err)
      return text(getFileSummary(state.db, file_path))
    }
  )

  // ── search_code ──
  server.tool(
    'search_code',
    'Semantic code search using TF-IDF. Finds files relevant to a natural language query. No API keys — runs entirely local.',
    {
      query: z.string().describe('Search query (e.g. "authentication middleware", "database connection")'),
      limit: z.number().min(1).max(50).default(10).describe('Max results to return'),
    },
    async ({ query, limit }) => {
      const err = requireProject()
      if (err) return text(err)
      return text(searchCode(state.db, query, limit))
    }
  )

  return server
}

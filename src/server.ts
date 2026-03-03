import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { resolve, relative, isAbsolute } from 'node:path'
import { existsSync } from 'node:fs'
import type { DB } from './store/db.js'
import { openDatabase } from './store/db.js'
import { getStats, startSession, endSession, invalidateFileHash, invalidateAllFileHashes } from './store/queries.js'
import { indexProject, indexFile, removeFile } from './indexer/indexer.js'
import { initParser } from './indexer/parser.js'
import { startWatcher } from './indexer/watcher.js'
import { loadConfig, getDbPath, type Config } from './config.js'
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
import { findUnusedCode } from './tools/find-unused-code.js'
import { findNearestProjectRoot } from './utils/monorepo.js'
import type { Logger } from './logger.js'

// Mutable state — allows set_project to swap project at runtime
export interface ServerState {
  db: DB
  projectRoot: string
  config?: Config
  stopWatcher?: () => Promise<void>
  sessionId?: number
  logger: Logger
}

const PATH_DESC = 'Absolute path to any file/directory in the project. Auto-detects and sets the project root. In monorepos, scopes to the nearest package.'

export function createServer(state: ServerState) {
  const { logger } = state
  const server = new McpServer({
    name: 'context-bunker',
    version: '0.1.5',
  })

  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

  // Serial queue — process tool calls one at a time to avoid stdout contention
  let queue: Promise<unknown> = Promise.resolve()

  /** Wrap a tool handler with logging + error catching + serial execution */
  function safeTool<A>(name: string, handler: (args: A) => Promise<ReturnType<typeof text>>) {
    return (args: A) => {
      const job = queue.then(async () => {
        logger.info(`Tool call: ${name}`, args)
        try {
          return await handler(args)
        } catch (err) {
          logger.error(
            `Tool ${name} failed\n` +
            `  args: ${JSON.stringify(args)}\n` +
            `  projectRoot: ${state.projectRoot ?? '(none)'}\n` +
            `  sessionId: ${state.sessionId ?? '(none)'}`,
            err,
          )
          const msg = err instanceof Error ? err.message : String(err)
          return text(`Internal error in ${name}: ${msg}\n\nThis error has been logged. Check log file for details.`)
        }
      })
      queue = job.catch(() => {}) // prevent queue from breaking on error
      return job
    }
  }

  // ── Shared helpers ──

  /** Teardown current project, open new DB, index, start watcher + session */
  async function switchProject(root: string) {
    if (state.stopWatcher) {
      await state.stopWatcher()
      state.stopWatcher = undefined
    }
    if (state.sessionId != null && state.db) {
      endSession(state.db, state.sessionId, buildFileSnapshot(state.db))
      state.sessionId = undefined
    }
    if (state.db && state.projectRoot !== root) {
      try { state.db.close() } catch { /* ignore */ }
    }

    await initParser()
    const config = loadConfig(root)
    state.config = config

    const dbPath = getDbPath(root, config.storage)
    state.db = await openDatabase(dbPath)
    state.projectRoot = root

    const result = await indexProject(state.db, root, undefined, config)

    const watcher = startWatcher(root, {
      onAdd: async (path) => { await indexFile(state.db, path, root, config) },
      onChange: async (path) => { await indexFile(state.db, path, root, config) },
      onUnlink: async (path) => { await removeFile(state.db, path, root) },
      onError: () => { state.stopWatcher = undefined },
      onCallbackError: (err, path, event) => { logger.error(`Watcher ${event} callback failed for ${path}:`, err) },
    })
    state.stopWatcher = () => watcher.close()

    const sr = startSession(state.db)
    state.sessionId = Number(sr.lastInsertRowid)

    return result
  }

  /**
   * Auto-detect project from an absolute path and switch if needed.
   * Returns error string if project cannot be determined, null on success.
   */
  async function ensureProject(inputPath?: string): Promise<string | null> {
    if (inputPath && isAbsolute(inputPath)) {
      const root = findNearestProjectRoot(inputPath)
      if (root !== state.projectRoot) await switchProject(root)
      return null
    }
    if (!state.projectRoot || !state.db) {
      return 'No project set. Provide an absolute path or call set_project first.'
    }
    return null
  }

  /** Convert absolute file path to project-relative, pass through relative paths */
  function toRelative(filePath: string): string {
    if (isAbsolute(filePath)) return relative(state.projectRoot, filePath).replace(/\\/g, '/')
    return filePath
  }

  // ── set_project ──
  server.tool(
    'set_project',
    'Set the project directory to index and analyze. Accepts any absolute path (file or directory) — auto-detects the nearest project root. In monorepos, automatically scopes to the specific package.',
    {
      path: z.string().describe('Absolute path to any file or directory in the project. The nearest project root is auto-detected (e.g. passing a monorepo sub-package path scopes to that package).'),
    },
    safeTool('set_project', async ({ path: projectPath }: { path: string }) => {
      const absPath = resolve(projectPath)
      if (!existsSync(absPath)) return text(`Not found: ${absPath}`)

      const root = findNearestProjectRoot(absPath)
      const result = await switchProject(root)

      return text([
        `Project set: ${root}`,
        `Indexed: ${result.indexed} files, ${result.skipped} unchanged, ${result.removed} removed (${result.timeMs}ms)`,
        '',
        'All tools are now ready. Try get_status or get_project_map.',
      ].join('\n'))
    })
  )

  // ── get_status ──
  server.tool(
    'get_status',
    'Get index health, stats, and current project info.',
    {
      path: z.string().optional().describe(PATH_DESC),
    },
    safeTool('get_status', async ({ path }: { path?: string }) => {
      const err = await ensureProject(path)
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
    })
  )

  // ── reindex ──
  server.tool(
    'reindex',
    'Force re-index of the codebase or a single file.',
    { file_path: z.string().optional().describe('Path to a specific file (absolute or relative). Omit for full re-index. Absolute paths auto-detect the project.') },
    safeTool('reindex', async ({ file_path }: { file_path?: string }) => {
      const err = await ensureProject(file_path)
      if (err) return text(err)
      if (file_path) {
        const relPath = toRelative(file_path)
        const fullPath = resolve(state.projectRoot, relPath)
        invalidateFileHash(state.db, relPath)
        const changed = await indexFile(state.db, fullPath, state.projectRoot, state.config)
        return text(changed ? `Re-indexed: ${relPath}` : `No changes: ${relPath}`)
      }
      invalidateAllFileHashes(state.db)
      const result = await indexProject(state.db, state.projectRoot, undefined, state.config)
      return text(`Full re-index: ${result.indexed} indexed, ${result.skipped} unchanged, ${result.removed} removed (${result.timeMs}ms)`)
    })
  )

  // ── find_symbol ──
  server.tool(
    'find_symbol',
    'Find symbol definitions by name (supports wildcards). AST-aware — returns definitions, not text matches.',
    {
      query: z.string().describe('Symbol name to search for. Supports * wildcards (e.g. "handle*", "*Service")'),
      kind: z.enum(['function', 'class', 'interface', 'type', 'enum', 'variable']).optional().describe('Filter by symbol kind'),
      scope: z.string().optional().describe('Filter by file path prefix (e.g. "src/routes/")'),
      path: z.string().optional().describe(PATH_DESC),
    },
    safeTool('find_symbol', async ({ query, kind, scope, path }: { query: string, kind?: string, scope?: string, path?: string }) => {
      const err = await ensureProject(path)
      if (err) return text(err)
      return text(findSymbol(state.db, query, kind, scope))
    })
  )

  // ── find_references ──
  server.tool(
    'find_references',
    'Find where a symbol is used across the codebase — imports, calls, and type references.',
    {
      symbol: z.string().describe('Symbol name to find references for'),
      file: z.string().optional().describe('Limit to references of the symbol defined in this file (absolute or relative path)'),
      path: z.string().optional().describe(PATH_DESC),
    },
    safeTool('find_references', async ({ symbol, file, path }: { symbol: string, file?: string, path?: string }) => {
      const err = await ensureProject(file ?? path)
      if (err) return text(err)
      return text(findReferences(state.db, symbol, file ? toRelative(file) : undefined))
    })
  )

  // ── get_smart_context ──
  server.tool(
    'get_smart_context',
    'Get full context for a file in one call: exports, imports with signatures, dependents, test file, and dependencies. Replaces 8-16 manual Read/Grep calls.',
    {
      file_path: z.string().describe('Path to the file (absolute or relative). Absolute paths auto-detect the project.'),
    },
    safeTool('get_smart_context', async ({ file_path }: { file_path: string }) => {
      const err = await ensureProject(file_path)
      if (err) return text(err)
      return text(getSmartContext(state.db, toRelative(file_path)))
    })
  )

  // ── get_dependency_graph ──
  server.tool(
    'get_dependency_graph',
    'Get the transitive import graph for a file. "dependents" = what breaks if I change this. "dependencies" = what this file needs.',
    {
      file_path: z.string().describe('Path to the file (absolute or relative). Absolute paths auto-detect the project.'),
      direction: z.enum(['dependencies', 'dependents']).default('dependents').describe('"dependents" = files that import this, "dependencies" = files this imports'),
      depth: z.number().min(1).max(10).default(3).describe('How many levels deep to traverse'),
    },
    safeTool('get_dependency_graph', async ({ file_path, direction, depth }: { file_path: string, direction: 'dependencies' | 'dependents', depth: number }) => {
      const err = await ensureProject(file_path)
      if (err) return text(err)
      return text(getDependencyGraph(state.db, toRelative(file_path), direction, depth))
    })
  )

  // ── get_call_graph ──
  server.tool(
    'get_call_graph',
    'Get what a function calls recursively, rendered as a tree. Shows the execution flow from a function.',
    {
      function_name: z.string().describe('Function name to trace calls from'),
      file: z.string().optional().describe('File where the function is defined (absolute or relative path)'),
      depth: z.number().min(1).max(5).default(2).describe('How many levels deep to trace'),
      path: z.string().optional().describe(PATH_DESC),
    },
    safeTool('get_call_graph', async ({ function_name, file, depth, path }: { function_name: string, file?: string, depth: number, path?: string }) => {
      const err = await ensureProject(file ?? path)
      if (err) return text(err)
      return text(getCallGraph(state.db, function_name, file ? toRelative(file) : undefined, depth))
    })
  )

  // ── get_symbol_source ──
  server.tool(
    'get_symbol_source',
    'Extract the source code of a single function/class/interface — not the whole file. Includes JSDoc. ~80% fewer tokens than reading the full file.',
    {
      symbol: z.string().describe('Symbol name to extract'),
      file: z.string().optional().describe('File where the symbol is defined (absolute or relative path)'),
      path: z.string().optional().describe(PATH_DESC),
    },
    safeTool('get_symbol_source', async ({ symbol, file, path }: { symbol: string, file?: string, path?: string }) => {
      const err = await ensureProject(file ?? path)
      if (err) return text(err)
      return text(getSymbolSource(state.db, state.projectRoot, symbol, file ? toRelative(file) : undefined))
    })
  )

  // ── get_project_map ──
  server.tool(
    'get_project_map',
    'Get a high-level architecture overview: directories, files, and their exported symbols. Understand the project structure in one call.',
    {
      depth: z.number().min(1).max(5).default(3).describe('How many directory levels deep to show'),
      path: z.string().optional().describe(PATH_DESC),
    },
    safeTool('get_project_map', async ({ depth, path }: { depth: number, path?: string }) => {
      const err = await ensureProject(path)
      if (err) return text(err)
      return text(getProjectMap(state.db, depth))
    })
  )

  // ── get_changes_since_last_session ──
  server.tool(
    'get_changes_since_last_session',
    'What changed in the codebase since the AI last interacted with it. Shows added, modified, and deleted files with their symbols.',
    {
      path: z.string().optional().describe(PATH_DESC),
    },
    safeTool('get_changes_since_last_session', async ({ path }: { path?: string }) => {
      const err = await ensureProject(path)
      if (err) return text(err)
      return text(getChangesSinceLastSession(state.db, state.projectRoot))
    })
  )

  // ── find_unused_exports ──
  server.tool(
    'find_unused_exports',
    'Dead code detection: find exported symbols that are never imported anywhere in the codebase.',
    {
      scope: z.string().optional().describe('Limit to exports in files matching this path prefix (e.g. "src/utils/")'),
      path: z.string().optional().describe(PATH_DESC),
    },
    safeTool('find_unused_exports', async ({ scope, path }: { scope?: string, path?: string }) => {
      const err = await ensureProject(path)
      if (err) return text(err)
      return text(findUnusedExports(state.db, scope))
    })
  )

  // ── search_by_pattern ──
  server.tool(
    'search_by_pattern',
    'Find code by structural pattern. Available: http_calls, env_access, error_handlers, async_functions, todos, test_files.',
    {
      pattern: z.enum(['http_calls', 'env_access', 'error_handlers', 'async_functions', 'todos', 'test_files'])
        .describe('Pattern to search for'),
      path: z.string().optional().describe(PATH_DESC),
    },
    safeTool('search_by_pattern', async ({ pattern, path }: { pattern: string, path?: string }) => {
      const err = await ensureProject(path)
      if (err) return text(err)
      return text(searchByPattern(state.db, pattern))
    })
  )

  // ── get_file_summary ──
  server.tool(
    'get_file_summary',
    'Token-efficient file overview (~50 tokens). Shows imports, exports, and dependents in compact format. Use to scan multiple files cheaply.',
    {
      file_path: z.string().describe('Path to the file (absolute or relative). Absolute paths auto-detect the project.'),
    },
    safeTool('get_file_summary', async ({ file_path }: { file_path: string }) => {
      const err = await ensureProject(file_path)
      if (err) return text(err)
      return text(getFileSummary(state.db, toRelative(file_path)))
    })
  )

  // ── search_code ──
  server.tool(
    'search_code',
    'Semantic code search using TF-IDF. Finds files relevant to a natural language query. No API keys — runs entirely local.',
    {
      query: z.string().describe('Search query (e.g. "authentication middleware", "database connection")'),
      limit: z.number().min(1).max(50).default(10).describe('Max results to return'),
      path: z.string().optional().describe(PATH_DESC),
    },
    safeTool('search_code', async ({ query, limit, path }: { query: string, limit: number, path?: string }) => {
      const err = await ensureProject(path)
      if (err) return text(err)
      return text(searchCode(state.db, query, limit))
    })
  )

  // ── find_unused_code ──
  server.tool(
    'find_unused_code',
    'Find dead code: internal symbols (functions, classes, variables, types) that are never called, imported, or exported anywhere.',
    {
      scope: z.string().optional().describe('Limit to files matching this path prefix (e.g. "src/utils/")'),
      kind: z.enum(['function', 'class', 'interface', 'type', 'enum', 'variable']).optional().describe('Filter by symbol kind'),
      path: z.string().optional().describe(PATH_DESC),
    },
    safeTool('find_unused_code', async ({ scope, kind, path }: { scope?: string, kind?: string, path?: string }) => {
      const err = await ensureProject(path)
      if (err) return text(err)
      return text(findUnusedCode(state.db, scope, kind))
    })
  )

  return server
}

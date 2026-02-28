import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { resolve } from 'node:path'
import type { DB } from './store/db.js'
import { getStats } from './store/queries.js'
import { indexProject, indexFile } from './indexer/indexer.js'
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

export function createServer(db: DB, projectRoot: string) {
  const server = new McpServer({
    name: 'context-bunker',
    version: '0.1.0',
  })

  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

  // ── get_status ──
  server.tool(
    'get_status',
    'Get index health, stats, and session info',
    {},
    async () => {
      const stats = getStats(db)
      return text([
        `context-bunker index status`,
        `  Project: ${projectRoot}`,
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
    'Force re-index of the codebase or a single file',
    { file_path: z.string().optional().describe('Relative path to a specific file. Omit for full re-index.') },
    async ({ file_path }) => {
      if (file_path) {
        const fullPath = resolve(projectRoot, file_path)
        const changed = await indexFile(db, fullPath, projectRoot)
        return text(changed ? `Re-indexed: ${file_path}` : `No changes: ${file_path}`)
      }
      const result = await indexProject(db, projectRoot)
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
    async ({ query, kind, scope }) => text(findSymbol(db, query, kind, scope))
  )

  // ── find_references ──
  server.tool(
    'find_references',
    'Find where a symbol is used across the codebase — imports, calls, and type references.',
    {
      symbol: z.string().describe('Symbol name to find references for'),
      file: z.string().optional().describe('Limit to references of the symbol defined in this file'),
    },
    async ({ symbol, file }) => text(findReferences(db, symbol, file))
  )

  // ── get_smart_context ──
  server.tool(
    'get_smart_context',
    'Get full context for a file in one call: exports, imports with signatures, dependents, test file, and dependencies. Replaces 8-16 manual Read/Grep calls.',
    {
      file_path: z.string().describe('Relative path to the file (e.g. "src/auth/middleware.ts")'),
    },
    async ({ file_path }) => text(getSmartContext(db, file_path))
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
    async ({ file_path, direction, depth }) => text(getDependencyGraph(db, file_path, direction, depth))
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
    async ({ function_name, file, depth }) => text(getCallGraph(db, function_name, file, depth))
  )

  // ── get_symbol_source ──
  server.tool(
    'get_symbol_source',
    'Extract the source code of a single function/class/interface — not the whole file. Includes JSDoc. ~80% fewer tokens than reading the full file.',
    {
      symbol: z.string().describe('Symbol name to extract'),
      file: z.string().optional().describe('File where the symbol is defined (disambiguates if multiple matches)'),
    },
    async ({ symbol, file }) => text(getSymbolSource(db, projectRoot, symbol, file))
  )

  // ── get_project_map ──
  server.tool(
    'get_project_map',
    'Get a high-level architecture overview: directories, files, and their exported symbols. Understand the project structure in one call.',
    {
      depth: z.number().min(1).max(5).default(3).describe('How many directory levels deep to show'),
    },
    async ({ depth }) => text(getProjectMap(db, depth))
  )

  // ── get_changes_since_last_session ──
  server.tool(
    'get_changes_since_last_session',
    'What changed in the codebase since the AI last interacted with it. Shows added, modified, and deleted files with their symbols. Impossible without persistent index.',
    {},
    async () => text(getChangesSinceLastSession(db, projectRoot))
  )

  // ── find_unused_exports ──
  server.tool(
    'find_unused_exports',
    'Dead code detection: find exported symbols that are never imported anywhere in the codebase.',
    {
      scope: z.string().optional().describe('Limit to exports in files matching this path prefix (e.g. "src/utils/")'),
    },
    async ({ scope }) => text(findUnusedExports(db, scope))
  )

  // ── search_by_pattern ──
  server.tool(
    'search_by_pattern',
    'Find code by structural pattern. Available: http_calls, env_access, error_handlers, async_functions, todos, test_files.',
    {
      pattern: z.enum(['http_calls', 'env_access', 'error_handlers', 'async_functions', 'todos', 'test_files'])
        .describe('Pattern to search for'),
    },
    async ({ pattern }) => text(searchByPattern(db, pattern))
  )

  // ── get_file_summary ──
  server.tool(
    'get_file_summary',
    'Token-efficient file overview (~50 tokens). Shows imports, exports, and dependents in compact format. Use to scan multiple files cheaply.',
    {
      file_path: z.string().describe('Relative path to the file'),
    },
    async ({ file_path }) => text(getFileSummary(db, file_path))
  )

  // ── search_code ──
  server.tool(
    'search_code',
    'Semantic code search using TF-IDF. Finds files relevant to a natural language query. No API keys — runs entirely local.',
    {
      query: z.string().describe('Search query (e.g. "authentication middleware", "database connection")'),
      limit: z.number().min(1).max(50).default(10).describe('Max results to return'),
    },
    async ({ query, limit }) => text(searchCode(db, query, limit))
  )

  return server
}

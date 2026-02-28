import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { resolve } from 'node:path'
import type { DB } from './store/db.js'
import { getStats } from './store/queries.js'
import { indexProject, indexFile } from './indexer/indexer.js'

export function createServer(db: DB, projectRoot: string) {
  const server = new McpServer({
    name: 'context-bunker',
    version: '0.1.0',
  })

  // ── get_status ──
  server.tool(
    'get_status',
    'Get index health, stats, and session info',
    {},
    async () => {
      const stats = getStats(db)
      const text = [
        `context-bunker index status`,
        `  Project: ${projectRoot}`,
        `  Indexed files: ${stats.files}`,
        `  Symbols: ${stats.symbols}`,
        `  Imports tracked: ${stats.imports}`,
        `  Exports tracked: ${stats.exports}`,
        `  Call edges: ${stats.calls}`,
      ].join('\n')
      return { content: [{ type: 'text' as const, text }] }
    }
  )

  // ── reindex ──
  server.tool(
    'reindex',
    'Force re-index of the codebase or a single file',
    { file_path: z.string().optional().describe('Path to a specific file to re-index. Omit for full re-index.') },
    async ({ file_path }) => {
      if (file_path) {
        const fullPath = resolve(projectRoot, file_path)
        const changed = await indexFile(db, fullPath, projectRoot)
        const text = changed ? `Re-indexed: ${file_path}` : `No changes: ${file_path}`
        return { content: [{ type: 'text' as const, text }] }
      }
      const result = await indexProject(db, projectRoot)
      const text = `Full re-index complete: ${result.indexed} indexed, ${result.skipped} unchanged, ${result.removed} removed (${result.timeMs}ms)`
      return { content: [{ type: 'text' as const, text }] }
    }
  )

  return server
}

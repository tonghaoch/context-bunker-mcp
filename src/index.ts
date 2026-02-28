#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolve, join } from 'node:path'
import { openDatabase } from './store/db.js'
import { initParser } from './indexer/parser.js'
import { indexProject, indexFile, removeFile } from './indexer/indexer.js'
import { startWatcher } from './indexer/watcher.js'
import { createServer } from './server.js'

// ── CLI Args ──
const args = process.argv.slice(2)
const verbose = args.includes('--verbose') || args.includes('-v')
const noWatch = args.includes('--no-watch')
const projectRoot = resolve(args.find(a => !a.startsWith('-')) ?? '.')

function log(...msg: unknown[]) {
  if (verbose) console.error('[context-bunker]', ...msg)
}

// ── Main ──
async function main() {
  log('Starting context-bunker MCP server...')
  log('Project root:', projectRoot)

  // Init SQLite
  const dbPath = join(projectRoot, '.context-bunker', 'index.db')
  log('Database:', dbPath)
  const db = await openDatabase(dbPath)
  log('Database opened')

  // Init tree-sitter
  await initParser()
  log('Tree-sitter initialized')

  // Initial index
  log('Indexing project...')
  const result = await indexProject(db, projectRoot, log)
  log(`Index complete: ${result.indexed} indexed, ${result.skipped} unchanged, ${result.removed} removed (${result.timeMs}ms)`)

  // Start file watcher
  let watcher: { close: () => Promise<void> } | undefined
  if (!noWatch) {
    watcher = startWatcher(projectRoot, {
      onAdd: async (path) => {
        log('File added:', path)
        await indexFile(db, path, projectRoot)
      },
      onChange: async (path) => {
        log('File changed:', path)
        await indexFile(db, path, projectRoot)
      },
      onUnlink: async (path) => {
        log('File removed:', path)
        await removeFile(db, path, projectRoot)
      },
    })
    log('File watcher started')
  }

  // Create MCP server
  const server = createServer(db, projectRoot)

  // Connect via stdio
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log('MCP server running on stdio')

  // Graceful shutdown
  const shutdown = async () => {
    log('Shutting down...')
    if (watcher) await watcher.close()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})

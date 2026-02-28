#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolve, join } from 'node:path'
import { openDatabase } from './store/db.js'
import { initParser } from './indexer/parser.js'
import { indexProject, indexFile, removeFile } from './indexer/indexer.js'
import { startWatcher } from './indexer/watcher.js'
import { createServer } from './server.js'
import { startSession, endSession, getStats } from './store/queries.js'
import { buildFileSnapshot } from './tools/get-changes.js'
import { loadConfig, initConfig } from './config.js'

// ── CLI Args ──
const args = process.argv.slice(2)
const verbose = args.includes('--verbose') || args.includes('-v')
const noWatch = args.includes('--no-watch')
const showHelp = args.includes('--help') || args.includes('-h')
const doInit = args.includes('--init')
const showStatus = args.includes('--status')
const projectRoot = resolve(args.find(a => !a.startsWith('-')) ?? '.')

function log(...msg: unknown[]) {
  if (verbose) console.error('[context-bunker]', ...msg)
}

// ── Help ──
if (showHelp) {
  console.log(`context-bunker — Pre-computed codebase intelligence MCP server

Usage:
  bun src/index.ts [project-root] [options]

Options:
  --help, -h       Show this help message
  --init           Create .context-bunker.json config file
  --status         Show index stats and exit
  --verbose, -v    Verbose logging to stderr
  --no-watch       Disable file watcher

Examples:
  bun src/index.ts                     # Index current directory, start MCP server
  bun src/index.ts /path/to/project    # Index specific project
  bun src/index.ts --init              # Create config file
  bun src/index.ts --status            # Show index stats

MCP setup (Claude Code):
  claude mcp add context-bunker -- bun /path/to/context-bunker/src/index.ts
`)
  process.exit(0)
}

// ── Init ──
if (doInit) {
  console.log(initConfig(projectRoot))
  process.exit(0)
}

// ── Status ──
if (showStatus) {
  const dbPath = join(projectRoot, '.context-bunker', 'index.db')
  try {
    const db = await openDatabase(dbPath)
    const stats = getStats(db)
    console.log(`context-bunker index status`)
    console.log(`  Project: ${projectRoot}`)
    console.log(`  Indexed files: ${stats.files}`)
    console.log(`  Symbols: ${stats.symbols}`)
    console.log(`  Imports tracked: ${stats.imports}`)
    console.log(`  Exports tracked: ${stats.exports}`)
    console.log(`  Call edges: ${stats.calls}`)
    db.close()
  } catch {
    console.log('No index found. Run without --status to index the project first.')
  }
  process.exit(0)
}

// ── Main: MCP Server ──
async function main() {
  log('Starting context-bunker MCP server...')
  log('Project root:', projectRoot)

  // Load config
  const config = loadConfig(projectRoot)
  log('Config loaded:', JSON.stringify(config))

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
  const result = await indexProject(db, projectRoot, log, config)
  log(`Index complete: ${result.indexed} indexed, ${result.skipped} unchanged, ${result.removed} removed (${result.timeMs}ms)`)

  // Start file watcher
  let watcher: { close: () => Promise<void> } | undefined
  if (!noWatch) {
    watcher = startWatcher(projectRoot, {
      onAdd: async (path) => {
        log('File added:', path)
        await indexFile(db, path, projectRoot, config)
      },
      onChange: async (path) => {
        log('File changed:', path)
        await indexFile(db, path, projectRoot, config)
      },
      onUnlink: async (path) => {
        log('File removed:', path)
        await removeFile(db, path, projectRoot)
      },
    })
    log('File watcher started')
  }

  // Start session tracking
  const sessionResult = startSession(db)
  const sessionId = Number(sessionResult.lastInsertRowid)
  log('Session started:', sessionId)

  // Create MCP server
  const server = createServer(db, projectRoot)

  // Connect via stdio
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log('MCP server running on stdio')

  // Graceful shutdown — save session snapshot
  const shutdown = async () => {
    log('Saving session snapshot...')
    const snapshot = buildFileSnapshot(db)
    endSession(db, sessionId, snapshot)
    log('Session saved')
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

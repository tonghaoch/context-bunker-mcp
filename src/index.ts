#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolve } from 'node:path'
import { openDatabase } from './store/db.js'
import { initParser } from './indexer/parser.js'
import { indexProject, indexFile, removeFile } from './indexer/indexer.js'
import { startWatcher } from './indexer/watcher.js'
import { createServer, type ServerState } from './server.js'
import { startSession, endSession, getStats } from './store/queries.js'
import { buildFileSnapshot } from './tools/get-changes.js'
import { loadConfig, initConfig, getDbPath } from './config.js'
import { createLogger } from './logger.js'

// ── CLI Args ──
const args = process.argv.slice(2)
const verbose = args.includes('--verbose') || args.includes('-v')
const noWatch = args.includes('--no-watch')
const useLocal = args.includes('--local')
const showHelp = args.includes('--help') || args.includes('-h')
const doInit = args.includes('--init')
const showStatus = args.includes('--status')
const projectArg = args.find(a => !a.startsWith('-'))

// ── Logger ──
const logger = createLogger(verbose)
const log = (...msg: unknown[]) => logger.info(...msg)

// ── Help ──
if (showHelp) {
  console.log(`context-bunker-mcp — Pre-computed codebase intelligence MCP server

Usage:
  context-bunker-mcp [project-root] [options]

Options:
  --help, -h       Show this help message
  --init           Create .context-bunker.json config file
  --status         Show index stats and exit
  --verbose, -v    Verbose logging to stderr
  --no-watch       Disable file watcher
  --local          Store index in project directory instead of global cache

If no project-root is given, the server starts without a project.
The AI can then call set_project(path) to dynamically select a project.

Examples:
  context-bunker-mcp                       # Start server, AI calls set_project later
  context-bunker-mcp /path/to/project      # Index specific project at startup
  context-bunker-mcp --init                # Create config file in current directory
  context-bunker-mcp --status              # Show index stats

MCP setup (Claude Code):
  claude mcp add context-bunker -- npx context-bunker-mcp
`)
  process.exit(0)
}

// ── Init ──
if (doInit) {
  const root = resolve(projectArg ?? '.')
  console.log(initConfig(root))
  process.exit(0)
}

// ── Status ──
if (showStatus) {
  const root = resolve(projectArg ?? '.')
  const config = loadConfig(root)
  const storage = useLocal ? 'local' : config.storage
  const dbPath = getDbPath(root, storage)
  try {
    const db = await openDatabase(dbPath)
    const stats = getStats(db)
    console.log(`context-bunker index status`)
    console.log(`  Project: ${root}`)
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

  await initParser()
  log('Tree-sitter initialized')

  // Server state — mutable, allows set_project to swap project
  const state: ServerState = { logger } as ServerState

  // If project path given, index it upfront
  if (projectArg) {
    const projectRoot = resolve(projectArg)
    log('Project root:', projectRoot)

    const config = loadConfig(projectRoot)
    const storage = useLocal ? 'local' : config.storage
    const dbPath = getDbPath(projectRoot, storage)
    state.db = await openDatabase(dbPath)
    state.projectRoot = projectRoot
    state.config = config

    log('Indexing project...')
    const result = await indexProject(state.db, projectRoot, log, config)
    log(`Index complete: ${result.indexed} indexed, ${result.skipped} unchanged, ${result.removed} removed (${result.timeMs}ms)`)

    // File watcher
    if (!noWatch) {
      const watcher = startWatcher(projectRoot, {
        onAdd: async (path) => { log('File added:', path); await indexFile(state.db, path, projectRoot, config) },
        onChange: async (path) => { log('File changed:', path); await indexFile(state.db, path, projectRoot, config) },
        onUnlink: async (path) => { log('File removed:', path); await removeFile(state.db, path, projectRoot) },
      })
      state.stopWatcher = () => watcher.close()
      log('File watcher started')
    }

    // Session tracking
    const sr = startSession(state.db)
    state.sessionId = Number(sr.lastInsertRowid)
    log('Session started:', state.sessionId)
  } else {
    log('No project specified. AI can call set_project(path) to select a project.')
  }

  // Create MCP server
  const server = createServer(state)

  // Connect via stdio
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log('MCP server running on stdio')

  // Graceful shutdown
  const shutdown = async () => {
    log('Shutting down...')
    if (state.db && state.sessionId != null) {
      try {
        const snapshot = buildFileSnapshot(state.db)
        endSession(state.db, state.sessionId, snapshot)
        log('Session saved')
      } catch (err) {
        logger.error('Error saving session during shutdown:', err)
      }
    }
    if (state.stopWatcher) {
      try { await state.stopWatcher() } catch (err) { logger.error('Error stopping watcher:', err) }
    }
    if (state.db) {
      try { state.db.close() } catch (err) { logger.error('Error closing DB:', err) }
    }
    logger.flush()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Global crash handlers
  const getState = () => ({
    projectRoot: state.projectRoot,
    sessionId: state.sessionId,
    pid: process.pid,
  })

  process.on('uncaughtException', (err) => {
    logger.fatal('uncaughtException', err, getState())
    process.exit(1)
  })

  process.on('unhandledRejection', (reason) => {
    logger.fatal('unhandledRejection', reason, getState())
    process.exit(1)
  })
}

main().catch(err => {
  logger.fatal('main() rejected', err)
  process.exit(1)
})

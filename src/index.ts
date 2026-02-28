#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolve, join } from 'node:path'
import { openDatabase } from './store/db.js'
import { initParser } from './indexer/parser.js'
import { indexProject, indexFile, removeFile } from './indexer/indexer.js'
import { startWatcher } from './indexer/watcher.js'
import { createServer, type ServerState } from './server.js'
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
const projectArg = args.find(a => !a.startsWith('-'))

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

If no project-root is given, the server starts without a project.
The AI can then call set_project(path) to dynamically select a project.

Examples:
  bun src/index.ts                     # Start server, AI calls set_project later
  bun src/index.ts /path/to/project    # Index specific project at startup
  bun src/index.ts --init              # Create config file in current directory
  bun src/index.ts --status            # Show index stats

MCP setup (Claude Code):
  claude mcp add context-bunker -- bun /path/to/context-bunker/src/index.ts
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
  const dbPath = join(root, '.context-bunker', 'index.db')
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
  const state: ServerState = {} as ServerState

  // If project path given, index it upfront
  let sessionId: number | undefined
  let watcher: { close: () => Promise<void> } | undefined

  if (projectArg) {
    const projectRoot = resolve(projectArg)
    log('Project root:', projectRoot)

    const config = loadConfig(projectRoot)
    const dbPath = join(projectRoot, '.context-bunker', 'index.db')
    state.db = await openDatabase(dbPath)
    state.projectRoot = projectRoot

    log('Indexing project...')
    const result = await indexProject(state.db, projectRoot, log, config)
    log(`Index complete: ${result.indexed} indexed, ${result.skipped} unchanged, ${result.removed} removed (${result.timeMs}ms)`)

    // File watcher
    if (!noWatch) {
      watcher = startWatcher(projectRoot, {
        onAdd: async (path) => { log('File added:', path); await indexFile(state.db, path, projectRoot, config) },
        onChange: async (path) => { log('File changed:', path); await indexFile(state.db, path, projectRoot, config) },
        onUnlink: async (path) => { log('File removed:', path); await removeFile(state.db, path, projectRoot) },
      })
      log('File watcher started')
    }

    // Session tracking
    const sr = startSession(state.db)
    sessionId = Number(sr.lastInsertRowid)
    log('Session started:', sessionId)
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
    if (state.db && sessionId != null) {
      const snapshot = buildFileSnapshot(state.db)
      endSession(state.db, sessionId, snapshot)
      log('Session saved')
    }
    if (watcher) await watcher.close()
    if (state.db) state.db.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})

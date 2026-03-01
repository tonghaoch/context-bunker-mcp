# context-bunker 🏗️

> Pre-computed codebase intelligence for AI coding tools. One command. Code never leaves your machine.

## What is this?

An MCP (Model Context Protocol) server that indexes your codebase using **tree-sitter AST parsing** and exposes structural intelligence to AI coding tools — Claude Code, Cursor, Windsurf, Copilot, and any MCP-compatible client.

**The problem:** AI coding agents spend [~80% of tokens on "orientation"](https://earezki.com/ai-news/2026-02-26-how-i-cut-my-ai-coding-agents-token-usage-by-65-without-changing-models/) — re-discovering project structure, reading files to find the right function, manually tracing import chains. Every session starts from scratch.

**The solution:** context-bunker pre-computes a structural index (symbols, imports, exports, call graphs, dependency trees) and persists it in SQLite. AI tools query the index instead of doing dozens of grep/read calls.

```
# Bun (recommended — zero native deps, fastest)
bunx context-bunker

# Node.js (requires optional better-sqlite3)
npx context-bunker
```

## Why Not Just Use Grep?

Great question. Grep is excellent for text search — but **structural intelligence** is a different game:

| Task | CLI (Grep/Read) | context-bunker | Savings |
|------|----------------|----------------|---------|
| Understand a file + all its deps | 8-16 tool calls, ~4K tokens | 1 call, ~400 tokens | **90%** |
| "What breaks if I change this?" | Recursive grep (infeasible at depth 3) | 1 call, pre-computed graph | **~90%** |
| "What changed since yesterday?" | **Impossible** (no session memory) | 1 call | **∞** |
| Find dead code | Check every export vs all imports | 1 call, set difference | **∞** |
| Scan 10 files to find the right one | 10 full file reads, ~5K tokens | 10 summaries, ~500 tokens | **90%** |

context-bunker is **not** a grep replacement. It's for things grep structurally can't do well: cross-session memory, transitive dependency graphs, smart context assembly, and dead code detection. See [full CLI comparison](./docs/cli-comparison.md).

## Tools (15)

### 🔥 Unique Tools (no competitor has these)

| Tool | What it does |
|------|-------------|
| `get_changes_since_last_session` | What changed in the codebase since the AI last saw it. Eliminates re-orientation cost. |
| `find_unused_exports` | Dead code detection — symbols exported but never imported anywhere. |
| `get_file_summary` | Token-efficient file overview (~50 tokens vs ~500 for full read). Scan 10 files for the cost of 1. |
| `search_by_pattern` | Find code by structural pattern: HTTP calls, env access, error handlers, async functions, TODOs. |

### 🧠 Core Intelligence Tools

| Tool | What it does |
|------|-------------|
| `get_smart_context` | Full context for a file in 1 call: imports, exports, dependents, types, test file. Replaces 8-16 CLI calls. |
| `get_dependency_graph` | Transitive import graph — "if I change this, what breaks?" with direction + depth control. |
| `find_symbol` | AST-aware symbol search by name, kind (function/class/interface), and scope. Not text matching. |
| `find_references` | Where a symbol is used across the codebase, classified by kind (import, call, type annotation). |
| `get_call_graph` | What a function calls, recursively, rendered as a tree. |
| `get_symbol_source` | Extract one function/class definition — not the whole file. 80% token savings per lookup. |
| `get_project_map` | Architecture overview: modules, their public APIs, and relationships. |

### 🔧 Housekeeping

| Tool | What it does |
|------|-------------|
| `set_project` | Dynamically set the project to index. AI calls this if no project was specified at startup. |
| `search_code` | Semantic code search using local TF-IDF. No API keys. Finds files relevant to natural language queries. |
| `reindex` | Force re-index of the codebase or a single file. |
| `get_status` | Index health, file counts, and session token savings estimate. |

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Runtime** | **Bun** (Node.js fallback) | `bun:sqlite` built-in = zero native deps, 3x faster reads, 4-10x faster startup |
| **MCP** | `@modelcontextprotocol/sdk` | Official TypeScript SDK |
| **AST** | `web-tree-sitter` (WASM) | No native bindings, 30+ languages, works everywhere |
| **Storage** | `bun:sqlite` / `better-sqlite3` | Single file, WAL mode, survives restarts |
| **Search** | TF-IDF (local) | Zero API keys, no cloud, fast |
| **Watch** | `chokidar` | Incremental re-index on file changes |

## Language Support

| Priority | Languages | Status |
|----------|-----------|--------|
| **P0** | TypeScript, JavaScript (TSX/JSX/MTS/CTS) | ✅ Complete |
| **P1** | Python, Go | ✅ Complete |
| **P2** | Rust, Java, C/C++ | 🔲 Planned |

Tree-sitter WASM grammars are loaded from `tree-sitter-wasms` (npm dependency). Adding a new language requires writing an extractor in `src/languages/`.

## Setup

### As an MCP server (recommended)

**Claude Code:**
```bash
# Option A: specify project at startup (auto-indexes)
claude mcp add context-bunker -- bun /path/to/context-bunker/src/index.ts /your/project

# Option B: no project — AI calls set_project(path) dynamically
claude mcp add context-bunker -- bun /path/to/context-bunker/src/index.ts
```

**Cursor / Windsurf / VS Code (settings.json):**
```json
{
  "mcpServers": {
    "context-bunker": {
      "command": "bun",
      "args": ["/path/to/context-bunker/src/index.ts", "/your/project"]
    }
  }
}
```

If no project path is given, the AI can call `set_project` to dynamically select any project directory.

### Install
```bash
git clone https://github.com/tonghaoch/context-bunker-mcp.git
cd context-bunker-mcp
bun install
```

## Development Status

| Phase | Description | Status |
|-------|-------------|--------|
| **Phase 1** | Foundation — scaffold, SQLite, tree-sitter, MCP shell | ✅ Complete |
| **Phase 2** | Indexing engine — extractor, resolver, watcher, TF-IDF | ✅ Complete |
| **Phase 3** | Core tools — 7 main intelligence tools | ✅ Complete |
| **Phase 4** | Unique tools — session diff, dead code, patterns, search, summaries | ✅ Complete |
| **Phase 5** | Polish — CLI, config, tests | ✅ Complete |
| **Phase 6** | Publish — npm, MCP registries, launch | 🔲 Next |

## License

MIT

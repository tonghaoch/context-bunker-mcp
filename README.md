# Context Bunker MCP 🏗️

[![Build & Test](https://github.com/tonghaoch/context-bunker-mcp/actions/workflows/build-and-test.yml/badge.svg?branch=main)](https://github.com/tonghaoch/context-bunker-mcp/actions/workflows/build-and-test.yml)

> **Stop wasting tokens on orientation.** Pre-computed codebase intelligence for AI coding tools. One command. Code never leaves your machine.

## What is this?

AI coding agents spend [~80% of tokens just figuring out where things are](https://earezki.com/ai-news/2026-02-26-how-i-cut-my-ai-coding-agents-token-usage-by-65-without-changing-models/) — re-reading files, tracing imports, grepping for symbols. Every. Single. Session.

Context Bunker fixes this. It's an [MCP](https://modelcontextprotocol.io/) server that indexes your codebase using **tree-sitter AST parsing** and gives your AI tools instant access to structural intelligence — dependency graphs, call trees, dead code, cross-session diffs — all from a local SQLite database.

**One call replaces 8-16 grep/read calls. ~90% token savings. Zero cloud. Zero API keys.**

Works with Claude Code, Cursor, Windsurf, Copilot, and any MCP-compatible client.

> **Why not just grep?** Grep finds text. Context Bunker understands **structure** — dependency graphs, cross-session memory, dead code detection, and token-efficient summaries. Things grep structurally can't do. [Full comparison](./docs/cli-comparison.md).

## Setup

### Install

```bash
# Run directly — no install needed
npx context-bunker-mcp /your/project

# Or install globally
npm install -g context-bunker-mcp
```

### Add to your AI tool

**Claude Code:**
```bash
# With a project (auto-indexes on startup)
claude mcp add context-bunker -- npx context-bunker-mcp /your/project

# Without a project (AI calls set_project dynamically)
claude mcp add context-bunker -- npx context-bunker-mcp
```

**Cursor / Windsurf / VS Code** — add to `settings.json`:
```json
{
  "mcpServers": {
    "context-bunker": {
      "command": "npx",
      "args": ["context-bunker-mcp", "/your/project"]
    }
  }
}
```

## Tools (15)

| Tool | What it does |
|------|-------------|
| 🔥 `get_changes_since_last_session` | What changed since the AI last looked. No more re-orientation. |
| 🔥 `find_unused_exports` | Dead code detection — exported but never imported anywhere. |
| 🔥 `get_file_summary` | File overview in ~50 tokens. Scan 10 files for the cost of 1. |
| 🔥 `search_by_pattern` | Find structural patterns: HTTP calls, env access, error handlers, async, TODOs. |
| 🧠 `get_smart_context` | Full file context in 1 call — imports, exports, dependents, types, tests. |
| 🧠 `get_dependency_graph` | "If I change this, what breaks?" — transitive import graph with depth control. |
| 🧠 `find_symbol` | AST-aware symbol search by name, kind, and scope. Not text matching. |
| 🧠 `find_references` | Where a symbol is used, classified by kind (import, call, type annotation). |
| 🧠 `get_call_graph` | What a function calls, recursively, as a tree. |
| 🧠 `get_symbol_source` | Extract one definition — not the whole file. 80% token savings. |
| 🧠 `get_project_map` | Architecture overview: modules, public APIs, relationships. |
| 🔧 `set_project` | Point the index at any project directory on the fly. |
| 🔧 `search_code` | Semantic search via local TF-IDF. No API keys needed. |
| 🔧 `reindex` | Force re-index of the codebase or a single file. |
| 🔧 `get_status` | Index health, file counts, token savings estimate. |

🔥 Unique &nbsp; 🧠 Core Intelligence &nbsp; 🔧 Housekeeping

## Language Support

TypeScript, JavaScript (TSX/JSX/MTS/CTS), Python, Go, Rust, Java, C#

Powered by tree-sitter WASM grammars. Adding a new language = one extractor file in `src/languages/`.

## Tech Stack

| | |
|---|---|
| **Runtime** | Bun (Node.js fallback) — `bun:sqlite` = zero native deps, 4-10x faster startup |
| **MCP** | `@modelcontextprotocol/sdk` |
| **AST** | `web-tree-sitter` (WASM) — no native bindings, works everywhere |
| **Storage** | SQLite (WAL mode) — single file, survives restarts |
| **Search** | TF-IDF (local) — zero API keys, no cloud |
| **Watch** | `chokidar` — incremental re-index on file changes |

## Storage

The index lives in your OS cache directory — **not** inside the project. No `.gitignore` needed.

| Platform | Location |
|----------|----------|
| macOS | `~/Library/Caches/context-bunker/<project>/index.db` |
| Linux | `~/.cache/context-bunker/<project>/index.db` |
| Windows | `%LOCALAPPDATA%\context-bunker\<project>\index.db` |

Want it inside the project instead? Use `--local` or set `{ "storage": "local" }` in `.context-bunker.json`.

## License

MIT

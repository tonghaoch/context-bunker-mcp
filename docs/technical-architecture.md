# Technical Architecture: context-bunker

## 1. Design Constraints

- **Zero external API keys** — no OpenAI, no cloud services
- **Zero native bindings** — must work on Windows/Mac/Linux without compilation (Bun-first; Node fallback uses optional `better-sqlite3`)
- **Single command install** — `bunx context-bunker` (Bun) or `npx context-bunker` (Node with optional native dep)
- **<500ms cold start** (Bun) / <2s (Node) — index loads from SQLite on startup
- **Incremental indexing** — only re-parse changed files
- **TypeScript-native** — same language as MCP SDK ecosystem

## 2. Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Runtime** | **Bun-first** (Node 20+ fallback) | `bun:sqlite` built-in (zero native deps, 3x faster reads); Node users fall back to `better-sqlite3` |
| **MCP SDK** | `@modelcontextprotocol/sdk` | Official TypeScript SDK, Zod schema validation |
| **AST Parser** | `web-tree-sitter` (WASM) | No native bindings, 30+ languages, runs in Node/Bun |
| **Search** | TF-IDF (custom, simple) | Zero API keys, fast, local, sufficient for code search |
| **Storage** | `bun:sqlite` (primary) / `better-sqlite3` (Node fallback) | Single file, zero setup, survives restarts. Runtime detection: `typeof Bun !== 'undefined'` |
| **File Watching** | `chokidar` | Incremental re-index on changes |
| **Transport** | stdio (primary), SSE (optional) | stdio for CLI tools, SSE for IDE integrations |

### Runtime Strategy: Bun-First + Node Fallback

```typescript
// src/store/db.ts — runtime detection
const isBun = typeof globalThis.Bun !== 'undefined'
const db = isBun
  ? await openBunSqlite(dbPath)   // bun:sqlite — zero deps, built-in
  : await openBetterSqlite3(dbPath) // better-sqlite3 — optional native dep
```

**Performance comparison:**

| Operation | Node.js | Bun | Speedup |
|-----------|---------|-----|---------|
| Startup time | 40-120ms | 8-15ms | 4-10x |
| SQLite reads | baseline | 3-6x faster (interop) | ~3x |
| File I/O | baseline | ~2x faster | 2x |
| Native deps needed | `better-sqlite3` (C++ build) | None (built-in) | ∞ |

**Distribution:**

| Command | Runtime | Works? |
|---------|---------|--------|
| `bunx context-bunker` | Bun | ✅ Best experience |
| `npx context-bunker` | Node | ✅ With optional `better-sqlite3` |
| MCP config: `"command": "bun"` | Bun | ✅ Recommended |
| MCP config: `"command": "node"` | Node | ✅ Fallback |

## 3. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     MCP Client                                   │
│         (Claude Code, Cursor, Windsurf, etc.)                   │
└──────────────────────┬──────────────────────────────────────────┘
                       │ stdio / SSE
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                   context-bunker MCP Server                      │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Tool Router                                                 │  │
│  │  registerTool('get_smart_context', ...)                     │  │
│  │  registerTool('find_symbol', ...)                           │  │
│  │  registerTool('get_dependency_graph', ...)                  │  │
│  │  ... (15 tools total)                                       │  │
│  └───────────────────────┬────────────────────────────────────┘  │
│                          │                                       │
│  ┌───────────────────────▼────────────────────────────────────┐  │
│  │ Query Engine                                                │  │
│  │  SymbolIndex   → find_symbol, find_references               │  │
│  │  ImportGraph   → get_dependency_graph, get_smart_context    │  │
│  │  CallGraph     → get_call_graph                             │  │
│  │  SearchEngine  → search_by_pattern, TF-IDF search           │  │
│  │  DiffEngine    → get_changes_since_last_session             │  │
│  └───────────────────────┬────────────────────────────────────┘  │
│                          │                                       │
│  ┌───────────────────────▼────────────────────────────────────┐  │
│  │ Index Store (SQLite)                                        │  │
│  │  files        → path, hash, mtime, last_indexed             │  │
│  │  symbols      → name, kind, file_id, start_line, end_line   │  │
│  │  imports      → file_id, symbol, from_file, from_module     │  │
│  │  exports      → file_id, symbol, kind                       │  │
│  │  calls        → caller_symbol_id, callee_name, file_id      │  │
│  │  tfidf        → term, file_id, tf_score                     │  │
│  │  sessions     → timestamp, file_hashes_snapshot             │  │
│  └───────────────────────┬────────────────────────────────────┘  │
│                          │                                       │
│  ┌───────────────────────▼────────────────────────────────────┐  │
│  │ Indexer                                                     │  │
│  │  FileWatcher  → chokidar, detects changes                  │  │
│  │  Parser       → web-tree-sitter (WASM), extracts AST       │  │
│  │  Extractor    → symbols, imports, exports, calls            │  │
│  │  TF-IDF       → builds term frequency index                 │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## 4. Data Model (SQLite)

```sql
-- Core tables
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  hash TEXT NOT NULL,          -- content hash for change detection
  mtime INTEGER NOT NULL,
  lines INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
);

CREATE TABLE symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,           -- function, class, interface, type, variable, enum
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  is_exported BOOLEAN DEFAULT FALSE,
  signature TEXT,               -- e.g. "(req: Request, res: Response): void"
  jsdoc TEXT,
  UNIQUE(file_id, name, kind, start_line)
);

CREATE TABLE imports (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,         -- imported symbol name
  from_path TEXT NOT NULL,      -- resolved path or module name
  is_type_only BOOLEAN DEFAULT FALSE,
  is_external BOOLEAN DEFAULT FALSE
);

CREATE TABLE exports (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  is_reexport BOOLEAN DEFAULT FALSE,
  original_path TEXT            -- for re-exports: where it comes from
);

CREATE TABLE calls (
  id INTEGER PRIMARY KEY,
  caller_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  callee_name TEXT NOT NULL,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line INTEGER NOT NULL
);

-- TF-IDF search index
CREATE TABLE tfidf (
  term TEXT NOT NULL,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tf REAL NOT NULL,
  PRIMARY KEY (term, file_id)
);

CREATE TABLE idf (
  term TEXT NOT NULL PRIMARY KEY,
  idf REAL NOT NULL
);

-- Session tracking
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  file_snapshot TEXT            -- JSON: {path: {hash, symbols[]}} at session end
);

-- Indexes
CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_symbols_kind ON symbols(kind);
CREATE INDEX idx_symbols_file ON symbols(file_id);
CREATE INDEX idx_imports_file ON imports(file_id);
CREATE INDEX idx_imports_from ON imports(from_path);
CREATE INDEX idx_exports_file ON exports(file_id);
CREATE INDEX idx_exports_symbol ON exports(symbol);
CREATE INDEX idx_calls_caller ON calls(caller_symbol_id);
CREATE INDEX idx_calls_callee ON calls(callee_name);
```

## 5. Tree-Sitter Strategy

### Why web-tree-sitter (WASM)

| Option | Native bindings? | Windows? | Bundle size | Speed |
|--------|-----------------|----------|-------------|-------|
| `tree-sitter` (native) | Yes ❌ | Build issues | N/A | Fastest |
| `web-tree-sitter` (WASM) | No ✅ | Works ✅ | ~500KB per lang | Fast enough |
| `@aspect-build/tree-sitter` | Prebuild | Partial | N/A | Fast |

web-tree-sitter runs in any Node/Bun environment without compilation. The WASM overhead is ~2-5x slower than native, but parsing a 1000-line file takes <10ms — well within budget.

### Language Support

| Language | Tree-sitter grammar | Extractor | Priority |
|----------|-------------------|-----------|----------|
| TypeScript/TSX | `tree-sitter-typescript` | ✅ `languages/typescript.ts` | P0 |
| JavaScript/JSX | `tree-sitter-javascript` | ✅ `languages/javascript.ts` | P0 |
| Python | `tree-sitter-python` | ✅ `languages/python.ts` | P1 |
| Go | `tree-sitter-go` | ✅ `languages/go.ts` | P1 |
| Rust | `tree-sitter-rust` | ✅ `languages/rust.ts` | P2 |
| Java | `tree-sitter-java` | 🔲 Grammar only | P2 |
| C/C++ | `tree-sitter-c`, `tree-sitter-cpp` | 🔲 Not yet | P2 |

### Symbol Extraction (per language)

Tree-sitter queries extract:
- **Function definitions** — name, params, return type, exported?, line range
- **Class definitions** — name, methods, extends/implements, exported?
- **Interface/type definitions** — name, properties, exported?
- **Import statements** — symbol, source path, type-only?
- **Export statements** — symbol, kind, re-export?
- **Call expressions** — function name, within which parent function
- **Variable declarations** — name, kind (const/let/var), exported?

## 6. Indexing Pipeline

```
File Changed (watcher)
    │
    ▼
Check hash — same as stored? → skip
    │ (different)
    ▼
Parse with tree-sitter → AST
    │
    ▼
Extract: symbols, imports, exports, calls
    │
    ▼
Resolve import paths (relative → absolute, handle aliases)
    │
    ▼
Update SQLite tables (DELETE old + INSERT new, within transaction)
    │
    ▼
Update TF-IDF index (tokenize identifiers + comments)
    │
    ▼
Mark file as indexed (hash + timestamp)
```

### Import Path Resolution

Language-aware resolution via `resolveImportPath(fromPath, importingFile, projectRoot, language?)`:

**TypeScript/JavaScript:**
```typescript
"./jwt"           → src/auth/jwt.ts (relative, tries .ts/.tsx/.js extensions)
"../models/user"  → src/models/user.ts (relative)
"@/utils/crypto"  → src/utils/crypto.ts (tsconfig paths)
"express"         → (external, mark as is_external=true)
"."               → index.ts barrel (resolve to actual re-exports)
```
Uses `tsconfig.json` `paths` and `baseUrl` if present.

**Python:**
```python
".utils"          → utils.py or utils/__init__.py (relative, dots = directory levels)
"..models"        → ../models.py or ../models/__init__.py
"os"              → (external)
```

**Go:**
```go
"fmt"                         → (external)
"example.com/myapp/auth"      → auth/ (local, resolved via go.mod module name)
```

**Rust:**
```rust
"crate::utils::hash_password" → src/utils.rs (local, crate:: maps to src/)
"super::models"               → parent module (relative)
"std::collections::HashMap"   → (external)
```

## 7. Performance Budget

| Operation | Target | Notes |
|-----------|--------|-------|
| Cold start (load SQLite index) | <2s | Depends on index size |
| Index 1 file | <50ms | Parse + extract + store |
| Full index 500 files | <15s | Parallelized with worker_threads |
| `find_symbol` query | <10ms | SQLite LIKE query on indexed column |
| `get_smart_context` query | <20ms | 3-4 SQLite queries + assembly |
| `get_dependency_graph` depth=3 | <50ms | BFS on import graph |
| `get_call_graph` depth=2 | <30ms | BFS on call graph |
| `get_project_map` | <100ms | Full table scan + aggregation |

## 8. File Structure

```
context-bunker-mcp/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # Entry point: CLI args, MCP server setup
│   ├── server.ts                 # Tool registration (15 tools)
│   ├── config.ts                 # .context-bunker.json config loading + validation
│   │
│   ├── tools/                    # One file per tool
│   │   ├── find-symbol.ts
│   │   ├── find-references.ts
│   │   ├── get-smart-context.ts
│   │   ├── get-dependency-graph.ts
│   │   ├── get-call-graph.ts
│   │   ├── get-symbol-source.ts
│   │   ├── get-project-map.ts
│   │   ├── get-file-summary.ts
│   │   ├── get-changes.ts
│   │   ├── find-unused-exports.ts
│   │   ├── search-by-pattern.ts
│   │   └── search-code.ts
│   │
│   ├── indexer/                  # Indexing pipeline
│   │   ├── indexer.ts            # Main indexer orchestrator
│   │   ├── parser.ts             # Tree-sitter wrapper (WASM from tree-sitter-wasms npm)
│   │   ├── extractor.ts          # Dispatches to language extractors
│   │   ├── resolver.ts           # Language-aware import path resolution
│   │   ├── watcher.ts            # File watcher for incremental updates
│   │   └── tfidf.ts              # TF-IDF search index builder
│   │
│   ├── store/                    # SQLite data layer
│   │   ├── db.ts                 # Database connection (Bun/better-sqlite3)
│   │   ├── schema.ts             # Schema + indices
│   │   └── queries.ts            # ~40 reusable query functions
│   │
│   ├── languages/                # Per-language AST extractors
│   │   ├── typescript.ts         # TS/TSX extraction (P0)
│   │   ├── javascript.ts         # JS/JSX — re-exports TS extractor (P0)
│   │   ├── python.ts             # Python extraction (P1)
│   │   ├── go.ts                 # Go extraction (P1)
│   │   └── rust.ts               # Rust extraction (P2)
│   │
│   └── utils/
│       └── paths.ts              # Path normalization
│
├── tests/
│   ├── indexer.test.ts           # TS indexer tests
│   ├── tools.test.ts             # Tool function tests
│   ├── python.test.ts            # Python extractor tests
│   ├── go.test.ts                # Go extractor tests
│   ├── rust.test.ts              # Rust extractor tests
│   └── fixtures/
│       ├── small-ts/             # 5-file TS project
│       ├── small-py/             # 4-file Python project
│       ├── small-go/             # 3-file Go project
│       └── small-rust/           # 4-file Rust project
│
└── docs/
    ├── market-analysis.md
    ├── competitor-analysis.md
    ├── tool-design.md
    ├── cli-comparison.md
    ├── implementation-plan.md
    └── technical-architecture.md  # (this file)
```

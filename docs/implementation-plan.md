# Implementation Plan: context-bunker

## Overview

**Goal:** Ship a working MCP server that indexes codebases and exposes 15 tools to AI coding agents.

**Target:** MVP in ~5 weeks. Ship with TS/JS support, expand languages from community PRs.

---

## Phase 1: Foundation (Week 1)

**Goal:** MCP server boots, connects to clients, SQLite stores data, tree-sitter parses files.

### 1.1 Project Scaffold

```
bun init
```

- `package.json` with `"bin": { "context-bunker": "./dist/index.js" }` for `npx` support
- `tsconfig.json` — strict, ESM, target ES2022
- Basic scripts: `build`, `dev`, `test`

**Dependencies:**
```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.x",
    "web-tree-sitter": "^0.24",
    "better-sqlite3": "^11",
    "chokidar": "^4",
    "zod": "^3.25"
  },
  "devDependencies": {
    "typescript": "^5.7",
    "@types/better-sqlite3": "^7"
  }
}
```

**Files to create:**
- `src/index.ts` — entry point, parse CLI args, start server
- `src/server.ts` — McpServer setup with StdioTransport

### 1.2 SQLite Store

**Files:**
- `src/store/db.ts` — connection, schema creation, WAL mode
- `src/store/migrations.ts` — schema versioning (simple: version table + SQL scripts)
- `src/store/queries.ts` — typed query functions

**Schema:** See `docs/technical-architecture.md` for full SQL. Key tables: `files`, `symbols`, `imports`, `exports`, `calls`, `tfidf`, `idf`, `sessions`.

**Test:** Write to DB, read back, verify data integrity.

### 1.3 Tree-Sitter Setup

**Files:**
- `src/indexer/parser.ts` — initialize web-tree-sitter, load WASM grammars, parse file → AST
- WASM grammars loaded from `tree-sitter-wasms` npm package at runtime

**Key decisions:**
- WASM grammars come from `tree-sitter-wasms` dependency (not vendored in repo)
- Language detection by file extension (`.ts` → typescript, `.tsx` → tsx, `.js/.jsx` → javascript, `.py` → python, `.go` → go)

**Test:** Parse a `.ts` file, walk the AST, print node types.

### 1.4 Minimal MCP Server

**Files:**
- `src/server.ts` — register 1 placeholder tool (`get_status`), connect via stdio

**Test:** Start server, connect with Claude Code `mcp add`, verify tool appears in `mcp list`.

**Milestone:** `npx context-bunker` starts an MCP server that responds to tool calls.

---

## Phase 2: Indexing Engine (Week 2)

**Goal:** Full indexing pipeline — parse files, extract symbols/imports/exports/calls, store in SQLite, watch for changes.

### 2.1 Symbol Extractor

**Files:**
- `src/indexer/extractor.ts` — walk AST, extract symbols, imports, exports, calls
- `src/languages/typescript.ts` — tree-sitter queries for TS/TSX
- `src/languages/javascript.ts` — tree-sitter queries for JS/JSX

**What to extract from TypeScript AST:**

| AST Node Type | Extract |
|---------------|---------|
| `function_declaration` | name, params, return type, exported?, line range |
| `arrow_function` (in variable_declarator) | name (from variable), params, line range |
| `class_declaration` | name, extends, implements, methods, exported? |
| `interface_declaration` | name, properties, extends, exported? |
| `type_alias_declaration` | name, exported? |
| `enum_declaration` | name, members, exported? |
| `import_statement` | symbols, source path, type-only? |
| `export_statement` | symbols, re-export source |
| `call_expression` | function name, parent function scope |

**Key challenge:** Arrow functions assigned to variables (`const foo = () => {}`) need to be recognized as named function definitions. Handle by checking if parent is `variable_declarator` with `export` keyword.

### 2.2 Import Path Resolver

**Files:**
- `src/indexer/resolver.ts` — resolve relative paths, tsconfig paths, barrel files

**Resolution order:**
1. Relative paths (`./foo`, `../bar`) → resolve to absolute
2. tsconfig `paths` (`@/utils/*`) → map to filesystem
3. `index.ts` barrel → resolve `./utils` to `./utils/index.ts`
4. External modules (`express`) → mark as `is_external=true`, don't resolve

**Reads:** `tsconfig.json` (if present) for `paths`, `baseUrl`, `rootDir`.

### 2.3 Indexer Orchestrator

**Files:**
- `src/indexer/indexer.ts` — scan directory, filter by language, hash files, index changed ones

**Algorithm:**
```
1. Glob for supported file extensions
2. For each file:
   a. Compute hash (xxhash or SHA-256 of content)
   b. Check if hash matches stored hash → skip if same
   c. Parse with tree-sitter
   d. Extract symbols, imports, exports, calls
   e. Resolve import paths
   f. Store in SQLite (DELETE old rows for file + INSERT new, in transaction)
3. Delete DB rows for files that no longer exist
```

**Parallelization:** Use `Promise.all` with concurrency limit (e.g., 8 files at once). Tree-sitter WASM is sync per parse, but file I/O is async.

### 2.4 File Watcher

**Files:**
- `src/indexer/watcher.ts` — chokidar setup, debounce, re-index on change

**Behavior:**
- Watch project root for `add`, `change`, `unlink` events
- Debounce: 200ms (batch rapid changes)
- On change: re-index only the changed file
- On delete: remove file from DB
- Ignore: `node_modules/`, `.git/`, `dist/`, `build/`, `coverage/`

### 2.5 TF-IDF Builder

**Files:**
- `src/indexer/tfidf.ts` — tokenize identifiers + comments, compute TF-IDF scores

**Tokenization:** Split camelCase, PascalCase, snake_case into terms. `getUserById` → `["get", "user", "by", "id"]`. Store term frequencies per file, compute IDF across corpus.

**Milestone:** `npx context-bunker` indexes a project, stores everything in `.context-bunker/index.db`.

---

## Phase 3: Core Tools (Week 3)

**Goal:** Implement the 7 most impactful tools.

### 3.1 `find_symbol`

**Input:** `{ query, kind?, scope? }`
**Query:** SQLite `WHERE name LIKE ?` with wildcard support. Filter by kind, scope (path prefix).
**Output:** Array of `{ name, kind, file, line, signature }`

### 3.2 `find_references`

**Input:** `{ symbol, file? }`
**Query:** Find all imports that reference the symbol. Join `imports` table with `files` table.
**Output:** Array of `{ file, line, kind }` where kind = import | call | type_reference

### 3.3 `get_smart_context`

**Input:** `{ file_path }`
**Algorithm:**
1. Get file metadata from `files` table
2. Get exports from `exports` table
3. Get imports from `imports` table (with resolved paths)
4. For non-external imports: get the symbol's signature from `symbols` table
5. Find files that import from this file (reverse lookup on `imports`)
6. Find test file: glob for `*.test.ts`, `*.spec.ts` with matching name
7. Assemble and return

### 3.4 `get_dependency_graph`

**Input:** `{ file_path, direction: "dependencies" | "dependents", depth }`
**Algorithm:** BFS on the import graph stored in `imports` table.
- `dependencies` direction: follow `imports.from_path` FROM the file
- `dependents` direction: follow `imports.file_id` TO the file
- Handle barrel files by following re-exports

### 3.5 `get_call_graph`

**Input:** `{ function_name, file?, depth }`
**Algorithm:**
1. Find the function's symbol ID
2. BFS on `calls` table: caller_symbol_id → callee_name → resolve callee to symbol → repeat
3. Format as tree

### 3.6 `get_symbol_source`

**Input:** `{ symbol, file? }`
**Algorithm:**
1. Find symbol in `symbols` table → get file_id, start_line, end_line
2. Read the file, extract lines [start_line, end_line]
3. Include JSDoc comment above start_line if present

### 3.7 `get_project_map`

**Input:** `{ depth? }`
**Algorithm:**
1. Group files by directory
2. For each directory: count files, list exported symbols
3. Format as tree with symbol summaries

**Milestone:** 7 tools working, testable with Claude Code.

---

## Phase 4: Unique Tools + Search (Week 4)

**Goal:** Implement the 4 unique/differentiating tools + TF-IDF search integration.

### 4.1 `get_changes_since_last_session`

**Algorithm:**
1. On server startup: load last session from `sessions` table
2. Get stored file snapshot (path → hash map)
3. Compute current file hashes
4. Diff: added (in current, not in snapshot), modified (hash differs), deleted (in snapshot, not current)
5. For modified files: compare stored symbols vs current symbols → find added/removed/modified symbols
6. On server shutdown: save current snapshot to `sessions` table

### 4.2 `find_unused_exports`

**Algorithm:**
1. Get all exported symbols from `exports` table (where `is_external=false`, i.e., internal files)
2. For each: check if any import in `imports` table references it
3. Return those with zero references
4. Add caveat: "if this is a library, external consumers may use these"

### 4.3 `search_by_pattern`

**Patterns implemented via tree-sitter queries:**
- `http_calls` — find `call_expression` where function name is `fetch` or matches `axios.*`, `http.*`
- `env_access` — find `member_expression` matching `process.env.*`
- `error_handlers` — find `try_statement` blocks
- `async_functions` — find function declarations with `async` keyword
- `todos` — find comments containing `TODO` or `FIXME`
- `test_files` — find files matching `*.test.*`, `*.spec.*`

### 4.4 `get_file_summary`

**Algorithm:**
1. Get file metadata, imports, exports from DB
2. Get calls made from this file
3. Get dependents (files that import this)
4. Format as compact text (~50 tokens)

### 4.5 TF-IDF Search Integration

Add `search_code` tool (or integrate into `find_symbol` as fallback):
- Tokenize query into terms
- Score files by TF-IDF similarity
- Return top-N files with matched terms highlighted

**Milestone:** All 15 tools working. Full feature set.

---

## Phase 5: Polish (Week 5)

### 5.1 CLI Polish

- `bunx context-bunker` — auto-detect project root, index, start server
- `bunx context-bunker --init` — create config file
- `bunx context-bunker --status` — show index stats
- `--verbose` / `--quiet` flags
- Graceful shutdown (save session snapshot) ✅ (done in Phase 4)

### 5.2 Config File (`.context-bunker.json`)

```json
{
  "include": ["src/", "lib/"],
  "exclude": ["**/*.test.ts", "**/__mocks__/**"],
  "languages": ["typescript", "javascript"],
  "maxFileSize": 1048576
}
```

### 5.3 Testing

| Test Type | Tool | Coverage |
|-----------|------|----------|
| Unit | bun test | Extractor, resolver, queries, TF-IDF |
| Integration | bun test | Index a fixture project → query tools → validate output |
| Snapshot | bun test | Tool outputs against known codebases |

**Fixture projects:**
- `tests/fixtures/small-ts/` — 5-file TS project
- `tests/fixtures/small-py/` — 4-file Python project (functions, classes, imports, async, decorators)
- `tests/fixtures/small-go/` — 3-file Go project with go.mod (functions, methods, structs, interfaces)

### 5.4 README + Demo

- Demo GIF: show Claude Code using context-bunker tools
- Installation instructions for Claude Code, Cursor, Windsurf
- Benchmark: token savings on a real project

---

## Phase 6: Publish (Week 6)

### 6.1 npm Publish

- `npm publish` as `context-bunker`
- Ensure `bunx context-bunker` / `npx context-bunker` works out of the box
- Vendor tree-sitter WASM grammars in the package

### 6.2 Distribution

- GitHub releases with changelog
- MCP registry listing (PulseMCP, mcpservers.org, LobeHub)
- Social: Reddit (r/javascript, r/typescript), Hacker News, Twitter/X

---

## Post-MVP Roadmap

| Priority | Feature | Effort |
|----------|---------|--------|
| ~~P1~~ | ~~Python language support~~ | ✅ Implemented |
| ~~P1~~ | ~~Go language support~~ | ✅ Implemented |
| P1 | SSE transport (for IDE integrations) | 1 day |
| ~~P2~~ | ~~Rust, Java, C# support~~ | ✅ Implemented |
| ~~P2~~ | ~~Monorepo-aware indexing (auto-detect project root)~~ | ✅ Implemented — all tools auto-detect nearest project root from any path |
| ~~P2~~ | ~~`find_unused_code` tool (internal dead code)~~ | ✅ Implemented |
| ~~P2~~ | ~~`search_code` tool (TF-IDF semantic search)~~ | ✅ Implemented |
| P2 | `analyze_pr_impact` tool (git diff → affected symbols) | 2-3 days |
| P2 | `trace_api_flow` tool (route → handler → service) | 3-5 days |
| P2 | C/C++ language support | 1-2 days |
| P3 | Remote codebases (GitHub URL → index) | 1 week |
| P3 | Shared indexes (team-wide, git-synced) | 1 week |
| P3 | Web dashboard for index visualization | 1-2 weeks |

---

## Risk Mitigation

| Risk | Severity | Mitigation |
|------|----------|------------|
| web-tree-sitter WASM too slow | Medium | Benchmark early (Phase 1.3). Fallback: use `@aspect-build/tree-sitter` prebuilds |
| better-sqlite3 native build fails | Medium | Alternative: `sql.js` (pure WASM SQLite). Slightly slower but zero native deps |
| Tree-sitter queries miss edge cases | High | Extensive test fixtures. Iterate on extraction accuracy throughout development |
| MCP SDK breaking changes | Low | Pin version, update incrementally |
| Competing project launches | Medium | Ship fast, focus on DX (npx install), build community early |

---

## Implementation Order (File-by-File)

### Week 1
1. `package.json`, `tsconfig.json`, `.gitignore`
2. `src/store/db.ts` — SQLite connection + schema
3. `src/store/queries.ts` — typed query functions
4. `src/indexer/parser.ts` — tree-sitter WASM init
5. `src/server.ts` — MCP server with `get_status` placeholder
6. `src/index.ts` — CLI entry point

### Week 2
7. `src/languages/typescript.ts` — TS/TSX extraction queries
8. `src/languages/javascript.ts` — JS/JSX extraction queries
9. `src/indexer/extractor.ts` — AST → symbols/imports/exports/calls
10. `src/indexer/resolver.ts` — import path resolution
11. `src/indexer/indexer.ts` — orchestrator
12. `src/indexer/watcher.ts` — file watcher
13. `src/indexer/tfidf.ts` — TF-IDF builder

### Week 3
14. `src/tools/find-symbol.ts`
15. `src/tools/find-references.ts`
16. `src/tools/get-smart-context.ts`
17. `src/tools/get-dependency-graph.ts`
18. `src/tools/get-call-graph.ts`
19. `src/tools/get-symbol-source.ts`
20. `src/tools/get-project-map.ts`

### Week 4
21. `src/tools/get-changes.ts`
22. `src/tools/find-unused-exports.ts`
23. `src/tools/search-by-pattern.ts`
24. `src/tools/get-file-summary.ts`
25. `src/tools/reindex.ts`
26. Update `src/tools/get-status.ts` with token tracking

### Week 5 (Phase 5: Polish)
27. CLI polish (`src/index.ts` — args, config, graceful shutdown)
28. Config file support (`.context-bunker.json`)
29. Tests (`tests/`)
30. README, demo GIF

### Week 6 (Phase 6: Publish)
31. npm publish prep (WASM grammars come from tree-sitter-wasms dependency)
32. MCP registry listings
33. Social launch

# Tool Design: context-bunker MCP Server

## Design Principles

1. **Read-only** — no file editing (AI tools already do this; adding editing creates security concerns and duplication)
2. **Token-efficient** — every tool should return less data than the equivalent CLI workflow
3. **Pre-computed** — expensive operations done at index time, not query time
4. **Persistent** — index survives across sessions (SQLite)
5. **Incremental** — file watcher re-indexes only changed files

## Core Tools (11 + 2 housekeeping)

---

### 1. `get_smart_context`

**The single most valuable tool. Assembles everything an AI needs to understand and modify a file in one call.**

**Input:**
```json
{ "file_path": "src/auth/middleware.ts" }
```

**Output:**
```json
{
  "file": {
    "path": "src/auth/middleware.ts",
    "lines": 45,
    "lastModified": "2026-02-28T10:30:00Z"
  },
  "exports": [
    { "name": "authMiddleware", "kind": "function", "line": 12 },
    { "name": "requireRole", "kind": "function", "line": 34 }
  ],
  "imports": [
    { "symbol": "verifyToken", "from": "src/auth/jwt.ts", "kind": "function" },
    { "symbol": "User", "from": "src/models/user.ts", "kind": "interface" },
    { "symbol": "Request", "from": "express", "kind": "type", "external": true }
  ],
  "importedBy": [
    { "file": "src/routes/api.ts", "symbols": ["authMiddleware"] },
    { "file": "src/routes/admin.ts", "symbols": ["authMiddleware", "requireRole"] }
  ],
  "testFile": "tests/auth/middleware.test.ts",
  "relatedTypes": [
    { "name": "User", "file": "src/models/user.ts", "kind": "interface", "summary": "id, email, name, role" }
  ]
}
```

**CLI comparison:**
| Approach | Tool calls | Tokens | Time |
|----------|-----------|--------|------|
| Claude Code (Read + Grep) | 8-16 calls | ~3,000-5,000 | 30-60s |
| `get_smart_context` | 1 call | ~300-500 | <50ms |

**Token savings: ~80-90%**

---

### 2. `get_dependency_graph`

**Transitive import graph — "if I change this file, what might break?"**

**Input:**
```json
{
  "file_path": "src/utils/auth.ts",
  "direction": "dependents",
  "depth": 3
}
```

**Output:**
```json
{
  "root": "src/utils/auth.ts",
  "direction": "dependents",
  "graph": [
    {
      "file": "src/middleware/auth.ts",
      "depth": 1,
      "imports": ["verifyToken", "hashPassword"]
    },
    {
      "file": "src/routes/api.ts",
      "depth": 2,
      "imports": ["authMiddleware"],
      "via": "src/middleware/auth.ts"
    }
  ],
  "totalAffected": 8,
  "barrelFiles": ["src/utils/index.ts"]
}
```

**Why CLI can't match this:** Transitive graph traversal requires O(n × depth) grep calls. Barrel file (index.ts) re-exports are invisible to text search. Pre-computed graph does BFS in <10ms.

**Token savings: ~90%**

---

### 3. `find_symbol`

**AST-aware symbol search — finds definitions, not text matches.**

**Input:**
```json
{
  "query": "handle*",
  "kind": "function",
  "scope": "src/routes/"
}
```

**Output:**
```json
{
  "results": [
    { "name": "handleLogin", "kind": "function", "file": "src/routes/auth.ts", "line": 23, "params": "(req, res)" },
    { "name": "handleRegister", "kind": "function", "file": "src/routes/auth.ts", "line": 45, "params": "(req, res)" },
    { "name": "handleWebhook", "kind": "function", "file": "src/routes/webhooks.ts", "line": 12, "params": "(req, res)" }
  ]
}
```

**vs Grep:** `grep "handle"` returns 200+ matches (comments, strings, variable usage, imports). AST search returns 3 actual definitions. Signal-to-noise ratio: 100x better.

**Token savings: ~70%**

---

### 4. `find_references`

**Where is this symbol used across the codebase?**

**Input:**
```json
{ "symbol": "UserService", "file": "src/services/user.ts" }
```

**Output:**
```json
{
  "symbol": "UserService",
  "definedIn": "src/services/user.ts:5",
  "references": [
    { "file": "src/routes/api.ts", "line": 3, "kind": "import" },
    { "file": "src/routes/api.ts", "line": 15, "kind": "instantiation" },
    { "file": "src/routes/admin.ts", "line": 7, "kind": "import" },
    { "file": "tests/services/user.test.ts", "line": 4, "kind": "import" }
  ],
  "totalReferences": 4
}
```

**vs Grep:** Grep finds text `UserService` in comments, strings, and unrelated variables. AST-aware reference search returns only actual code references with their kind (import, call, instantiation, type annotation).

**Token savings: ~70%**

---

### 5. `get_call_graph`

**What does this function call, recursively?**

**Input:**
```json
{ "function": "processPayment", "file": "src/payments/processor.ts", "depth": 2 }
```

**Output:**
```text
processPayment()                    src/payments/processor.ts:15
├── validateCard()                  src/payments/validation.ts:8
│   ├── checkLuhn()                 src/payments/validation.ts:23
│   └── checkExpiry()               src/payments/validation.ts:34
├── chargeStripe()                  src/payments/stripe.ts:12
│   ├── stripe.paymentIntents.create()  (external: stripe)
│   └── logTransaction()            src/audit/logger.ts:5
└── sendReceipt()                   src/email/receipts.ts:18
    └── renderTemplate()            src/email/templates.ts:7
```

**Why CLI can't match this:** At depth=2 with branching factor 4, Claude needs to read ~20 files sequentially, manually parsing function bodies. The pre-computed call graph returns this in 1 call.

**Token savings: ~85%**

---

### 6. `get_changes_since_last_session` ✨ UNIQUE

**What changed in the codebase since the AI last interacted with it? Impossible without persistence.**

**Input:** (none — uses stored index state)

**Output:**
```json
{
  "lastSessionEnd": "2026-02-28T09:00:00Z",
  "summary": "3 files modified, 1 added, 1 deleted",
  "changes": {
    "added": [
      { "file": "src/routes/webhooks.ts", "symbols": ["handleStripeWebhook", "verifySignature"] }
    ],
    "modified": [
      {
        "file": "src/auth/middleware.ts",
        "symbolsAdded": ["rateLimiter"],
        "symbolsRemoved": ["deprecatedCheck"],
        "symbolsModified": ["authMiddleware"]
      }
    ],
    "deleted": ["src/utils/legacy.ts"]
  }
}
```

**Why CLI fundamentally cannot do this:** No persistence between sessions. The MCP server diffs current file state against stored index. Eliminates the 80% "orientation" cost.

**Token savings: 100% (impossible otherwise)**

---

### 7. `find_unused_exports` ✨ UNIQUE

**Dead code detection — symbols defined but never imported anywhere.**

**Input:**
```json
{ "scope": "src/" }
```

**Output:**
```json
{
  "unusedExports": [
    { "symbol": "legacyHash", "file": "src/utils/crypto.ts", "line": 45, "kind": "function" },
    { "symbol": "DebugConfig", "file": "src/config/debug.ts", "line": 12, "kind": "interface" },
    { "symbol": "DEPRECATED_FLAG", "file": "src/constants.ts", "line": 78, "kind": "variable" }
  ],
  "total": 3,
  "note": "Only checks internal imports. External consumers (if this is a library) may use these."
}
```

**Why CLI can't match this:** Requires checking EVERY exported symbol against ALL import statements. For 500 exports across 200 files, that's 100,000 comparisons. Infeasible with grep. The index does a simple set difference in <100ms.

---

### 8. `get_symbol_source`

**Extract just one function/class definition — not the whole file.**

**Input:**
```json
{ "symbol": "authMiddleware", "file": "src/auth/middleware.ts" }
```

**Output:**
```json
{
  "symbol": "authMiddleware",
  "kind": "function",
  "file": "src/auth/middleware.ts",
  "startLine": 12,
  "endLine": 32,
  "source": "export async function authMiddleware(req: Request, res: Response, next: NextFunction) {\n  const token = req.headers.authorization?.split(' ')[1]\n  if (!token) return res.status(401).json({ error: 'No token' })\n  try {\n    const user = await verifyToken(token)\n    req.user = user\n    next()\n  } catch {\n    res.status(401).json({ error: 'Invalid token' })\n  }\n}",
  "jsdoc": "/** Validates JWT and attaches user to request */"
}
```

**vs Read:** Claude reads a 500-line file (2,000+ tokens) to get one 20-line function. This returns ~200 tokens.

**Token savings: ~80%**

---

### 9. `search_by_pattern` ✨ NEAR-UNIQUE

**Find code by structural pattern — not text matching.**

**Input:**
```json
{ "pattern": "http_calls" }
```

**Supported patterns:**
- `http_calls` — functions containing `fetch()`, `axios.*`, `http.*`
- `env_access` — code accessing `process.env.*`
- `error_handlers` — `try/catch` blocks
- `async_functions` — all `async` function definitions
- `todos` — functions containing `// TODO` or `// FIXME` comments
- `test_files` — files matching test patterns

**Output:**
```json
{
  "pattern": "http_calls",
  "matches": [
    { "function": "chargeStripe", "file": "src/payments/stripe.ts", "line": 12, "call": "fetch('https://api.stripe.com/...')" },
    { "function": "sendEmail", "file": "src/email/sender.ts", "line": 8, "call": "fetch(SENDGRID_URL, ...)" }
  ]
}
```

**vs Grep:** `grep "fetch("` returns matches in comments, strings, import statements, and test mocks. AST search returns only actual call expressions within function bodies.

---

### 10. `get_file_summary`

**Token-efficient file overview — scan 10 files for ~50 tokens each instead of reading them.**

**Input:**
```json
{ "file_path": "src/auth/middleware.ts" }
```

**Output:**
```text
src/auth/middleware.ts (45 lines, modified 2h ago)
  Imports: express.{Request,Response,NextFunction}, ./jwt.verifyToken, ../models/user.User
  Exports: authMiddleware (fn), requireRole (fn)
  Calls: verifyToken, res.status, res.json, next
  Dependencies: src/auth/jwt.ts, src/models/user.ts
  Dependents: src/routes/api.ts, src/routes/admin.ts
```

**vs Read:** Reading the full file = 500+ tokens. Summary = ~50 tokens. When scanning 10 candidate files to find the right one, that's **10x fewer tokens**.

**Token savings: ~90%**

---

### 11. `get_project_map`

**High-level architecture overview — modules, their APIs, relationships.**

**Input:**
```json
{ "depth": 2 }
```

**Output:**
```text
src/ (42 files, 156 exports)
├── routes/          (4 files, 12 exports)
│   ├── api.ts       → GET /users, POST /users, DELETE /users/:id
│   ├── auth.ts      → POST /login, POST /register, POST /refresh
│   └── webhooks.ts  → POST /stripe-webhook
├── services/        (3 files, 8 exports)
│   ├── UserService  → findById, create, update, delete
│   └── AuthService  → login, register, verifyToken
├── models/          (4 files, 4 types)
│   ├── User         → interface {id, email, name, role}
│   └── Session      → interface {token, userId, expiresAt}
├── middleware/       (2 files, 3 exports)
│   └── auth         → authMiddleware, requireRole, rateLimiter
└── utils/           (5 files, 12 exports)
    ├── crypto       → hashPassword, verifyPassword, generateToken
    └── validation   → validateEmail, validatePassword
```

**vs CLI:** Building this requires reading every file and extracting exports. That's 40+ Read calls. The MCP returns it from the pre-computed index in 1 call.

**Token savings: ~90%**

---

### Housekeeping Tools

#### `reindex`
Force full re-index. Normally not needed — file watcher handles incremental updates.

```json
{ "scope": "full" | "file", "file_path": "optional/path.ts" }
```

#### `get_status`
Index health + session efficiency metrics.

```json
{
  "indexedFiles": 142,
  "totalSymbols": 856,
  "lastFullIndex": "2026-02-28T08:00:00Z",
  "staleFiles": 2,
  "sessionStats": {
    "toolCalls": 23,
    "tokensServed": 4200,
    "estimatedTokensWithoutIndex": 31000,
    "savings": "86%"
  }
}
```

## Tool Uniqueness Summary

| Tool | Unique? | Key Differentiator |
|------|---------|-------------------|
| `get_smart_context` | Best-in-class | Full context assembly (nobody else does file+deps+types+tests) |
| `get_dependency_graph` | Shared (2 competitors) | Barrel file handling, direction control |
| `find_symbol` | Shared (3 competitors) | Kind + scope filtering, fuzzy match |
| `find_references` | Shared (2 competitors) | Reference kind classification |
| `get_call_graph` | Shared (2 competitors) | Tree visualization, depth control |
| `get_changes_since_last_session` | **UNIQUE** | Impossible without persistence |
| `find_unused_exports` | **UNIQUE** | Infeasible with grep |
| `get_symbol_source` | Shared (1 competitor) | JSDoc inclusion, line range |
| `search_by_pattern` | **NEAR-UNIQUE** | Structural patterns, not text |
| `get_file_summary` | **UNIQUE** (token-optimized) | 10x more compact than file read |
| `get_project_map` | Shared (2 competitors) | Symbol-level detail, not just files |

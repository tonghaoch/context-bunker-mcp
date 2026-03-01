export const SCHEMA_VERSION = 1

// Each migration runs when stored version < migration.version
// Add new migrations at the end with incrementing version numbers
export const MIGRATIONS: { version: number; sql: string }[] = [
  // Example: { version: 2, sql: 'ALTER TABLE symbols ADD COLUMN namespace TEXT;' }
]

export const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  lines INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  is_exported INTEGER DEFAULT 0,
  signature TEXT,
  jsdoc TEXT,
  UNIQUE(file_id, name, kind, start_line)
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  from_path TEXT NOT NULL,
  is_type_only INTEGER DEFAULT 0,
  is_external INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS exports (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  is_reexport INTEGER DEFAULT 0,
  original_path TEXT
);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  caller_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  callee_name TEXT NOT NULL,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tfidf (
  term TEXT NOT NULL,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tf REAL NOT NULL,
  PRIMARY KEY (term, file_id)
);

CREATE TABLE IF NOT EXISTS idf (
  term TEXT NOT NULL PRIMARY KEY,
  idf REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  file_snapshot TEXT
);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);
CREATE INDEX IF NOT EXISTS idx_imports_from ON imports(from_path);
CREATE INDEX IF NOT EXISTS idx_exports_file ON exports(file_id);
CREATE INDEX IF NOT EXISTS idx_exports_symbol ON exports(symbol);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_symbol_id);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_name);
`

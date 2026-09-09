import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "facts.db"));
db.pragma("journal_mode = WAL");

// Schema is intentionally generic: `metric`, `category`, `entity` etc. are
// free-text fields populated by the LLM per-document, not fixed columns per
// fact type. This lets new kinds of facts show up without a migration.
db.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  statement TEXT NOT NULL,
  entity TEXT NOT NULL,
  metric TEXT NOT NULL,
  value TEXT,
  unit TEXT,
  period TEXT,
  quote TEXT NOT NULL,
  page INTEGER NOT NULL,
  confidence TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_facts_metric ON facts(metric);
CREATE INDEX IF NOT EXISTS idx_facts_document ON facts(document_id);

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_a_id INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  fact_b_id INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS failure_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

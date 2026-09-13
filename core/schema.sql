CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT 'new chat',
  model TEXT NOT NULL DEFAULT 'gpt-5.6-terra',
  summary TEXT NOT NULL DEFAULT '',
  summarized_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  parts_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);

CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  token TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_servers_user ON servers(user_id);

-- per-user markdown files injected into the system prompt:
--   context: user-curated (or update_context) standing instructions/background
--   lessons: append-only list the agent grows via save_lesson
CREATE TABLE IF NOT EXISTS user_files (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('context', 'lessons')),
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kind)
);

-- skills: reusable procedures (system prompt lists name — description; use_skill loads body)
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'agent', 'catalog')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(user_id);

-- per-user settings (built-in tool toggles)
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  disabled_tools_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- MCP marketplace: per-server transport/auth config (additive; legacy servers
-- rows without a config use defaults). Secrets never leave the worker.
CREATE TABLE IF NOT EXISTS server_configs (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  transport TEXT NOT NULL DEFAULT 'auto' CHECK (transport IN ('auto', 'streamable_http', 'sse')),
  auth_type TEXT NOT NULL DEFAULT 'bearer' CHECK (auth_type IN ('none', 'bearer', 'headers', 'oauth')),
  headers_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  oauth_json TEXT NOT NULL DEFAULT '{}',
  catalog_slug TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- OAuth dynamic client registrations, cached per authorization server
CREATE TABLE IF NOT EXISTS oauth_clients (
  auth_server TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL DEFAULT '',
  registration_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (auth_server, redirect_uri)
);

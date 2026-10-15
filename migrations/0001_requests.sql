CREATE TABLE IF NOT EXISTS requests (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, request_id TEXT NOT NULL,
 type TEXT NOT NULL, policy_version TEXT NOT NULL, vendedor_id TEXT,
 created_at TEXT NOT NULL, completed_at TEXT, state TEXT NOT NULL,
 decision TEXT, revision INTEGER NOT NULL DEFAULT 0,
 total_usd REAL, processing_ms REAL, elapsed_ms REAL,
 input_tokens INTEGER, output_tokens INTEGER, stages_json TEXT NOT NULL DEFAULT '[]',
 indexed_at TEXT NOT NULL,
 UNIQUE(client_id, type, request_id)
);
CREATE INDEX IF NOT EXISTS requests_client_date ON requests(client_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS requests_client_seller_date ON requests(client_id, vendedor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_client_state_date ON requests(client_id, state, created_at DESC);

-- T-112: monitor one scheduled source scan across independent keyword messages.
CREATE TABLE ingest_scan_results (
  scan_id INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  keyword_index INTEGER NOT NULL,
  scan_group TEXT NOT NULL,
  expected_count INTEGER NOT NULL,
  success INTEGER NOT NULL,
  raw_count INTEGER NOT NULL,
  PRIMARY KEY (scan_id, source_type, keyword_index)
);
CREATE INDEX idx_ingest_scan_source_time ON ingest_scan_results(source_type, scan_id DESC);

-- Written only after a successful alert send. A crash before this write can resend.
CREATE TABLE ingest_scan_alerts (
  source_type TEXT PRIMARY KEY,
  scan_id INTEGER NOT NULL,
  sent_at INTEGER NOT NULL
);
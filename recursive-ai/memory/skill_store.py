import hashlib
import json
import sqlite3
from pathlib import Path
from core.ledger import confidence


class MemoryEngine:
    def __init__(self, root):
        Path(root).mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(Path(root) / "memory.sqlite3", isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS active(id INTEGER PRIMARY KEY CHECK(id=1), commit_sha TEXT);
            CREATE TABLE IF NOT EXISTS evidence(digest TEXT PRIMARY KEY, successes INTEGER, failures INTEGER);
            CREATE TABLE IF NOT EXISTS strategies(name TEXT PRIMARY KEY, attempts INTEGER, reward REAL);
            CREATE TABLE IF NOT EXISTS checkpoints(sha TEXT PRIMARY KEY);
        """)

    def current(self):
        row = self.db.execute("SELECT commit_sha FROM active WHERE id=1").fetchone()
        return row[0] if row else None

    def event(self, payload):
        self.db.execute("INSERT INTO events(payload) VALUES (?)", (json.dumps(payload, allow_nan=False),))

    def history(self):
        return {name: (attempts, reward) for name, attempts, reward in self.db.execute("SELECT * FROM strategies")}

    def failures(self):
        rows = self.db.execute("SELECT payload FROM events ORDER BY id DESC LIMIT 30").fetchall()
        return [e["failed_gate"] for (raw,) in reversed(rows) if (e := json.loads(raw)).get("failed_gate")]

    def record(self, source, passed, strategy, reward, episode):
        digest = hashlib.sha256(source.encode()).hexdigest()
        self.db.execute("INSERT INTO evidence VALUES (?, ?, ?) ON CONFLICT(digest) DO UPDATE SET successes=successes+excluded.successes, failures=failures+excluded.failures",
                        (digest, int(passed), int(not passed)))
        self.db.execute("INSERT INTO strategies VALUES (?, 1, ?) ON CONFLICT(name) DO UPDATE SET attempts=attempts+1, reward=reward+excluded.reward", (strategy, reward))
        self.event(episode)

    def activate(self, commit):
        self.db.execute("INSERT OR IGNORE INTO checkpoints VALUES (?)", (commit,))
        self.db.execute("INSERT INTO active VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET commit_sha=excluded.commit_sha", (commit,))

    def evidence(self):
        return [{"sha256": digest, "successes": s, "failures": f, "confidence": confidence(s, f)}
                for digest, s, f in self.db.execute("SELECT * FROM evidence")]

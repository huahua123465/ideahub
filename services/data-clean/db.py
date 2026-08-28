"""SQLite 数据层"""
import sqlite3
import json
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from config import DB_PATH


class TaskDB:
    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = db_path
        self._init_db()

    @contextmanager
    def _conn(self):
        conn = sqlite3.connect(str(self.db_path))
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_db(self):
        with self._conn() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS tasks (
                    id          TEXT PRIMARY KEY,
                    url         TEXT NOT NULL,
                    source      TEXT,
                    title       TEXT,
                    description TEXT,
                    duration_sec REAL,
                    status      TEXT DEFAULT 'pending',
                    error_msg   TEXT,
                    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS artifacts (
                    id       INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id  TEXT REFERENCES tasks(id) ON DELETE CASCADE,
                    type     TEXT NOT NULL,
                    path     TEXT NOT NULL,
                    meta     TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS scripts (
                    id       INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id  TEXT REFERENCES tasks(id) ON DELETE CASCADE,
                    version  INTEGER DEFAULT 1,
                    file_path_md   TEXT,
                    file_path_json TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS characters (
                    id       INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id  TEXT REFERENCES tasks(id) ON DELETE CASCADE,
                    char_id  TEXT NOT NULL,
                    name     TEXT,
                    role     TEXT,
                    age      TEXT,
                    gender   TEXT,
                    appearance TEXT,
                    personality TEXT,
                    voice_style TEXT,
                    UNIQUE(task_id, char_id)
                );
            """)
            columns = {row[1] for row in conn.execute("PRAGMA table_info(tasks)").fetchall()}
            if "account_name" not in columns:
                conn.execute("ALTER TABLE tasks ADD COLUMN account_name TEXT")
            if "owner_id" not in columns:
                conn.execute("ALTER TABLE tasks ADD COLUMN owner_id TEXT")

    def create_task(self, vid, url, source="", title="", description="", owner_id=""):
        with self._conn() as conn:
            cursor = conn.execute(
                "INSERT OR IGNORE INTO tasks(id,url,source,title,description,status,owner_id) VALUES(?,?,?,?,?,?,?)",
                (vid, url, source, title, description, "pending", owner_id)
            )
            created = cursor.rowcount > 0
            if not created:
                conn.execute(
                    """UPDATE tasks
                       SET url=?, source=?, status='pending', error_msg=NULL,
                           owner_id=CASE WHEN ?<>'' THEN ? ELSE owner_id END, updated_at=?
                       WHERE id=?""",
                    (url, source, owner_id, owner_id, datetime.now(), vid),
                )
            return created

    def update_status(self, vid, status, error_msg=None, title=None, description=None,
                      duration_sec=None, account_name=None):
        fields = ["status=?", "updated_at=?"]
        values = [status, datetime.now()]
        if status in {"pending", "running", "done"}:
            fields.append("error_msg=NULL")
        elif error_msg is not None:
            fields.append("error_msg=?"); values.append(error_msg)
        if title: fields.append("title=?"); values.append(title)
        if description: fields.append("description=?"); values.append(description)
        if duration_sec: fields.append("duration_sec=?"); values.append(duration_sec)
        if account_name: fields.append("account_name=?"); values.append(account_name)
        values.append(vid)
        with self._conn() as conn:
            conn.execute(f"UPDATE tasks SET {','.join(fields)} WHERE id=?", values)

    def get_task(self, vid):
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (vid,)).fetchone()
            return dict(row) if row else None

    def delete_task(self, vid):
        """Delete a task and all database rows linked through foreign keys."""
        return self.delete_tasks([vid]) > 0

    def delete_tasks(self, vids):
        """Delete multiple tasks in one transaction."""
        task_ids = list(dict.fromkeys(vids))
        if not task_ids:
            return 0
        placeholders = ",".join("?" for _ in task_ids)
        with self._conn() as conn:
            cursor = conn.execute(
                f"DELETE FROM tasks WHERE id IN ({placeholders})",
                task_ids,
            )
            return cursor.rowcount

    def list_tasks(self, limit=20):
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT id,url,source,title,account_name,owner_id,status,error_msg,created_at,updated_at FROM tasks ORDER BY created_at DESC LIMIT ?",
                (limit,)
            ).fetchall()
            return [dict(r) for r in rows]

    def recover_interrupted_tasks(self):
        """Never silently re-run work after process/container restart."""
        with self._conn() as conn:
            cursor = conn.execute(
                """UPDATE tasks
                   SET status='interrupted',
                       error_msg='服务重启导致任务中断，请手动重试',
                       updated_at=?
                   WHERE status IN ('pending','running','downloading','processing')""",
                (datetime.now(),),
            )
            return cursor.rowcount

    def add_artifact(self, vid, art_type, path, meta=None):
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO artifacts(task_id,type,path,meta) VALUES(?,?,?,?)",
                (vid, art_type, path, json.dumps(meta or {}, ensure_ascii=False))
            )

    def get_artifacts(self, vid, art_type=None):
        with self._conn() as conn:
            if art_type:
                rows = conn.execute(
                    "SELECT * FROM artifacts WHERE task_id=? AND type=? ORDER BY created_at",
                    (vid, art_type)
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM artifacts WHERE task_id=? ORDER BY type,created_at", (vid,)
                ).fetchall()
            return [dict(r) for r in rows]

    def add_script(self, vid, md_path, json_path):
        with self._conn() as conn:
            cur = conn.execute("SELECT COALESCE(MAX(version),0)+1 FROM scripts WHERE task_id=?", (vid,))
            version = cur.fetchone()[0]
            conn.execute(
                "INSERT INTO scripts(task_id,version,file_path_md,file_path_json) VALUES(?,?,?,?)",
                (vid, version, md_path, json_path)
            )
            return version

    def get_latest_script(self, vid):
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM scripts WHERE task_id=? ORDER BY version DESC LIMIT 1", (vid,)
            ).fetchone()
            return dict(row) if row else None

    def save_characters(self, vid, chars):
        with self._conn() as conn:
            for c in chars:
                conn.execute(
                    """INSERT OR REPLACE INTO characters(task_id,char_id,name,role,age,gender,appearance,personality,voice_style)
                       VALUES(?,?,?,?,?,?,?,?,?)""",
                    (vid, c["id"], c.get("name"), c.get("role"), c.get("age"),
                     c.get("gender"), c.get("appearance"), c.get("personality"),
                     c.get("voice_style"))
                )

    def get_characters(self, vid):
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT char_id as id,name,role,age,gender,appearance,personality,voice_style FROM characters WHERE task_id=?", (vid,)
            ).fetchall()
            return [dict(r) for r in rows]

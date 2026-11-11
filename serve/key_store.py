"""Opt-in API credentials and durable usage. No prompts, responses, or plaintext keys are stored."""
from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import secrets
import sqlite3
import threading
import time
import uuid
from pathlib import Path


class StoreUnavailable(RuntimeError):
    pass


FIELDS = ("requests", "successful", "failed", "interrupted", "running", "input_tokens",
          "cached_tokens", "output_tokens", "total_tokens", "incomplete")
SUMS = """COUNT(*) AS requests,
 SUM(state='successful') AS successful, SUM(state='failed') AS failed,
 SUM(state='interrupted') AS interrupted, SUM(state='running') AS running,
 SUM(input_tokens) AS input_tokens, SUM(cached_tokens) AS cached_tokens,
 SUM(output_tokens) AS output_tokens, SUM(input_tokens+output_tokens) AS total_tokens,
 SUM(incomplete) AS incomplete"""
BEIJING = dt.timezone(dt.timedelta(hours=8))


def date_bounds(start=None, end=None, timezone=BEIJING):
    """Inclusive calendar dates, expressed as an exclusive-end UTC interval."""
    try:
        dates = [dt.date.fromisoformat(v) if v else None for v in (start, end)]
        if any(v and (len(v) != 10 or parsed.isoformat() != v)
               for v, parsed in zip((start, end), dates)):
            raise ValueError
        if all(dates) and dates[0] > dates[1]:
            raise ValueError
        lo = dt.datetime.combine(dates[0], dt.time(), timezone).timestamp() if dates[0] else None
        hi = dt.datetime.combine(dates[1] + dt.timedelta(days=1), dt.time(), timezone).timestamp() \
            if dates[1] else None
        return lo, hi
    except (ValueError, TypeError, OverflowError):
        raise ValueError("日期应为 YYYY-MM-DD，开始日期不能晚于结束日期") from None


def digest(key):
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def totals(row):
    return {field: int(row[field] or 0) if row else 0 for field in FIELDS}


class KeyStore:
    def __init__(self, path, legacy_keys=()):
        self.path = Path(path)
        self.lock = threading.RLock()
        self.fault = False
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.db = sqlite3.connect(str(self.path), timeout=5, check_same_thread=False)
            self.db.row_factory = sqlite3.Row
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=FULL")
            self.db.execute("PRAGMA foreign_keys=ON")
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS api_keys (
                    id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
                    preview TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','disabled','deleted')),
                    created_at REAL NOT NULL, last_used_at REAL, deleted_at REAL
                );
                CREATE TABLE IF NOT EXISTS key_usage (
                    id TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES api_keys(id),
                    path TEXT NOT NULL, started_at REAL NOT NULL, finished_at REAL,
                    state TEXT NOT NULL CHECK(state IN ('running','successful','failed','interrupted')),
                    input_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0, incomplete INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS usage_key_time ON key_usage(key_id, started_at);
                CREATE INDEX IF NOT EXISTS usage_time ON key_usage(started_at);
            """)
            with self.db:
                if "model" not in {row[1] for row in self.db.execute("PRAGMA table_info(api_keys)")}:
                    self.db.execute("ALTER TABLE api_keys ADD COLUMN model TEXT")
                if "model" not in {row[1] for row in self.db.execute("PRAGMA table_info(key_usage)")}:
                    self.db.execute("ALTER TABLE key_usage ADD COLUMN model TEXT")
                self.db.execute("UPDATE key_usage SET state='interrupted', incomplete=1, finished_at=? "
                                "WHERE state='running'", (time.time(),))
                for i, key in enumerate(legacy_keys, 1):
                    self._insert(key, f"现有 Key {i}")
        except (sqlite3.Error, OSError) as exc:
            if hasattr(self, "db"):
                self.db.close()
            raise StoreUnavailable("API Key 数据库无法打开，请检查路径和磁盘空间") from exc

    @contextlib.contextmanager
    def transaction(self):
        with self.lock:
            if self.fault:
                raise StoreUnavailable("API Key 数据库发生故障，请修复后重启服务")
            try:
                with self.db:
                    yield self.db
            except sqlite3.Error as exc:
                self.fault = True
                raise StoreUnavailable("API Key 数据库读写失败，请检查磁盘并重启服务") from exc

    def close(self):
        with self.lock:
            self.db.close()

    def _insert(self, key, name):
        ident = uuid.uuid4().hex
        preview = key[:10] + "…" + key[-4:] if len(key) >= 24 else "••••••••"
        self.db.execute("INSERT OR IGNORE INTO api_keys "
                        "(id,digest,name,preview,state,created_at) VALUES (?,?,?,?,'active',?)",
                        (ident, digest(key), name, preview, time.time()))
        return ident

    def authenticate(self, key):
        candidates = [digest(key)]
        try:
            candidates.append(digest(key.encode("latin-1").decode("utf-8")))
        except (UnicodeError, ValueError):
            candidates.append(candidates[0])
        with self.transaction() as db:
            row = db.execute("SELECT id FROM api_keys WHERE digest IN (?,?) AND state='active'", candidates).fetchone()
            return row["id"] if row else None

    def create(self, name):
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 128:
            raise ValueError("名称不能为空，最长 128 个字符")
        key = "sk-strata-" + secrets.token_urlsafe(32)
        with self.transaction():
            ident = self._insert(key, name.strip())
        return {"id": ident, "key": key}

    def model(self, ident):
        with self.transaction() as db:
            row = db.execute("SELECT model FROM api_keys WHERE id=? AND state='active'", (ident,)).fetchone()
            if not row:
                raise KeyError(ident)
            return row["model"]

    def set_model(self, ident, model):
        with self.transaction() as db:
            row = db.execute("SELECT state FROM api_keys WHERE id=?", (ident,)).fetchone()
            if not row:
                raise KeyError(ident)
            if row["state"] == "deleted":
                raise ValueError("已删除的 Key 不能修改模型")
            db.execute("UPDATE api_keys SET model=? WHERE id=?", (model, ident))

    def change(self, ident, state):
        if state not in ("active", "disabled", "deleted"):
            raise ValueError("state 应为 active 或 disabled")
        with self.transaction() as db:
            row = db.execute("SELECT state FROM api_keys WHERE id=?", (ident,)).fetchone()
            if not row:
                raise KeyError(ident)
            if row["state"] == "deleted":
                if state != "deleted":
                    raise ValueError("已删除的 Key 不能重新启用")
                return
            db.execute("UPDATE api_keys SET state=?, deleted_at=? WHERE id=?",
                       (state, time.time() if state == "deleted" else None, ident))

    @staticmethod
    def _filter(start, end, timezone=BEIJING):
        lo, hi = date_bounds(start, end, timezone)
        clauses, params = [], []
        for op, bound in ((">=", lo), ("<", hi)):
            if bound is not None:
                clauses.append(f"started_at {op} ?")
                params.append(bound)
        return (" AND " + " AND ".join(clauses) if clauses else ""), params

    def list(self, include_deleted=False, start=None, end=None):
        where, params = self._filter(start, end)
        with self.transaction() as db:
            rows = db.execute("SELECT id,name,preview,state,created_at,last_used_at,deleted_at,model FROM api_keys "
                              + ("" if include_deleted else "WHERE state!='deleted' ")
                              + "ORDER BY created_at DESC").fetchall()
            stats = {r["key_id"]: totals(r) for r in db.execute(
                f"SELECT key_id,{SUMS} FROM key_usage WHERE 1=1 {where} GROUP BY key_id", params)}
            return [{**dict(row), "usage": stats.get(row["id"], totals(None))} for row in rows]

    def usage(self, ident, start=None, end=None):
        where, params = self._filter(start, end)
        with self.transaction() as db:
            if not db.execute("SELECT id FROM api_keys WHERE id=?", (ident,)).fetchone():
                raise KeyError(ident)
            selected = "FROM key_usage WHERE key_id=?" + where
            args = [ident, *params]
            summary = totals(db.execute(f"SELECT {SUMS} {selected}", args).fetchone())
            lifetime = totals(db.execute(f"SELECT {SUMS} FROM key_usage WHERE key_id=?", (ident,)).fetchone())
            daily = [{"date": r["date"], **totals(r)} for r in db.execute(
                f"SELECT date(started_at,'unixepoch','+8 hours') AS date,{SUMS} {selected} "
                "GROUP BY date ORDER BY date", args)]
        return {"id": ident, "timezone": "Asia/Shanghai", "from": start, "to": end,
                "usage": summary, "lifetime": lifetime, "daily": daily}

    def usage_report(self, start=None, end=None, interval="day", key_id=None, group="key", timezone="Asia/Shanghai",
                     models=()):
        if interval not in ("day", "hour"):
            raise ValueError("interval 应为 day 或 hour")
        if group not in ("key", "path"):
            raise ValueError("group 应为 key 或 path")
        if timezone not in ("Asia/Shanghai", "UTC"):
            raise ValueError("timezone 应为 Asia/Shanghai 或 UTC")
        where, params = self._filter(start, end, BEIJING if timezone == "Asia/Shanghai" else dt.timezone.utc)
        offset = "+8 hours" if timezone == "Asia/Shanghai" else "+0 hours"
        with self.transaction() as db:
            rows = db.execute("SELECT id,name,preview,state FROM api_keys ORDER BY created_at DESC").fetchall()
            if key_id is not None and not any(row["id"] == key_id for row in rows):
                raise KeyError(key_id)
            stats = {r["key_id"]: totals(r) for r in db.execute(
                f"SELECT key_id,{SUMS} FROM key_usage WHERE 1=1 {where} GROUP BY key_id", params)}
            keys = [{**dict(row), "usage": stats.get(row["id"], totals(None))} for row in rows]
            selected = "FROM key_usage WHERE 1=1" + where
            args = list(params)
            if key_id is not None:
                selected += " AND key_id=?"
                args.append(key_id)
            summary = totals(db.execute(f"SELECT {SUMS} {selected}", args).fetchone())
            lifetime = totals(db.execute(f"SELECT {SUMS} FROM key_usage").fetchone())
            fmt = "%Y-%m-%d" if interval == "day" else "%Y-%m-%d %H:00"
            series = [{"time": r["time"], **totals(r)} for r in db.execute(
                f"SELECT strftime(?,started_at,'unixepoch',?) AS time,{SUMS} {selected} "
                "GROUP BY time ORDER BY time", [fmt, offset, *args])]
            names = {row["id"]: row["name"] for row in rows}
            column = "key_id" if group == "key" else "path"
            groups = {}
            for row in db.execute(
                    f"SELECT {column} AS group_id,strftime(?,started_at,'unixepoch',?) AS time,"
                    f"{SUMS} {selected} GROUP BY group_id,time ORDER BY group_id,time", [fmt, offset, *args]):
                ident = row["group_id"]
                item = groups.setdefault(ident, {"id": ident, "name": names[ident] if group == "key" else ident,
                                                 "usage": totals(None), "series": []})
                bucket = totals(row)
                item["series"].append({"time": row["time"], **bucket})
                for field in FIELDS:
                    item["usage"][field] += bucket[field]
            model_groups = {name: {"id": name, "name": name, "usage": totals(None), "series": []}
                            for name in models}
            for row in db.execute(
                    f"SELECT model,strftime(?,started_at,'unixepoch',?) AS time,{SUMS} {selected} "
                    "GROUP BY model,time ORDER BY model,time", [fmt, offset, *args]):
                ident = row["model"]
                item = model_groups.setdefault(ident, {"id": ident,
                    "name": ident if ident is not None else "历史记录（模型未记录）",
                    "usage": totals(None), "series": []})
                bucket = totals(row)
                item["series"].append({"time": row["time"], **bucket})
                for field in FIELDS:
                    item["usage"][field] += bucket[field]
        return {"timezone": timezone, "from": start, "to": end, "interval": interval,
                "key_id": key_id, "group": group, "usage": summary, "lifetime": lifetime, "series": series,
                "keys": keys, "groups": list(groups.values()), "model_groups": list(model_groups.values())}

    def begin(self, key_id, path, model=None):
        ident, now = uuid.uuid4().hex, time.time()
        with self.transaction() as db:
            db.execute("INSERT INTO key_usage(id,key_id,path,started_at,state,incomplete,model) "
                       "VALUES (?,?,?,?,'running',1,?)", (ident, key_id, path, now, model))
            db.execute("UPDATE api_keys SET last_used_at=? WHERE id=?", (now, key_id))
        return Usage(self, ident)


class Usage:
    """One HTTP invocation, possibly containing several Service.run calls (MCP rounds)."""
    def __init__(self, store, ident):
        self.store, self.id = store, ident
        self.input = self.cached = self.output = 0
        self.outcome = None
        self.error = False
        self.finished = False

    def add(self, prompt, cached, output, finish):
        self.input += max(0, int(prompt or 0))
        self.cached += min(max(0, int(cached or 0)), max(0, int(prompt or 0)))
        self.output += max(0, int(output or 0))
        if finish in ("cancel", "disconnect"):
            self.outcome = "interrupted"
        elif finish == "error":
            self.error = True
        with self.store.transaction() as db:
            db.execute("UPDATE key_usage SET input_tokens=?,cached_tokens=?,output_tokens=? WHERE id=?",
                       (self.input, self.cached, self.output, self.id))

    def note(self, values):
        if values.get("error") or (values.get("http_status") or 0) >= 400:
            self.error = True
        if values.get("outcome") == "disconnected":
            self.outcome = "interrupted"

    def finish(self):
        if self.finished:
            return
        state = self.outcome or ("failed" if self.error else "successful")
        with self.store.transaction() as db:
            db.execute("UPDATE key_usage SET state=?,finished_at=?,incomplete=0 WHERE id=?",
                       (state, time.time(), self.id))
        self.finished = True

"""Per-request Monitor metrics and lifecycle, without a model pack or GPU."""
import json
import queue
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from serve.frontend import ChatTemplate
from serve.server import ByteTokenizer, EngineDied, KeyStore, Service, serve


class ControlledEngine:
    max_context = 4096
    batch = 2

    def __init__(self):
        self.actions = {1: queue.Queue(), 2: queue.Queue()}
        self.entered = {1: threading.Event(), 2: threading.Event()}

    def generate(self, ids, max_new, sampling, cancel, embeddings=None):
        number = ids[0]
        self.entered[number].set()
        while True:
            action = self.actions[number].get(timeout=10)
            if action == "read":
                cancel._strata_queue_started()
            elif action == "token":
                yield ord("x")
            elif action == "ping":
                yield None
            elif action == "error":
                raise EngineDied("simulated failure")
            elif action == "end":
                return


class LiveRequests(unittest.TestCase):
    def setUp(self):
        self.engine = ControlledEngine()
        tok = ByteTokenizer()
        self.svc = Service(self.engine, tok, ChatTemplate(Path(__file__).with_name("chat_template.jinja")))
        self.threads = []
        self.errors = []

    def tearDown(self):
        for q in self.engine.actions.values():
            q.put("end")
        for thread in self.threads:
            thread.join(10)
            self.assertFalse(thread.is_alive())

    def start_request(self, number, length, limit, cancel=None, close_on_ping=False):
        cancel = cancel or threading.Event()
        def run():
            gen = self.svc.run([number] * length, False, [], limit, {}, cancel)
            try:
                for kind, _ in gen:
                    if close_on_ping and kind == "ping":
                        gen.close()
                        break
            except Exception as exc:
                self.errors.append(exc)
        thread = threading.Thread(target=run)
        self.threads.append(thread)
        thread.start()
        return thread, cancel

    def wait_for(self, predicate):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            if predicate():
                return
            time.sleep(0.01)
        self.fail("timed out waiting for the request state")

    def rows(self):
        return self.svc.metrics()["live"]["requests"]

    def test_parallel_mixed_states_independent_rates_and_cleanup(self):
        first, _ = self.start_request(1, 3, 20)
        second, _ = self.start_request(2, 7, 40)
        self.assertTrue(self.engine.entered[1].wait(5))
        self.assertTrue(self.engine.entered[2].wait(5))
        rows = {r["prompt_tokens"]: r for r in self.rows()}
        self.assertEqual({r["state"] for r in rows.values()}, {"waiting"})
        self.assertTrue(all(r["generated"] is None and r["tok_s"] is None for r in rows.values()))
        ids = {r["id"] for r in rows.values()}
        self.assertEqual(len(ids), 2)
        self.assertTrue(all(len(ident) == 12 and all(ch in "0123456789abcdef" for ch in ident) for ident in ids))
        self.engine.actions[1].put("read")
        self.engine.actions[1].put("token")
        self.engine.actions[2].put("read")
        self.wait_for(lambda: {r["state"] for r in self.rows()} == {"generating", "reading"} and
                      any(r["generated"] == 1 for r in self.rows()))
        # Distinct windows prove each row uses its own rate, not the aggregate.
        with self.svc.status_lock:
            for st, rate in self.svc.live_reqs.values():
                now = time.time()
                rate.clear()
                rate.extend([(now - 1, 0), (now, 4 if st["prompt_tokens"] == 3 else 9)])
        rows = {r["prompt_tokens"]: r for r in self.rows()}
        a, b = rows[3], rows[7]
        self.assertEqual(set(a), {"id", "state", "prompt_tokens", "generated", "max_tokens", "max_context", "tok_s", "elapsed_s"})
        self.assertEqual((a["state"], a["generated"], a["max_tokens"], a["max_context"], a["tok_s"]),
                         ("generating", 1, 20, 4096, 4.0))
        self.assertEqual((b["state"], b["generated"], b["max_tokens"], b["tok_s"]), ("reading", 0, 40, None))
        self.engine.actions[2].put("token")
        self.wait_for(lambda: all(r["state"] == "generating" for r in self.rows()))
        self.assertEqual({r["id"] for r in self.rows()}, ids)
        self.engine.actions[1].put("end")
        first.join(5)
        self.assertEqual(len(self.rows()), 1)
        self.engine.actions[2].put("end")
        second.join(5)
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.errors, [])

    def test_single_queue_timeout_cancel_error_and_disconnect(self):
        self.engine.batch = 0
        self.svc.fifo.acquire()
        try:
            self.svc.queue_timeout_s = 0.2
            first, _ = self.start_request(1, 3, 20)
            self.wait_for(lambda: len(self.rows()) == 1)
            row = self.rows()[0]
            self.assertEqual((row["state"], row["generated"], row["tok_s"]), ("queued", None, None))
            first.join(5)
            self.assertEqual(len(self.errors), 1)
            self.assertEqual(type(self.errors.pop()).__name__, "QueueWaitExpired")
            self.assertEqual(self.rows(), [])
            self.svc.queue_timeout_s = 1
            second, cancel = self.start_request(1, 3, 20)
            self.wait_for(lambda: len(self.rows()) == 1)
            self.svc.note_client_disconnect(cancel)
            second.join(5)
            self.assertEqual(self.rows(), [])
        finally:
            self.svc.fifo.release()
        for action in ("error", "ping"):
            thread, _ = self.start_request(1, 3, 20, close_on_ping=action == "ping")
            self.assertTrue(self.engine.entered[1].wait(5))
            self.wait_for(lambda: len(self.rows()) == 1)
            self.engine.actions[1].put("read")
            self.wait_for(lambda: self.rows()[0]["state"] == "reading")
            if action == "error":
                self.engine.actions[1].put("token")
                self.wait_for(lambda: self.rows()[0]["state"] == "generating" and self.rows()[0]["generated"] == 1)
                row = self.rows()[0]
                self.assertEqual((row["generated"], row["max_tokens"]), (1, 20))
                self.assertIsNotNone(row["tok_s"])
            self.engine.actions[1].put(action)
            thread.join(5)
            self.assertEqual(self.rows(), [])
            self.engine.entered[1].clear()
        self.assertEqual(len(self.errors), 1)
        self.assertIsInstance(self.errors[0], EngineDied)

    def test_metrics_routes_permissions_and_whitelist(self):
        with tempfile.TemporaryDirectory() as folder:
            self.svc.api_key = "private-call-key"
            self.svc.key_store = KeyStore(Path(folder) / "keys.sqlite", [self.svc.api_key])
            httpd = serve(self.svc, port=0)
            base = f"http://127.0.0.1:{httpd.server_address[1]}"
            thread, _ = self.start_request(1, 3, 20)
            try:
                self.assertTrue(self.engine.entered[1].wait(5))
                self.engine.actions[1].put("read")
                self.engine.actions[1].put("token")
                self.wait_for(lambda: self.rows() and self.rows()[0]["state"] == "generating")
                with self.svc.status_lock:
                    st = next(iter(self.svc.live_reqs.values()))[0]
                    st.update(tail="private-content", tool="private-tool")
                def get(path, key=None, headers=None):
                    req = urllib.request.Request(base + path, headers={**(headers or {}),
                        **({"Authorization": "Bearer " + key} if key else {})})
                    try:
                        response = urllib.request.urlopen(req, timeout=5)
                    except urllib.error.HTTPError as exc:
                        response = exc
                    with response:
                        return response.status, json.load(response)
                self.assertEqual(get("/metrics")[0], 401)
                self.assertEqual(get("/api/monitor/metrics", headers={"Origin": "https://evil.example"})[0], 403)
                a = get("/metrics", "private-call-key")[1]["live"]["requests"]
                b = get("/api/monitor/metrics")[1]["live"]["requests"]
                self.assertEqual(a[0]["id"], b[0]["id"])
                for rows in (a, b):
                    raw = json.dumps(rows)
                    self.assertNotIn("private-content", raw)
                    self.assertNotIn("private-tool", raw)
                    self.assertNotIn("private-call-key", raw)
            finally:
                self.engine.actions[1].put("end")
                thread.join(5)
                httpd.shutdown()
                httpd.server_close()


if __name__ == "__main__":
    unittest.main()

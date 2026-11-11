"""Managed keys through real HTTP and SQLite; no model pack or GPU is required.

    python -m unittest serve.test_key_management -v
"""
import concurrent.futures
import datetime as dt
import http.client
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

from serve.frontend import ChatTemplate
from serve.key_store import KeyStore
from serve.server import ByteTokenizer, MockEngine, Service, KeyModelRouter, configure_key_management, serve

ROOT = Path(__file__).resolve().parents[1]
ADMIN = "test-independent-admin"
LEGACY = "test-existing-call-key"


class KeyHttpCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "usage.sqlite"
        self.start()

    def start(self, engine=None, legacy=LEGACY):
        tok = ByteTokenizer()
        self.svc = Service(engine or MockEngine(tok, "Thought.</think>\nHello.", max_context=16384), tok,
                           ChatTemplate(ROOT / "serve/chat_template.jinja"))
        self.svc.api_key = legacy
        with mock.patch.dict(os.environ, {"STRATA_ADMIN_API_KEY": ADMIN}):
            configure_key_management(self.svc, {"key_management": True, "api_keys_db": str(self.path)})
        self.httpd = serve(self.svc, port=0)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.legacy_id = self.svc.key_store.authenticate(LEGACY)

    def tearDown(self):
        self.stop()
        self.tmp.cleanup()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def call(self, path, body=None, key=LEGACY, headers=None, raw=None):
        h = {"Content-Type": "application/json", "anthropic-version": "2023-06-01"}
        if key is not None:
            h["Authorization"] = "Bearer " + key
        h.update(headers or {})
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, headers=h)
        try:
            response = urllib.request.urlopen(req, timeout=15)
        except urllib.error.HTTPError as e:
            response = e
        with response:
            text = response.read().decode()
            try:
                value = json.loads(text)
            except ValueError:
                value = text
            return response.status, value

    def create(self, name="Laptop"):
        code, value = self.call("/api/keys", {"name": name}, ADMIN)
        self.assertEqual(code, 201, value)
        return value

    def chat(self, path="/v1/chat/completions", stream=False, key=LEGACY, **extra):
        body = {"model": "m", "max_tokens": 400, "stream": stream, **extra}
        body.update({"input": "Hi"} if path == "/v1/responses" else {"messages": [{"role": "user", "content": "Hi"}]})
        return self.call(path, body, key)

    def usage(self, ident=None):
        code, value = self.call(f"/api/keys/{ident or self.legacy_id}/usage", key=ADMIN)
        self.assertEqual(code, 200, value)
        return value["usage"]


class ManagedKeys(KeyHttpCase):
    def test_model_usage_tracks_routing_and_filters(self):
        coder_path = Path(self.tmp.name) / 'coder.json'
        spare_path = Path(self.tmp.name) / 'spare.json'
        coder_path.write_text('{}')
        spare_path.write_text('{}')
        router = self.svc.model_router = KeyModelRouter(self.svc, {'coder': str(coder_path), 'spare': str(spare_path)})
        coder = router.snapshot()
        coder['model'] = 'coder'
        router.build = lambda name: coder
        self.svc.engine.unload = lambda: None
        other = self.create('Coder')
        self.assertEqual(self.call(f"/api/keys/{other['id']}/model", {'model': 'coder'}, key=ADMIN)[0], 200)
        self.assertEqual(self.chat(key=other['key'])[1]['model'], 'coder')  # request says model=m
        self.assertEqual(self.chat(path='/v1/v1/messages', key=other['key'])[1]['model'], 'coder')
        self.assertEqual(self.call('/v1/chat/completions', raw=b'{broken', key=other['key'])[0], 400)
        self.assertEqual(self.chat()[1]['model'], router.default)
        self.assertEqual(self.call(f"/api/keys/{other['id']}/model", {'model': None}, key=ADMIN)[0], 200)

        timestamp = dt.datetime(2026, 10, 15, 16, tzinfo=dt.timezone.utc).timestamp()
        with self.svc.key_store.transaction() as db:
            db.execute('UPDATE key_usage SET started_at=?', (timestamp,))
        query = 'from=2026-10-16&to=2026-10-16&interval=hour&group=path'
        code, report = self.call('/api/keys/usage?' + query, key=ADMIN)
        self.assertEqual(code, 200)
        groups = {g['id']: g for g in report['model_groups']}
        self.assertEqual((groups['coder']['usage']['requests'], groups['coder']['usage']['failed']), (3, 1))
        self.assertEqual(groups[router.default]['usage']['requests'], 1)
        self.assertEqual(groups['spare']['usage']['requests'], 0)
        self.assertEqual(groups['spare']['series'], [])
        self.assertEqual(groups['coder']['series'][0]['time'], '2026-10-16 00:00')
        self.assertEqual(sum(g['usage']['total_tokens'] for g in groups.values()), report['usage']['total_tokens'])
        filtered = self.call('/api/keys/usage?' + query + '&key_id=' + other['id'], key=ADMIN)[1]
        self.assertEqual({g['id']: g['usage']['requests'] for g in filtered['model_groups']},
                         {router.default: 0, 'coder': 3, 'spare': 0})
        utc = self.call('/api/keys/usage?' + query + '&timezone=UTC', key=ADMIN)[1]
        self.assertEqual(utc['usage']['requests'], 0)
        coder_path.unlink()
        removed = self.call('/api/keys/usage?' + query, key=ADMIN)[1]
        self.assertEqual(next(g for g in removed['model_groups'] if g['id'] == 'coder')['usage']['requests'], 3)

    def test_old_usage_database_migrates_without_guessing_model(self):
        path = Path(self.tmp.name) / 'old.sqlite'
        with sqlite3.connect(path) as db:
            db.executescript("""
                CREATE TABLE api_keys (id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
                    preview TEXT NOT NULL, state TEXT NOT NULL, created_at REAL NOT NULL,
                    last_used_at REAL, deleted_at REAL);
                CREATE TABLE key_usage (id TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES api_keys(id),
                    path TEXT NOT NULL, started_at REAL NOT NULL, finished_at REAL, state TEXT NOT NULL,
                    input_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0, incomplete INTEGER NOT NULL DEFAULT 0);
                INSERT INTO api_keys VALUES ('old', 'hash', 'old key', '••••', 'active', 1, NULL, NULL);
                INSERT INTO key_usage VALUES ('request', 'old', '/v1/messages', 1, 2, 'successful', 10, 2, 3, 0);
            """)
        db.close()
        store = KeyStore(path)
        try:
            store.set_model('old', 'new-assignment')
            report = store.usage_report(models=['new-assignment'])
            groups = {g['id']: g for g in report['model_groups']}
            self.assertEqual(groups[None]['name'], '历史记录（模型未记录）')
            self.assertEqual(groups[None]['usage'], report['usage'])
            self.assertEqual(groups['new-assignment']['usage']['requests'], 0)
        finally:
            store.close()

    def test_model_assignment_routes_and_persists(self):
        path = Path(self.tmp.name) / 'coder.json'
        path.write_text('{}')
        self.svc.model_router = KeyModelRouter(self.svc, {'coder': str(path)})
        default = self.svc.model
        coder = self.svc.model_router.snapshot()
        coder['model'] = 'coder'
        self.svc.model_router.build = lambda name: coder
        self.svc.engine.unload = lambda: None
        other = self.create('Coder')
        endpoint = f"/api/keys/{other['id']}/model"
        self.assertEqual(self.call(endpoint, {'model': 'coder'}, key=LEGACY)[0], 403)
        self.assertEqual(self.call(endpoint, {'model': 'missing'}, key=ADMIN)[0], 400)
        self.assertEqual(self.call(endpoint, {'model': 'coder'}, key=ADMIN)[0], 200)
        self.assertEqual(self.call('/v1/models', key=other['key'])[1]['data'][0]['id'], 'coder')
        for protocol in ('/v1/chat/completions', '/v1/messages', '/v1/responses'):
            code, result = self.chat(path=protocol, key=other['key'])
            self.assertEqual(code, 200, result)
            self.assertEqual(result['model'], 'coder')
            code, result = self.chat(path=protocol, key=LEGACY)
            self.assertEqual(code, 200, result)
            self.assertEqual(result['model'], default)
        self.assertEqual(self.svc.key_store.model(other['id']), 'coder')
        path.unlink()
        code, result = self.chat(key=other['key'])
        self.assertEqual(code, 503)
        self.assertIn('不可用', result['error']['message'])
        self.assertEqual(self.svc.model, default)
        self.stop()
        self.start()
        self.assertEqual(self.svc.key_store.model(other['id']), 'coder')

    def test_model_route_serializes_complete_requests(self):
        path = Path(self.tmp.name) / 'coder.json'
        path.write_text('{}')
        router = self.svc.model_router = KeyModelRouter(self.svc, {'coder': str(path)})
        coder = router.snapshot()
        coder['model'] = 'coder'
        router.build = lambda name: coder
        self.svc.engine.unload = lambda: None
        other = self.create('Coder')
        self.call(f"/api/keys/{other['id']}/model", {'model': 'coder'}, key=ADMIN)
        entered = threading.Event()
        release = threading.Event()
        original = self.svc.run
        def delayed(*args, **kwargs):
            entered.set()
            release.wait(5)
            yield from original(*args, **kwargs)
        self.svc.run = delayed
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(self.chat, key=LEGACY)
            self.assertTrue(entered.wait(5))
            second = pool.submit(self.chat, key=other['key'])
            time.sleep(0.1)
            self.assertEqual(self.svc.model, router.default)
            release.set()
            self.assertEqual(first.result()[1]['model'], router.default)
            self.assertEqual(second.result()[1]['model'], 'coder')

    def test_same_model_requests_overlap_and_switch_waits_for_both(self):
        path = Path(self.tmp.name) / 'coder.json'
        path.write_text('{}')
        router = self.svc.model_router = KeyModelRouter(self.svc, {'coder': str(path)})
        coder = router.snapshot()
        coder['model'] = 'coder'
        router.build = lambda name: coder
        self.svc.engine.unload = lambda: None
        other = self.create('Coder')
        self.call(f"/api/keys/{other['id']}/model", {'model': 'coder'}, key=ADMIN)
        entered = [threading.Event() for _ in range(4)]
        release = [threading.Event() for _ in range(4)]
        count_lock = threading.Lock()
        count = 0
        original = self.svc.run

        def delayed(*args, **kwargs):
            nonlocal count
            with count_lock:
                index = count
                count += 1
            entered[index].set()
            if not release[index].wait(5):
                raise RuntimeError('test did not release the request')
            yield from original(*args, **kwargs)

        def wait_queued(n):
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                with router.condition:
                    if len(router.waiting) >= n:
                        return
                time.sleep(.01)
            self.fail('request did not reach the model queue')

        self.svc.run = delayed
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            try:
                first = pool.submit(self.chat, key=LEGACY)
                self.assertTrue(entered[0].wait(5))
                second = pool.submit(self.chat, key=LEGACY)
                self.assertTrue(entered[1].wait(5), 'same-model request was serialized')
                switching = pool.submit(self.chat, key=other['key'])
                wait_queued(1)
                after_switch = pool.submit(self.chat, key=LEGACY)
                wait_queued(2)
                self.assertFalse(entered[2].is_set())
                release[0].set()
                self.assertEqual(first.result(timeout=5)[1]['model'], router.default)
                self.assertFalse(entered[2].is_set(), 'switched while the second request was active')
                release[1].set()
                self.assertEqual(second.result(timeout=5)[1]['model'], router.default)
                self.assertTrue(entered[2].wait(5))
                self.assertEqual(self.svc.model, 'coder')
                self.assertFalse(entered[3].is_set(), 'later request bypassed the waiting switch')
                release[2].set()
                self.assertEqual(switching.result(timeout=5)[1]['model'], 'coder')
                self.assertTrue(entered[3].wait(5))
                release[3].set()
                self.assertEqual(after_switch.result(timeout=5)[1]['model'], router.default)
            finally:
                for event in release:
                    event.set()

    def test_model_route_rechecks_a_key_revoked_while_waiting(self):
        path = Path(self.tmp.name) / 'coder.json'
        path.write_text('{}')
        router = self.svc.model_router = KeyModelRouter(self.svc, {'coder': str(path)})
        coder = router.snapshot()
        coder['model'] = 'coder'
        router.build = lambda name: coder
        self.svc.engine.unload = lambda: None
        other = self.create('Coder')
        self.call(f"/api/keys/{other['id']}/model", {'model': 'coder'}, key=ADMIN)
        entered, release = threading.Event(), threading.Event()
        original = self.svc.run

        def delayed(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise RuntimeError('test did not release the request')
            yield from original(*args, **kwargs)

        self.svc.run = delayed
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            try:
                first = pool.submit(self.chat, key=LEGACY)
                self.assertTrue(entered.wait(5))
                waiting = pool.submit(self.chat, key=other['key'])
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    with router.condition:
                        if router.waiting:
                            break
                    time.sleep(.01)
                else:
                    self.fail('request did not reach the model queue')
                self.assertEqual(self.call(f"/api/keys/{other['id']}/state", {'state': 'disabled'}, ADMIN)[0], 200)
                release.set()
                self.assertEqual(first.result(timeout=5)[0], 200)
                self.assertEqual(waiting.result(timeout=5)[0], 401)
                self.assertEqual(self.svc.model, router.default)
                self.assertEqual(self.usage(other['id'])['requests'], 0)
            finally:
                release.set()

    def test_model_control_waits_for_routed_request(self):
        from serve.test_lifecycle import ResidentEngine
        self.stop()
        engine = ResidentEngine(ByteTokenizer())
        self.start(engine=engine)
        engine.restart()
        router = self.svc.model_router = KeyModelRouter(self.svc, {})
        entered, release = threading.Event(), threading.Event()
        original = self.svc.run

        def delayed(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise RuntimeError('test did not release the request')
            yield from original(*args, **kwargs)

        self.svc.run = delayed
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            try:
                first = pool.submit(self.chat)
                self.assertTrue(entered.wait(5))
                control = pool.submit(self.call, '/api/model', {'enabled': False}, ADMIN)
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    with router.condition:
                        if router.waiting:
                            break
                    time.sleep(.01)
                else:
                    self.fail('model control did not wait for the request')
                later = pool.submit(self.chat)
                release.set()
                self.assertEqual(first.result(timeout=5)[0], 200)
                self.assertEqual(control.result(timeout=5)[0], 200)
                self.assertEqual(later.result(timeout=5)[0], 503)
                self.assertFalse(engine.alive())
            finally:
                release.set()

    def test_same_model_concurrent_keys_keep_usage_separate(self):
        self.svc.model_router = KeyModelRouter(self.svc, {})
        other = self.create('Concurrent')
        both = threading.Barrier(2)
        original = self.svc.run

        def delayed(*args, **kwargs):
            both.wait(timeout=5)
            yield from original(*args, **kwargs)

        self.svc.run = delayed
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = [pool.submit(self.chat, key=key) for key in (LEGACY, other['key'])]
            self.assertEqual([f.result(timeout=10)[0] for f in results], [200, 200])
        for ident in (self.legacy_id, other['id']):
            usage = self.usage(ident)
            self.assertEqual((usage['requests'], usage['successful']), (1, 1))
            self.assertGreater(usage['input_tokens'], 0)
            self.assertGreater(usage['output_tokens'], 0)

    def test_real_lifecycle_switch_and_failed_load(self):
        from serve.test_lifecycle import ResidentEngine
        self.stop()
        first = ResidentEngine(ByteTokenizer())
        self.start(engine=first)
        first.restart()
        config = Path(self.tmp.name) / 'coder.json'
        config.write_text('{}')
        router = self.svc.model_router = KeyModelRouter(self.svc, {'coder': str(config)})
        second = ResidentEngine(self.svc.tok)
        target = router.snapshot()
        target.update(engine=second, model='coder')
        router.build = lambda name: target
        other = self.create('Coder')
        self.call(f"/api/keys/{other['id']}/model", {'model': 'coder'}, key=ADMIN)
        self.assertEqual(self.chat(key=other['key'])[1]['model'], 'coder')
        self.assertFalse(first.alive())
        self.assertTrue(second.alive())
        self.assertEqual(self.chat(key=LEGACY)[1]['model'], router.default)
        self.assertTrue(first.alive())
        self.assertFalse(second.alive())
        with mock.patch.object(second, 'restart', side_effect=Exception('load failed')):
            # Engine failures are reported to the caller and never answered by the other model.
            from serve.server import EngineDied
            second.restart.side_effect = EngineDied('load failed')
            code, result = self.chat(key=other['key'])
            self.assertEqual(code, 503, result)
        self.assertFalse(first.alive())
        self.assertEqual(self.chat(key=LEGACY)[1]['model'], router.default)

    def test_monitor_reads_all_keys_without_a_credential(self):
        keys = [self.create("Monitor A"), self.create("Monitor B")]
        for key in (LEGACY, *(row["key"] for row in keys)):
            self.assertEqual(self.chat(key=key)[0], 200)
        for credential in (None, "wrong", ADMIN, keys[0]["key"]):
            code, data = self.call("/api/monitor/metrics", key=credential)
            self.assertEqual(code, 200, data)
            self.assertEqual(data["totals"]["requests"], 3)
            self.assertEqual(data["requests_kept"], 3)
            self.assertEqual(len(data["requests"]), 3)
            self.assertIn("hardware", data)
            self.assertIn("engine", data)
            self.assertEqual(data["live"]["state"], "idle")
            for secret in (LEGACY, ADMIN, *(row["key"] for row in keys), "Hello.", "Thought."):
                self.assertNotIn(secret, json.dumps(data))
        self.svc.key_store.change(keys[0]["id"], "disabled")
        self.assertEqual(self.call("/api/monitor/metrics", key=None)[1]["totals"]["requests"], 3)
        # Viewing the dashboard neither consumes a call nor opens any protected API.
        self.assertEqual(self.usage()["requests"], 1)
        for path in ("/metrics", "/metrics/prometheus", "/metrics?format=prometheus", "/v1/models", "/config", "/api/keys"):
            self.assertEqual(self.call(path, key=None)[0], 401)
        self.svc.api_monitor = True
        self.assertEqual(self.call("/api/requests", key=None)[0], 401)
        self.assertEqual(self.chat(key=None)[0], 401)

    def test_monitor_checks_host_origin_retention_and_cache(self):
        path = "/api/monitor/metrics"
        for headers in ({"Origin": "https://evil.example"}, {"Host": "evil.example"},
                        {"Host": "evil.example", "Origin": "http://evil.example"}):
            self.assertEqual(self.call(path, key=None, headers=headers)[0], 403)
        self.assertEqual(self.call(path, key=None, headers={"Origin": self.base})[0], 200)
        with self.svc.status_lock:
            self.svc.history.extend({"time": i} for i in range(15))
        self.assertEqual(len(self.call(path, key=None)[1]["requests"]), 12)
        self.assertEqual(len(self.call(path + "?requests=all", key=None)[1]["requests"]), 15)
        with urllib.request.urlopen(self.base + path) as response:
            self.assertEqual(response.headers.get("Cache-Control"), "no-store")
            self.assertIsNone(response.headers.get("Access-Control-Allow-Origin"))

    def test_full_lifecycle_persists_without_plaintext(self):
        created = self.create("手机 <script>test</script>")
        ident, key = created["id"], created["key"]
        self.assertEqual(self.chat(key=key)[0], 200)
        before = self.usage(ident)
        self.assertEqual(before["requests"], 1)
        self.assertGreater(before["input_tokens"], 0)
        self.assertGreater(before["output_tokens"], 0)
        self.assertEqual(before["total_tokens"], before["input_tokens"] + before["output_tokens"])
        code, listing = self.call("/api/keys", key=ADMIN)
        self.assertEqual(code, 200)
        self.assertNotIn(key, json.dumps(listing))
        self.assertNotIn(ADMIN, json.dumps(listing))
        self.assertEqual(self.call(f"/api/keys/{ident}/state", {"state": "disabled"}, ADMIN)[0], 200)
        self.assertEqual(self.chat(key=key)[0], 401)
        self.assertEqual(self.call(f"/api/keys/{ident}/state", {"state": "active"}, ADMIN)[0], 200)
        self.assertEqual(self.call("/v1/models", key=key)[0], 200)
        self.assertEqual(self.call(f"/api/keys/{ident}/delete", {}, ADMIN)[0], 200)
        self.assertEqual(self.chat(key=key)[0], 401)
        self.assertEqual(self.usage(ident), before)
        self.assertNotIn(ident, [r["id"] for r in self.call("/api/keys", key=ADMIN)[1]["keys"]])
        self.assertIn(ident, [r["id"] for r in self.call("/api/keys?include_deleted=true", key=ADMIN)[1]["keys"]])
        self.assertEqual(self.call(f"/api/keys/{ident}/state", {"state": "active"}, ADMIN)[0], 400)
        self.stop()
        self.start()
        self.assertEqual(self.chat(key=key)[0], 401)
        self.assertEqual(self.usage(ident), before)
        self.assertNotIn(key.encode(), self.path.read_bytes())
        self.assertNotIn(LEGACY.encode(), self.path.read_bytes())

    def test_admin_is_separate_and_routes_are_same_origin_only(self):
        for path, body in (("/api/keys", None), ("/api/keys", {"name": "bad"}),
                           ("/api/keys/usage", None),
                           (f"/api/keys/{self.legacy_id}/state", {"state": "disabled"}),
                           (f"/api/keys/{self.legacy_id}/delete", {}),
                           (f"/api/keys/{self.legacy_id}/usage", None)):
            self.assertEqual(self.call(path, body, key=None)[0], 401)
            self.assertEqual(self.call(path, body, LEGACY)[0], 403)
            self.assertEqual(self.call(path, body, ADMIN, {"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.chat(key=ADMIN)[0], 401)
        self.assertEqual(self.call("/api/keys", {"name": "bad"}, ADMIN, {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.call("/api/keys", {"name": "  "}, ADMIN)[0], 400)
        self.assertEqual(self.call("/api/keys", [], ADMIN)[0], 400)
        self.assertEqual(self.usage()["requests"], 0)

    def test_three_protocols_stream_and_nonstream(self):
        for path in ("/v1/chat/completions", "/v1/responses", "/v1/messages"):
            for stream in (False, True):
                with self.subTest(path=path, stream=stream):
                    code, response = self.chat(path, stream)
                    self.assertEqual(code, 200, response)
        u = self.usage()
        self.assertEqual((u["requests"], u["successful"], u["failed"], u["incomplete"]), (6, 6, 0, 0))
        self.assertGreater(u["output_tokens"], 0)
        self.assertEqual(len(self.svc.api_requests), 0, "accounting must work with api_monitor off")

    def test_admin_is_one_credential_even_when_it_contains_a_comma(self):
        self.svc.admin_api_key = LEGACY + ",independent-admin-suffix"
        self.assertEqual(self.call("/api/keys", key=LEGACY)[0], 403)
        self.assertEqual(self.call("/api/keys", key=self.svc.admin_api_key)[0], 200)

    def test_bad_requests_count_but_metadata_and_auth_failures_do_not(self):
        for path in ("/health", "/v1/models", "/metrics"):
            self.assertEqual(self.call(path)[0], 200)
        self.assertEqual(self.chat(key="wrong")[0], 401)
        self.assertEqual(self.call("/v1/messages/count_tokens", {"messages": [{"role": "user", "content": "Hi"}]})[0], 200)
        self.assertEqual(self.call("/v1/chat/completions", raw=b"{broken")[0], 400)
        self.assertEqual(self.call("/v1/chat/completions", {"messages": 42})[0], 400)
        self.assertEqual(self.chat(max_tokens="bad")[0], 400)
        u = self.usage()
        self.assertEqual((u["requests"], u["failed"], u["input_tokens"], u["output_tokens"]), (3, 3, 0, 0))

    def test_concurrent_keys_do_not_share_usage(self):
        keys = [self.create(str(i)) for i in range(3)]
        jobs = [key for i, key in enumerate(keys, 1) for _ in range(i)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            replies = list(pool.map(lambda k: self.chat(key=k["key"]), jobs))
        self.assertTrue(all(r[0] == 200 for r in replies))
        for i, key in enumerate(keys, 1):
            u = self.usage(key["id"])
            self.assertEqual((u["requests"], u["successful"]), (i, i))
        self.assertEqual(self.usage()["requests"], 0)

    def test_imported_disabled_or_deleted_key_never_revives(self):
        ident = self.legacy_id
        for state in ("disabled", "deleted"):
            self.svc.key_store.change(ident, state)
            self.stop()
            self.start()
            self.assertEqual(self.chat()[0], 401)
            self.assertIsNone(self.svc.key_store.authenticate(LEGACY))

    def test_dates_are_inclusive_beijing_days(self):
        for timestamp in (dt.datetime(2026, 10, 15, 15, 59, 59, tzinfo=dt.timezone.utc).timestamp(),
                          dt.datetime(2026, 10, 15, 16, 0, 0, tzinfo=dt.timezone.utc).timestamp()):
            with mock.patch("serve.key_store.time.time", return_value=timestamp):
                usage = self.svc.key_store.begin(self.legacy_id, "/v1/responses")
                usage.add(10, 3, 4, "stop")
                usage.finish()
        code, value = self.call(f"/api/keys/{self.legacy_id}/usage?from=2026-10-16&to=2026-10-16", key=ADMIN)
        self.assertEqual(code, 200)
        self.assertEqual(value["usage"]["requests"], 1)
        self.assertEqual(value["lifetime"]["requests"], 2)
        self.assertEqual([d["date"] for d in value["daily"]], ["2026-10-16"])
        for query in ("from=2026-99-01", "from=2026-10-17&to=2026-10-16", "to=9999-12-31"):
            self.assertEqual(self.call("/api/keys?" + query, key=ADMIN)[0], 400)

    def test_restart_marks_unfinished_as_incomplete_and_keeps_committed_tokens(self):
        u = self.svc.key_store.begin(self.legacy_id, "/v1/responses")
        u.add(120, 20, 9, "stop")
        self.stop()
        self.start()
        result = self.usage()
        self.assertEqual((result["requests"], result["interrupted"], result["incomplete"]), (1, 1, 1))
        self.assertEqual((result["input_tokens"], result["cached_tokens"], result["output_tokens"]), (120, 20, 9))

    def test_usage_report_filters_groups_and_timezones(self):
        other = self.create("已删除")
        records = ((self.legacy_id, "/v1/responses", 15, 15, "stop"),
                   (other["id"], "/v1/chat/completions", 15, 16, "error"),
                   (other["id"], "/v1/responses", 16, 1, "disconnect"))
        for ident, path, day, hour, outcome in records:
            timestamp = dt.datetime(2026, 10, day, hour, tzinfo=dt.timezone.utc).timestamp()
            with mock.patch("serve.key_store.time.time", return_value=timestamp):
                usage = self.svc.key_store.begin(ident, path)
                usage.add(10, 3, 4, outcome)
                usage.finish()
        self.svc.key_store.change(other["id"], "deleted")

        query = "from=2026-10-16&to=2026-10-16&interval=hour"
        code, report = self.call("/api/keys/usage?" + query, key=ADMIN)
        self.assertEqual(code, 200)
        self.assertEqual(report["timezone"], "Asia/Shanghai")
        self.assertEqual((report["usage"]["requests"], report["usage"]["failed"],
                          report["usage"]["interrupted"]), (2, 1, 1))
        self.assertEqual((report["usage"]["input_tokens"], report["usage"]["cached_tokens"],
                          report["usage"]["output_tokens"]), (20, 6, 8))
        self.assertEqual(report["lifetime"]["requests"], 3)
        self.assertEqual([r["time"] for r in report["series"]], ["2026-10-16 00:00", "2026-10-16 09:00"])
        self.assertEqual([(g["id"], g["name"], g["usage"]["requests"]) for g in report["groups"]],
                         [(other["id"], "已删除", 2)])
        self.assertEqual(next(k for k in report["keys"] if k["id"] == other["id"])["state"], "deleted")
        self.assertNotIn(other["key"], json.dumps(report, ensure_ascii=False))
        self.assertNotIn(ADMIN, json.dumps(report, ensure_ascii=False))

        code, report = self.call("/api/keys/usage?" + query + "&timezone=UTC&group=path&key_id=" + other["id"],
                                 key=ADMIN)
        self.assertEqual(code, 200)
        self.assertEqual(report["timezone"], "UTC")
        self.assertEqual(report["usage"]["requests"], 1)
        self.assertEqual(report["lifetime"]["requests"], 3)
        self.assertEqual(report["series"][0]["time"], "2026-10-16 01:00")
        self.assertEqual(report["groups"][0]["id"], "/v1/responses")
        self.assertEqual(report["groups"][0]["usage"], report["usage"])
        for invalid in ("interval=minute", "group=model", "timezone=local", "from=bad", "key_id=missing"):
            status = self.call("/api/keys/usage?" + invalid, key=ADMIN)[0]
            self.assertEqual(status, 404 if invalid == "key_id=missing" else 400)

    def test_database_write_failure_blocks_generation(self):
        self.svc.key_store.db.execute("PRAGMA query_only=ON")
        code, value = self.chat()
        self.assertEqual(code, 503, value)
        self.assertFalse(hasattr(self.svc.engine, "last_prompt") and self.svc.engine.last_prompt)
        self.assertEqual(self.chat()[0], 503)
        self.assertEqual(self.call("/api/keys", key=ADMIN)[0], 503)

    def test_disable_allows_accepted_request_to_settle(self):
        entered, release = threading.Event(), threading.Event()
        original = self.svc.engine.generate

        def held(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise RuntimeError("test did not release the engine")
            yield from original(*args, **kwargs)

        self.svc.engine.generate = held
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.chat)
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(self.call(f"/api/keys/{self.legacy_id}/state", {"state": "disabled"}, ADMIN)[0], 200)
                self.assertEqual(self.chat()[0], 401)
            finally:
                release.set()
            self.assertEqual(future.result()[0], 200)
        self.assertEqual(self.usage()["successful"], 1)

    def test_generated_keys_work_without_a_configured_legacy_key(self):
        self.stop()
        self.start(legacy="")
        key = self.create()
        self.assertEqual(self.chat(key=key["key"])[0], 200)
        self.assertEqual(self.chat(key=None)[0], 401)
        self.assertEqual(self.call("/health", key=None)[1]["api_key"], True)

    def test_disconnected_stream_records_partial_work(self):
        self.svc.engine.delay = .015
        self.svc.engine.script = self.svc.tok.encode("</think>\n" + "long answer " * 20)
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=10)
        conn.request("POST", "/v1/chat/completions", json.dumps({"messages": [{"role": "user", "content": "Hi"}],
                     "max_tokens": 400, "stream": True}), {"Content-Type": "application/json", "Authorization": "Bearer " + LEGACY})
        response = conn.getresponse()
        response.readline()
        response.close(); conn.close()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            u = self.usage()
            if u["interrupted"]:
                break
            time.sleep(.03)
        self.assertEqual((u["requests"], u["interrupted"]), (1, 1))


class AccountingContinuations(KeyHttpCase):
    def test_thinking_continuation_uses_original_input_once(self):
        from serve.test_request_accounting import ClockedThinkingEngine
        self.stop()
        engine = ClockedThinkingEngine(ByteTokenizer())
        self.start(engine)
        code, response = self.chat(reasoning_budget_tokens=20)
        self.assertEqual(code, 200, response)
        u = self.usage()
        self.assertEqual(engine.attempts, 2)
        self.assertEqual(u["requests"], 1)
        self.assertEqual(u["input_tokens"], response["usage"]["prompt_tokens"])
        self.assertEqual(u["cached_tokens"], 5)
        self.assertEqual(u["output_tokens"], response["usage"]["completion_tokens"])

    def test_cancel_and_engine_failure_have_correct_outcomes(self):
        from serve.test_request_accounting import ClockedThinkingEngine
        for failed in (False, True):
            self.stop()
            engine = ClockedThinkingEngine(ByteTokenizer())
            engine.fail_continuation = failed
            engine.cancel_continuation = not failed
            self.start(engine)
            code, response = self.chat(stream=True, reasoning_budget_tokens=20)
            self.assertEqual(code, 200, response)
        u = self.usage()
        self.assertEqual((u["requests"], u["interrupted"], u["failed"]), (2, 1, 1))
        self.assertGreater(u["output_tokens"], 0)


class ManagedMcp(unittest.TestCase):
    def test_tool_rounds_count_one_http_request_and_sum_work(self):
        from serve.test_mcp import ToolLoop, call_script
        loop = ToolLoop("test_tool_call_then_answer")
        loop.setUp()
        try:
            with tempfile.TemporaryDirectory() as folder:
                loop.start(call_script("fake__echo", text="hello from the tool"), "</think>\n\nTool complete.")
                loop.svc.api_key = LEGACY
                loop.svc.admin_api_key = ADMIN
                loop.svc.key_store = KeyStore(Path(folder) / "keys.sqlite", [LEGACY])
                code, text = loop.post({"strata_mcp": True}, headers={"Authorization": "Bearer " + LEGACY})
                self.assertEqual(code, 200, text)
                ident = loop.svc.key_store.authenticate(LEGACY)
                u = loop.svc.key_store.usage(ident)["usage"]
                self.assertEqual(len(loop.engine.prompts), 2)
                self.assertEqual((u["requests"], u["successful"]), (1, 1))
                self.assertEqual(u["input_tokens"], sum(map(len, loop.engine.prompts)))
                self.assertEqual(u["output_tokens"], loop.chunks(text)[-1]["usage"]["completion_tokens"])
                report = loop.svc.key_store.usage_report(models=[loop.svc.model])
                self.assertEqual(report['model_groups'][0]['usage'], u)
                loop.httpd.shutdown(); loop.httpd.server_close(); loop.httpd = None
        finally:
            loop.tearDown()


class FeatureOff(unittest.TestCase):
    def test_short_legacy_keys_are_fully_masked(self):
        with tempfile.TemporaryDirectory() as folder:
            store = KeyStore(Path(folder) / "keys.sqlite", ["tiny-secret", "中文密钥"])
            try:
                self.assertEqual([r["preview"] for r in store.list()], ["••••••••", "••••••••"])
                self.assertIsNotNone(store.authenticate("中文密钥".encode("utf-8").decode("latin-1")))
            finally:
                store.close()

    def test_no_database_and_no_management_routes_by_default(self):
        tok = ByteTokenizer()
        svc = Service(MockEngine(tok, "ok"), tok, ChatTemplate(ROOT / "serve/chat_template.jinja"))
        configure_key_management(svc, {})
        httpd = serve(svc, port=0)
        try:
            base = f"http://127.0.0.1:{httpd.server_address[1]}"
            for path in ("/api/keys", "/api/keys/anything/usage", "/api/monitor/metrics"):
                with self.assertRaises(urllib.error.HTTPError) as err:
                    urllib.request.urlopen(base + path)
                self.assertEqual(err.exception.code, 404)
                err.exception.close()
            with urllib.request.urlopen(base + "/health") as response:
                self.assertNotIn("key_management", json.load(response))
            self.assertIsNone(svc.key_store)
            svc.api_key = LEGACY
            for path, status in (("/metrics", 401), ("/api/monitor/metrics", 404)):
                with self.assertRaises(urllib.error.HTTPError) as err:
                    urllib.request.urlopen(base + path)
                self.assertEqual(err.exception.code, status)
                err.exception.close()
        finally:
            httpd.shutdown(); httpd.server_close()

    def test_admin_configuration_and_default_path(self):
        tok = ByteTokenizer()
        svc = Service(MockEngine(tok, "ok"), tok, ChatTemplate(ROOT / "serve/chat_template.jinja"))
        svc.api_key = LEGACY
        with tempfile.TemporaryDirectory() as folder, mock.patch.dict(os.environ):
            os.environ.pop("STRATA_ADMIN_API_KEY", None)
            config = Path(folder) / "strata-test.json"
            with self.assertRaises(ValueError):
                configure_key_management(svc, {"key_management": True}, config)
            with self.assertRaises(ValueError):
                configure_key_management(svc, {"key_management": True, "admin_api_key": LEGACY}, config)
            svc.api_key = "中文密钥"
            with self.assertRaises(ValueError):
                configure_key_management(svc, {"key_management": True, "admin_api_key": "中文密钥"}, config)
            svc.api_key = LEGACY
            configure_key_management(svc, {"key_management": True, "admin_api_key": ADMIN}, config)
            self.assertEqual(svc.key_store.path, Path(folder) / "strata-test.keys.sqlite")
            svc.key_store.close()


if __name__ == "__main__":
    unittest.main()

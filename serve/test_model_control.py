"""Explicit model admission and residency switch over the HTTP console API."""
import unittest
from unittest import mock

from serve import test_lifecycle as lifecycle
from serve.key_store import KeyStore
from serve.server import EngineDied, EngineStarting, EngineStuck


class ModelControl(unittest.TestCase):
    setUp = lifecycle.Lifecycle.setUp
    tearDown = lifecycle.Lifecycle.tearDown
    request = lifecycle.Lifecycle.request

    def switch(self, enabled):
        return self.request('/api/model', {'enabled': enabled})

    def test_disable_blocks_every_generation_dialect_and_explicit_load(self):
        self.assertEqual(self.switch(True)[0], 200)
        self.assertEqual(self.switch(False), (200, {'enabled': False, 'loaded': False, 'supported': True}))
        for path in ('/v1/chat/completions', '/v1/messages', '/v1/responses', '/v1/images/generations',
                     '/load', '/v1/load'):
            for stream in (False, True):
                with self.subTest(path=path, stream=stream):
                    code, body = self.request(path, {'stream': stream})
                    self.assertEqual(code, 503)
                    self.assertEqual(body['error']['code'], 'model_disabled')
        self.assertEqual(self.engine.starts, 1)
        self.assertEqual(self.engine.closes, 1)
        self.assertEqual(self.request('/v1/models')[1]['data'], [])
        self.assertFalse(self.request('/v1/status')[1]['auto_load'])
        self.assertFalse(self.request('/health')[1]['enabled'])
        self.assertFalse(self.request('/metrics')[1]['model_control']['enabled'])
        with self.assertRaises(EngineStarting):
            self.svc.load()
        with self.assertRaises(EngineStarting):
            self.svc.ensure_loaded()
        with self.assertRaises(EngineStarting):
            with self.svc._turn():
                self.fail('disabled image jobs must not enter the GPU turn')
        self.assertTrue(self.svc.fifo.acquire(blocking=False))
        self.svc.fifo.release()

    def test_enable_loads_immediately_and_restores_api(self):
        self.switch(False)
        self.assertEqual(self.switch(True), (200, {'enabled': True, 'loaded': True, 'supported': True}))
        self.assertEqual(self.engine.starts, 1)
        code, body = self.request('/v1/chat/completions', {
            'messages': [{'role': 'user', 'content': 'Hello'}], 'max_tokens': 32, 'reasoning_effort': 'none'})
        self.assertEqual(code, 200)
        self.assertEqual(body['choices'][0]['message']['content'], 'Hello.')
        self.assertEqual(self.engine.starts, 1)

    def test_busy_switch_keeps_existing_admission_state(self):
        with self.svc.fifo:
            self.assertEqual(self.switch(False)[0], 409)
        for state in ({'busy': True, 'queued': 0}, {'busy': False, 'queued': 1}):
            self.svc.status.update(state)
            self.assertEqual(self.switch(False)[0], 409)
        self.assertTrue(self.svc.model_enabled)
        self.assertEqual(self.engine.closes, 0)

    def test_disabled_load_failure_stays_disabled(self):
        self.switch(False)
        with mock.patch.object(self.engine, 'restart', side_effect=EngineDied('load failed')):
            self.assertEqual(self.switch(True)[0], 503)
        self.assertFalse(self.svc.model_enabled)
        self.assertFalse(self.engine.loaded)
        self.assertEqual(self.switch(True)[0], 200)

    def test_unload_failure_blocks_api_and_can_be_retried(self):
        self.switch(True)
        vision = mock.Mock()
        self.svc.vision = vision
        with mock.patch.object(self.engine, 'unload', side_effect=EngineStuck('still releasing')):
            self.assertEqual(self.switch(False)[0], 503)
        self.assertFalse(self.svc.model_enabled)
        vision.unload.assert_called_once()
        self.assertEqual(self.switch(False)[0], 200)
        self.assertFalse(self.engine.loaded)

    def test_encoder_unloads_even_when_engine_already_stopped(self):
        self.svc.vision = mock.Mock()
        self.assertEqual(self.switch(False)[0], 200)
        self.svc.vision.unload.assert_called_once()
        self.assertEqual(self.engine.closes, 1)

    def test_validation_auth_and_foreign_origin(self):
        for body in ({}, {'enabled': 1}, {'enabled': 'false'}, []):
            self.assertEqual(self.request('/api/model', body)[0], 400)
        self.svc.api_key = 'secret'
        self.assertEqual(self.switch(False)[0], 401)
        self.assertEqual(self.request('/api/model', {'enabled': False}, {
            'Authorization': 'Bearer secret', 'Origin': 'https://other.example'})[0], 403)
        self.assertEqual(self.request('/api/model', {'enabled': False}, {
            'Authorization': 'Bearer secret'})[0], 200)

    def test_managed_call_key_cannot_switch_but_admin_can(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            self.svc.key_store = KeyStore(Path(tmp) / 'keys.sqlite', legacy_keys=['call-key'])
            self.svc.admin_api_key = 'admin-key'
            self.assertEqual(self.request('/api/model', {'enabled': False}, {
                'Authorization': 'Bearer call-key'})[0], 403)
            self.assertTrue(self.svc.model_enabled)
            self.assertEqual(self.request('/api/model', {'enabled': False}, {
                'Authorization': 'Bearer admin-key'})[0], 200)
            self.svc.key_store.close()
            self.svc.key_store = None

    def test_idle_unload_still_allows_autoload(self):
        self.switch(True)
        self.assertEqual(self.request('/unload', {})[0], 200)
        self.assertTrue(self.svc.model_enabled)
        self.svc.load()
        self.assertTrue(self.engine.loaded)
        self.assertEqual(self.engine.starts, 2)


if __name__ == '__main__':
    unittest.main()

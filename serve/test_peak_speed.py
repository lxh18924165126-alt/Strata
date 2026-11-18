"""Per-request peak live decode speed, without a GPU or real-time waits."""
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from serve.frontend import ChatTemplate
from serve.server import ByteTokenizer, MockEngine, Service


class PeakSpeed(unittest.TestCase):
    def test_peak_is_retained_in_history_and_reset_for_the_next_request(self):
        tok = ByteTokenizer()
        clock = [100.0]

        class ClockedEngine(MockEngine):
            def generate(self, *args, **kwargs):
                started = clock[0]
                for token, elapsed in zip(super().generate(*args, **kwargs), [0, .5, 1, 2]):
                    clock[0] = started + elapsed
                    yield token

        engine = ClockedEngine(tok, 'abcd')
        svc = Service(engine, tok, ChatTemplate(Path(__file__).with_name('chat_template.jinja')))
        with patch('serve.server.time.time', side_effect=lambda: clock[0]):
            list(svc.run([1], False, [], 4, {}, threading.Event()))
            self.assertEqual(svc.history[-1]['decode_peak_tok_s'], 2.0)
            # A one-token request has no measurable decode interval and must not inherit the peak.
            list(svc.run([1], False, [], 1, {}, threading.Event()))
            self.assertIsNone(svc.history[-1]['decode_peak_tok_s'])

    def test_parallel_request_samples_do_not_share_peaks(self):
        svc = Service.__new__(Service)
        svc.status_lock = threading.Lock()
        a = dict(busy=True, first_token=None)
        b = dict(busy=True, first_token=None)
        ar, br = [], []
        with patch('serve.server.time.time', return_value=100.0):
            svc._note(1, [], a, ar)
            svc._note(1, [], b, br)
        with patch('serve.server.time.time', return_value=100.01):
            svc._note(2, [], a, ar)
            self.assertNotIn('decode_peak_tok_s', a)
        with patch('serve.server.time.time', return_value=100.5):
            svc._note(3, [], a, ar)
            svc._note(2, [], b, br)
        self.assertEqual(a['decode_peak_tok_s'], 4.0)
        self.assertEqual(b['decode_peak_tok_s'], 2.0)


if __name__ == '__main__':
    unittest.main()

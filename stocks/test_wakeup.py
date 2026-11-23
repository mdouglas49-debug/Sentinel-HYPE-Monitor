from datetime import datetime
import unittest
from wakeup import in_window, wake


class WakeupTests(unittest.TestCase):
    def test_eastern_window_handles_both_offsets_and_weekend(self):
        for stamp, expected in [
            ('2026-11-23T14:11:00+00:00', True),
            ('2026-07-06T13:16:00+00:00', True),
            ('2026-11-23T13:11:00+00:00', False),
            ('2026-11-23T14:25:00+00:00', False),
            ('2026-11-21T14:11:00+00:00', False),
        ]:
            self.assertEqual(in_window(datetime.fromisoformat(stamp)), expected, stamp)

    def test_claim_suppresses_dispatch_and_unreadable_claim_fails_closed(self):
        now = datetime.fromisoformat('2026-11-23T14:11:00+00:00')
        calls = []
        def claimed(path, token, payload=None):
            calls.append(payload)
            return {'artifacts': [{'name': 'sentinel-stocks-watchlist-claim-2026-11-23', 'expired': False}]}
        self.assertEqual(wake(now, 'private', api=claimed)['status'], 'ALREADY_CLAIMED')
        self.assertEqual(calls, [None])
        with self.assertRaises(RuntimeError):
            wake(now, 'private', api=lambda *a: {})

    def test_production_and_probe_select_safe_dispatch_modes(self):
        now = datetime.fromisoformat('2026-11-23T14:11:00+00:00')
        calls = []
        def api(path, token, payload=None):
            calls.append((path, payload))
            return {'artifacts': []}
        result = wake(now, 'private', api=api)
        self.assertEqual(calls[-1][1], {'ref': 'main', 'inputs': {'dry_run': False}})
        self.assertFalse(result['delivery_confirmed'])
        calls.clear()
        wake(datetime.fromisoformat('2026-11-23T23:00:00+00:00'), 'private', probe=True, api=api)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], {'ref': 'main', 'inputs': {'dry_run': True}})

    def test_outside_window_is_noop_and_uncertain_dispatch_not_retried(self):
        calls = []
        def fail(path, token, payload=None):
            calls.append(path)
            if payload is not None:
                raise RuntimeError('uncertain send')
            return {'artifacts': []}
        self.assertEqual(wake(datetime.fromisoformat('2026-11-23T23:00:00+00:00'), '', api=fail)['status'], 'OUTSIDE_WAKEUP_WINDOW')
        self.assertEqual(calls, [])
        with self.assertRaises(RuntimeError):
            wake(datetime.fromisoformat('2026-11-23T14:11:00+00:00'), 'private', api=fail)
        self.assertEqual(len(calls), 2)

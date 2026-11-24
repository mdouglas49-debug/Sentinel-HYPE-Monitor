import base64
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from runtime import Store, seal, unseal, snapshot, restore, seed, open_context, deliver_pending, live_window
from scanner import Journal, at, confirmations, digest, event

SESSION = '2026-11-24'


def watchlist():
    return event('watchlist', SESSION, {'feed': 'sip', 'cutoff': at(SESSION,'08:59').isoformat(),
                 'candidates': [{'symbol':'TEST', 'trigger':100, 'stop':99, 'target':102, 'reason':'fixture'}]})


class MemoryAPI:
    def __init__(self): self.rows={}; self.branch=False; self.calls=[]
    def __call__(self,path,payload=None,method=None,missing=False):
        self.calls.append((path,method))
        if path=='git/ref/heads/main': return {'object':{'sha':'main-sha'}}
        if path.startswith('git/ref/heads/'): return {'object':{'sha':'state-sha'}} if self.branch else None
        if path=='git/refs': self.branch=True; return {}
        path=path.split('?')[0]
        if method=='PUT':
            old=self.rows.get(path)
            if old and payload.get('sha')!=old['sha']: raise RuntimeError('Durable state GitHub HTTP 409')
            row={'content':payload['content'],'sha':str(len(self.calls)), 'encoding':'base64'}
            self.rows[path]=row
            return {'content':{'sha':row['sha']}}
        return self.rows.get(path)


class RuntimeTests(unittest.TestCase):
    def test_encryption_authenticates_key_session_and_ciphertext(self):
        value={'private_symbol':'TEST', 'private_level':100}
        raw=seal(value,'secret-fixture',SESSION)
        self.assertNotIn(b'private_symbol',raw)
        self.assertEqual(unseal(raw,'secret-fixture',SESSION),value)
        for secret,session in [('wrong',SESSION),('secret-fixture','2026-11-25')]:
            with self.assertRaises(RuntimeError):unseal(raw,secret,session)
        envelope=json.loads(raw);cipher=bytearray(base64.b64decode(envelope['ciphertext']));cipher[0]^=1
        envelope['ciphertext']=base64.b64encode(cipher).decode()
        with self.assertRaises(RuntimeError):unseal(json.dumps(envelope),'secret-fixture',SESSION)

    def test_state_write_read_and_atomic_conflict(self):
        api=MemoryAPI(); a=Store(SESSION,'fixture',api); self.assertIsNone(a.read())
        w=watchlist(); seed(w,a)
        b=Store(SESSION,'fixture',api); value=b.read(); self.assertEqual(value['watchlist'],w)
        a.write(value)
        with self.assertRaisesRegex(RuntimeError,'409'):b.write(value)
        self.assertNotIn('TEST',json.dumps(api.rows))

    def test_network_read_failure_never_becomes_an_empty_journal(self):
        def denied(*args,**kwargs):raise RuntimeError('HTTP 403')
        store=Store(SESSION,'fixture',denied)
        with self.assertRaises(RuntimeError):store.read()
        self.assertFalse(store.loaded)
        with self.assertRaisesRegex(RuntimeError,'Read private state'):store.write({})

    def test_unknown_claim_is_durable_before_send_and_suppresses_after_restart(self):
        api=MemoryAPI();store=Store(SESSION,'fixture',api);w=watchlist();seed(w,store)
        with tempfile.TemporaryDirectory() as d:
            _,journal,_=open_context(Path(d)/'first.sqlite',SESSION,Store(SESSION,'fixture',api))
            sent=[]
            def uncertain(e):
                persisted=Store(SESSION,'fixture',api).read()
                self.assertEqual(persisted['deliveries'][0][2],'UNKNOWN')
                sent.append(e)
                raise RuntimeError('Send acknowledgement lost')
            with self.assertRaises(RuntimeError):journal.deliver(w,'telegram',uncertain)
            journal.db.close()
            _,restarted,_=open_context(Path(d)/'second.sqlite',SESSION,Store(SESSION,'fixture',api))
            state,_=restarted.deliver(w,'telegram',lambda e:self.fail('Must not replay an uncertain send'))
            self.assertEqual(state,'UNKNOWN');self.assertEqual(len(sent),1)
            restarted.db.close()

    def test_failed_checkpoint_prevents_side_effect(self):
        with tempfile.TemporaryDirectory() as d:
            def fail(j):raise RuntimeError('Checkpoint unavailable')
            journal=Journal(str(Path(d)/'journal.sqlite'),checkpoint=fail)
            with self.assertRaises(RuntimeError):journal.deliver(watchlist(),'telegram',lambda e:self.fail('No unclaimed send'))
            journal.db.close()

    def test_no_retroactive_iex_alert_and_channels_are_independent(self):
        w=watchlist();c=w['candidates'][0]
        e=event('breakout',SESSION,{'watchlist_id':w['id'],'candidate':c,'feed':'iex',
                'confirmation':{'bar_at':at(SESSION,'09:30').isoformat(),'close':100.1,'volume':200,'baseline':100},
                'observed_at':at(SESSION,'09:31').isoformat(),'cutoff':at(SESSION,'09:31').isoformat()})
        with tempfile.TemporaryDirectory() as d:
            journal=Journal(str(Path(d)/'j.sqlite'));journal.add(e);calls=[]
            senders={'telegram':lambda e:calls.append('telegram') or {'payload_sha256':digest(e)},
                     'dashboard':lambda e:(_ for _ in ()).throw(RuntimeError('Dashboard unavailable'))}
            with patch.dict(os.environ,{'SENTINEL_SITES_TOKEN':'fixture'}):
                deliver_pending(journal,at(SESSION,'10:00'),senders)
                self.assertEqual(calls,[])
                deliver_pending(journal,at(SESSION,'09:32'),senders)
                self.assertEqual(calls,['telegram'])
            journal.db.close()

    def test_missing_iex_minute_cannot_fabricate_cross_from_old_close(self):
        bars=[{'t':at(SESSION,'09:30').isoformat(),'o':99,'c':99.5,'v':200},
              {'t':at(SESSION,'09:32').isoformat(),'o':100.5,'c':101,'v':200}]
        self.assertEqual(confirmations({'trigger':100},bars,at(SESSION,'09:33'),{'09:30':100,'09:32':100},SESSION,'iex'),[])

    def test_live_window_does_not_run_after_reconciliation_or_on_weekends(self):
        self.assertTrue(live_window(at(SESSION,'09:15')))
        self.assertFalse(live_window(at(SESSION,'10:47')))
        self.assertFalse(live_window(at('2026-11-28','09:30')))


if __name__=='__main__':unittest.main()

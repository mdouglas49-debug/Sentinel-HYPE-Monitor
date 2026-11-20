import tempfile
from pathlib import Path
import unittest
from scanner import digest
from telegram_proof import deliver,fixture

class TelegramProofTests(unittest.TestCase):
 def test_fixture_is_clearly_paper_and_has_no_market_values(self):
  e=fixture('123','2026-11-20');self.assertTrue(e['test']);self.assertEqual(e['mode'],'PAPER_ONLY')
  self.assertEqual(e['feed'],'NONE');self.assertIsNone(e['cutoff']);self.assertEqual(e['candidates'],[])
  with self.assertRaises(RuntimeError):fixture('not-a-run','2026-11-20')
 def test_one_delivery_survives_journal_restart(self):
  e=fixture('123','2026-11-20');calls=[]
  def send(value):calls.append(value);return {'message_id':1,'date':2,'payload_sha256':digest(value)}
  with tempfile.TemporaryDirectory() as directory:
   r=deliver(e,'123',Path(directory)/'j.sqlite',send)
  self.assertEqual(len(calls),1);self.assertEqual(r['status'],'DELIVERED');self.assertTrue(r['restart_duplicate_suppressed'])
 def test_tampered_or_real_candidate_never_sends(self):
  e=fixture('123','2026-11-20');e['candidates']=[{'symbol':'TEST'}]
  def send(value):self.fail('No send is allowed')
  with tempfile.TemporaryDirectory() as directory:
   with self.assertRaises(RuntimeError):deliver(e,'123',Path(directory)/'j.sqlite',send)
if __name__=='__main__':unittest.main()

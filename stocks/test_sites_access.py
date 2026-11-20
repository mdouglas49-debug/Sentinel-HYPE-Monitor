import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from scanner import Journal, canonical, digest, verify_dashboard
from sites_access import ORIGIN, NoRedirect, call, configuration, configure

class SitesAccessTests(unittest.TestCase):
 def test_owner_only_storage_loads_requested_environment_names(self):
  with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,{},clear=True):
   path=Path(directory)/'private'/'.env.sites'
   configure({'SENTINEL_DASHBOARD_URL':ORIGIN,'SENTINEL_SITES_TOKEN':'fixture-token'},path)
   self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o600)
   self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode),0o700)
   self.assertEqual(configuration(path),(ORIGIN,'fixture-token'))
   self.assertEqual(os.environ['SENTINEL_SITES_TOKEN'],'fixture-token')
 def test_rejects_readable_by_others_and_symbolic_links(self):
  with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{},clear=True):
   path=Path(directory)/'.env.sites'
   values={'SENTINEL_DASHBOARD_URL':ORIGIN,'SENTINEL_SITES_TOKEN':'fixture-token'}
   configure(values,path);os.chmod(path,0o644)
   with self.assertRaisesRegex(RuntimeError,'owner-only'):configuration(path)
   link=Path(directory)/'link';link.symlink_to(path)
   with self.assertRaises(RuntimeError):configuration(link)
   with self.assertRaises(RuntimeError):configure(values,link)
 def test_existing_environment_values_take_precedence(self):
  values={'SENTINEL_DASHBOARD_URL':ORIGIN,'SENTINEL_SITES_TOKEN':'environment-token'}
  with patch.dict(os.environ,values,clear=True):
   self.assertEqual(configuration(Path('/nonexistent/ignored')), (ORIGIN,'environment-token'))
 def test_header_only_authentication_and_canonical_paper_payload(self):
  class Response:
   status=200
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def read(self,limit):return b'{"persisted":true}'
  class Opener:
   def open(inner,request,timeout):
    self.assertEqual(request.full_url,ORIGIN+'/api/stocks')
    self.assertNotIn('fixture-token',request.full_url)
    self.assertEqual(request.get_header('Oai-sites-authorization'),'Bearer fixture-token')
    self.assertEqual(request.data,canonical({'mode':'PAPER_ONLY'}).encode())
    self.assertEqual(timeout,25)
    return Response()
  with patch('sites_access.build_opener',return_value=Opener()) as build:
   self.assertEqual(call('POST',{'mode':'PAPER_ONLY'},config=(ORIGIN,'fixture-token')),(200,{'persisted':True}))
   self.assertIsInstance(build.call_args.args[0],NoRedirect)
  self.assertIsNone(NoRedirect().redirect_request(None,None,302,'redirect',{},'https://other.example'))
  with self.assertRaisesRegex(RuntimeError,'origin denied'):call('GET',config=('https://other.example','fixture-token'))
 def test_errors_do_not_print_credentials_or_redirects(self):
  class Opener:
   def open(self,*args,**kwargs):raise URLError('fixture-token')
  with patch('sites_access.build_opener',return_value=Opener()):
   with self.assertRaises(RuntimeError) as raised:call('GET',config=(ORIGIN,'fixture-token'))
   self.assertNotIn('fixture-token',str(raised.exception))
  class Redirect:
   def open(self,*args,**kwargs):raise HTTPError(ORIGIN,302,'fixture-token',{},None)
  with patch('sites_access.build_opener',return_value=Redirect()):
   self.assertEqual(call('GET',config=(ORIGIN,'fixture-token')),(302,None))
 def test_verification_rejects_public_endpoint_before_any_write(self):
  with tempfile.TemporaryDirectory() as directory,patch('sites_access.call',return_value=(200,{})) as network:
   with self.assertRaisesRegex(RuntimeError,'privacy'):verify_dashboard(Journal(str(Path(directory)/'j.sqlite')),'2026-11-17','fixture')
   self.assertEqual(network.call_count,1)
 def test_authenticated_write_readback_and_replay(self):
  records={};posts=[]
  def network(method,body=None,query='',authenticated=True,**kwargs):
   if not authenticated:return 403,None
   if method=='POST':
    duplicate=body['id'] in records;records[body['id']]=body;posts.append(body)
    return 200,{'id':body['id'],'payload_sha256':digest(body),'persisted':True,'duplicate':duplicate}
   return 200,{'events':list(records.values()),'cursor':None}
  with tempfile.TemporaryDirectory() as directory,patch('sites_access.call',side_effect=network):
   journal=Journal(str(Path(directory)/'j.sqlite'))
   result=verify_dashboard(journal,'2026-11-17','fixture')
   self.assertEqual(result['readback'],'matched');self.assertEqual(result['replay'],'deduplicated')
   self.assertEqual(len(records),1);self.assertEqual(len(posts),2)
   self.assertTrue(posts[0]['test']);self.assertEqual(posts[0]['mode'],'PAPER_ONLY')
   self.assertEqual(posts[0]['candidates'],[])
if __name__=='__main__':unittest.main()

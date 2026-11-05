import unittest, tempfile, argparse, json, os
from pathlib import Path
from unittest.mock import patch
import configure
class ConfigurationTests(unittest.TestCase):
 def test_generates_matching_credentials_and_refuses_overwrite(self):
  with tempfile.TemporaryDirectory() as temp:
   args=argparse.Namespace(app_domain='studio.example.com',livekit_domain='rtc.example.com',turn_domain='turn.example.com',email='me@example.com')
   with patch.object(configure,'ROOT',Path(temp)),patch('getpass.getpass',return_value='a-safe-test-password'):
    configure.configure(args)
    livekit=json.loads((Path(temp)/'deploy/generated/livekit.yaml').read_text());egress=json.loads((Path(temp)/'deploy/generated/egress.yaml').read_text())
    self.assertEqual(livekit['keys'][egress['api_key']],egress['api_secret'])
    self.assertEqual(livekit['redis'],egress['redis'])
    self.assertEqual((Path(temp)/'.env').stat().st_mode&0o777,0o600)
    with self.assertRaises(ValueError):configure.configure(args)
 def test_invalid_domain_rejected_before_files_are_written(self):
  args=argparse.Namespace(app_domain='bad\nconfig',livekit_domain='rtc.example.com',turn_domain='turn.example.com',email='me@example.com')
  with self.assertRaises(ValueError):configure.configure(args)
if __name__=='__main__':unittest.main()

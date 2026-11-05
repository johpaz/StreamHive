#!/usr/bin/env python3
"""Generate first-install configuration without shell interpolation or secret output."""
import argparse, base64, getpass, json, os, re, secrets
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent

def configure(args):
    for domain in [args.app_domain,args.livekit_domain,args.turn_domain]:
        if not re.fullmatch(r'(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}',domain):
            raise ValueError('Use valid lowercase public DNS names')
    if len({args.app_domain,args.livekit_domain,args.turn_domain})!=3: raise ValueError('Use three distinct subdomains')
    if not re.fullmatch(r'[^\s@\'"$]+@[^\s@\'"$]+\.[^\s@\'"$]+',args.email): raise ValueError('Invalid ACME email')
    if (ROOT/'.env').exists(): raise ValueError('.env already exists; refusing to overwrite credentials')
    password=getpass.getpass('Initial administrator password (12+ characters): ')
    if len(password)<12 or any(c in password for c in "\r\n\x00"): raise ValueError('Password must contain 12+ characters and no control characters')
    if password!=getpass.getpass('Repeat password: '): raise ValueError('Passwords do not match')
    values=dict(APP_DOMAIN=args.app_domain,LIVEKIT_DOMAIN=args.livekit_domain,TURN_DOMAIN=args.turn_domain,ACME_EMAIL=args.email,PUBLIC_ORIGIN='https://'+args.app_domain,LIVEKIT_PUBLIC_URL='wss://'+args.livekit_domain,ADMIN_PASSWORD=password,SESSION_SECRET=secrets.token_urlsafe(48),MASTER_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),LIVEKIT_API_KEY='SH'+secrets.token_hex(10),LIVEKIT_API_SECRET=secrets.token_urlsafe(48),REDIS_PASSWORD=secrets.token_urlsafe(32),RUST_LOG='streamhive=info')
    # Single quotes prevent Docker Compose dollar interpolation; escape embedded quotes.
    def quote(v): return "'"+v.replace('\\','\\\\').replace("'","\\'")+"'"
    old=os.umask(0o077)
    try:
        (ROOT/'.env').write_text(''.join(f'{k}={quote(v)}\n' for k,v in values.items()))
        generated=ROOT/'deploy/generated';generated.mkdir(parents=True,exist_ok=True)
        livekit={'port':7880,'rtc':{'tcp_port':7881,'udp_port':7882,'use_external_ip':True},'redis':{'address':'127.0.0.1:6379','password':values['REDIS_PASSWORD']},'keys':{values['LIVEKIT_API_KEY']:values['LIVEKIT_API_SECRET']},'turn':{'enabled':True,'domain':args.turn_domain,'tls_port':5349,'udp_port':3478,'proxy_protocol':True,'proxy_protocol_trusted_cidrs':['127.0.0.0/8'],'cert_file':f'/caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/{args.turn_domain}/{args.turn_domain}.crt','key_file':f'/caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/{args.turn_domain}/{args.turn_domain}.key'},'webhook':{'api_key':values['LIVEKIT_API_KEY'],'urls':['http://127.0.0.1:8080/api/v1/webhook']},'logging':{'level':'warn'},'prometheus_port':6789}
        egress={'api_key':values['LIVEKIT_API_KEY'],'api_secret':values['LIVEKIT_API_SECRET'],'ws_url':'ws://127.0.0.1:7880','redis':{'address':'127.0.0.1:6379','password':values['REDIS_PASSWORD']},'health_port':7980,'prometheus_port':7981,'logging':{'level':'warn'}}
        # JSON is a valid YAML subset, accepted by LiveKit and Egress.
        (generated/'livekit.yaml').write_text(json.dumps(livekit,indent=2)+'\n')
        (generated/'egress.yaml').write_text(json.dumps(egress,indent=2)+'\n')
        (generated/'haproxy.cfg').write_text(f'''global
  log stdout format raw local0 warning
defaults
  mode tcp
  timeout connect 10s
  timeout client 4h
  timeout server 4h
frontend tls
  bind :443
  tcp-request inspect-delay 5s
  tcp-request content accept if {{ req.ssl_hello_type 1 }}
  use_backend turn if {{ req.ssl_sni -i {args.turn_domain} }}
  default_backend web
backend web
  server caddy 127.0.0.1:8443
backend turn
  server livekit 127.0.0.1:5349 send-proxy-v2
''')
        (generated/'haproxy.cfg').chmod(0o644)
        if os.geteuid()==0:
            for config in ['livekit.yaml','egress.yaml']: os.chown(generated/config,1000,1000)
        for folder in ['runtime/data','runtime/recordings']:
            path=ROOT/folder;path.mkdir(parents=True,exist_ok=True);path.chmod(0o770)
        # The backend and Egress containers write as UID 1000.
        if os.geteuid()==0:
            for folder in ['runtime/data','runtime/recordings']:os.chown(ROOT/folder,1000,1000)
        elif os.getuid()!=1000: print('Set ownership of runtime/data and runtime/recordings to UID/GID 1000 before starting Docker.')
    finally: os.umask(old)
    print('Created .env, deploy/generated and runtime directories. No secrets printed.')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--app-domain',required=True);p.add_argument('--livekit-domain',required=True);p.add_argument('--turn-domain',required=True);p.add_argument('--email',required=True)
    try: configure(p.parse_args())
    except ValueError as error: p.error(str(error))

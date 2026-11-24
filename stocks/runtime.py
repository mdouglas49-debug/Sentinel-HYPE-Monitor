"""Unattended paper monitor with encrypted durable state and pre-send claims."""
import argparse
import base64
from datetime import datetime, timedelta
import gzip
import json
import os
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from scanner import (Alpaca, Journal, UTC, ET, at, canonical, dashboard, digest,
                     iso, monitor_once, parse, telegram)

REPO = 'mdouglas49-debug/Sentinel-HYPE-Monitor'
BRANCH = 'sentinel-stocks-state'
API = 'https://api.github.com/repos/' + REPO + '/'
ROOT = Path('stocks-state')


def validate_session(session):
    if str(datetime.strptime(session, '%Y-%m-%d').date()) != session:
        raise RuntimeError('Invalid state session')
    return session


def key(secret, session):
    if not secret:
        raise RuntimeError('APCA_API_SECRET_KEY is required for encrypted paper state')
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                info=('Sentinel private paper state v1/' + REPO + '/' + session).encode()).derive(secret.encode())


def seal(value, secret, session):
    nonce = os.urandom(12)
    payload = gzip.compress(canonical(value).encode(), mtime=0)
    cipher = AESGCM(key(secret, session)).encrypt(nonce, payload, session.encode())
    return canonical({'schema': 1, 'algorithm': 'AES-256-GCM-HKDF-SHA256',
                      'session': session, 'nonce': base64.b64encode(nonce).decode(),
                      'ciphertext': base64.b64encode(cipher).decode()}).encode()


def unseal(raw, secret, session):
    try:
        envelope = json.loads(raw)
        if envelope['schema'] != 1 or envelope['session'] != session:
            raise ValueError()
        plain = AESGCM(key(secret, session)).decrypt(base64.b64decode(envelope['nonce']),
                    base64.b64decode(envelope['ciphertext']), session.encode())
        return json.loads(gzip.decompress(plain))
    except Exception:
        raise RuntimeError('Private paper state could not be authenticated; do not reset claims') from None


def github(path, payload=None, method=None, missing=False):
    token = os.environ.get('GITHUB_TOKEN')
    if not token:
        raise RuntimeError('GitHub Actions token is required for durable state')
    headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
               'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Sentinel-paper-state'}
    body = None if payload is None else canonical(payload).encode()
    if body is not None:
        headers['Content-Type'] = 'application/json'
    try:
        with urlopen(Request(API + path, data=body, headers=headers, method=method), timeout=25) as response:
            raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise RuntimeError('Encrypted state response exceeded size limit')
            return json.loads(raw)
    except HTTPError as error:
        if missing and error.code == 404:
            return None
        raise RuntimeError('Durable state GitHub HTTP ' + str(error.code)) from None
    except (URLError, TimeoutError, ValueError):
        raise RuntimeError('Durable state operation unverified; no write retry') from None


class Store:
    def __init__(self, session, secret=None, api=github):
        self.session = validate_session(session)
        self.secret = secret if secret is not None else os.environ.get('APCA_API_SECRET_KEY')
        if not self.secret:
            raise RuntimeError('APCA_API_SECRET_KEY is required for encrypted paper state')
        self.api = api
        self.sha = None
        self.loaded = False
        self.path = 'contents/sessions/' + session + '.sealed.json'

    def read(self):
        # A failed auth/network read is never interpreted as an empty journal.
        row = self.api(self.path + '?ref=' + BRANCH, missing=True)
        self.loaded = True
        if row is None:
            return None
        if row.get('encoding') != 'base64' or not row.get('content'):
            raise RuntimeError('Private paper state was not returned completely')
        self.sha = row['sha']
        value = unseal(base64.b64decode(row['content']), self.secret, self.session)
        if value.get('schema') != 1 or value.get('session') != self.session:
            raise RuntimeError('Private state session mismatch')
        return value

    def write(self, value):
        if not self.loaded:
            raise RuntimeError('Read private state before attempting a write')
        if not self.api('git/ref/heads/' + BRANCH, missing=True):
            head = self.api('git/ref/heads/main')['object']['sha']
            self.api('git/refs', {'ref': 'refs/heads/' + BRANCH, 'sha': head}, method='POST')
        encrypted = seal(value, self.secret, self.session)
        if len(encrypted) > 650_000:
            raise RuntimeError('Private state exceeded its verified storage bound')
        body = {'message': 'Checkpoint encrypted paper stock state ' + self.session,
                'branch': BRANCH, 'content': base64.b64encode(encrypted).decode()}
        if self.sha:
            body['sha'] = self.sha
        receipt = self.api(self.path, body, method='PUT')
        self.sha = receipt['content']['sha']


def snapshot(watchlist, journal):
    return {'schema': 1, 'session': watchlist['session'], 'mode': 'PAPER_ONLY',
            'watchlist': watchlist, 'events': journal.events(),
            'deliveries': [list(row) for row in journal.db.execute('SELECT id,channel,status,receipt FROM delivery')]}


def restore(journal, value):
    if journal.events():
        raise RuntimeError('Restore requires a fresh local journal')
    for e in value['events']:
        journal.add(e)
    with journal.db:
        journal.db.executemany('INSERT INTO delivery VALUES(?,?,?,?)', value['deliveries'])


def validate_watchlist(w, session):
    if (w.get('mode') != 'PAPER_ONLY' or w.get('test') is not False or
            w.get('kind') != 'watchlist' or w.get('session') != session or
            len(w.get('candidates', [])) > 5):
        raise RuntimeError('A matching real paper watchlist is required')
    expected = dict(w)
    expected.pop('id', None)
    if w['id'] != 'stocks-' + digest(expected)[:32]:
        raise RuntimeError('Watchlist integrity check failed')


def open_context(filename, session=None, store=None):
    session = session or str(datetime.now(ET).date())
    store = store or Store(session)
    value = store.read()
    if value is None:
        raise RuntimeError('No durable watchlist exists for this session; no reconstruction or alerts')
    w = value['watchlist']
    validate_watchlist(w, session)
    # Fresh local SQLite is a cache of the authenticated remote checkpoint.
    filename = Path(filename)
    for suffix in ('', '-wal', '-shm'):
        Path(str(filename) + suffix).unlink(missing_ok=True)
    journal = Journal(str(filename))
    restore(journal, value)
    journal.checkpoint = lambda j: store.write(snapshot(w, j))
    return w, journal, store


def seed(w, store=None):
    session = w['session']
    validate_watchlist(w, session)
    store = store or Store(session)
    value = store.read()
    if value is not None:
        if value['watchlist'] != w:
            raise RuntimeError('A different durable watchlist already exists; reconcile before replacing')
        return
    store.write({'schema': 1, 'session': session, 'mode': 'PAPER_ONLY',
                 'watchlist': w, 'events': [w], 'deliveries': []})


def deliver_pending(journal, now, senders=None):
    senders = senders or {'telegram': telegram, 'dashboard': dashboard}
    errors = []
    for e in journal.events():
        if e['kind'] != 'breakout':
            continue
        c = e['candidate']
        if not c['stop'] < e['confirmation']['close'] < c['target']:
            continue
        closed = parse(e['confirmation']['bar_at']) + timedelta(minutes=1)
        max_age = timedelta(seconds=120) if e['feed'] == 'iex' else timedelta(minutes=18)
        if now - closed <= max_age:
            try:
                journal.deliver(e, 'telegram', senders['telegram'])
            except RuntimeError as error:
                errors.append(str(error))
    if os.environ.get('SENTINEL_SITES_TOKEN'):
        for e in journal.events():
            try:
                # A newly configured dashboard receives the original morning
                # event too. Telegram never replays it from the monitor.
                journal.deliver(e, 'dashboard', senders['dashboard'])
            except RuntimeError as error:
                errors.append(str(error))
    return errors


def live_window(now):
    local = now.astimezone(ET)
    return local.weekday() < 5 and at(local.date(), '09:14') <= now < at(local.date(), '10:47')


def monitor(session):
    now = datetime.now(UTC)
    if session != str(now.astimezone(ET).date()):
        raise RuntimeError('Live monitoring requires today; use preview for retrospective verification')
    finish = at(session, '10:47')
    if not live_window(now):
        raise RuntimeError('Monitor window is over; no stale automated alerts')
    # Load after the open, so the morning sender can finish checkpointing both
    # channel receipts while this runner waits. Holding a 09:15 SHA until 09:30
    # would otherwise create a stale-writer conflict on the first alert.
    while datetime.now(UTC) < at(session, '09:30'):
        time.sleep(min(20, max(0, (at(session,'09:30')-datetime.now(UTC)).total_seconds())))
    w, journal, store = open_context(ROOT / 'monitor-journal.sqlite', session)
    api = Alpaca()
    failures = 0
    while True:
        now = datetime.now(UTC)
        if now >= at(session, '09:30'):
            errors = []
            # Check IEX and offer its alerts before fetching delayed SIP.
            for feeds in [('iex',), ('sip',), ('iex', 'sip')] if now >= at(session, '10:46') else [('iex',), ('sip',)]:
                try:
                    monitor_once(api, w, journal, ROOT / 'monitor-cache', now=now, feeds=feeds)
                    journal.checkpoint(journal)
                    errors.extend(deliver_pending(journal, datetime.now(UTC)))
                except RuntimeError as error:
                    errors.append(str(error))
            failures = failures + 1 if errors else 0
            report = {'mode': 'PAPER_ONLY', 'status': 'MONITORING',
                      'session': session, 'observed_at': iso(now), 'events': len(journal.events()),
                      'deliveries_confirmed': journal.db.execute("SELECT count(*) FROM delivery WHERE status='CONFIRMED'").fetchone()[0],
                      'deliveries_unknown': journal.db.execute("SELECT count(*) FROM delivery WHERE status='UNKNOWN'").fetchone()[0],
                      'dashboard': 'CONFIGURED' if os.environ.get('SENTINEL_SITES_TOKEN') else 'PENDING_CREDENTIAL',
                      'window_end': iso(at(session, '10:30')), 'errors': errors}
            if now >= finish:
                report['status'] = 'COMPLETED_WITH_GAPS' if errors or report['deliveries_unknown'] or any(e['kind']=='outcome' and e['outcome']['state']=='UNVERIFIED' for e in journal.events()) else 'COMPLETED'
                report['outcomes_by_state'] = {}
                latest_outcomes = {}
                for e in journal.events():
                    if e['kind']=='outcome':
                        latest_outcomes[(e['symbol'],e['feed'])]=e['outcome']['state']
                for state in latest_outcomes.values():
                    report['outcomes_by_state'][state]=report['outcomes_by_state'].get(state,0)+1
            ROOT.mkdir(parents=True, exist_ok=True)
            (ROOT / 'monitor-report.json').write_text(canonical(report) + '\n')
            print(canonical(report), flush=True)
            if failures >= 6:
                raise RuntimeError('Monitoring stopped after six unsuccessful cycles; encrypted claims retained for safe recovery')
            if now >= finish:
                break
        time.sleep(20)
    journal.db.close()


def data_proof():
    w = json.loads((ROOT / 'daily-watchlist.json').read_text())
    validate_watchlist(w, str(datetime.now(ET).date()))
    journal = Journal(str(ROOT / ('data-proof-' + str(time.time_ns()) + '.sqlite')))
    now = datetime.now(UTC)
    if now < at(w['session'], '09:31'):
        print(canonical({'mode': 'PAPER_ONLY', 'status': 'SKIPPED_BEFORE_OPEN', 'delivery_enabled': False}))
        return
    api = Alpaca()
    monitor_once(api, w, journal, ROOT / 'proof-cache', now=now)
    counts = {}
    for e in journal.events():
        counts[e['kind']] = counts.get(e['kind'], 0) + 1
    print(canonical({'check': 'POST_OPEN_DATA_PREVIEW', 'mode': 'PAPER_ONLY',
                     'status': 'VERIFIED', 'session': w['session'], 'events_by_kind': counts,
                     'api_requests': api.calls, 'delivery_enabled': False,
                     'scope': 'Retrospective processing; no live alerts or outcome fills are claimed'}))
    journal.db.close()


def state_proof():
    session = str(datetime.now(ET).date())
    store = Store(session)
    run = os.environ.get('GITHUB_RUN_ID', '')
    if not run.isdigit():
        raise RuntimeError('State proof requires a hosted run ID')
    store.path = 'contents/probes/' + run + '-' + os.environ.get('GITHUB_RUN_ATTEMPT', '1') + '.sealed.json'
    store.read()
    value = {'schema': 1, 'session': session, 'mode': 'PAPER_ONLY', 'probe': True,
             'proof': 'Synthetic persistence check; no market setups or credentials'}
    store.write(value)
    reopened = Store(session)
    reopened.path = store.path
    if reopened.read() != value:
        raise RuntimeError('Encrypted state readback did not match')
    print(canonical({'check': 'ENCRYPTED_STATE_ACCESS', 'mode': 'PAPER_ONLY',
                     'status': 'VERIFIED', 'readback': 'MATCHED', 'delivery_enabled': False}))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('phase', choices=['seed', 'monitor', 'gate', 'data-proof', 'state-proof'])
    p.add_argument('--session', default=str(datetime.now(ET).date()))
    args = p.parse_args()
    try:
        if args.phase == 'gate':
            should_run = live_window(datetime.now(UTC)) and Store(args.session).read() is not None
            if os.environ.get('GITHUB_OUTPUT'):
                with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
                    output.write('should_run=' + str(should_run).lower() + '\n')
            print(canonical({'mode': 'PAPER_ONLY', 'status': 'READY' if should_run else 'SKIPPED_NO_ACTIVE_WATCHLIST'}))
        elif args.phase == 'data-proof':
            data_proof()
        elif args.phase == 'state-proof':
            state_proof()
        elif args.phase == 'seed':
            seed(json.loads((ROOT / 'daily-watchlist.json').read_text()))
            print(canonical({'mode': 'PAPER_ONLY', 'status': 'ENCRYPTED_CHECKPOINT_VERIFIED'}))
        else:
            monitor(args.session)
        return 0
    except Exception as error:
        # Do not emit provider payloads, pick content, URL credentials or traces.
        reason = str(error) if isinstance(error, RuntimeError) else 'Private monitor operation failed; inspect metadata and retained claims'
        print(canonical({'mode': 'PAPER_ONLY', 'status': 'BLOCKED', 'reason': reason}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

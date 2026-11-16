"""Sentinel Full Market. Standard library only; no order API exists here."""
import argparse, csv, hashlib, io, json, math, os, sqlite3, statistics, sys, time
from datetime import datetime, timedelta, timezone, date
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlencode, urlsplit
from urllib.error import HTTPError, URLError
from zoneinfo import ZoneInfo

ET = ZoneInfo('America/New_York')
UTC = timezone.utc
SOURCES = {
 'sp500': 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv',
 'nasdaq100': 'https://raw.githubusercontent.com/yfiua/index-constituents/main/docs/constituents-nasdaq100.csv',
}

def iso(t): return t.astimezone(UTC).isoformat().replace('+00:00', 'Z')
def parse(s): return datetime.fromisoformat(s.replace('Z', '+00:00'))
def at(d, hhmm): return datetime.combine(date.fromisoformat(str(d)), datetime.strptime(hhmm, '%H:%M').time(), ET)
def canonical(x): return json.dumps(x, sort_keys=True, separators=(',', ':'), allow_nan=False)
def digest(x): return hashlib.sha256(canonical(x).encode()).hexdigest()

def request(url, headers=None, body=None, method=None):
    req = Request(url, headers={'User-Agent': 'Sentinel-Paper-Scanner/1.0', **(headers or {})}, data=canonical(body).encode() if body is not None else None, method=method)
    try:
        with urlopen(req, timeout=25) as r:
            raw = r.read(32_000_001)
            if len(raw) > 32_000_000: raise RuntimeError('Response exceeded size limit')
            return raw, dict(r.headers)
    except HTTPError as e:
        # Never print URLs containing bot tokens, headers, or provider response text.
        raise RuntimeError(f'{urlsplit(url).hostname}: HTTP {e.code}') from None
    except URLError:
        raise RuntimeError(f'{urlsplit(url).hostname}: connection failed; check environment network policy') from None

def universe():
    groups, evidence = {}, {}
    for name, url in SOURCES.items():
        raw, _ = request(url)
        rows = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
        column = next((c for c in rows[0] if c.lower() in ('symbol', 'ticker')), None) if rows else None
        if column is None: raise RuntimeError(f'{name}: symbol column missing')
        symbols = {r[column].strip().replace('-', '.').upper() for r in rows}
        if not all(s and len(s) <= 12 and all(c.isalnum() or c == '.' for c in s) for s in symbols): raise RuntimeError('Invalid constituent symbol')
        low, high = (490, 510) if name == 'sp500' else (95, 110)
        if not low <= len(symbols) <= high: raise RuntimeError(f'{name}: suspicious constituent count {len(symbols)}')
        groups[name] = symbols
        evidence[name] = {'url': url, 'downloaded_at': iso(datetime.now(UTC)), 'sha256': hashlib.sha256(raw).hexdigest(), 'symbols': len(symbols), 'membership_status': 'community source; official current membership unverified'}
    merged = sorted(set.union(*groups.values()))
    return merged, {'sources': evidence, 'overlap': len(groups['sp500'] & groups['nasdaq100']), 'unique': len(merged)}

class Alpaca:
    def __init__(self):
        self.key = os.environ.get('APCA_API_KEY_ID') or os.environ.get('ALPACA_API_KEY')
        self.secret = os.environ.get('APCA_API_SECRET_KEY') or os.environ.get('ALPACA_SECRET_KEY')
        if not self.key or not self.secret: raise RuntimeError('Missing APCA_API_KEY_ID and APCA_API_SECRET_KEY secrets')
        self.calls, self.last = 0, 0
    def get(self, path, params=None, calendar=False):
        # Fixed read-only hosts and GET only. No configurable broker/order routes.
        if path not in ('/v2/stocks/bars', '/v2/calendar', '/v1beta1/news'): raise RuntimeError('Read-only route denied')
        time.sleep(max(0, .36 - (time.monotonic() - self.last)))
        self.last = time.monotonic(); self.calls += 1
        host = 'paper-api.alpaca.markets' if calendar else 'data.alpaca.markets'
        raw, headers = request('https://' + host + path + '?' + urlencode(params or {}), {'APCA-API-KEY-ID': self.key, 'APCA-API-SECRET-KEY': self.secret})
        return json.loads(raw), headers
    def calendar(self, start, end):
        return self.get('/v2/calendar', {'start': str(start), 'end': str(end)}, calendar=True)[0]
    def bars(self, symbols, start, end, feed='sip', timeframe='1Min'):
        result = {s: [] for s in symbols}; pages = 0; tokens = set(); token = None
        while True:
            params = {'symbols': ','.join(symbols), 'timeframe': timeframe, 'start': iso(start), 'end': iso(end), 'feed': feed, 'adjustment': 'split', 'sort': 'asc', 'limit': 10000}
            if token: params['page_token'] = token
            data, _ = self.get('/v2/stocks/bars', params); pages += 1
            for s, bars in (data.get('bars') or {}).items():
                if s in result: result[s].extend(bars)
            token = data.get('next_page_token')
            if not token: break
            if token in tokens or pages > 3000: raise RuntimeError('Invalid pagination')
            tokens.add(token)
        for s in result:
            result[s] = sorted({b['t']: b for b in result[s] if start <= parse(b['t']) and parse(b['t']) + (timedelta(minutes=1) if timeframe == '1Min' else timedelta(0)) <= end}.values(), key=lambda b: b['t'])
        return result, pages

class Journal:
    def __init__(self, filename):
        Path(filename).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(filename)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS delivery(id TEXT, channel TEXT, status TEXT, receipt TEXT, PRIMARY KEY(id,channel))')
        self.db.commit()
    def add(self, event):
        old = self.db.execute('SELECT payload FROM events WHERE id=?', (event['id'],)).fetchone()
        if old and old[0] != canonical(event): raise RuntimeError('Event ID reused with different content')
        self.db.execute('INSERT OR IGNORE INTO events VALUES(?,?)', (event['id'], canonical(event))); self.db.commit()
    def events(self): return [json.loads(r[0]) for r in self.db.execute('SELECT payload FROM events ORDER BY rowid')]
    def deliver(self, event, channel, sender):
        self.add(event)
        # Claim BEFORE side effect. Ambiguous sends remain UNKNOWN and never auto resend.
        with self.db:
            c = self.db.execute('INSERT OR IGNORE INTO delivery VALUES(?,?,?,NULL)', (event['id'], channel, 'UNKNOWN'))
        if not c.rowcount:
            return self.db.execute('SELECT status,receipt FROM delivery WHERE id=? AND channel=?', (event['id'], channel)).fetchone()
        receipt = sender(event)
        with self.db: self.db.execute('UPDATE delivery SET status=?,receipt=? WHERE id=? AND channel=?', ('CONFIRMED', canonical(receipt), event['id'], channel))
        return 'CONFIRMED', receipt


def event(kind, session, data, test=False):
    payload = {'schema': 1, 'mode': 'PAPER_ONLY', 'kind': kind, 'session': str(session), 'test': test, **data}
    payload['id'] = 'stocks-' + digest(payload)[:32]
    return payload

def rank(symbols, current, previous, history, cutoff):
    eligible, excluded = [], {}
    for s in symbols:
        bars = current.get(s, []); prior = previous.get(s, [])
        values = [sum(b['v'] for b in day[s]) for day in history if day.get(s)]
        # Sparse bars mean no qualifying trades; absent history never becomes zero-volume evidence.
        reason = None
        if not bars: reason = 'no_premarket_bars'
        elif cutoff - (parse(bars[-1]['t']) + timedelta(minutes=1)) > timedelta(minutes=5): reason = 'stale_premarket'
        elif not prior: reason = 'no_previous_close'
        elif len(values) < 5 or sum(v > 0 for v in values) < 5: reason = 'insufficient_same_time_history'
        if reason: excluded[s] = reason; continue
        close = bars[-1]['c']; prev = prior[-1]['c']; high = max(b['h'] for b in bars)
        trigger = math.ceil((high + .01) * 100 - 1e-8) / 100
        gap = 100 * (close / prev - 1); rvol = sum(b['v'] for b in bars) / statistics.mean(values)
        distance = 100 * (trigger / close - 1)
        if gap <= 0 or rvol < 1.5 or distance > 2:
            excluded[s] = 'below_pilot_thresholds'; continue
        risk = max(trigger * .005, trigger - min(b['l'] for b in bars[-15:]))
        stop = round(trigger - risk, 2); target = round(trigger + 2 * risk, 2)
        eligible.append({'symbol': s, 'gap_pct': round(gap, 3), 'premarket_rvol': round(rvol, 3), 'distance_pct': round(distance, 3), 'trigger': trigger, 'stop': stop, 'target': target, 'last_bar_at': bars[-1]['t'], 'reason': f'Gap {gap:.1f}%; same-time premarket volume {rvol:.1f}x; {distance:.2f}% below premarket-high breakout', 'catalyst': None, 'catalyst_status': 'unverified'})
    # Equal-weight percentile ranks prevent raw volume or gap scale dominating.
    for c in eligible:
        n = len(eligible)
        c['score'] = round(sum(sum(o[k] <= c[k] for o in eligible) / n if k != 'distance_pct' else sum(o[k] >= c[k] for o in eligible) / n for k in ('gap_pct', 'premarket_rvol', 'distance_pct')) / 3, 6)
    eligible.sort(key=lambda c: (-c['score'], c['symbol']))
    return eligible[:5], excluded, len(eligible)

def scan(api, symbols, membership, session, cache, now=None):
    now = now or datetime.now(UTC); started = time.monotonic()
    cutoff = min(at(session, '09:00'), (now - timedelta(minutes=15, seconds=5)).replace(second=0, microsecond=0))
    if cutoff < at(session, '08:55'): raise RuntimeError('Too early for the 09:00 data cutoff')
    sessions = api.calendar(date.fromisoformat(session) - timedelta(days=45), session)
    if not sessions or sessions[-1]['date'] != session: raise RuntimeError('Not a verified trading session')
    past = sessions[:-1][-20:]
    if len(past) < 5: raise RuntimeError('Insufficient calendar history')
    cache = Path(cache); cache.mkdir(parents=True, exist_ok=True)
    history = []; calls_before = api.calls
    for d in past:
        day = d['date']; key = digest({'symbols': symbols, 'day': day, 'feed': 'sip', 'end': cutoff.astimezone(ET).strftime('%H:%M'), 'adjustment': 'split'})
        p = cache / (key + '.json')
        if p.exists(): bars = json.loads(p.read_text())
        else:
            bars, _ = api.bars(symbols, at(day, '04:00'), at(day, cutoff.astimezone(ET).strftime('%H:%M')))
            temp = p.with_suffix('.tmp'); temp.write_text(canonical(bars)); temp.replace(p)
        history.append(bars)
    prevday = past[-1]['date']
    previous, _ = api.bars(symbols, at(prevday, '00:00'), at(prevday, '23:59'), timeframe='1Day')
    current, _ = api.bars(symbols, at(session, '04:00'), cutoff)
    candidates, excluded, total = rank(symbols, current, previous, history, cutoff)
    # News is evidence, never inferred from price. Freeze availability as of the brief.
    for c in candidates:
        try:
            news, _ = api.get('/v1beta1/news', {'symbols': c['symbol'], 'start': iso(at(prevday, '16:00')), 'end': iso(now), 'sort': 'desc', 'limit': 10})
            articles = [n for n in news.get('news', []) if n.get('url', '').startswith('https://') and n.get('source') and n.get('headline') and c['symbol'] in n.get('symbols', []) and parse(n['created_at']) <= now]
            if articles:
                n = articles[0]; c['catalyst'] = {k: n[k] for k in ('headline', 'url', 'source', 'created_at')}; c['catalyst_status'] = 'verified_news_reference; causal link unverified'
        except RuntimeError: pass
    latest = [b[-1]['t'] for b in current.values() if b]
    return event('watchlist', session, {'created_at': iso(now), 'cutoff': iso(cutoff), 'feed': 'sip', 'delay_minutes': 15, 'candidates': candidates, 'membership': membership, 'coverage': {'requested': len(symbols), 'with_premarket_bars': sum(bool(b) for b in current.values()), 'eligible': total, 'excluded': excluded, 'history_sessions': len(history)}, 'benchmark': {'seconds': round(time.monotonic() - started, 3), 'api_requests': api.calls - calls_before, 'cache': 'warm_or_cold; inspect cache directory'}, 'latest_bar_min': min(latest) if latest else None, 'latest_bar_max': max(latest) if latest else None})

def confirmations(candidate, bars, end, baseline, session, feed):
    result = []
    previous_close = None
    for b in bars:
        t = parse(b['t']); minute = t.astimezone(ET).strftime('%H:%M')
        if not at(session, '09:30') <= t or t + timedelta(minutes=1) > end: continue
        base = baseline.get(minute)
        through = (previous_close if previous_close is not None else b['o']) <= candidate['trigger'] < b['c']
        if through and base and b['v'] >= base * 1.5:
            result.append({'bar_at': b['t'], 'close': b['c'], 'volume': b['v'], 'baseline': base, 'feed': feed})
        previous_close = b['c']
    return result

def outcome(candidate, confirmation, bars, end, window_end):
    start = parse(confirmation['bar_at']) + timedelta(minutes=1)
    entry = confirmation['close']
    if not candidate['stop'] < entry < candidate['target']: return {'state': 'SKIPPED', 'reason': 'confirmation close outside paper bracket'}
    next_time = start
    for b in bars:
        t = parse(b['t'])
        if t < start or t + timedelta(minutes=1) > end: continue
        if t != next_time: return {'state': 'UNVERIFIED', 'reason': 'missing minute bar after entry', 'entry': entry}
        next_time = t + timedelta(minutes=1)
        if b['o'] <= candidate['stop']: return {'state': 'STOP', 'exit': b['o'], 'bar_at': b['t'], 'entry': entry}
        if b['o'] >= candidate['target']: return {'state': 'TARGET', 'exit': candidate['target'], 'bar_at': b['t'], 'entry': entry}
        if b['l'] <= candidate['stop']: return {'state': 'STOP', 'exit': candidate['stop'], 'bar_at': b['t'], 'entry': entry, 'both_touched': b['h'] >= candidate['target']}
        if b['h'] >= candidate['target']: return {'state': 'TARGET', 'exit': candidate['target'], 'bar_at': b['t'], 'entry': entry}
    if next_time < min(end, window_end): return {'state': 'UNVERIFIED', 'reason': 'missing trailing minute bars', 'entry': entry}
    return {'state': 'OPEN_AT_WINDOW_END' if end >= window_end else 'OPEN', 'asof': iso(end), 'entry': entry}

def monitor_once(api, watchlist, journal, cache, now=None, window='10:30'):
    now = now or datetime.now(UTC); session = watchlist['session']; symbols = [c['symbol'] for c in watchlist['candidates']]
    if not symbols: return []
    end_window = at(session, window)
    sessions = api.calendar(date.fromisoformat(session) - timedelta(days=35), session)
    past = [s['date'] for s in sessions if s['date'] < session][-10:]
    if len(past) < 5: raise RuntimeError('Insufficient volume baseline sessions')
    results = []; cache = Path(cache); cache.mkdir(parents=True, exist_ok=True)
    existing = journal.events(); evidence = {}
    for feed in ('iex', 'sip'):
        end = min(end_window, (now - (timedelta(minutes=15, seconds=5) if feed == 'sip' else timedelta(seconds=5))).replace(second=0, microsecond=0))
        if end <= at(session, '09:30'): continue
        history = []
        for day in past:
            p = cache / (digest({'feed': feed, 'day': day, 'symbols': symbols, 'window': window}) + '.json')
            if p.exists(): h = json.loads(p.read_text())
            else:
                h, _ = api.bars(symbols, at(day, '09:30'), at(day, window), feed)
                p.write_text(canonical(h))
            history.append(h)
        bars, _ = api.bars(symbols, at(session, '09:30'), end, feed)
        for c in watchlist['candidates']:
            by_minute = {}
            for h in history:
                for b in h.get(c['symbol'], []): by_minute.setdefault(parse(b['t']).astimezone(ET).strftime('%H:%M'), []).append(b['v'])
            baseline = {m: statistics.mean(v) for m, v in by_minute.items() if len(v) >= 5}
            hits = confirmations(c, bars[c['symbol']], end, baseline, session, feed)
            expected=int((end-at(session,'09:30')).total_seconds()/60)
            evidence[(feed,c['symbol'])]={'bars':len(bars[c['symbol']]),'expected_minutes':expected,'baseline_minutes':len(baseline),'complete':len(bars[c['symbol']])==expected and len(baseline)>=expected}
            prior = next((e for e in existing if e['kind'] == 'breakout' and e['watchlist_id'] == watchlist['id'] and e['candidate']['symbol'] == c['symbol'] and e['feed'] == feed), None)
            if prior: confirmation = prior['confirmation']
            elif hits:
                confirmation = hits[0]
                alert = event('breakout', session, {'watchlist_id': watchlist['id'], 'candidate': c, 'confirmation': confirmation, 'feed': feed, 'observed_at': iso(now), 'cutoff': iso(end)})
                journal.add(alert); results.append(alert); existing.append(alert)
            else: continue
            terminal=next((e for e in existing if e['kind']=='outcome' and e['watchlist_id']==watchlist['id'] and e['symbol']==c['symbol'] and e['feed']==feed and e['outcome']['state'] in ('STOP','TARGET','SKIPPED','OPEN_AT_WINDOW_END')),None)
            if terminal: continue
            result = event('outcome', session, {'watchlist_id': watchlist['id'], 'symbol': c['symbol'], 'feed': feed, 'cutoff': iso(end), 'outcome': outcome(c, confirmation, bars[c['symbol']], end, end_window)})
            journal.add(result); results.append(result)
    for c in watchlist['candidates']:
        hits = {f: next((e for e in existing if e['kind'] == 'breakout' and e['watchlist_id'] == watchlist['id'] and e['candidate']['symbol'] == c['symbol'] and e['feed'] == f), None) for f in ('iex', 'sip')}
        if now >= end_window + timedelta(minutes=16):
            comparison = event('comparison', session, {'watchlist_id': watchlist['id'], 'symbol': c['symbol'], 'iex': hits['iex']['confirmation'] if hits['iex'] else None, 'sip': hits['sip']['confirmation'] if hits['sip'] else None, 'coverage':{f:evidence.get((f,c['symbol']),{}) for f in ('iex','sip')}, 'status': 'UNVERIFIED' if not all(evidence.get((f,c['symbol']),{}).get('complete') for f in ('iex','sip')) else 'BOTH' if all(hits.values()) else 'IEX_ONLY' if hits['iex'] else 'SIP_ONLY' if hits['sip'] else 'NEITHER', 'cutoff': iso(end_window)})
            journal.add(comparison); results.append(comparison)
            for feed in ('iex','sip'):
                if not hits[feed]:
                    no_entry=event('outcome',session,{'watchlist_id':watchlist['id'],'symbol':c['symbol'],'feed':feed,'cutoff':iso(end_window),'outcome':{'state':'NO_TRIGGER' if evidence.get((feed,c['symbol']),{}).get('complete') else 'UNVERIFIED','reason':'No paper entry; inspect feed coverage and baseline evidence'}})
                    journal.add(no_entry);results.append(no_entry)
    return results

def message(e):
    title = 'Sentinel AI - Full Market | PAPER ONLY' + (' | SYNTHETIC TEST' if e.get('test') else '')
    lines = [title, f"Event: {e['id']}", f"Session: {e['session']} | {e['kind']}", f"Data cutoff: {e.get('cutoff') or 'NONE - fixture, no market data'}", f"Feed: {e.get('feed', 'NONE')}"]
    if e.get('test'): lines.append('Delivery test only. No market candidates or trade results.')
    for c in e.get('candidates', []):
        lines.extend([f"{c['symbol']} | trigger {c['trigger']:.2f} | paper stop {c['stop']:.2f} | target {c['target']:.2f}", c['reason'], 'News: ' + (c['catalyst']['url'] if c.get('catalyst') else 'unverified')])
    if e['kind'] == 'breakout':
        c=e['candidate']; lines.append(f"{c['symbol']} completed 1m close {e['confirmation']['close']:.2f} through {c['trigger']:.2f}; paper stop {c['stop']:.2f}; target {c['target']:.2f}")
    lines.append('IEX is one exchange; alerts and volume can differ from consolidated SIP.')
    return '\n'.join(lines)

def telegram(e):
    token, chat = os.environ.get('TELEGRAM_BOT_TOKEN'), os.environ.get('TELEGRAM_CHAT_ID')
    if not token or not chat: raise RuntimeError('Missing Telegram configuration')
    raw, _ = request(f'https://api.telegram.org/bot{token}/sendMessage', {'Content-Type': 'application/json'}, {'chat_id': chat, 'text': message(e), 'disable_web_page_preview': True})
    d = json.loads(raw)
    if not d.get('ok') or d['result'].get('text') != message(e): raise RuntimeError('Telegram result failed verification')
    return {'message_id': d['result']['message_id'], 'date': d['result']['date'], 'payload_sha256': digest(e)}

def dashboard(e):
    origin, token = os.environ.get('SENTINEL_DASHBOARD_URL'), os.environ.get('SENTINEL_SITES_TOKEN')
    if origin != 'https://sentinel-hype-dashboard.chirpyfrog6.chatgpt.site' or not token: raise RuntimeError('Missing private dashboard service access')
    raw, _ = request(origin + '/api/stocks', {'Content-Type': 'application/json', 'OAI-Sites-Authorization': 'Bearer ' + token}, e)
    d = json.loads(raw)
    if d.get('id') != e['id'] or d.get('payload_sha256') != digest(e): raise RuntimeError('Dashboard receipt mismatch')
    return d

def main():
    p=argparse.ArgumentParser(); p.add_argument('command', choices=['preflight','universe','scan','benchmark','watch','test-delivery','publish']);p.add_argument('--session', default=str(datetime.now(ET).date()));p.add_argument('--state', default='stocks-state/journal.sqlite');p.add_argument('--cache', default='stocks-state/cache');p.add_argument('--file', default='stocks-state/watchlist.json');p.add_argument('--send', action='store_true');p.add_argument('--test-id',default='pilot-connectivity-v1');p.add_argument('--channel',choices=['both','telegram','dashboard'],default='both')
    a=p.parse_args(); journal=Journal(a.state)
    if a.command == 'universe':
        symbols, evidence=universe();print(json.dumps({'symbols':symbols,'membership':evidence},indent=2));return
    if a.command == 'preflight':
        api=Alpaca();now=datetime.now(UTC);end=(now-timedelta(minutes=16)).replace(second=0,microsecond=0)
        for feed in ('sip','iex'):
            cutoff=end if feed=='sip' else now.replace(second=0,microsecond=0)
            bars,pages=api.bars(['AAPL','MSFT'],cutoff-timedelta(days=3),cutoff,feed)
            print(canonical({'feed':feed,'requested_end':iso(cutoff),'http_access':'verified','pages':pages,'latest':{s:bs[-1]['t'] if bs else None for s,bs in bars.items()},'server_now':iso(now)}))
        print(canonical({'calendar':api.calendar(now.astimezone(ET).date(),now.astimezone(ET).date())}));return
    if a.command == 'benchmark':
        symbols,membership=universe();e=scan(Alpaca(),symbols,membership,a.session,a.cache);print(canonical(e));return
    if a.command == 'scan':
        prior=next((e for e in journal.events() if e['kind']=='watchlist' and e['session']==a.session),None)
        if prior: e=prior
        else:
            symbols,membership=universe();e=scan(Alpaca(),symbols,membership,a.session,a.cache);journal.add(e)
        Path(a.file).parent.mkdir(parents=True,exist_ok=True);Path(a.file).write_text(canonical(e));print(canonical(e))
        if a.send:
            for ch,sender in [('dashboard',dashboard),('telegram',telegram)]:
                if a.channel in ('both',ch): print(ch,journal.deliver(e,ch,sender))
    elif a.command == 'test-delivery':
        e=event('delivery_test',a.session,{'test_id':a.test_id,'cutoff':None,'feed':'NONE','candidates':[],'reason':'Synthetic connectivity check; Alpaca access, universe benchmark and market alerts are not verified'},True)
        journal.add(e);Path(a.file).parent.mkdir(parents=True,exist_ok=True);Path(a.file).write_text(canonical(e));print(message(e))
        if a.send:
            for ch,sender in [('dashboard',dashboard),('telegram',telegram)]:
                if a.channel in ('both',ch): print(ch,journal.deliver(e,ch,sender))
    elif a.command == 'publish':
        e=json.loads(Path(a.file).read_text())
        for ch,sender in [('dashboard',dashboard),('telegram',telegram)]:
                if a.channel in ('both',ch): print(ch,journal.deliver(e,ch,sender))
    elif a.command == 'watch':
        api=Alpaca();w=json.loads(Path(a.file).read_text())
        if w.get('test') or w['kind']!='watchlist' or w['session']!=str(datetime.now(ET).date()):raise RuntimeError('Requires today\'s actual paper watchlist')
        while datetime.now(UTC)<=at(w['session'],'10:47'):
            monitor_once(api,w,journal,a.cache)
            if a.send:
                for e in journal.events():
                    if e['session']!=w['session']: continue
                    for ch,sender in [('dashboard',dashboard),('telegram',telegram)]:
                        if a.channel not in ('both',ch): continue
                        if ch=='telegram' and e['kind'] not in ('watchlist','breakout'): continue
                        journal.deliver(e,ch,sender)
            time.sleep(20)

if __name__ == '__main__':
    try: main()
    except (RuntimeError, ValueError, KeyError) as e: print('BLOCKED:',str(e),file=sys.stderr);sys.exit(1)

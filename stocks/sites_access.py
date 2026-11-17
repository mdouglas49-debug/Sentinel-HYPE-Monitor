"""Private Sites service access. Credentials never enter Git or shell arguments."""
import json
import os
from pathlib import Path
import stat
import tempfile
from urllib.error import HTTPError, URLError
from urllib.request import Request, HTTPRedirectHandler, build_opener

ORIGIN = 'https://sentinel-hype-dashboard.chirpyfrog6.chatgpt.site'
CONFIG = Path(__file__).resolve().parent.parent / 'stocks-state' / '.env.sites'
KEYS = {'SENTINEL_DASHBOARD_URL', 'SENTINEL_SITES_TOKEN'}


def configure(values, path=CONFIG):
    if set(values) != KEYS or values['SENTINEL_DASHBOARD_URL'] != ORIGIN or not isinstance(values['SENTINEL_SITES_TOKEN'], str) or not values['SENTINEL_SITES_TOKEN'] or any(c in values['SENTINEL_SITES_TOKEN'] for c in '\r\n'):
        raise RuntimeError('Invalid Sites credential configuration')
    path = Path(path)
    if path.parent.is_symlink() or path.is_symlink():
        raise RuntimeError('Sites credential path must not be a symbolic link')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    fd, temporary = tempfile.mkstemp(prefix='.sites-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as output:
            for key in sorted(KEYS):
                output.write(key + '=' + json.dumps(values[key]) + '\n')
            output.flush(); os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def configuration(path=CONFIG):
    values = {k: os.environ[k] for k in KEYS if os.environ.get(k)}
    if len(values) < len(KEYS):
        try:
            fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        except FileNotFoundError:
            fd = None
        except OSError:
            raise RuntimeError('Sites credential file could not be opened safely') from None
        if fd is not None:
            with os.fdopen(fd) as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 20000:
                    raise RuntimeError('Sites credential file must be owner-only (0600)')
                saved = {}
                try:
                    for line in source:
                        key, value = line.rstrip('\n').split('=', 1)
                        if key not in KEYS or key in saved: raise ValueError()
                        saved[key] = json.loads(value)
                except (ValueError, TypeError):
                    raise RuntimeError('Invalid Sites credential file') from None
                for key, value in saved.items(): values.setdefault(key, value)
    if values.get('SENTINEL_DASHBOARD_URL') != ORIGIN or not isinstance(values.get('SENTINEL_SITES_TOKEN'), str) or not values['SENTINEL_SITES_TOKEN'] or any(c in values['SENTINEL_SITES_TOKEN'] for c in '\r\n'):
        raise RuntimeError('Missing or invalid private dashboard service access')
    # Make the requested names available to the scanner process only.
    for key, value in values.items(): os.environ.setdefault(key, value)
    return values['SENTINEL_DASHBOARD_URL'], values['SENTINEL_SITES_TOKEN']


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def call(method, body=None, query='', authenticated=True, config=None):
    if method not in ('GET', 'POST') or (query and (not query.startswith('?') or '#' in query or '\r' in query or '\n' in query)):
        raise RuntimeError('Sites request denied')
    origin, token = config or configuration()
    if origin != ORIGIN:
        raise RuntimeError('Sites origin denied')
    headers = {'Content-Type': 'application/json', 'User-Agent': 'Sentinel-Paper-Scanner/1.0'}
    if authenticated: headers['OAI-Sites-Authorization'] = 'Bearer ' + token
    raw = json.dumps(body, sort_keys=True, separators=(',', ':'), allow_nan=False).encode() if body is not None else None
    request = Request(origin + '/api/stocks' + query, headers=headers, data=raw, method=method)
    # Never forward the bearer credential through a redirect. Keep inherited
    # proxy settings and TLS verification; no authentication appears in URLs.
    try:
        with build_opener(NoRedirect()).open(request, timeout=25) as response:
            data = response.read(2_000_001)
            if len(data) > 2_000_000: raise RuntimeError('Sites response exceeded size limit')
            return response.status, json.loads(data)
    except HTTPError as error:
        return error.code, None
    except URLError:
        raise RuntimeError('Dashboard connection blocked or unavailable; check the environment network policy') from None
    except (ValueError, UnicodeError):
        raise RuntimeError('Dashboard returned an invalid response') from None


if __name__ == '__main__':
    import sys
    if sys.stdin.isatty():
        import termios
        attrs = termios.tcgetattr(sys.stdin); attrs[3] &= ~termios.ECHO
        termios.tcsetattr(sys.stdin, termios.TCSANOW, attrs)
    print('Ready for Sites credential JSON on stdin (hidden).', flush=True)
    try:
        configure(json.loads(sys.stdin.readline()))
        print('Sites service credential configured in owner-only, Git-ignored scanner storage.')
    except Exception:
        print('Sites credential configuration failed.', file=sys.stderr); sys.exit(1)

"""Restricted GET transport using the official alpaca-py SDK."""
import os
from alpaca.common.rest import RESTClient
from alpaca.common.exceptions import APIError
from requests.exceptions import RequestException

class ReadOnlyClient(RESTClient):
    def __init__(self, host, key, secret):
        if host not in ('data.alpaca.markets', 'paper-api.alpaca.markets'):
            raise RuntimeError('Alpaca host denied')
        self.host, self.request_count = host, 0
        super().__init__(base_url='https://' + host, api_key=key, secret_key=secret, api_version='v2', raw_data=True)
        # requests honors REQUESTS_CA_BUNDLE/CURL_CA_BUNDLE itself. Also retain
        # the Cloud runtime's SSL_CERT_FILE trust configuration when supplied.
        if os.environ.get('SSL_CERT_FILE'):
            self._session.verify = os.environ['SSL_CERT_FILE']

    def _request(self, method, path, data=None, base_url=None, api_version=None):
        version = api_version if api_version is not None else self._api_version
        allowed = {
            ('data.alpaca.markets', 'v2', '/stocks/bars'),
            ('data.alpaca.markets', 'v1beta1', '/news'),
            ('paper-api.alpaca.markets', 'v2', '/calendar'),
        }
        if method.upper() != 'GET' or base_url is not None or (self.host, version, path) not in allowed:
            raise RuntimeError('Read-only Alpaca route denied')
        try:
            return super()._request(method, path, data, api_version=api_version)
        except APIError as e:
            status = getattr(e, 'status_code', None)
            raise RuntimeError(f'{self.host}: HTTP {status or "error"}') from None
        except RequestException:
            raise RuntimeError(f'{self.host}: connection failed; check credentials, network policy and CA trust') from None
        except ValueError:
            raise RuntimeError(f'{self.host}: invalid JSON response') from None

    def _one_request(self, method, url, opts, retry):
        self.request_count += 1
        return super()._one_request(method, url, {**opts, 'timeout': 25}, retry)

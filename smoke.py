"""Checks the running, freshly extracted release; writes synthetic accounts only."""
import argparse
from datetime import datetime, timezone
import hashlib
from http.cookiejar import CookieJar
import json
from pathlib import Path
import re
import sqlite3
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import HTTPCookieProcessor, Request, build_opener
from uuid import uuid4

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--frontend-port', type=int, default=5178)
    parser.add_argument('--reuse-account', type=int)
    args = parser.parse_args()
    processes = json.loads((ROOT / '.runtime/processes.json').read_text(encoding='utf-8'))
    assert processes['smoke_test'] is True, 'Writes only allowed in a smoke-test deployment'
    assert processes['ports']['frontend'] == args.frontend_port
    base = f'http://127.0.0.1:{args.frontend_port}'
    results = []
    opener = build_opener(HTTPCookieProcessor(CookieJar()))
    csrf = None

    def request(path, method='GET', body=None, code=200, headers=None):
        req = Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                      method=method, headers={'Content-Type': 'application/json',
                          **({'Origin': base, 'X-Guiliu-CSRF': csrf} if csrf else {}), **(headers or {})})
        try:
            response = opener.open(req, timeout=25)
        except HTTPError as error:
            response = error
        with response:
            raw, actual = response.read(), response.status
            assert actual == code, f'{method} {path}: expected {code}, got {actual}: {raw[:300]!r}'
            data = json.loads(raw) if 'application/json' in response.headers.get('Content-Type', '') else raw.decode('utf-8')
            if isinstance(data, dict) and code < 400:
                assert data.get('success', True) is not False, f'{path}: {data}'
        results.append({'method': method, 'path': path, 'status': actual})
        return data

    request('/healthz')
    request('/backend/DB/accounts', code=401)
    log = (ROOT / '.runtime/logs/frontend.out.log').read_text(encoding='utf-8')
    codes = re.findall(r'GUILIU pairing code \(one use, 30 minutes\): ([a-f0-9]{32})', log)
    assert codes, 'Start the release first to obtain a pairing code'
    pair = Request(base + '/auth/pair', data=urlencode({'code': codes[-1]}).encode(),
                   headers={'Origin': base, 'Content-Type': 'application/x-www-form-urlencoded'})
    with opener.open(pair, timeout=25) as response:
        assert response.status == 200
    csrf = request('/auth/session')['csrf']
    index = request('/')
    init = request('/initialization.html')
    for path in sorted(set(re.findall(r'(?:src|href)="(/(?:src|assets)/[^"?]+)', index + init))):
        # Binary assets are checked by HTTP and manifest, not decoded as HTML.
        with opener.open(base + path, timeout=10) as response:
            assert response.status == 200 and response.read()
        results.append({'method': 'GET', 'path': path, 'status': 200})
    config = request('/src/config.js')
    assert 'backendPath: "/backend"' in config and 'agentPath: "/agent"' in config
    setup = request('/backend/initialization')['result']
    assert setup['initialized'] is False
    assert setup.get('completed_steps', []) == []
    request('/agent/health')
    settings = request('/agent/initialization')['result']
    assert settings['ready'] is False and not any(settings['credentials'].values())
    for path in ['/backend/openapi.json', '/agent/openapi.json', '/backend/DB/dealing-data',
                 '/backend/DB/ADRresults', '/backend/DB/accounts', '/backend/DB/assets/settings',
                 '/backend/DB/assets/overview', '/backend/DB/assets/history?start_date=2026-10-01&end_date=2026-10-10', '/backend/imports/presets',
                 '/agent/prompts', '/agent/chat/sessions', '/agent/automations', '/agent/automation-agents',
                 '/agent/insights', '/agent/plans', '/agent/plans/accounts']:
        request(path)
    for path in ['/tests/initialization-preview.html', '/tests/gmail-authorization.html',
                 '/.env', '/.git/config', '/.initialization-test.local.json', '/package.json',
                 '/src/server.mjs', '/src/initialization/test-autofill-server.mjs', '/__test/initialization-autofill']:
        request(path, code=404)
    # A stale browser-side address is ignored: the request still reaches only this deployment.
    assert request('/backend/initialization', headers={'x-target-base': 'http://127.0.0.1:8001'})['result']['initialized'] is False
    request('/backend/initialization/step', 'POST', {'step': 'complete', 'data': {}}, code=409)
    request('/backend/initialization/step', 'POST', {'step': 'gmail', 'data': {}}, code=409)
    request('/backend/initialization/step', 'POST', {'step': 'not-a-step', 'data': {}}, code=422)

    if args.reuse_account:
        number = args.reuse_account
        account = request(f'/backend/DB/accounts/{number}')['result']
        assert account['name'] == 'Release smoke account'
    else:
        payload = {'name': 'Release smoke account', 'account_type': 'cash', 'currency': 'JPY',
                   'institution': 'Synthetic test', 'opening_balance': '1000'}
        key = {'Idempotency-Key': str(uuid4())}
        first = request('/backend/DB/accounts', 'POST', payload, headers=key)['result']
        again = request('/backend/DB/accounts', 'POST', payload, headers=key)['result']
        assert again['replayed'] is True and first['replayed'] is False
        assert {k: v for k, v in first.items() if k != 'replayed'} == {k: v for k, v in again.items() if k != 'replayed'}, 'Idempotent create changed the original result'
        number = first['account_number']
        request(f'/backend/DB/accounts/{number}/calibrate', 'POST',
                {'confirmed_balance': '1200', 'note': 'Synthetic deployment smoke test'},
                headers={'Idempotency-Key': str(uuid4())})
    account = request(f'/backend/DB/accounts/{number}')['result']
    assert str(account['balance']) in {'1200', '1200.0', '1200.00'}
    with sqlite3.connect(ROOT / '.runtime/data/backend.sqlite3') as db:
        assert db.execute('SELECT COUNT(*) FROM DealingData').fetchone()[0] == 0
        assert db.execute('SELECT COUNT(*) FROM DoneList').fetchone()[0] == 0
        assert db.execute('SELECT COUNT(*) FROM OCRresults').fetchone()[0] == 0
    assert not (ROOT / '.runtime/data/gmail-token.json').exists()
    assert not (ROOT / '.runtime/data/agent/credentials.json').exists()
    prepared = request('/agent/initialization/prepare', 'POST')['result']
    assert set(prepared['vector_tables']) == {'merchant_memory', 'classification_case_memory', 'adr_memory'}
    import lancedb
    vectors = lancedb.connect(str(ROOT / '.runtime/data/vectors'))
    for name in prepared['vector_tables']:
        assert vectors.open_table(name).count_rows() == 0
    assert request('/backend/initialization')['result']['initialized'] is False
    # Packaged copies carry MANIFEST.json; a source checkout has nothing to compare against.
    packaged = (ROOT / 'MANIFEST.json').is_file()
    if packaged:
        manifest = json.loads((ROOT / 'MANIFEST.json').read_text(encoding='utf-8'))
        for name, digest in manifest['files'].items():
            assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest, name
    report = {'passed': True, 'checked_at': datetime.now(timezone.utc).isoformat(), 'checks': results,
              'test_account': number, 'restarted_persistence_test': bool(args.reuse_account),
              'release_files_unchanged': True if packaged else None, 'initialized': False,
              'not_tested': ['browser visual interaction', 'live OAuth', 'LLM', 'Embedding', 'OCR', 'mail processing']}
    output = ROOT.parent / ('smoke-restart.json' if args.reuse_account else 'smoke-first-start.json')
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'checks': len(results), 'test_account': number, 'report': str(output)}))


if __name__ == '__main__':
    main()

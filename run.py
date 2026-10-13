"""Run only this extracted release, with isolated, persistent local storage."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import secrets
import webbrowser
from urllib.request import Request, ProxyHandler, HTTPRedirectHandler, build_opener, urlopen

# A release keeps each version's program files in versions/<version>/ (this file's folder) beside the shared
# runtime/ and the user data in .runtime/, so an update swaps program files without touching data. A source checkout
# runs from its own folder. launch.py names the release folder in GUILIU_HOME.
ROOT = Path(__file__).resolve().parent
HOME = Path(os.environ['GUILIU_HOME']).resolve() if os.environ.get('GUILIU_HOME') else (
    ROOT.parents[1] if ROOT.parent.name == 'versions' else ROOT)
RUNTIME = HOME / '.runtime'
# The embedded interpreter's ._pth fixes sys.path and does not add the script folder.
sys.path.insert(0, str(ROOT))
UPDATE_EXIT = 75   # services stopped for an update; launch.py switches versions and starts again


def release_version():
    try:
        return json.loads((ROOT / 'RELEASE.json').read_text(encoding='utf-8'))['version']
    except (OSError, ValueError, KeyError):
        return 'source'


def migrate_user_files(data):
    """Copy bank rules and mail attachments that older layouts kept inside backend/ into the data folder, once."""
    for legacy, target in (('backend/ZhenZeJson', data / 'bank-rules'), ('backend/attachments', data / 'mail/attachments')):
        for base in dict.fromkeys((ROOT, HOME)):
            folder = base / legacy
            if not folder.is_dir():
                continue
            for item in folder.iterdir():
                if item.is_file() and not (target / item.name).exists():
                    target.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(item, target / item.name)


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def environment(args):
    # Never inherit production paths, API keys, proxies, or a parent PYTHONPATH.
    blocked = ('ABK_', 'OPENAI_', 'DASHSCOPE_', 'GUILIU_', 'GOOGLE_', 'PYTHON')
    env = {k: v for k, v in os.environ.items()
           if not k.upper().startswith(blocked)
           and k.upper() not in {'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'BACKEND_URL', 'AGENT_URL', 'PORT', 'HOST'}}
    data = RUNTIME / 'data'
    for folder in (data / 'initialization', data / 'agent', data / 'context', data / 'bank-rules', RUNTIME / 'logs'):
        folder.mkdir(parents=True, exist_ok=True)
    migrate_user_files(data)
    settings = RUNTIME / 'settings.json'
    if not settings.exists():
        shutil.copyfile(ROOT / 'backend/config/settings.json', settings)
    env.update({
        'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8', 'PYTHONDONTWRITEBYTECODE': '1',
        'ABK_SETTINGS_FILE': str(settings), 'ABK_SERVER_DATA_DIR': str(data),
        'GUILIU_AUTH_FILE': str(data / 'security/service-credentials.json'),
        'ABK_DB_FILE': str(data / 'backend.sqlite3'),
        'ABK_AGENT_DB': str(data / 'agent.sqlite3'),
        'ABK_VECTOR_DB_PATH': str(data / 'vectors'),
        'ABK_CONTEXT_DIR': str(data / 'context'),
        'ABK_INITIALIZATION_DIR': str(data / 'initialization'),
        'ABK_AGENT_CREDENTIALS_FILE': str(data / 'agent/credentials.json'),
        'ABK_GMAIL_TOKEN_FILE': str(data / 'gmail-token.json'),
        'ABK_ZHENZE_DIR': str(data / 'bank-rules'),
        'ABK_ATTACHMENT_DIR': str(data / 'mail/attachments'),
        'GUILIU_HOME': str(HOME), 'GUILIU_APP_DIR': str(ROOT), 'GUILIU_VERSION': release_version(),
        'ABK_BACKEND_BASE_URL': f'http://127.0.0.1:{args.backend_port}',
        'ABK_AGENT_BASE_URL': f'http://127.0.0.1:{args.agent_port}',
        'BACKEND_URL': f'http://127.0.0.1:{args.backend_port}',
        'AGENT_URL': f'http://127.0.0.1:{args.agent_port}',
        'HOST': '127.0.0.1', 'PORT': str(args.frontend_port),
        # Avoid discovering a parent .env when deployed under a development directory.
        'PYTHON_DOTENV_DISABLED': '1',
    })
    # Tests and mirrors may point the update check elsewhere; it is still signature-checked.
    if os.environ.get('GUILIU_UPDATE_URL'):
        env['GUILIU_UPDATE_URL'] = os.environ['GUILIU_UPDATE_URL']
    if args.smoke_test:
        env.update(ABK_LOOP_ENABLED='false', ABK_ADR_ENABLED='false', ABK_ADR_MAIL_ENABLED='false',
                   ABK_AUTOMATION_ENABLED='false', ABK_FX_OFFLINE='1', GUILIU_SMOKE_TEST='1')
    return env


def verify():
    # This version's program files, then (in a release) the shared files beside versions/.
    total = 0
    for base in dict.fromkeys((ROOT, HOME)):
        if base != ROOT and not (base / 'MANIFEST.json').is_file():
            continue
        manifest = json.loads((base / 'MANIFEST.json').read_text(encoding='utf-8'))
        bad = [name for name, digest in manifest['files'].items()
               if not (base / name).is_file() or hashlib.sha256((base / name).read_bytes()).hexdigest() != digest]
        if bad:
            raise RuntimeError('Release files changed or missing: ' + ', '.join(bad))
        total += len(manifest['files'])
    print(f"Verified {total} release files", flush=True)


def open_paired_browser(frontend_port, auth_file):
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    base = f'http://127.0.0.1:{frontend_port}'
    owner = json.loads(Path(auth_file).read_text(encoding='utf-8'))['tokens']['owner']
    request = Request(base + '/auth/launch-ticket', data=b'{}', method='POST',
                      headers={'Authorization': 'Bearer ' + owner, 'Content-Type': 'application/json'})
    with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=5) as response:
        ticket = json.load(response)['ticket']
    if not isinstance(ticket, str) or len(ticket) != 64 or any(c not in '0123456789abcdef' for c in ticket):
        raise ValueError('Invalid launch ticket')
    # The fragment is stripped by the landing page before the one-time exchange.
    return webbrowser.open(base + '/auth/launch#' + ticket)


def pair_browser(frontend_port, auth_file, fallback):
    try:
        if not open_paired_browser(frontend_port, auth_file):
            print('Browser could not be opened. ' + fallback, flush=True)
    except Exception:
        # Never log ticket-bearing URLs or service credentials.
        print('Automatic browser pairing failed. ' + fallback, flush=True)


def supervisor_alive(record):
    from backend.system_control import same_process
    return bool(same_process(record))


# What each service's command line holds, to recognise a service of this copy from an older record (pids only).
SERVICE_MARKS = {'backend': 'BackendAPI:app', 'agent': 'agent_api:app', 'frontend': 'server.mjs'}


def orphaned_services(state):
    """Services recorded by a supervisor that is gone but that still run: same identity, or (older records) same pid
    with this copy's folder and the service's entry point on its command line."""
    from backend.system_control import identity, same_process
    import psutil
    found = []
    for name, record in (state.get('services') or {}).items():
        if same_process(record['process']):
            found.append({'role': name, **record})
    if found or not state.get('children'):
        return found
    for name, pid in state['children'].items():
        try:
            process = psutil.Process(pid)
            command = ' '.join(process.cmdline())
            cwd = process.cwd()
        except (psutil.Error, OSError):
            continue
        if SERVICE_MARKS.get(name, '\0') in command and str(HOME).lower() in (command + ' ' + cwd).lower():
            port = state.get('ports', {}).get(name)
            found.append({'role': name, 'process': identity(process), 'port': port, 'url': f'http://127.0.0.1:{port}'})
    return found


def stop_orphans():
    try:
        state = json.loads((RUNTIME / 'processes.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return
    try:
        if supervisor_alive(state['supervisor_process']):
            return
    except (KeyError, TypeError):
        pass
    targets = orphaned_services(state)
    if targets:
        from backend.system_control import stop_services
        print('Stopping services left running by an earlier start of this copy.', flush=True)
        stop_services(targets, auth_file=RUNTIME / 'data/security/service-credentials.json')
    (RUNTIME / 'processes.json').unlink(missing_ok=True)


def running_instance(timeout=90):
    """Ports of this copy's live supervisor once its frontend answers; None when it is not running."""
    try:
        state = json.loads((RUNTIME / 'processes.json').read_text(encoding='utf-8'))
        port, record = int(state['ports']['frontend']), state['supervisor_process']
        if not supervisor_alive(record):
            return None
    except (OSError, ValueError, KeyError, TypeError):
        return None
    # A second double-click while the first launcher is still starting waits for it instead of failing.
    deadline = time.monotonic() + timeout
    while True:
        try:
            with build_opener(ProxyHandler({})).open(f'http://127.0.0.1:{port}/healthz', timeout=2) as response:
                health = json.load(response)
            if health.get('service') == 'guiliu-release' and health.get('port') == port:
                return state['ports']
        except (OSError, ValueError):
            pass
        if time.monotonic() >= deadline or not supervisor_alive(record):
            return None
        time.sleep(.5)


DEFAULT_PORTS = {'frontend': 3000, 'backend': 8001, 'agent': 8000}


def ports_file():
    return RUNTIME / 'ports.json'


def port_free(port):
    with socket.socket() as probe:
        try:
            probe.bind(('127.0.0.1', port))
            return True
        except OSError:
            return False


def choose_ports(requested):
    """Ports for this run. A port given on the command line is used as is (and must be free); any other prefers the
    port this copy used last (so the browser session and bookmarks keep working), then the default, then the next free
    one above it, then one the system assigns. The browser only ever talks to the frontend, which proxies the rest."""
    try:
        last = json.loads(ports_file().read_text(encoding='utf-8'))
    except (OSError, ValueError):
        last = {}
    chosen, busy = {}, []
    for name in ('frontend', 'backend', 'agent'):
        explicit = requested.get(name)
        if explicit is not None:
            if explicit in chosen.values() or not port_free(explicit):
                busy.append(f'{name} {explicit}')
            chosen[name] = explicit
            continue
        default = DEFAULT_PORTS[name]
        candidates = [last.get(name) if isinstance(last, dict) else None, default, *range(default + 1, default + 100)]
        port = next((p for p in candidates if isinstance(p, int) and 1024 <= p <= 65535
                     and p not in chosen.values() and port_free(p)), None)
        if port is None:
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
        chosen[name] = port
    if busy:
        raise SystemExit('Port in use: ' + ', '.join(busy) + '. Another program or another GUILIU copy is using it. '
                         'Close it, choose other ports with --frontend-port, --backend-port and --agent-port, '
                         'or leave those options out to pick free ports automatically.')
    return chosen


def serve(args):
    requested = {name: getattr(args, name + '_port') for name in ('frontend', 'backend', 'agent')}
    explicit = [port for port in requested.values() if port is not None]
    if len(set(explicit)) != len(explicit):
        raise ValueError('Choose three distinct ports')
    running = running_instance()
    if running:
        url = f"http://127.0.0.1:{running['frontend']}"
        print(f'GUILIU is already running: {url}', flush=True)
        if not args.no_browser and not args.smoke_test:
            pair_browser(running['frontend'], RUNTIME / 'data/security/service-credentials.json',
                         f'Open {url} and use a pairing code from .runtime/logs/frontend.out.log.')
        return
    stop_orphans()
    chosen = choose_ports(requested)
    for name, port in chosen.items():
        if requested[name] is None and port != DEFAULT_PORTS[name]:
            print(f'Port {DEFAULT_PORTS[name]} is busy or was not used last time; {name} uses {port}.', flush=True)
        setattr(args, name + '_port', port)
    node = shutil.which(args.node)
    if not node:
        raise RuntimeError('Node.js not found. Pass --node with its absolute path.')
    version = subprocess.check_output([node, '--version'], text=True).strip()
    if int(version.lstrip('v').split('.')[0]) < 22:
        raise RuntimeError('Node.js 22 or later is required')
    env = environment(args)
    # Only the Backend from this run may request shutdown through the supervisor.
    control_token = secrets.token_hex(32)
    env.update(GUILIU_CONTROL_DIR=str(RUNTIME), GUILIU_CONTROL_TOKEN=control_token)
    from backend.system_control import identity, stop_services
    import psutil
    stop, restart = RUNTIME / 'stop-request', RUNTIME / 'restart-request'
    stop.unlink(missing_ok=True); restart.unlink(missing_ok=True); (RUNTIME / 'ready.json').unlink(missing_ok=True)
    processes, logs = [], []
    commands = [
        ('agent', [sys.executable, '-B', '-m', 'uvicorn', 'agent_api:app', '--app-dir', str(ROOT / 'agent'), '--host', '127.0.0.1', '--port', str(args.agent_port), '--no-access-log']),
        ('backend', [sys.executable, '-B', '-m', 'uvicorn', 'BackendAPI:app', '--app-dir', str(ROOT / 'backend'), '--host', '127.0.0.1', '--port', str(args.backend_port), '--no-access-log']),
        ('frontend', [node, 'src/server.mjs']),
    ]
    try:
        for name, command in commands:
            out = (RUNTIME / f'logs/{name}.out.log').open('a', encoding='utf-8')
            err = (RUNTIME / f'logs/{name}.err.log').open('a', encoding='utf-8')
            logs.extend([out, err])
            child = subprocess.Popen(command, cwd=ROOT / name, env=env, stdout=out, stderr=err,
                                     creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            processes.append((name, child))
        write_json(RUNTIME / 'processes.json', {'supervisor': os.getpid(), 'root': str(ROOT),
                   'supervisor_process': identity(psutil.Process()), 'control_token': control_token,
                   'ports': {'frontend': args.frontend_port, 'backend': args.backend_port, 'agent': args.agent_port},
                   'children': {name: p.pid for name, p in processes}, 'smoke_test': args.smoke_test,
                   # Identities, so a later start can stop these safely if this supervisor ends without stopping them.
                   'services': {name: {'process': identity(psutil.Process(p.pid)), 'port': getattr(args, name + '_port'),
                                       'url': f"http://127.0.0.1:{getattr(args, name + '_port')}"} for name, p in processes}})
        pending = {f'http://127.0.0.1:{args.frontend_port}/healthz',
                   f'http://127.0.0.1:{args.backend_port}/healthz',
                   f'http://127.0.0.1:{args.agent_port}/agent/health'}
        deadline = time.monotonic() + 90
        while True:
            if stop_requested(stop, control_token):
                return
            failed = [(name, p.returncode) for name, p in processes if p.poll() is not None]
            if failed:
                raise RuntimeError(f'Service exited: {failed}. Read .runtime/logs.')
            for url in list(pending):
                try:
                    with urlopen(url, timeout=1) as response:
                        if response.status == 200:
                            pending.remove(url)
                except OSError:
                    pass
            if not pending:
                write_json(ports_file(), {'frontend': args.frontend_port, 'backend': args.backend_port, 'agent': args.agent_port})
                # launch.py keeps a new version only once it has reached this point.
                write_json(RUNTIME / 'ready.json', {'version': release_version(), 'supervisor': os.getpid()})
                print(f'All services ready: http://127.0.0.1:{args.frontend_port}', flush=True)
                lines = (RUNTIME / 'logs/frontend.out.log').read_text(encoding='utf-8').splitlines()
                code = next((line for line in reversed(lines) if line.startswith('GUILIU pairing code')), '')
                if code:
                    print(code, flush=True)
                if not args.no_browser and not args.smoke_test:
                    pair_browser(args.frontend_port, env['GUILIU_AUTH_FILE'], 'Use the manual pairing code above.')
                break
            if time.monotonic() >= deadline:
                raise RuntimeError('Service startup timeout: ' + ', '.join(sorted(pending)))
            time.sleep(.5)
        while not stop_requested(stop, control_token):
            if any(p.poll() is not None for _, p in processes):
                raise RuntimeError('A service stopped; stopping this deployment only. Read .runtime/logs.')
            time.sleep(.5)
    except KeyboardInterrupt:
        pass
    finally:
        targets = []
        for name, process in processes:
            if process.poll() is None:
                port = getattr(args, name + '_port')
                try:
                    record = identity(psutil.Process(process.pid))
                except psutil.NoSuchProcess:
                    continue
                targets.append({'role': name, 'process': record,
                                'port': port, 'url': f'http://127.0.0.1:{port}'})
        stop_services(targets, auth_file=env['GUILIU_AUTH_FILE'])
        for _, process in processes:
            process.wait(timeout=5)
        for stream in logs:
            stream.close()
        (RUNTIME / 'processes.json').unlink(missing_ok=True)
        stop.unlink(missing_ok=True)
    # The Backend asks for a restart (after preparing an update) with this run's control token.
    if stop_requested(restart, control_token):
        restart.unlink(missing_ok=True)
        return UPDATE_EXIT
    return 0


def stop_requested(path, token):
    try:
        return json.loads(path.read_text(encoding='utf-8')).get('token') == token
    except (OSError, ValueError):
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['serve', 'verify', 'stop'])
    bundled_node = HOME / 'runtime/node/node.exe'
    parser.add_argument('--node', default=str(bundled_node) if bundled_node.is_file() else 'node')
    # Leave these out to pick free ports automatically (defaults 3000 / 8001 / 8000 when available).
    parser.add_argument('--frontend-port', type=int)
    parser.add_argument('--backend-port', type=int)
    parser.add_argument('--agent-port', type=int)
    parser.add_argument('--smoke-test', action='store_true', help='Disable background jobs and market/FX fetching')
    parser.add_argument('--no-browser', action='store_true', help='Start services without opening or pairing a browser')
    args = parser.parse_args()
    if args.command == 'verify':
        verify()
    elif args.command == 'stop':
        if not (RUNTIME / 'processes.json').exists():
            raise RuntimeError('This deployment has no running supervisor')
        state = json.loads((RUNTIME / 'processes.json').read_text(encoding='utf-8'))
        write_json(RUNTIME / 'stop-request', {'token': state['control_token']})
        print('Stop requested for this deployment only')
    else:
        sys.exit(serve(args) or 0)


if __name__ == '__main__':
    main()

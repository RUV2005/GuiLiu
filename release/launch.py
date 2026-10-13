"""GUILIU launcher: start the version that current.json names, and switch to an update the app has prepared.

It sits at the release root and rarely changes. Each version's program files live in versions/<version>/; the shared
runtime in runtime/ and every piece of user data in .runtime/ stay where they are, so switching versions never touches
data. Before a switch the data is backed up; a new version that does not start is replaced by the previous one again
and the backup restored. Standard library only, so it runs on the bundled interpreter of any version."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

HOME = Path(__file__).resolve().parent
RUNTIME = HOME / '.runtime'
UPDATES = RUNTIME / 'updates'
POINTER = HOME / 'current.json'
UPDATE_EXIT = 75          # run.py stopped its services for an update
VERSIONS_KEPT = 2         # the running version and the one before it
BACKUPS_KEPT = 2
# Mail that can be read from the mailbox again is not part of an update backup.
BACKUP_SKIP = {('mail', 'cache'), ('mail', 'images'), ('mail', 'attachments')}


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return default


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for attempt in range(40):   # antivirus or an indexer may hold the file for a moment
        try:
            os.replace(temporary, path)
            return
        except PermissionError:
            time.sleep(0.05 * (attempt + 1))
    os.replace(temporary, path)


def log(message):
    print('GUILIU launcher: ' + message, flush=True)
    try:
        (RUNTIME / 'logs').mkdir(parents=True, exist_ok=True)
        with (RUNTIME / 'logs/launcher.log').open('a', encoding='utf-8') as out:
            out.write(time.strftime('%Y-%m-%d %H:%M:%S ') + message + '\n')
    except OSError:
        pass


def version_folder(version):
    folder = (HOME / 'versions' / str(version)).resolve()
    if folder.parent != (HOME / 'versions').resolve() or not (folder / 'run.py').is_file():
        raise SystemExit(f'GUILIU version {version!r} is missing from versions/. Extract the full package again.')
    return folder


def intact(folder):
    """Every file the version's MANIFEST.json lists is present and unchanged."""
    manifest = read_json(folder / 'MANIFEST.json')
    if not manifest or not isinstance(manifest.get('files'), dict):
        return False
    for name, digest in manifest['files'].items():
        path = (folder / name).resolve()
        if not path.is_relative_to(folder) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            return False
    return True


def copy_tree(source, target, rel=()):
    target.mkdir(parents=True, exist_ok=True)
    for item in source.iterdir():
        here = rel + (item.name,)
        if here in BACKUP_SKIP:
            continue
        if item.is_dir():
            copy_tree(item, target / item.name, here)
        else:
            shutil.copy2(item, target / item.name)


def backup_data(version):
    target = RUNTIME / 'backups' / (time.strftime('%Y%m%d-%H%M%S') + '-' + version)
    if (RUNTIME / 'data').is_dir():
        copy_tree(RUNTIME / 'data', target / 'data')
    if (RUNTIME / 'settings.json').is_file():
        target.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RUNTIME / 'settings.json', target / 'settings.json')
    target.mkdir(parents=True, exist_ok=True)
    for old in sorted(p for p in (RUNTIME / 'backups').iterdir() if p.is_dir())[:-BACKUPS_KEPT]:
        shutil.rmtree(old, ignore_errors=True)
    return target


def restore_tree(source, target, rel=()):
    """Make target match source again, leaving the skipped mail caches alone."""
    target.mkdir(parents=True, exist_ok=True)
    wanted = {item.name for item in source.iterdir()}
    for item in list(target.iterdir()):
        here = rel + (item.name,)
        if item.name not in wanted and here not in BACKUP_SKIP and not any(here == skip[:len(here)] for skip in BACKUP_SKIP):
            shutil.rmtree(item) if item.is_dir() else item.unlink()
    for item in source.iterdir():
        here = rel + (item.name,)
        if item.is_dir():
            restore_tree(item, target / item.name, here)
        else:
            shutil.copy2(item, target / item.name)


def apply_pending():
    """Switch to a version the app downloaded and verified, after backing up the data. Returns True on a switch."""
    pending = read_json(UPDATES / 'pending.json')
    if not pending:
        return False
    pointer = read_json(POINTER, {})
    version = str(pending.get('version', ''))
    folder = HOME / 'versions' / version
    if not version or version == pointer.get('version') or not (folder / 'run.py').is_file() or not intact(folder):
        log(f'Discarding a prepared update that is incomplete or already installed: {version!r}')
        (UPDATES / 'pending.json').unlink(missing_ok=True)
        return False
    backup = backup_data(pointer['version'])
    write_json(POINTER, {'version': version, 'previous': pointer['version'], 'trial': True,
                         'backup': backup.relative_to(HOME).as_posix(), 'switched_at': time.time()})
    (UPDATES / 'pending.json').unlink(missing_ok=True)
    log(f'Updating {pointer["version"]} -> {version}; data backed up to {backup.relative_to(HOME).as_posix()}')
    return True


def keep(pointer):
    """The new version started: keep it, and drop versions older than the one before it."""
    write_json(POINTER, {'version': pointer['version'], 'previous': pointer.get('previous'), 'trial': False,
                         'backup': pointer.get('backup'), 'switched_at': pointer.get('switched_at')})
    log(f'Version {pointer["version"]} started; update kept')
    keep_names = {pointer['version'], pointer.get('previous')}
    # Folders starting with "." are downloads the app is still preparing.
    installed = [p for p in (HOME / 'versions').iterdir() if p.is_dir() and not p.name.startswith('.')]
    older = sorted((p for p in installed if p.name not in keep_names), key=lambda p: p.stat().st_mtime)
    for folder in older[:max(0, len(installed) - VERSIONS_KEPT)]:
        shutil.rmtree(folder, ignore_errors=True)


def rollback(pointer, reason):
    previous = pointer.get('previous')
    log(f'Version {pointer["version"]} did not start ({reason}); returning to {previous}')
    backup = HOME / pointer['backup'] if pointer.get('backup') else None
    if backup and (backup / 'data').is_dir():
        restore_tree(backup / 'data', RUNTIME / 'data')
    if backup and (backup / 'settings.json').is_file():
        shutil.copy2(backup / 'settings.json', RUNTIME / 'settings.json')
    write_json(POINTER, {'version': previous, 'previous': None, 'trial': False})
    # The app reads this to say why it is still on the old version and not to offer the same update at once.
    write_json(UPDATES / 'failed.json', {'version': pointer['version'], 'reason': reason, 'at': time.time()})


def lock():
    """Hold the launcher lock while serving; a second launcher only opens the running copy in the browser."""
    RUNTIME.mkdir(parents=True, exist_ok=True)
    handle = open(RUNTIME / 'launcher.lock', 'a+b')
    try:
        if os.name == 'nt':
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except OSError:
        handle.close()
        return None


def run(version, args):
    folder = version_folder(version)
    env = {**os.environ, 'GUILIU_HOME': str(HOME)}
    return subprocess.Popen([sys.executable, '-X', 'utf8', '-B', str(folder / 'run.py'), *args], cwd=folder, env=env)


def copy_ready():
    """This copy's services answer: run.py marked them ready and the frontend responds as this release."""
    if not (RUNTIME / 'ready.json').is_file():
        return False
    try:
        from urllib.request import ProxyHandler, build_opener
        port = int((read_json(RUNTIME / 'ports.json') or {})['frontend'])
        with build_opener(ProxyHandler({})).open(f'http://127.0.0.1:{port}/healthz', timeout=2) as response:
            return json.load(response).get('service') == 'guiliu-release'
    except (OSError, ValueError, KeyError, TypeError):
        return False


def attach(args, wait=300):
    """Another launcher serves this copy and may be switching versions (backing up data, starting the new version).
    Starting services here would race that switch, so wait until the copy answers, then let run.py open the browser
    on it. If that launcher ends meanwhile, serve the copy from here."""
    deadline = time.monotonic() + wait
    told = False
    while time.monotonic() < deadline:
        held = lock()
        if held is not None:
            return serve(args, held)
        if copy_ready():
            return run(read_json(POINTER)['version'], ['serve', *args]).wait()
        if not told:
            print('GUILIU is starting or updating in another window; waiting for it to finish...', flush=True)
            told = True
        time.sleep(1)
    print('GUILIU did not finish starting. Close the other GUILIU window and start again.', flush=True)
    return 1


def serve(args, held=None):
    held = held or lock()
    if held is None:
        return attach(args)
    restarted = False
    try:
        while True:
            apply_pending()
            pointer = read_json(POINTER)
            (RUNTIME / 'ready.json').unlink(missing_ok=True)
            child = run(pointer['version'], ['serve', *args, *(['--no-browser'] if restarted and '--no-browser' not in args else [])])
            trial = bool(pointer.get('trial'))
            try:
                while child.poll() is None:
                    if trial and (read_json(RUNTIME / 'ready.json') or {}).get('version') == pointer['version']:
                        keep(pointer)
                        trial = False
                    time.sleep(0.5)
            except KeyboardInterrupt:
                # Ctrl+C reaches run.py too, which stops its services; wait for it instead of leaving them.
                child.wait()
                return 130
            code = child.returncode
            if trial:
                rollback(pointer, f'exit code {code} before all services were ready')
                restarted = True
                continue
            if code == UPDATE_EXIT:
                restarted = True   # the browser tab stays open and reconnects to the new version
                continue
            return code
    finally:
        held.close()


def main():
    command, args = (sys.argv[1] if len(sys.argv) > 1 else 'serve'), sys.argv[2:]
    if not POINTER.is_file():
        raise SystemExit('current.json is missing. Extract the full GUILIU package again.')
    if command == 'serve':
        sys.exit(serve(args))
    if command in {'stop', 'verify'}:
        sys.exit(run(read_json(POINTER)['version'], [command, *args]).wait())
    raise SystemExit('Usage: launch.py serve|stop|verify [run.py options]')


if __name__ == '__main__':
    main()

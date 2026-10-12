"""Allowlisted source release; never copy a working directory wholesale."""
import argparse
import ast
from datetime import datetime, timezone
from email.parser import BytesParser
import hashlib
import json
from pathlib import Path
from portable import bundle_runtimes
import re
import shutil
import subprocess
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SKIP_PARTS = {'.git', '.venv', 'node_modules', '__pycache__', 'tests', 'artifacts'}
TEXT = {'.py', '.js', '.mjs', '.css', '.html', '.json', '.md', '.txt', '.toml', '.svg', '.ps1', '.cmd'}
SECRET_PATTERNS = [r'\bsk-[A-Za-z0-9_-]{20,}', r'GOCSPX-[A-Za-z0-9_-]{10,}',
                   r'ya29\.[A-Za-z0-9_.-]+', r'\b\d{10,}-[a-z0-9]+\.apps\.googleusercontent\.com',
                   r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
                   r'[A-Za-z0-9._%+-]+@(?:gmail|icloud|outlook|hotmail|qq|163)\.[A-Za-z]{2,}']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def json_file(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True, encoding='utf-8',
                                   stderr=subprocess.DEVNULL).strip()


def source_commit():
    """Commit of the repository being packaged, or None for an unversioned copy."""
    try:
        if Path(git(ROOT, 'rev-parse', '--show-toplevel')).resolve() == ROOT:
            return git(ROOT, 'rev-parse', 'HEAD')
    except (OSError, subprocess.CalledProcessError):
        pass
    return None


def bundle_wheels(source, root, copy):
    """Keep original wheels, pin every hash, and preserve upstream notices."""
    packages = []
    names = set()
    for wheel in sorted(source.glob('*.whl')):
        with zipfile.ZipFile(wheel) as archive:
            metadata_paths = [p for p in archive.namelist() if p.endswith('.dist-info/METADATA')]
            if len(metadata_paths) != 1:
                raise ValueError('Invalid wheel metadata: ' + wheel.name)
            metadata = BytesParser().parsebytes(archive.read(metadata_paths[0]))
            name, version = metadata['Name'], metadata['Version']
            normalized = re.sub(r'[-_.]+', '-', name).lower()
            if normalized in names or not re.fullmatch(r'[A-Za-z0-9_.-]+', name + version):
                raise ValueError('Duplicate or invalid package: ' + name)
            names.add(normalized)
            notices = []
            for member in archive.namelist():
                rel = Path(member)
                if rel.is_absolute() or '..' in rel.parts or ':' in member or '\\' in member:
                    raise ValueError('Unsafe wheel path: ' + wheel.name)
                if member.endswith('/'):
                    continue
                if '/licenses/' in member or re.match(r'^(license|licence|copying|notice|authors)([._-]|$)', rel.name, re.I):
                    target = root / 'licenses/python' / (normalized + '-' + version) / rel
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.read(member))
                    notices.append(target.relative_to(root).as_posix())
            license_name = metadata.get('License-Expression') or metadata.get('License') or '; '.join(
                item for item in metadata.get_all('Classifier', []) if item.startswith('License ::')) or 'Not declared'
            packages.append({'name': name, 'version': version, 'wheel': wheel.name,
                             'sha256': sha(wheel), 'license': license_name, 'notices': notices})
        copy(wheel, root / 'wheelhouse' / wheel.name)
    if not packages:
        raise ValueError('No wheels supplied')
    lock = '# Windows x64 / CPython 3.13. Install with --no-index --find-links wheelhouse --require-hashes.\n'
    lock += ''.join(f"{p['name']}=={p['version']} --hash=sha256:{p['sha256']}\n" for p in packages)
    (root / 'requirements-offline.txt').write_text(lock, encoding='utf-8')
    json_file(root / 'DEPENDENCIES.json', {'target': 'Windows x64 / CPython 3.13', 'packages': packages})
    return len(packages)


def build(args):
    sources = {name: Path(getattr(args, name)).resolve() for name in ('frontend', 'backend', 'agent')}
    if ((sources['backend'] / 'service_auth.py').read_bytes()
            != (sources['agent'] / 'service_auth.py').read_bytes()):
        raise ValueError('Backend and Agent authentication contracts must match')
    out = Path(args.output).resolve()
    for source in sources.values():
        if out.is_relative_to(source):
            raise ValueError('Output must be outside all source projects')
    out.mkdir(parents=True, exist_ok=False)
    root = out / 'GUILIU'
    root.mkdir()
    copies = {}

    def copy(source, target):
        if source.is_symlink() or source.is_junction():
            raise ValueError('Refusing linked source: ' + str(source))
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        copies[str(target.relative_to(root)).replace('\\', '/')] = sha(source)

    def tree(source, target, extensions, exclude=()):
        for item in sorted(source.rglob('*')):
            rel = item.relative_to(source)
            if any(p in SKIP_PARTS or p.startswith('.') for p in rel.parts):
                continue
            if not item.is_file() or item.name in exclude or item.suffix.lower() not in extensions:
                continue
            if not item.resolve().is_relative_to(source.resolve()):
                raise ValueError('Source escapes allowlist root')
            copy(item, target / rel)

    for name in ('index.html', 'initialization.html'):
        copy(sources['frontend'] / name, root / 'frontend' / name)
    tree(sources['frontend'] / 'src', root / 'frontend/src',
         {'.js', '.mjs', '.css', '.json', '.txt', '.md'},
         ('test-autofill-server.mjs', 'check.mjs', 'README.md'))
    # Keep the vendored library notice, but not development documentation with local paths.
    copy(sources['frontend'] / 'src/vendor/tanstack-virtual-core/README.md',
         root / 'frontend/src/vendor/tanstack-virtual-core/README.md')
    tree(sources['frontend'] / 'assets', root / 'frontend/assets',
         {'.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.txt'})
    # Extension-less notices are skipped by the allowlists above, but MIT / ISC require them in every copy.
    for notice in ('src/vendor/tanstack-virtual-core/LICENSE', 'assets/category-icons/LICENSE'):
        copy(sources['frontend'] / notice, root / 'frontend' / notice)
    json_file(root / 'frontend/package.json', {'name': 'guiliu-frontend', 'private': True,
              'version': args.version, 'type': 'module', 'engines': {'node': '>=22'},
              'scripts': {'start': 'node src/server.mjs'}})
    # run.py serves the frontend with a same-origin proxy, so the source defaults must point at it.
    config = (root / 'frontend/src/config.js').read_text(encoding='utf-8')
    if 'backendPath: "/backend"' not in config or 'agentPath: "/agent"' not in config:
        raise ValueError('Frontend defaults must use the same-origin /backend and /agent paths')

    # Historical one-off scripts can contain local paths and are not runtime entrypoints.
    excluded = {'test.py', 'main.py', 'reload.py', 'CreateNewShopName.py', 'import_gmail_to_adr_memory.py', 'memory.py'}
    for role in ('backend', 'agent'):
        for source in sorted(sources[role].glob('*.py')):
            if source.name not in excluded:
                copy(source, root / role / source.name)
    for name in ('alipay_v1.json', 'wechat_v1.json'):
        copy(sources['backend'] / 'import_presets' / name, root / 'backend/import_presets' / name)
    tree(sources['agent'] / 'prompt_store', root / 'agent/prompt_store', {'.json'})

    defaults_tree = ast.parse((sources['backend'] / 'runtime_settings.py').read_text(encoding='utf-8-sig'))
    defaults = next(ast.literal_eval(n.value) for n in defaults_tree.body if isinstance(n, ast.Assign)
                    and any(isinstance(t, ast.Name) and t.id == 'DEFAULTS' for t in n.targets))
    defaults['storage'] = {'backend_db': '../.runtime/data/backend.sqlite3', 'server_data_dir': '../.runtime/data'}
    # Mail sync, ADR and automation keep the code defaults (on). They start only once setup completes,
    # and the setup page tells the user before finishing; the settings page can turn each one off.
    json_file(root / 'backend/config/settings.json', defaults)

    # Vendored DDGS, copied unchanged from this reviewed upstream commit.
    vendor = sources['agent'] / 'vendor/ddgs'
    expected = '70a5635510fb8d5b15d5ba6ceced6a67e212149b'
    tree(vendor / 'ddgs', root / 'agent/vendor/ddgs/ddgs', {'.py', '.json', '.txt'})
    for name in ('LICENSE.md', 'README.md', 'pyproject.toml'):
        copy(vendor / name, root / 'agent/vendor/ddgs' / name)
    for name in ('run.py', 'smoke.py', 'requirements.txt', 'constraints.txt', 'THIRD_PARTY_NOTICES.md',
                 'install_windows.ps1', 'start_windows.cmd', 'stop_windows.cmd', 'LICENSE', 'DEPLOYMENT.md'):
        copy(ROOT / name, root / name)
    # The package opens with the product introduction; the full install and operations guide ships beside it.
    copy(HERE / 'README.package.md', root / 'README.md')

    wheel_count = bundle_wheels(Path(args.wheelhouse).resolve(), root, copy) if args.wheelhouse else 0
    if args.dependency_sources:
        extra = Path(args.dependency_sources).resolve()
        records = json.loads((extra / 'SOURCES.json').read_text(encoding='utf-8'))
        for record in records:
            archive = (extra / record['file']).resolve()
            if not archive.is_relative_to(extra) or sha(archive) != record['sha256']:
                raise ValueError('Invalid dependency source archive')
        for file in sorted(extra.rglob('*')):
            if file.is_file():
                if not file.resolve().is_relative_to(extra):
                    raise ValueError('Dependency notice path escapes source root')
                copy(file, root / 'dependency-sources' / file.relative_to(extra))
        if wheel_count:
            inventory = json.loads((root / 'DEPENDENCIES.json').read_text(encoding='utf-8'))
            for package in inventory['packages']:
                for record in records:
                    if package['name'].lower().replace('_', '-') == record['name'] and package['version'] == record['version']:
                        package['source_archive'] = 'dependency-sources/' + record['file']
                        package['notices'] += ['dependency-sources/' + name for name in record['notices']]
            json_file(root / 'DEPENDENCIES.json', inventory)

    runtimes = []
    if getattr(args, 'runtime_downloads', None):
        if not wheel_count:
            raise ValueError('Portable runtime requires the complete offline wheelhouse')
        runtimes = bundle_runtimes(args.runtime_downloads, root)

    hits = []
    for file in root.rglob('*'):
        if not file.is_file():
            continue
        if file.read_bytes().startswith(b'SQLite format 3'):
            hits.append(str(file.relative_to(root)) + ': database')
        if file.suffix.lower() in TEXT and not {'licenses', 'dependency-sources', 'runtime'}.intersection(file.relative_to(root).parts):
            value = file.read_text(encoding='utf-8-sig')
            # These exact UI placeholders are public examples, not configured mailboxes.
            if file.relative_to(root).as_posix() == 'frontend/src/initialization/mailbox-view.js':
                value = value.replace('placeholder="name@163.com"', 'placeholder=""')
                value = value.replace('placeholder="name@gmail.com"', 'placeholder=""')
            if any(re.search(pattern, value) for pattern in SECRET_PATTERNS):
                hits.append(str(file.relative_to(root)) + ': credential pattern')
    if hits:
        raise ValueError('Sensitive content detected; nothing zipped: ' + ', '.join(hits))

    commit = source_commit()
    source_status = {role: {'commit': commit,
                          'packaged_source_hashes': {key: value for key, value in copies.items() if key.startswith(role + '/')},
                          'working_copy_included': True} for role, path in sources.items()}
    json_file(root / 'RELEASE.json', {'version': args.version,
        'created_at': datetime.now(timezone.utc).isoformat(), 'sources': source_status,
        'third_party': {'ddgs': expected}, 'license': 'MIT', 'bundled_wheels': wheel_count,
        'bundled_runtimes': [{k: r[k] for k in ('name', 'version', 'sha256')} for r in runtimes],
        'scope': 'Windows x64 portable release candidate' if runtimes else 'Local single-user source release candidate',
        'transforms': ['Backend settings generated from code defaults with mail sync, ADR and automation enabled',
                       'Frontend package.json carries the release version'],
        'excluded': ['secrets', 'OAuth app credentials', 'Gmail tokens', 'mail/attachments', 'databases',
                     'vectors', 'history', 'profile', 'initialization state', 'machine settings',
                     'test fixtures', 'node_modules', 'venvs', 'Git history', 'local OCR models']})
    files = {str(p.relative_to(root)).replace('\\', '/'): sha(p) for p in sorted(root.rglob('*')) if p.is_file()}
    json_file(root / 'MANIFEST.json', {'algorithm': 'sha256', 'files': files})
    archive = out / ('GUILIU-' + args.version + '.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zipped:
        for file in sorted(root.rglob('*')):
            if file.is_file():
                zipped.write(file, str(file.relative_to(out)))
    (out / 'SHA256SUMS.txt').write_text(sha(archive) + '  ' + archive.name + '\n', encoding='ascii')
    print(json.dumps({'folder': str(root), 'archive': str(archive), 'files': len(files) + 1,
                      'bytes': archive.stat().st_size, 'sha256': sha(archive)}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('frontend', 'backend', 'agent'):
        parser.add_argument('--' + name, default=str(ROOT / name))
    parser.add_argument('--output', required=True)
    parser.add_argument('--version', default='0.1.0-rc.1')
    parser.add_argument('--wheelhouse', help='Optional CPython 3.13 Windows x64 wheel directory')
    parser.add_argument('--dependency-sources', help='Optional upstream source archives and license notices')
    parser.add_argument('--runtime-downloads', help='Verified official Python/Node archives with RUNTIMES.json')
    build(parser.parse_args())

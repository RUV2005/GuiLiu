"""Bundle official app-local runtimes and the hash-locked Python dependencies."""
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import zipfile

# Windows ships python.org's embeddable zip and Node's zip, extracted here. The Mac ships python-build-standalone
# (python.org has no relocatable Mac build) and Node's tarball; their links and file modes survive only in a tar, so
# build.py copies those members into the package tar as they are, and only the dependencies are installed here.
PLATFORMS = {
    'win-x64': {'site': 'runtime/python/Lib/site-packages', 'pip': []},
    'macos-arm64': {'site': 'runtime/python/lib/python3.13/site-packages',
                    # pyarrow's wheel needs macOS 12; every other dependency runs on macOS 11.
                    'pip': ['--platform', 'macosx_12_0_arm64', '--python-version', '3.13',
                            '--implementation', 'cp', '--abi', 'cp313']},
}
NODE_FILES = ('bin/node', 'LICENSE', 'README.md', 'CHANGELOG.md')


def stays_inside(top, path):
    """path, with its .. resolved, is top or lies under it."""
    parts = []
    for part in path.parts:
        if part == '..':
            if not parts:
                return False
            parts.pop()
        elif part != '.':
            parts.append(part)
    return parts[:1] == [top]


def runtime_members(record, archive):
    """(member, path under runtime/<name>/) for the files a Mac runtime tarball contributes; refuses anything that
    could land outside its folder."""
    prefix = 'python/' if record['name'] == 'python' else 'node-v' + record['version'] + '-darwin-arm64/'
    top = prefix.rstrip('/')
    chosen = []
    for member in archive.getmembers():
        name = PurePosixPath(member.name)
        if (name.is_absolute() or '..' in name.parts or '\\' in member.name or not stays_inside(top, name)
                or not (member.isfile() or member.isdir() or member.issym())):
            raise ValueError('Unsafe runtime archive')
        if member.issym() and (PurePosixPath(member.linkname).is_absolute()
                               or not stays_inside(top, name.parent / member.linkname)):
            raise ValueError('Unsafe runtime archive')
        if not member.name.startswith(prefix):
            continue
        rel = member.name[len(prefix):].rstrip('/')
        if not rel or (record['name'] == 'node' and rel not in NODE_FILES):
            continue
        chosen.append((member, rel))
    return chosen


def add_runtimes(tar, downloads, records, top):
    """Copy the Mac runtimes into the package tar under <top>/runtime/<name>/, keeping links and modes."""
    for record in records:
        with tarfile.open(Path(downloads) / record['file']) as archive:
            for member, rel in runtime_members(record, archive):
                info = copy.copy(member)
                info.name = f"{top}/runtime/{record['name']}/{rel}"
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                tar.addfile(info, archive.extractfile(member) if member.isfile() else None)


def bundle_runtimes(downloads, root, app=None, platform='win-x64'):
    downloads = Path(downloads).resolve()
    records = json.loads((downloads / 'RUNTIMES.json').read_text(encoding='utf-8'))
    if {r['name'] for r in records} != {'python', 'node'} or len(records) != 2:
        raise ValueError('Provide exactly one Python and one Node runtime')
    for record in records:
        archive = (downloads / record['file']).resolve()
        if not archive.is_relative_to(downloads) or hashlib.sha256(archive.read_bytes()).hexdigest() != record['sha256']:
            raise ValueError('Runtime checksum mismatch')
        if record['name'] == 'python' and not record['version'].startswith('3.13.'):
            raise ValueError('The dependency lock requires CPython 3.13')
        if platform == 'win-x64':
            extract_windows(record, archive, root)
        else:
            with tarfile.open(archive) as opened:
                contributed = {rel for _, rel in runtime_members(record, opened)}
            record['notice'] = 'runtime/python/lib/python3.13/LICENSE.txt' if record['name'] == 'python' else 'runtime/node/LICENSE'
            record['adaptations'] = (['python-build-standalone install_only build, unchanged; guiliu-home.pth adds the release root']
                                     if record['name'] == 'python' else ['Only Node executable and upstream notices; npm omitted'])
            if record['notice'].split('/', 2)[2] not in contributed:
                raise ValueError('Missing runtime license')
            continue
        if not (root / record['notice']).is_file():
            raise ValueError('Missing runtime license')

    site = root / PLATFORMS[platform]['site']
    subprocess.run([sys.executable, '-m', 'pip', '--isolated', 'install', '--no-index',
                    '--find-links', str(root / 'wheelhouse'), '--require-hashes', '--no-compile',
                    '--only-binary=:all:', *PLATFORMS[platform]['pip'], '--target', str(site),
                    '-r', str(root / 'requirements-offline.txt')],
                   check=True)
    # Entry-point executables contain absolute build paths. Services use python -m instead.
    scripts = site / 'bin'
    if scripts.is_dir():
        for path in scripts.iterdir():
            if not path.is_file() or path.is_symlink():
                raise ValueError('Unexpected dependency launcher directory')
            path.unlink()
        scripts.rmdir()
    if platform == 'win-x64':
        python = root / 'runtime/python/python.exe'
        # Program files sit in versions/<version>/ (app); the embedded interpreter adds only the paths in its ._pth.
        subprocess.run([str(python), '-B', '-c',
                        'import sys; sys.path.insert(0, "."); '
                        'import fastapi,uvicorn,sqlite3,psutil,lancedb,pyarrow,numpy,openai,PIL,primp,cryptography,backend.system_control; '
                        'import importlib.metadata as m; print("Portable imports OK:", len(list(m.distributions())))'],
                       check=True, cwd=app or root)
    else:
        # The same search path the Windows ._pth gives: the release root as well (site-packages is five levels down).
        (site / 'guiliu-home.pth').write_text('../../../../..\n', encoding='ascii')
        print('Mac runtime bundled; install_macos.sh checks the imports on the Mac.', flush=True)
    (root / 'RUNTIMES.json').write_text(json.dumps(records, indent=2) + '\n', encoding='utf-8')
    return records


def extract_windows(record, archive, root):
    target = root / 'runtime' / record['name']
    target.mkdir(parents=True)
    with zipfile.ZipFile(archive) as zipped:
        if record['name'] == 'python':
            for member in zipped.infolist():
                path = (target / member.filename).resolve()
                if not path.is_relative_to(target) or ':' in member.filename or '\\' in member.filename:
                    raise ValueError('Unsafe runtime archive')
            zipped.extractall(target)
            # The embedded interpreter ignores system Python, registry and PYTHONPATH.
            # Only the release root is shared; uvicorn adds its own service's app-dir.
            (target / 'python313._pth').write_text(
                'python313.zip\n.\nLib\\site-packages\n..\\..\nimport site\n', encoding='ascii')
            record['notice'] = 'runtime/python/LICENSE.txt'
            record['adaptations'] = ['App-local python313._pth search paths']
        else:
            prefix = 'node-v' + record['version'] + '-win-x64/'
            # The native frontend needs Node only, not npm or its dependency tree.
            for name in ('node.exe', 'LICENSE', 'README.md', 'CHANGELOG.md'):
                (target / name).write_bytes(zipped.read(prefix + name))
            record['notice'] = 'runtime/node/LICENSE'
            record['adaptations'] = ['Only Node executable and upstream notices; npm omitted']

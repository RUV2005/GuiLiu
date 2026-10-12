"""Bundle official app-local runtimes and the hash-locked Python dependencies."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import zipfile


def bundle_runtimes(downloads, root):
    downloads = Path(downloads).resolve()
    records = json.loads((downloads / 'RUNTIMES.json').read_text(encoding='utf-8'))
    if {r['name'] for r in records} != {'python', 'node'} or len(records) != 2:
        raise ValueError('Provide exactly one Python and one Node runtime')
    for record in records:
        archive = (downloads / record['file']).resolve()
        if not archive.is_relative_to(downloads) or hashlib.sha256(archive.read_bytes()).hexdigest() != record['sha256']:
            raise ValueError('Runtime checksum mismatch')
        target = root / 'runtime' / record['name']
        target.mkdir(parents=True)
        with zipfile.ZipFile(archive) as zipped:
            if record['name'] == 'python':
                if not record['version'].startswith('3.13.'):
                    raise ValueError('The dependency lock requires CPython 3.13')
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
        if not (root / record['notice']).is_file():
            raise ValueError('Missing runtime license')

    site = root / 'runtime/python/Lib/site-packages'
    subprocess.run([sys.executable, '-m', 'pip', '--isolated', 'install', '--no-index',
                    '--find-links', str(root / 'wheelhouse'), '--require-hashes', '--no-compile',
                    '--only-binary=:all:', '--target', str(site), '-r', str(root / 'requirements-offline.txt')],
                   check=True)
    # Entry-point executables contain absolute build paths. Services use python -m instead.
    scripts = site / 'bin'
    if scripts.is_dir():
        for path in scripts.iterdir():
            if not path.is_file() or path.is_symlink():
                raise ValueError('Unexpected dependency launcher directory')
            path.unlink()
        scripts.rmdir()
    python = root / 'runtime/python/python.exe'
    subprocess.run([str(python), '-B', '-c',
                    'import fastapi,uvicorn,sqlite3,psutil,lancedb,pyarrow,numpy,openai,PIL,primp,backend.system_control; '
                    'import importlib.metadata as m; print("Portable imports OK:", len(list(m.distributions())))'],
                   check=True, cwd=root)
    (root / 'RUNTIMES.json').write_text(json.dumps(records, indent=2) + '\n', encoding='utf-8')
    return records

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = '3.13.12';
const integrity = '1YBOJfRHV4sXUmWsFSf5rQor4Ss82G8dQWLRbnk3GA4jeP8hQt1hxXh0tmflpC0dz3VgEv/1+qwPyLeWkQuPFA==';
const url = `https://registry.npmjs.org/@tanstack/virtual-core/-/virtual-core-${version}.tgz`;
const files = ['dist/esm/index.js', 'dist/esm/utils.js', 'dist/esm/index.js.map', 'dist/esm/utils.js.map', 'LICENSE'];
const destination = fileURLToPath(new URL('../src/vendor/tanstack-virtual-core/', import.meta.url));
const temporaryRoot = resolve(tmpdir());
const work = await mkdtemp(join(temporaryRoot, 'abk-virtual-'));
try {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash('sha512').update(archive).digest('base64') !== integrity) throw new Error('Package checksum mismatch');
  const archivePath = join(work, 'package.tgz');
  await writeFile(archivePath, archive);
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:/Windows', 'System32/tar.exe') : 'tar';
  execFileSync(tar, ['-xzf', archivePath, '-C', work, ...files.map((file) => 'package/' + file)]);
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    const source = join(work, 'package', file);
    const target = join(destination, file.split('/').at(-1));
    if (file.endsWith('.js')) {
      const code = (await readFile(source, 'utf8')).replaceAll('process.env.NODE_ENV', '"production"');
      await writeFile(target, code);
    } else await copyFile(source, target);
  }
  console.log(`Vendored @tanstack/virtual-core ${version} (MIT), SHA-512 verified.`);
} finally {
  const location = relative(temporaryRoot, resolve(work));
  if (!isAbsolute(location) && !location.startsWith('..') && location.startsWith('abk-virtual-')) await rm(work, { recursive: true, force: true });
}

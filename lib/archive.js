import { createHash } from 'node:crypto';
import { readZip, writeZip } from './zip.js';

export const FORMAT = 'dsh-setting-backup/1';

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function buildArchive({ meta, configFiles, plugins }) {
  const manifest = { ...meta, format: meta.format || FORMAT };
  const body = [
    { relPath: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { relPath: 'plugins.json', data: Buffer.from(JSON.stringify(plugins || [], null, 2)) },
    ...(configFiles || []),
  ];
  const checksums = {};
  for (const file of body) checksums[file.relPath] = sha256(file.data);
  const entries = body.map((file) => ({ path: file.relPath, data: file.data }));
  entries.push({ path: 'checksums.json', data: Buffer.from(JSON.stringify(checksums, null, 2)) });
  return writeZip(entries);
}

export function parseArchive(buffer, { allowSensitive = false } = {}) {
  const entries = readZip(buffer);
  const byPath = new Map(entries.map((entry) => [entry.path, entry.data]));
  if (!byPath.has('manifest.json')) throw new Error('invalid archive: manifest.json missing');
  if (!byPath.has('checksums.json')) throw new Error('invalid archive: checksums.json missing');

  let manifest;
  try {
    manifest = JSON.parse(byPath.get('manifest.json').toString('utf8'));
  } catch {
    throw new Error('invalid archive: manifest.json is not json');
  }
  if (manifest.format !== FORMAT) throw new Error('unsupported format: ' + manifest.format);
  if (manifest.sensitive === true && !allowSensitive) {
    throw new Error('archive is sensitive (contains credentials); import requires explicit consent');
  }

  let checksums;
  try {
    checksums = JSON.parse(byPath.get('checksums.json').toString('utf8'));
  } catch {
    throw new Error('invalid archive: checksums.json is not json');
  }

  const files = [];
  for (const entry of entries) {
    if (entry.path === 'checksums.json') continue;
    const expected = checksums[entry.path];
    if (!expected) throw new Error('invalid archive: file not in checksums: ' + entry.path);
    if (sha256(entry.data) !== expected) throw new Error('checksum mismatch: ' + entry.path);
    if (entry.path !== 'manifest.json' && entry.path !== 'plugins.json') {
      files.push({ relPath: entry.path, data: entry.data });
    }
  }

  let plugins;
  try {
    plugins = JSON.parse(byPath.get('plugins.json').toString('utf8'));
  } catch {
    throw new Error('invalid archive: plugins.json is not json');
  }
  if (!Array.isArray(plugins)) throw new Error('invalid archive: plugins.json must be an array');
  return { manifest, plugins, files };
}

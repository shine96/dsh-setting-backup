import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArchive, parseArchive } from '../lib/archive.js';

const meta = {
  format: 'dsh-setting-backup/1',
  createdAt: '2026-11-09T16:00:00+08:00',
  profile: 'desktop',
  dshVersion: '0.2.2-rc.1',
  platform: 'win32',
  sensitive: false,
};
const configFiles = [
  { relPath: 'config/profile/package.json', data: Buffer.from('{"name":"p"}') },
  { relPath: 'config/home/settings.yaml', data: Buffer.from('llm: 1\n') },
];
const plugins = [{
  name: 'dsh-a', version: '1.2.3', declared: '1.2.3', role: 'bundle',
  source: 'registry', installSpec: 'dsh-a@1.2.3', installed: true,
}];

test('打包后解析还原出 manifest / plugins / files', () => {
  const zip = buildArchive({ meta, configFiles, plugins });
  const parsed = parseArchive(zip, { allowSensitive: false });
  assert.equal(parsed.manifest.format, 'dsh-setting-backup/1');
  assert.equal(parsed.plugins.length, 1);
  assert.equal(parsed.plugins[0].version, '1.2.3');
  assert.equal(parsed.files.length, 2);
});

test('校验和对不上时拒绝', () => {
  const bad = Buffer.from(buildArchive({ meta, configFiles, plugins }));
  const idx = bad.indexOf(Buffer.from('{"name":"p"}'));
  assert.ok(idx > 0, 'fixture 内容应存在于 zip 内');
  bad[idx] = 'X'.charCodeAt(0);
  assert.throws(() => parseArchive(bad, { allowSensitive: false }), /checksum/);
});

test('不认识的 format 被拒绝', () => {
  const zip = buildArchive({ meta: { ...meta, format: 'dsh-setting-backup/9' }, configFiles, plugins });
  assert.throws(() => parseArchive(zip, { allowSensitive: false }), /unsupported format/);
});

test('敏感包默认拒绝导入', () => {
  const zip = buildArchive({ meta: { ...meta, sensitive: true }, configFiles, plugins });
  assert.throws(() => parseArchive(zip, { allowSensitive: false }), /sensitive/);
  assert.doesNotThrow(() => parseArchive(zip, { allowSensitive: true }));
});

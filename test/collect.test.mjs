import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectConfig, collectPlugins, classifySource } from '../lib/collect.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsbk-home-'));
  const profileDir = join(home, 'profiles', 'desktop');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(home, 'settings.yaml'), 'llm: 1\n');
  writeFileSync(join(home, '.credentials.yaml'), 'secret: 1\n');
  writeFileSync(join(home, 'restart-now.config.json'), '{"a":1}');
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'p',
    dependencies: { 'dsh-a': '1.2.3', 'dsh-local': 'link:../local' },
    dsh: { profile: { bundles: ['dsh-a'] } },
  }));
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: x\n');
  mkdirSync(join(profileDir, 'node_modules', 'dsh-a'), { recursive: true });
  writeFileSync(join(profileDir, 'node_modules', 'dsh-a', 'package.json'), '{"version":"1.2.3"}');
  return { home, profileDir };
}

test('collectConfig 默认不含凭据', async () => {
  const { home, profileDir } = fixture();
  const files = await collectConfig({ home, profileDir, includeSensitive: false });
  const rels = files.map((f) => f.relPath);
  assert.ok(rels.includes('config/home/settings.yaml'));
  assert.ok(rels.includes('config/profile/cordis.patch.yml'));
  assert.ok(!rels.includes('config/home/.credentials.yaml'));
});

test('collectConfig 勾选后包含凭据', async () => {
  const { home, profileDir } = fixture();
  const files = await collectConfig({ home, profileDir, includeSensitive: true });
  assert.ok(files.some((f) => f.relPath === 'config/home/.credentials.yaml'));
});

test('collectPlugins 读实装版本并标注来源', async () => {
  const { profileDir } = fixture();
  const list = await collectPlugins({ profileDir });
  const a = list.find((p) => p.name === 'dsh-a');
  assert.equal(a.version, '1.2.3');
  assert.equal(a.role, 'bundle');
  assert.equal(a.source, 'registry');
  assert.equal(a.installSpec, 'dsh-a@1.2.3');
  const local = list.find((p) => p.name === 'dsh-local');
  assert.equal(local.source, 'link');
  assert.equal(local.installed, false);
});

test('classifySource 覆盖各来源', () => {
  assert.equal(classifySource('1.2.3'), 'registry');
  assert.equal(classifySource('^1.2.3'), 'registry');
  assert.equal(classifySource('link:../x'), 'link');
  assert.equal(classifySource('file:./x.tgz'), 'file');
  assert.equal(classifySource('github:user/repo'), 'github');
  assert.equal(classifySource('git+https://github.com/u/r.git'), 'github');
  assert.equal(classifySource('https://x/y.tgz'), 'tarball');
});

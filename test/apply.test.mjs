import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { commitConfig } from '../lib/apply.js';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'dsbk-apply-'));
  const profileDir = join(home, 'profiles', 'desktop');
  mkdirSync(join(profileDir, 'node_modules', 'dsh-a'), { recursive: true });
  writeFileSync(join(profileDir, 'node_modules', 'dsh-a', 'package.json'), '{"name":"dsh-a"}');
  writeFileSync(join(profileDir, 'cordis.patch.yml'), 'old\n');
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: [] } } }));
  writeFileSync(join(home, 'settings.yaml'), 'old-settings\n');
  return { home, profileDir };
}

test('成功提交：写 bak、覆盖配置、写 bundles，home 配置回到 home', async () => {
  const { home, profileDir } = setup();
  const files = [
    { relPath: 'config/profile/cordis.patch.yml', data: Buffer.from('new\n') },
    { relPath: 'config/home/settings.yaml', data: Buffer.from('new-settings\n') },
    { relPath: 'config/profile/package.json', data: Buffer.from(JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['dsh-a'] } } })) },
  ];
  const out = await commitConfig({ home, profileDir, files, bundles: ['dsh-a'], stamp: '20260101-000000' });
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), 'new\n');
  assert.equal(readFileSync(join(home, 'settings.yaml'), 'utf8'), 'new-settings\n');
  assert.ok(existsSync(join(profileDir, 'cordis.patch.yml.bak-20260101-000000')));
  assert.deepEqual(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles, ['dsh-a']);
  assert.equal(out.rolledBack, false);
});

test('守卫失败：不写任何文件并回滚', async () => {
  const { home, profileDir } = setup();
  const files = [{ relPath: 'config/profile/cordis.patch.yml', data: Buffer.from('new\n') }];
  await assert.rejects(
    () => commitConfig({ home, profileDir, files, bundles: ['dsh-a', 'dsh-missing'], stamp: 'x' }),
    /bundle guard failed: dsh-missing/,
  );
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), 'old\n');
  assert.equal(readFileSync(join(home, 'settings.yaml'), 'utf8'), 'old-settings\n');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSnapshot, listSnapshots, rotateSnapshots, restoreSnapshot } from '../lib/snapshots.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsbk-snap-'));
  const profileDir = join(home, 'profiles', 'desktop');
  mkdirSync(profileDir, { recursive: true });
  return { home, profileDir };
}

test('快照保存并可恢复（home 与 profile 两种前缀都按原位还原）', () => {
  const { home, profileDir } = fixture();
  const homeFile = join(home, 'settings.yaml');
  const profileFile = join(profileDir, 'cordis.patch.yml');
  writeFileSync(homeFile, 'home-v1');
  writeFileSync(profileFile, 'profile-v1');
  const files = [
    { absPath: homeFile, relPath: 'config/home/settings.yaml' },
    { absPath: profileFile, relPath: 'config/profile/cordis.patch.yml' },
  ];
  const snap = createSnapshot({ profileDir, files, keep: 5 });
  assert.ok(existsSync(join(snap.dir, 'config/home/settings.yaml')));

  writeFileSync(homeFile, 'home-v2');
  writeFileSync(profileFile, 'profile-v2');

  restoreSnapshot({ home, profileDir, stamp: snap.stamp });
  assert.equal(readFileSync(homeFile, 'utf8'), 'home-v1');
  assert.equal(readFileSync(profileFile, 'utf8'), 'profile-v1');
});

test('轮转只保留 N 份，删除最旧', () => {
  const { home, profileDir } = fixture();
  const target = join(home, 'x.json');
  writeFileSync(target, 'x');
  const files = [{ absPath: target, relPath: 'config/home/x.json' }];
  for (const stamp of ['20260101-000001', '20260101-000002', '20260101-000003']) {
    mkdirSync(join(profileDir, '.setting-backup', 'snapshots', stamp), { recursive: true });
    writeFileSync(join(profileDir, '.setting-backup', 'snapshots', stamp, 'x.json'), stamp);
  }
  const removed = rotateSnapshots(profileDir, 2);
  assert.equal(removed.length, 1);
  assert.equal(removed[0], '20260101-000001');
  assert.equal(listSnapshots(profileDir).length, 2);
});

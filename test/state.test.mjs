import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { transition, readState, writeState, clearState } from '../lib/state.js';

test('合法跳转链路', () => {
  assert.equal(transition('idle', 'staged'), 'staged');
  assert.equal(transition('staged', 'installing'), 'installing');
  assert.equal(transition('installing', 'installed'), 'installed');
  assert.equal(transition('installed', 'configured'), 'configured');
  assert.equal(transition('configured', 'done'), 'done');
  assert.equal(transition('installing', 'failed'), 'failed');
  assert.equal(transition('failed', 'installing'), 'installing');
});

test('非法跳转被拒绝', () => {
  assert.throws(() => transition('staged', 'configured'), /illegal transition/);
  assert.throws(() => transition('staged', 'installed'), /illegal transition/);
  assert.throws(() => transition('done', 'installing'), /illegal transition/);
});

test('读写与清理状态文件', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsbk-state-'));
  assert.equal(readState(profileDir), null);
  const written = writeState(profileDir, { state: 'staged', id: 'x1' });
  assert.equal(written.state, 'staged');
  const merged = writeState(profileDir, { state: 'installing' });
  assert.equal(merged.id, 'x1');
  assert.equal(readState(profileDir).state, 'installing');
  clearState(profileDir);
  assert.equal(readState(profileDir), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computePlan, assertBundlesResolvable, readBundleList } from '../lib/plan.js';

const backup = [
  { name: 'dsh-a', version: '1.2.3', source: 'registry', role: 'bundle', installSpec: 'dsh-a@1.2.3' },
  { name: 'dsh-b', version: '2.0.0', source: 'registry', role: 'bundle', installSpec: 'dsh-b@2.0.0' },
  { name: 'dsh-local', version: '0.0.0', source: 'link', role: 'dependency', installSpec: 'link:../x' },
];

test('缺失与版本不符被正确分类', () => {
  const installed = [
    { name: 'dsh-a', version: '1.0.0', source: 'registry' },
    { name: 'dsh-x', version: '9.9.9', source: 'registry' },
  ];
  const plan = computePlan({ backupPlugins: backup, installed });
  assert.deepEqual(plan.missing.map((p) => p.name), ['dsh-b']);
  assert.deepEqual(plan.versionMismatch.map((p) => p.name), ['dsh-a']);
  assert.deepEqual(plan.localWarn.map((p) => p.name), ['dsh-local']);
  assert.deepEqual(plan.extraLocal.map((p) => p.name), ['dsh-x']);
  assert.equal(plan.canInstall, true);
  assert.equal(plan.canApply, false);
});

test('本地来源不阻塞安装但要求确认', () => {
  const plan = computePlan({ backupPlugins: backup, installed: [] });
  assert.equal(plan.localWarn.length, 1);
  assert.equal(plan.canInstall, true);
});

test('全部就位时才 canApply', () => {
  const installed = [
    { name: 'dsh-a', version: '1.2.3', source: 'registry' },
    { name: 'dsh-b', version: '2.0.0', source: 'registry' },
  ];
  const plan = computePlan({ backupPlugins: backup, installed });
  assert.equal(plan.missing.length, 0);
  assert.equal(plan.versionMismatch.length, 0);
  assert.equal(plan.canApply, true);
});

test('bundles 守卫拦住不可解析的包', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsbk-plan-'));
  mkdirSync(join(profileDir, 'node_modules', 'dsh-a'), { recursive: true });
  writeFileSync(join(profileDir, 'node_modules', 'dsh-a', 'package.json'), '{"name":"dsh-a"}');
  const ok = assertBundlesResolvable(profileDir, ['dsh-a']);
  assert.equal(ok.ok, true);
  const bad = assertBundlesResolvable(profileDir, ['dsh-a', 'dsh-missing']);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unresolvable, ['dsh-missing']);
});

test('宿主托管的 @deepseek-ai/dsh-* 即使不在 node_modules 也放行', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsbk-plan-'));
  const bundles = [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-experimental-auto-review',
    '@deepseek-ai/dsh-setting-backup',
  ];
  const result = assertBundlesResolvable(profileDir, bundles);
  assert.equal(result.ok, true, '宿主托管 bundle 不应被误判为缺失');
  assert.deepEqual(result.unresolvable, []);
});

test('普通来源缺失仍被拦，宿主托管豁免不掩盖真实缺失', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsbk-plan-'));
  const result = assertBundlesResolvable(profileDir, ['@deepseek-ai/dsh-base', 'dsh-ghost']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unresolvable, ['dsh-ghost']);
});

test('readBundleList 读 dsh.profile.bundles', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsbk-plan-'));
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['a', 'b'] } } }));
  assert.deepEqual(await readBundleList(profileDir), ['a', 'b']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAddArgs, installPlugins, resolveDshCli } from '../lib/install.js';

function fakeSpawn(table) {
  const calls = [];
  const impl = (cmd, args) => {
    calls.push([cmd].concat(args));
    const spec = args[args.length - 1];
    const code = table[spec] === undefined ? 0 : table[spec];
    return {
      on: (event, cb) => {
        if (event === 'close') setTimeout(() => cb(code, '', code === 0 ? '' : 'boom'), 0);
      },
      kill: () => {},
    };
  };
  impl.calls = calls;
  return impl;
}

test('buildAddArgs 结构与官方 entry 一致', () => {
  assert.deepEqual(
    buildAddArgs({ profile: 'desktop', spec: 'dsh-a@1.2.3' }),
    ['plugin', '--profile', 'desktop', 'add', 'dsh-a@1.2.3'],
  );
});

test('resolveDshCli 支持环境覆盖', () => {
  assert.equal(resolveDshCli({ DSH_CLI: '/usr/bin/dsh' }), '/usr/bin/dsh');
  assert.equal(resolveDshCli({}), 'dsh');
});

test('逐个安装并记录失败，失败不中断其余', async () => {
  const spawnImpl = fakeSpawn({ 'dsh-b@2.0.0': 1 });
  const plan = {
    missing: [
      { name: 'dsh-a', version: '1.2.3', installSpec: 'dsh-a@1.2.3' },
      { name: 'dsh-b', version: '2.0.0', installSpec: 'dsh-b@2.0.0' },
      { name: 'dsh-c', version: '3.0.0', installSpec: 'dsh-c@3.0.0' },
    ],
  };
  const progress = [];
  const out = await installPlugins({
    profile: 'desktop',
    plan,
    spawnImpl,
    onProgress: (record, index, total) => progress.push([record.name, index, total]),
  });
  assert.equal(out.okCount, 2);
  assert.equal(out.failedCount, 1);
  assert.equal(out.results.find((r) => r.name === 'dsh-b').ok, false);
  assert.equal(spawnImpl.calls.length, 3);
  assert.deepEqual(progress.map((p) => p[0]), ['dsh-a', 'dsh-b', 'dsh-c']);
  assert.equal(progress[0][2], 3);
});

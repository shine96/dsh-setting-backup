import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, name } from '../lib/index.js';

test('插件导出 name 与 apply', () => {
  assert.equal(name, 'dsh-setting-backup');
  assert.equal(typeof apply, 'function');
});

test('apply 注册全部接口，且 dispose 时全部撤销', () => {
  const routes = new Map();
  let disposeOuter = null;
  const hostCtx = {
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler);
        return () => routes.delete(path);
      },
    },
    effect(fn) {
      disposeOuter = fn();
      return () => {};
    },
  };
  const fakeCtx = {
    inject(deps, fn) {
      fn(hostCtx);
    },
  };
  apply(fakeCtx, {});

  const expected = [
    '/plugins/dsh-setting-backup/status',
    '/plugins/dsh-setting-backup/export',
    '/plugins/dsh-setting-backup/download',
    '/plugins/dsh-setting-backup/preview',
    '/plugins/dsh-setting-backup/import',
    '/plugins/dsh-setting-backup/install',
    '/plugins/dsh-setting-backup/commit',
    '/plugins/dsh-setting-backup/rollback',
    '/plugins/dsh-setting-backup/done',
    '/plugins/dsh-setting-backup/restore-snapshot',
    '/plugins/dsh-setting-backup/delete-snapshot',
  ];
  assert.equal(routes.size, expected.length);
  for (const path of expected) assert.ok(routes.has(path), '缺少路由 ' + path);

  assert.equal(typeof disposeOuter, 'function');
  disposeOuter();
  assert.equal(routes.size, 0, 'dispose 后不应残留路由');
});

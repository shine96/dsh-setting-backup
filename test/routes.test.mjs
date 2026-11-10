import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHandlers, rejectNonLocal } from '../lib/routes.js';
import { buildArchive } from '../lib/archive.js';

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(body) {
      this.body = body || '';
    },
  };
}

function makeReq(method, body, url) {
  return {
    method,
    url: url || '/',
    headers: {},
    [Symbol.asyncIterator]: function* iterator() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsbk-orch-'));
  const profileDir = join(home, 'profiles', 'desktop');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(home, 'settings.yaml'), 'current: 1\n');
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } }));
  writeFileSync(join(profileDir, 'cordis.patch.yml'), 'current\n');
  return { home, profileDir };
}

function handlersFor({ home, profileDir }, extra = {}) {
  return buildHandlers({
    deps: {
      ctx: null,
      home,
      resolveProfileDir: () => profileDir,
      resolveProfileName: () => 'desktop',
      ...extra,
    },
  });
}

test('拒绝非本机 origin', () => {
  assert.equal(rejectNonLocal({ headers: { origin: 'https://evil.example' } }), true);
  assert.equal(rejectNonLocal({ headers: { origin: 'http://127.0.0.1:50279' } }), false);
  assert.equal(rejectNonLocal({ headers: {} }), false);
});

test('status 无状态时返回 idle', async () => {
  const { home, profileDir } = fixture();
  const res = fakeRes();
  await handlersFor({ home, profileDir }).status(makeReq('GET'), res);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.state.state, 'idle');
  assert.equal(payload.profile, 'desktop');
});

test('非法 method 返回 405', async () => {
  const { home, profileDir } = fixture();
  const res = fakeRes();
  await handlersFor({ home, profileDir }).status(makeReq('POST'), res);
  assert.equal(res.status, 405);
});

test('导出产生 zip 且清单带版本', async () => {
  const { home, profileDir } = fixture();
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'p',
    dependencies: { 'dsh-a': '1.2.3' },
    dsh: { profile: { bundles: ['dsh-a'] } },
  }));
  mkdirSync(join(profileDir, 'node_modules', 'dsh-a'), { recursive: true });
  writeFileSync(join(profileDir, 'node_modules', 'dsh-a', 'package.json'), '{"version":"1.2.3"}');

  const res = fakeRes();
  await handlersFor({ home, profileDir }).exportArchive(makeReq('POST', {}), res);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.ok(payload.bytes > 0);
  assert.match(
    payload.file,
    /dsh-setting-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip$/,
    '导出文件名应为本地时间且不含 ISO 的 T 分隔符',
  );
  // 导出包是用户资产：不能落在 profile 目录里，否则 profile 重建时会被清掉
  assert.equal(dirname(payload.file), join(home, 'setting-backup', 'exports'));
  const zip = readFileSync(payload.file);
  const { parseArchive } = await import('../lib/archive.js');
  const parsed = parseArchive(zip, { allowSensitive: false });
  assert.equal(parsed.plugins[0].version, '1.2.3');
  assert.ok(parsed.files.some((f) => f.relPath === 'config/profile/package.json'));
  assert.ok(!parsed.files.some((f) => f.relPath === 'config/home/.credentials.yaml'));
});

test('导入只覆盖 settings.yaml，不动 profile 配置，并进入 staged', async () => {
  const { home, profileDir } = fixture();
  const archive = buildArchive({
    meta: { format: 'dsh-setting-backup/1', createdAt: '2026-11-09T00:00:00Z', profile: 'desktop', dshVersion: 'x', platform: 'win32', sensitive: false },
    configFiles: [
      { relPath: 'config/profile/cordis.patch.yml', data: Buffer.from('backup\n') },
      { relPath: 'config/home/settings.yaml', data: Buffer.from('backup-settings: 1\n') },
    ],
    plugins: [],
  });
  const res = fakeRes();
  await handlersFor({ home, profileDir }).importArchive(makeReq('POST', { zipBase64: archive.toString('base64') }), res);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.state.state, 'staged');
  assert.equal(readFileSync(join(home, 'settings.yaml'), 'utf8'), 'backup-settings: 1\n');
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), 'current\n');
});

function waitFor(check, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let verdict;
      try {
        verdict = check();
      } catch (error) {
        reject(error);
        return;
      }
      if (verdict) return resolve(verdict);
      if (Date.now() - started > timeoutMs) {
        reject(new Error('waitFor timeout'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('done 状态下再次导入不会被非法跳转拦住', async () => {
  const { home, profileDir } = fixture();
  const { writeState, readState } = await import('../lib/state.js');
  writeState(profileDir, { state: 'staged', id: 'x', staged: join(profileDir, '.setting-backup', 'staged', 'x'), plan: {} });
  writeState(profileDir, { state: 'installing' });
  writeState(profileDir, { state: 'installed' });
  writeState(profileDir, { state: 'configured' });
  writeState(profileDir, { state: 'done' });
  assert.equal(readState(profileDir).state, 'done');

  const archive = buildArchive({
    meta: { format: 'dsh-setting-backup/1', createdAt: '2026-11-09T00:00:00Z', profile: 'desktop', dshVersion: 'x', platform: 'win32', sensitive: false },
    configFiles: [{ relPath: 'config/home/settings.yaml', data: Buffer.from('again: 1\n') }],
    plugins: [],
  });
  const res = fakeRes();
  await handlersFor({ home, profileDir }).importArchive(makeReq('POST', { zipBase64: archive.toString('base64') }), res);
  assert.equal(res.status, 200, 'done 状态下必须能再次导入');
  assert.equal(JSON.parse(res.body).state.state, 'staged');
});

test('download 接口按文件名取回导出包，并拒绝越界文件名', async () => {
  const { home, profileDir } = fixture();
  const handlers = handlersFor({ home, profileDir });

  const exportRes = fakeRes();
  await handlers.exportArchive(makeReq('POST', {}), exportRes);
  const exported = JSON.parse(exportRes.body);
  assert.ok(exported.name, '导出结果需要带文件名，供另存为使用');
  assert.equal(exported.name, exported.file.split(/[\\/]/).pop());

  const okRes = fakeRes();
  await handlers.download(makeReq('GET', undefined, '/plugins/dsh-setting-backup/download?name=' + encodeURIComponent(exported.name)), okRes);
  assert.equal(okRes.status, 200);
  assert.equal(okRes.headers['content-type'], 'application/zip');
  assert.ok(okRes.body && okRes.body.length > 0, '应返回 zip 字节');

  for (const bad of ['../package.json', 'C:/Windows/win.ini', '..', 'a/../b.zip']) {
    const res = fakeRes();
    await handlers.download(makeReq('GET', undefined, '/x?name=' + encodeURIComponent(bad)), res);
    assert.equal(res.status, 400, '应拒绝非法文件名: ' + bad);
  }

  const missing = fakeRes();
  await handlers.download(makeReq('GET', undefined, '/x?name=nope.zip'), missing);
  assert.equal(missing.status, 404);
});

test('preview 能解析敏感包并只返回元数据，不落盘也不泄露内容', async () => {
  const { home, profileDir } = fixture();
  const archive = buildArchive({
    meta: { format: 'dsh-setting-backup/1', createdAt: '2026-11-09T00:00:00Z', profile: 'desktop', dshVersion: 'x', platform: 'win32', sensitive: true },
    configFiles: [
      { relPath: 'config/home/settings.yaml', data: Buffer.from('llm: 1\n') },
      { relPath: 'config/home/.credentials.yaml', data: Buffer.from('SECRET-TOKEN-VALUE\n') },
    ],
    plugins: [],
  });
  const res = fakeRes();
  await handlersFor({ home, profileDir }).preview(makeReq('POST', { zipBase64: archive.toString('base64') }), res);
  const payload = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.manifest.sensitive, true);
  assert.ok(payload.files.some((f) => f.relPath === 'config/home/.credentials.yaml'));
  assert.match(payload.manifest.createdAtLabel, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, '导出时间应转成本地时间显示');
  assert.ok(!res.body.includes('SECRET-TOKEN-VALUE'), '预检不得回传凭据内容');
  assert.equal(
    existsSync(join(profileDir, '.setting-backup', 'staged')),
    false,
    '预检不得落盘',
  );
  assert.equal(readFileSync(join(home, 'settings.yaml'), 'utf8'), 'current: 1\n', '预检不得覆盖配置');
});

test('preview 对不敏感包返回敏感标记 false', async () => {
  const { home, profileDir } = fixture();
  const archive = buildArchive({
    meta: { format: 'dsh-setting-backup/1', createdAt: '2026-11-09T00:00:00Z', profile: 'desktop', dshVersion: 'x', platform: 'win32', sensitive: false },
    configFiles: [{ relPath: 'config/home/settings.yaml', data: Buffer.from('a: 1\n') }],
    plugins: [],
  });
  const res = fakeRes();
  await handlersFor({ home, profileDir }).preview(makeReq('POST', { zipBase64: archive.toString('base64') }), res);
  assert.equal(JSON.parse(res.body).manifest.sensitive, false);
});

test('import 在未显式同意时拒绝敏感包（安全边界不变）', async () => {
  const { home, profileDir } = fixture();
  const archive = buildArchive({
    meta: { format: 'dsh-setting-backup/1', createdAt: '2026-11-09T00:00:00Z', profile: 'desktop', dshVersion: 'x', platform: 'win32', sensitive: true },
    configFiles: [{ relPath: 'config/home/settings.yaml', data: Buffer.from('a: 1\n') }],
    plugins: [],
  });
  const res = fakeRes();
  await handlersFor({ home, profileDir }).importArchive(makeReq('POST', { zipBase64: archive.toString('base64') }), res);
  assert.equal(res.status, 400);
  assert.match(res.body, /sensitive/);

  const agreed = fakeRes();
  await handlersFor({ home, profileDir }).importArchive(
    makeReq('POST', { zipBase64: archive.toString('base64'), allowSensitive: true }),
    agreed,
  );
  assert.equal(agreed.status, 200, '显式同意后应允许导入');
});

test('install 在非 staged 状态返回 409', async () => {
  const { home, profileDir } = fixture();
  const res = fakeRes();
  await handlersFor({ home, profileDir }).install(makeReq('POST', {}), res);
  assert.equal(res.status, 409);
});

test('install 在 failed 状态可重试（不被 409 拦住）', async () => {
  const { home, profileDir } = fixture();
  const handlers = handlersFor({ home, profileDir }, {
    installPlugins: async () => ({ results: [], okCount: 0, failedCount: 0 }),
  });
  const { writeState } = await import('../lib/state.js');
  writeState(profileDir, { state: 'staged', id: 'x', staged: join(profileDir, '.setting-backup', 'staged', 'x'), plan: {} });
  writeState(profileDir, { state: 'installing' });
  writeState(profileDir, { state: 'failed' });

  const res = fakeRes();
  await handlers.install(makeReq('POST', {}), res);
  assert.notEqual(res.status, 409, 'failed 状态必须允许重试');
  assert.equal(JSON.parse(res.body).ok, true);
  await waitFor(async () => true);
});

test('commit 在非 configured 状态返回 409', async () => {
  const { home, profileDir } = fixture();
  const res = fakeRes();
  await handlersFor({ home, profileDir }).commit(makeReq('POST', {}), res);
  assert.equal(res.status, 409);
});

test('完整链路：import → install → commit → done-ready', async () => {
  const { home, profileDir } = fixture();
  // 模拟“本机已装齐”：package.json 已声明 dsh-a，且 node_modules 里有实装版本
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'p',
    dependencies: { 'dsh-a': '1.2.3' },
    dsh: { profile: { bundles: ['dsh-a'] } },
  }));
  mkdirSync(join(profileDir, 'node_modules', 'dsh-a'), { recursive: true });
  writeFileSync(join(profileDir, 'node_modules', 'dsh-a', 'package.json'), '{"name":"dsh-a","version":"1.2.3"}');
  const archive = buildArchive({
    meta: { format: 'dsh-setting-backup/1', createdAt: '2026-11-09T00:00:00Z', profile: 'desktop', dshVersion: 'x', platform: 'win32', sensitive: false },
    configFiles: [
      { relPath: 'config/profile/cordis.patch.yml', data: Buffer.from('restored\n') },
      { relPath: 'config/profile/package.json', data: Buffer.from(JSON.stringify({ name: 'p', dependencies: { 'dsh-a': '1.2.3' }, dsh: { profile: { bundles: ['dsh-a'] } } })) },
    ],
    plugins: [{ name: 'dsh-a', version: '1.2.3', declared: '1.2.3', role: 'bundle', source: 'registry', installSpec: 'dsh-a@1.2.3', installed: true }],
  });

  const handlers = handlersFor({ home, profileDir }, {});
  const resImport = fakeRes();
  await handlers.importArchive(makeReq('POST', { zipBase64: archive.toString('base64') }), resImport);
  assert.equal(JSON.parse(resImport.body).state.state, 'staged');

  // install 是后台任务：立即返回 202，随后状态推进到 installed
  const { readState } = await import('../lib/state.js');
  const resInstall = fakeRes();
  await handlers.install(makeReq('POST', {}), resInstall);
  assert.equal(resInstall.status, 202, 'install 必须立即返回，不能同步等待 pnpm');
  const installedState = await waitFor(() => {
    const current = readState(profileDir);
    return current && current.state === 'installed' ? current : null;
  });
  assert.equal(installedState.state, 'installed');
  assert.deepEqual(installedState.installResults, [], 'dsh-a 已存在，无需实际安装');

  const resCommit = fakeRes();
  await handlers.commit(makeReq('POST', {}), resCommit);
  const commitPayload = JSON.parse(resCommit.body);
  assert.equal(commitPayload.ok, true);
  assert.equal(commitPayload.restartRequired, true);
  assert.equal(readState(profileDir).state, 'configured');
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), 'restored\n');
  assert.deepEqual(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles, ['dsh-a']);
});

test('commit 被 bundles 守卫拦住时返回 400 且不改文件', async () => {
  const { home, profileDir } = fixture();
  const archive = buildArchive({
    meta: { format: 'dsh-setting-backup/1', createdAt: '2026-11-09T00:00:00Z', profile: 'desktop', dshVersion: 'x', platform: 'win32', sensitive: false },
    configFiles: [
      { relPath: 'config/profile/cordis.patch.yml', data: Buffer.from('restored\n') },
      { relPath: 'config/profile/package.json', data: Buffer.from(JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: ['dsh-ghost'] } } })) },
    ],
    plugins: [],
  });
  const handlers = handlersFor({ home, profileDir }, {
    installPlugins: async () => ({ results: [], okCount: 0, failedCount: 0 }),
  });
  await handlers.importArchive(makeReq('POST', { zipBase64: archive.toString('base64') }), fakeRes());
  const { readState } = await import('../lib/state.js');
  await handlers.install(makeReq('POST', {}), fakeRes());
  await waitFor(() => {
    const current = readState(profileDir);
    return current && current.state === 'installed' ? current : null;
  });
  const res = fakeRes();
  await handlers.commit(makeReq('POST', {}), res);
  assert.equal(res.status, 400);
  assert.match(res.body, /bundle guard failed: dsh-ghost/);
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), 'current\n');
});

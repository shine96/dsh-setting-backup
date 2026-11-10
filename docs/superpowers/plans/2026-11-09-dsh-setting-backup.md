# dsh-setting-backup 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个带左侧栏入口的 DSH 插件，支持导出配置与插件清单为 ZIP、覆盖式导入还原，并按「导入 → 重启① → 自动安装 → 重启② → 恢复工作台」两段式完成还原。

**Architecture:** 宿主侧（`index.js` + `lib/*.js`）负责收集配置、打包 ZIP、计算差异、调用官方 `dsh plugin add` 安装插件、提交配置并回滚；客户端侧（`lib/client.js`）只做侧栏入口、页面与进度展示。状态机落在 `<profile>/.setting-backup/pending-restore.json`，第一段绝不写 `bundles`，避免启动期 `cannot resolve` 拒绝启动。

**Tech Stack:** Node 20+ ESM、零运行时依赖（ZIP 用 `node:zlib` 自实现）、DSH 插件契约（`dsh.bundle.patch` + `dsh.client` + `ctx.inject(['webServer'])` + `slots.inject`）、`node --test`。

**Spec:** `docs/superpowers/specs/2026-11-09-dsh-setting-backup-design.md`

## Global Constraints

- 插件包名 `dsh-setting-backup`，客户端入口 `exports["./client"] = "./lib/client.js"`。
- 宿主入口 `main: "lib/index.js"`，必须 `export const name` 与 `export function apply(ctx, config)`。
- 客户端必须 `window.__ModuleLoader__.load({ id, factory })`，工厂返回 `{ name, inject: ['slots'], apply }`。
- 侧栏入口成对注册：`sidebar.panellist` + `main`，两者缺一会导致 `selectPanel` 抛错。
- **绝不**在第一段（`staged` 状态）写入 profile 的 `package.json` / `cordis.patch.yml` / `cordis.yml` / `pnpm-*.yaml`。
- 写 `bundles` 前必须逐条 resolve 校验，任何一条失败即中止并回滚。
- 插件安装走 `dsh plugin --profile <name> add <spec>`，spec 为精确版本。
- 默认不导出 `.credentials.yaml`、`.env`；勾选后才导出并标 `sensitive`。
- ZIP 解包拒绝绝对路径、`..`、盘符、符号链接条目。
- 运行时零第三方依赖（`peerDependencies` 仅 `@deepseek-ai/cordis`，可选）。
- 测试统一 `node --test test/*.test.mjs`。

---

### Task 0: 仓库初始化与骨架

**Files:**
- Create: `.gitignore`, `package.json`, `cordis.patch.yml`, `icon.svg`, `README.md`
- Create: `lib/index.js`（先只注册一个探测路由）
- Create: `lib/client.js`（先只注册 `sidebar.panellist` + `main` 占位）

**Interfaces:**
- Consumes: 无
- Produces: 可被 `dsh plugin add <本地目录>` 链接加载的插件骨架；`lib/index.js` 导出 `name`、`apply`；`lib/client.js` 导出 `name`、`inject`、`apply`。

- [ ] **Step 1: 初始化 git 与目录**

```bash
cd "D:/code/dsh-plugins/dsh-setting-backup"
git init
printf '%s\n' 'node_modules/' '.setting-backup/' '*.log' > .gitignore
mkdir -p lib test
```

- [ ] **Step 2: 写 `package.json`**

```json
{
  "name": "dsh-setting-backup",
  "version": "0.1.0",
  "type": "module",
  "description": "Back up, export and restore DeepSeek Harness settings together with the installed plugin list, as one zip.",
  "license": "MIT",
  "icon": "./icon.svg",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "icon.svg", "README.md"],
  "scripts": {
    "test": "node --test test/*.test.mjs"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": [] }
  },
  "engines": { "dsh": ">=0.2.0-0", "node": ">=20" }
}
```

- [ ] **Step 3: 写 `cordis.patch.yml` 与 `icon.svg`**

`cordis.patch.yml`：

```yaml
- insert:
    - id: setting-backup
      name: dsh-setting-backup
```

`icon.svg`（16×16 网格、`currentColor`，与官方图标同规格）：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1">
  <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h2.2l1 1.2H12A1.5 1.5 0 0 1 13.5 6.7v4.8A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5z"/>
  <path d="M8 7.6v3.1M6.5 9.1 8 10.6l1.5-1.5"/>
</svg>
```

- [ ] **Step 4: 写最小 `lib/index.js`**

```js
export const name = 'dsh-setting-backup';

export function apply(ctx) {
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const dispose = hostCtx.webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-setting-backup/ping',
        handler: (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET' });
            return res.end();
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, name: 'dsh-setting-backup' }));
        },
      });
      return () => dispose();
    }, 'dsh-setting-backup: routes');
  });
}
```

- [ ] **Step 5: 写最小 `lib/client.js`**

```js
window.__ModuleLoader__.load({
  id: 'dsh-setting-backup',
  factory: (require) => {
    var module = { exports: {} };
    var React = require('react');

    function Panel() {
      return React.createElement('div', { className: 'dsbk-root' }, '配置备份与恢复');
    }
    function Glyph() {
      return React.createElement('span', { className: 'dsbk-glyph' }, '备');
    }

    var name = 'dsh-setting-backup';
    module.exports.name = name;
    module.exports.inject = ['slots'];
    module.exports.apply = function (ctx) {
      var slots = ctx.get('slots');
      if (!slots || typeof slots.inject !== 'function') return;
      slots.inject('sidebar.panellist', function () {
        return slots.register(
          { name: 'sidebar.panellist', id: 'dsh-setting-backup', order: 70, label: '配置备份' },
          Glyph,
        );
      });
      slots.inject('main', function () {
        return slots.register({ name: 'main', key: 'dsh-setting-backup' }, Panel);
      });
    };
    return module.exports;
  },
});
```

- [ ] **Step 6: 本地链接安装并验证加载**

```bash
dsh plugin --profile desktop add "D:/code/dsh-plugins/dsh-setting-backup"
```

重启 DSH 后在浏览器访问 `http://127.0.0.1:<端口>/plugins/dsh-setting-backup/ping`，期望返回 `{"ok":true,...}`；侧栏出现「配置备份」行，点开主区显示占位文字。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat: scaffold dsh-setting-backup plugin with sidebar entry"
```

---

### Task 1: ZIP 读写与路径安全

**Files:**
- Create: `lib/zip.js`
- Test: `test/zip.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `writeZip(entries: Array<{ path: string, data: Buffer }>): Buffer`
  - `readZip(buffer: Buffer): Array<{ path: string, data: Buffer }>`
  - `assertSafeEntry(name: string): void`（越界/绝对/盘符/反斜杠穿越时抛 `Error`）

- [ ] **Step 1: 写失败测试**

```js
// test/zip.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeZip, readZip, assertSafeEntry } from '../lib/zip.js';

test('writeZip 与 readZip 往返一致', () => {
  const entries = [
    { path: 'manifest.json', data: Buffer.from('{"a":1}') },
    { path: 'config/home/settings.yaml', data: Buffer.from('llm: 1\n') },
  ];
  const zip = writeZip(entries);
  const back = readZip(zip);
  assert.equal(back.length, 2);
  assert.equal(back[0].path, 'manifest.json');
  assert.equal(back[1].data.toString(), 'llm: 1\n');
});

test('assertSafeEntry 拒绝越界路径', () => {
  assert.throws(() => assertSafeEntry('../evil'), /unsafe/);
  assert.throws(() => assertSafeEntry('/etc/passwd'), /unsafe/);
  assert.throws(() => assertSafeEntry('C:/x'), /unsafe/);
  assert.throws(() => assertSafeEntry('a/../../b'), /unsafe/);
  assert.doesNotThrow(() => assertSafeEntry('config/home/settings.yaml'));
});

test('readZip 对越界条目抛错', () => {
  const zip = writeZip([{ path: '../evil.txt', data: Buffer.from('x') }]);
  assert.throws(() => readZip(zip), /unsafe/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/zip.test.mjs`
Expected: FAIL，`Cannot find module '../lib/zip.js'`

- [ ] **Step 3: 实现 `lib/zip.js`**

用 store（method 0）写、store/deflate 读，CRC32 自实现：

```js
import { inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function assertSafeEntry(name) {
  const raw = String(name);
  if (raw.includes('\0')) throw new Error('unsafe entry: ' + raw);
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
    throw new Error('unsafe entry: ' + raw);
  }
  const parts = raw.replace(/\\/g, '/').split('/');
  if (parts.some((p) => p === '..')) throw new Error('unsafe entry: ' + raw);
  if (!raw.trim()) throw new Error('unsafe entry: empty');
}

export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    assertSafeEntry(entry.path);
    const nameBuf = Buffer.from(entry.path, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

export function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: eocd not found');
  const count = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error('not a zip: bad central header');
    const method = buffer.readUInt16LE(pointer + 10);
    const compSize = buffer.readUInt32LE(pointer + 20);
    const nameLen = buffer.readUInt16LE(pointer + 28);
    const extraLen = buffer.readUInt16LE(pointer + 30);
    const commentLen = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const path = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLen);
    assertSafeEntry(path);
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(start, start + compSize);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    out.push({ path, data });
    pointer += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/zip.test.mjs`
Expected: PASS（3 项）

- [ ] **Step 5: 提交**

```bash
git add lib/zip.js test/zip.test.mjs
git commit -m "feat(zip): add zero-dependency zip writer/reader with path guards"
```

---

### Task 2: 收集配置与插件清单

**Files:**
- Create: `lib/paths.js`, `lib/collect.js`
- Test: `test/collect.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `paths.resolveHome(env?): string`
  - `paths.resolveProfileDir(ctx, env?): string`
  - `paths.resolveProfileName(ctx, env?): string`
  - `paths.stateDir(profileDir): string`
  - `paths.statePath(profileDir): string`
  - `paths.stagedDir(profileDir, id): string`
  - `paths.snapshotsDir(profileDir): string`
  - `collect.collectConfig({ home, profileDir }): Promise<Array<{ relPath, absPath, data }>>`
  - `collect.collectPlugins({ profileDir }): Promise<Array<PluginEntry>>`，`PluginEntry = { name, version, declared, role, source, installSpec, installed }`

- [ ] **Step 1: 写失败测试（用临时目录造 fixture）**

```js
// test/collect.test.mjs
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/collect.test.mjs`
Expected: FAIL，`Cannot find module '../lib/collect.js'`

- [ ] **Step 3: 实现 `lib/paths.js`**

```js
import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveHome(env = process.env) {
  if (env && env.DSH_HOME) return env.DSH_HOME;
  return join(env && env.USERPROFILE ? env.USERPROFILE : homedir(), '.dsh');
}

export function resolveProfileName(ctx, env = process.env) {
  try {
    const svc = ctx && typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined;
    if (svc && typeof svc.name === 'string' && svc.name) return svc.name;
  } catch { /* 服务缺失继续兜底 */ }
  if (env && env.DSH_PROFILE) return env.DSH_PROFILE;
  return 'desktop';
}

export function resolveProfileDir(ctx, env = process.env) {
  try {
    const svc = ctx && typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined;
    if (svc && typeof svc.dir === 'string' && svc.dir) return svc.dir;
  } catch { /* 服务缺失继续兜底 */ }
  if (env && env.DSH_PROFILE_DIR) return env.DSH_PROFILE_DIR;
  return join(resolveHome(env), 'profiles', resolveProfileName(ctx, env));
}

export const stateDir = (profileDir) => join(profileDir, '.setting-backup');
export const statePath = (profileDir) => join(stateDir(profileDir), 'pending-restore.json');
export const stagedDir = (profileDir, id) => join(stateDir(profileDir), 'staged', id);
export const snapshotsDir = (profileDir) => join(stateDir(profileDir), 'snapshots');
```

- [ ] **Step 4: 实现 `lib/collect.js`**

```js
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const PROFILE_FILES = [
  'package.json', 'cordis.patch.yml', 'cordis.yml',
  'pnpm-workspace.yaml', 'pnpm-lock.yaml',
];
const HOME_FILES = ['settings.yaml'];
const SENSITIVE_FILES = ['.credentials.yaml', '.env'];

export function classifySource(declared) {
  const raw = String(declared || '').trim();
  if (raw.startsWith('link:')) return 'link';
  if (raw.startsWith('file:')) return 'file';
  if (raw.startsWith('github:') || raw.startsWith('git+') || raw.includes('github.com')) return 'github';
  if (/^https?:\/\//.test(raw)) return 'tarball';
  return 'registry';
}

async function readIfExists(absPath) {
  try { return await readFile(absPath); } catch { return null; }
}

export async function collectConfig({ home, profileDir, includeSensitive = false }) {
  const out = [];
  const push = async (relPath, absPath) => {
    const data = await readIfExists(absPath);
    if (data) out.push({ relPath, absPath, data });
  };
  for (const file of HOME_FILES) await push('config/home/' + file, join(home, file));
  if (includeSensitive) {
    for (const file of SENSITIVE_FILES) await push('config/home/' + file, join(home, file));
  }
  for (const file of PROFILE_FILES) await push('config/profile/' + file, join(profileDir, file));
  let entries = [];
  try { entries = await readdir(home); } catch { entries = []; }
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.startsWith('.')) continue;
    if (entry.includes('cache') || entry.includes('state')) continue;
    await push('config/home/' + entry, join(home, entry));
  }
  return out;
}

export async function collectPlugins({ profileDir }) {
  const raw = await readIfExists(join(profileDir, 'package.json'));
  if (!raw) return [];
  const pkg = JSON.parse(raw.toString('utf8'));
  const deps = pkg.dependencies || {};
  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  const out = [];
  for (const name of Object.keys(deps)) {
    const declared = deps[name];
    const installedPkg = await readIfExists(join(profileDir, 'node_modules', name, 'package.json'));
    let version = null;
    let bundlePatch = null;
    if (installedPkg) {
      try {
        const meta = JSON.parse(installedPkg.toString('utf8'));
        version = meta.version || null;
        bundlePatch = meta.dsh && meta.dsh.bundle ? meta.dsh.bundle.patch || null : null;
      } catch { /* 安装物损坏按未安装处理 */ }
    }
    const source = classifySource(declared);
    const effective = version || String(declared).replace(/^[\^~]/, '');
    out.push({
      name,
      version: version || effective,
      declared,
      role: bundles.includes(name) ? 'bundle' : 'dependency',
      source,
      installSpec: source === 'registry' ? name + '@' + effective : declared,
      installed: Boolean(installedPkg),
      bundlePatch,
    });
  }
  return out;
}
```

- [ ] **Step 5: 运行确认通过**

Run: `node --test test/collect.test.mjs`
Expected: PASS（4 项）

- [ ] **Step 6: 提交**

```bash
git add lib/paths.js lib/collect.js test/collect.test.mjs
git commit -m "feat(collect): gather config files and plugin inventory with versions"
```

---

### Task 3: 打包与解析归档

**Files:**
- Create: `lib/archive.js`
- Test: `test/archive.test.mjs`

**Interfaces:**
- Consumes: `zip.writeZip`、`zip.readZip`、`zip.assertSafeEntry`
- Produces:
  - `archive.sha256(buf: Buffer): string`
  - `archive.buildArchive({ meta, configFiles, plugins }): Buffer`
  - `archive.parseArchive(buffer, { allowSensitive }): { manifest, plugins, files }`，`files` 为 `[{ relPath, data }]`

- [ ] **Step 1: 写失败测试**

```js
// test/archive.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArchive, parseArchive } from '../lib/archive.js';

const meta = {
  format: 'dsh-setting-backup/1', createdAt: '2026-11-09T16:00:00+08:00',
  profile: 'desktop', dshVersion: '0.2.2-rc.1', platform: 'win32', sensitive: false,
};
const configFiles = [
  { relPath: 'config/profile/package.json', data: Buffer.from('{"name":"p"}') },
  { relPath: 'config/home/settings.yaml', data: Buffer.from('llm: 1\n') },
];
const plugins = [{ name: 'dsh-a', version: '1.2.3', declared: '1.2.3', role: 'bundle', source: 'registry', installSpec: 'dsh-a@1.2.3', installed: true }];

test('打包后解析还原出 manifest / plugins / files', () => {
  const zip = buildArchive({ meta, configFiles, plugins });
  const parsed = parseArchive(zip, { allowSensitive: false });
  assert.equal(parsed.manifest.format, 'dsh-setting-backup/1');
  assert.equal(parsed.plugins.length, 1);
  assert.equal(parsed.plugins[0].version, '1.2.3');
  assert.equal(parsed.files.length, 2);
});

test('校验和对不上时拒绝', () => {
  const zip = buildArchive({ meta, configFiles, plugins });
  const bad = Buffer.from(zip);
  const idx = bad.indexOf(Buffer.from('{"name":"p"}'));
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/archive.test.mjs`
Expected: FAIL，`Cannot find module '../lib/archive.js'`

- [ ] **Step 3: 实现 `lib/archive.js`**

```js
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
    { relPath: 'plugins.json', data: Buffer.from(JSON.stringify(plugins, null, 2)) },
    ...configFiles,
  ];
  const checksums = {};
  for (const file of body) checksums[file.relPath] = sha256(file.data);
  const entries = body.map((file) => ({ path: file.relPath, data: file.data }));
  entries.push({ path: 'checksums.json', data: Buffer.from(JSON.stringify(checksums, null, 2)) });
  return writeZip(entries);
}

export function parseArchive(buffer, { allowSensitive = false } = {}) {
  const entries = readZip(buffer);
  const byPath = new Map(entries.map((e) => [e.path, e.data]));
  if (!byPath.has('manifest.json')) throw new Error('invalid archive: manifest.json missing');
  if (!byPath.has('checksums.json')) throw new Error('invalid archive: checksums.json missing');
  const manifest = JSON.parse(byPath.get('manifest.json').toString('utf8'));
  if (manifest.format !== FORMAT) throw new Error('unsupported format: ' + manifest.format);
  if (manifest.sensitive === true && !allowSensitive) {
    throw new Error('archive is sensitive (contains credentials); import requires explicit consent');
  }
  const checksums = JSON.parse(byPath.get('checksums.json').toString('utf8'));
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
  const plugins = JSON.parse(byPath.get('plugins.json').toString('utf8'));
  return { manifest, plugins, files };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/archive.test.mjs`
Expected: PASS（4 项）

- [ ] **Step 5: 提交**

```bash
git add lib/archive.js test/archive.test.mjs
git commit -m "feat(archive): build and verify backup archives with checksums"
```

---

### Task 4: 差异计划与 bundles 守卫（核心安全）

**Files:**
- Create: `lib/plan.js`
- Test: `test/plan.test.mjs`

**Interfaces:**
- Consumes: `collect.collectPlugins`
- Produces:
  - `plan.computePlan({ backupPlugins, installed }): { missing, versionMismatch, localWarn, extraLocal, canInstall, canApply }`
  - `plan.assertBundlesResolvable(profileDir, bundles, { exists }): { ok, unresolvable }`
  - `plan.readBundleList(profileDir): Promise<string[]>`

- [ ] **Step 1: 写失败测试**

```js
// test/plan.test.mjs
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
  const installed = [{ name: 'dsh-a', version: '1.0.0', source: 'registry' }, { name: 'dsh-x', version: '9.9.9', source: 'registry' }];
  const plan = computePlan({ backupPlugins: backup, installed });
  assert.deepEqual(plan.missing.map((p) => p.name), ['dsh-b']);
  assert.deepEqual(plan.versionMismatch.map((p) => p.name), ['dsh-a']);
  assert.deepEqual(plan.localWarn.map((p) => p.name), ['dsh-local']);
  assert.deepEqual(plan.extraLocal.map((p) => p.name), ['dsh-x']);
  assert.equal(plan.canInstall, true);
});

test('本地来源不阻塞安装但要求确认', () => {
  const plan = computePlan({ backupPlugins: backup, installed: [] });
  assert.equal(plan.localWarn.length, 1);
  assert.equal(plan.canInstall, true);
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

test('readBundleList 读 dsh.profile.bundles', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsbk-plan-'));
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['a', 'b'] } } }));
  assert.deepEqual(await readBundleList(profileDir), ['a', 'b']);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/plan.test.mjs`
Expected: FAIL，`Cannot find module '../lib/plan.js'`

- [ ] **Step 3: 实现 `lib/plan.js`**

```js
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function computePlan({ backupPlugins, installed }) {
  const installedMap = new Map((installed || []).map((p) => [p.name, p]));
  const backupNames = new Set((backupPlugins || []).map((p) => p.name));
  const missing = [];
  const versionMismatch = [];
  const localWarn = [];
  const extraLocal = (installed || []).filter((p) => !backupNames.has(p.name));

  for (const plugin of backupPlugins || []) {
    const local = installedMap.get(plugin.name);
    if (plugin.source !== 'registry') {
      localWarn.push(plugin);
      continue;
    }
    if (!local) missing.push(plugin);
    else if (local.version !== plugin.version) versionMismatch.push({ ...plugin, current: local.version });
  }
  return {
    missing,
    versionMismatch,
    localWarn,
    extraLocal,
    canInstall: missing.length + versionMismatch.length > 0 || localWarn.length > 0,
    canApply: missing.length === 0 && versionMismatch.length === 0,
  };
}

export function assertBundlesResolvable(profileDir, bundles, deps = {}) {
  const exists = deps.exists || existsSync;
  const unresolvable = [];
  for (const name of bundles || []) {
    const pkgPath = join(profileDir, 'node_modules', name, 'package.json');
    if (!exists(pkgPath)) unresolvable.push(name);
  }
  return { ok: unresolvable.length === 0, unresolvable };
}

export async function readBundleList(profileDir) {
  try {
    const raw = readFileSync(join(profileDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    return (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/plan.test.mjs`
Expected: PASS（4 项）

- [ ] **Step 5: 提交**

```bash
git add lib/plan.js test/plan.test.mjs
git commit -m "feat(plan): compute restore diff and guard bundle resolvability"
```

---

### Task 5: 恢复状态机

**Files:**
- Create: `lib/state.js`
- Test: `test/state.test.mjs`

**Interfaces:**
- Consumes: `paths.statePath`
- Produces:
  - `state.STATES = ['staged','installing','configured','done','failed']`
  - `state.transition(current, next): string`（非法跳转抛 `Error('illegal transition ...')`）
  - `state.readState(profileDir): object|null`
  - `state.writeState(profileDir, patch): object`
  - `state.clearState(profileDir): void`

- [ ] **Step 1: 写失败测试**

```js
// test/state.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { transition, readState, writeState, clearState } from '../lib/state.js';

test('合法跳转链路', () => {
  assert.equal(transition('idle', 'staged'), 'staged');
  assert.equal(transition('staged', 'installing'), 'installing');
  assert.equal(transition('installing', 'configured'), 'configured');
  assert.equal(transition('configured', 'done'), 'done');
  assert.equal(transition('installing', 'failed'), 'failed');
  assert.equal(transition('failed', 'installing'), 'installing');
});

test('非法跳转被拒绝', () => {
  assert.throws(() => transition('staged', 'configured'), /illegal transition/);
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/state.test.mjs`
Expected: FAIL，`Cannot find module '../lib/state.js'`

- [ ] **Step 3: 实现 `lib/state.js`**

```js
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { statePath } from './paths.js';

export const STATES = ['staged', 'installing', 'configured', 'done', 'failed'];

const ALLOWED = {
  idle: ['staged'],
  staged: ['installing', 'failed'],
  installing: ['configured', 'failed'],
  configured: ['done', 'failed'],
  failed: ['installing', 'idle'],
  done: ['idle'],
};

export function transition(current, next) {
  const from = current || 'idle';
  const allowed = ALLOWED[from] || [];
  if (!allowed.includes(next)) throw new Error('illegal transition: ' + from + ' -> ' + next);
  return next;
}

export function readState(profileDir) {
  const file = statePath(profileDir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeState(profileDir, patch) {
  const file = statePath(profileDir);
  const current = readState(profileDir) || { state: 'idle' };
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  if (patch.state) transition(current.state, patch.state);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

export function clearState(profileDir) {
  const file = statePath(profileDir);
  if (existsSync(file)) rmSync(file, { force: true });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/state.test.mjs`
Expected: PASS（3 项）

- [ ] **Step 5: 提交**

```bash
git add lib/state.js test/state.test.mjs
git commit -m "feat(state): two-phase restore state machine"
```

---

### Task 6: 本地快照与轮转

**Files:**
- Create: `lib/snapshots.js`
- Test: `test/snapshots.test.mjs`

**Interfaces:**
- Consumes: `paths.snapshotsDir`
- Produces:
  - `snapshots.createSnapshot({ profileDir, files, keep }): { stamp, dir, count }`
  - `snapshots.listSnapshots(profileDir): Array<{ stamp, dir, files }>`
  - `snapshots.rotateSnapshots(profileDir, keep): string[]`
  - `snapshots.restoreSnapshot({ profileDir, stamp }): string[]`

- [ ] **Step 1: 写失败测试**

```js
// test/snapshots.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSnapshot, listSnapshots, rotateSnapshots, restoreSnapshot } from '../lib/snapshots.js';

test('快照保存并可恢复', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsbk-snap-'));
  const target = join(profileDir, 'settings.yaml');
  writeFileSync(target, 'v1');
  const files = [{ absPath: target, relPath: 'config/home/settings.yaml' }];
  const snap = createSnapshot({ profileDir, files, keep: 5 });
  assert.ok(existsSync(join(snap.dir, 'config/home/settings.yaml')));
  writeFileSync(target, 'v2');
  restoreSnapshot({ profileDir, stamp: snap.stamp });
  assert.equal(readFileSync(target, 'utf8'), 'v1');
});

test('轮转只保留 N 份', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsbk-snap-'));
  const target = join(profileDir, 'x.json');
  writeFileSync(target, 'x');
  const files = [{ absPath: target, relPath: 'x.json' }];
  for (const stamp of ['20260101-000001', '20260101-000002', '20260101-000003']) {
    mkdirSync(join(profileDir, '.setting-backup', 'snapshots', stamp), { recursive: true });
    writeFileSync(join(profileDir, '.setting-backup', 'snapshots', stamp, 'x.json'), stamp);
  }
  const removed = rotateSnapshots(profileDir, 2);
  assert.equal(removed.length, 1);
  assert.equal(listSnapshots(profileDir).length, 2);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/snapshots.test.mjs`
Expected: FAIL，`Cannot find module '../lib/snapshots.js'`

- [ ] **Step 3: 实现 `lib/snapshots.js`**

```js
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotsDir } from './paths.js';

const stampOf = (now = Date.now()) => new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);

export function createSnapshot({ profileDir, files, keep = 5 }) {
  const stamp = stampOf();
  const dir = join(snapshotsDir(profileDir), stamp);
  mkdirSync(dir, { recursive: true });
  let count = 0;
  for (const file of files || []) {
    if (!file.absPath || !existsSync(file.absPath)) continue;
    const dest = join(dir, file.relPath);
    mkdirSync(join(dest, '..'), { recursive: true });
    copyFileSync(file.absPath, dest);
    count += 1;
  }
  rotateSnapshots(profileDir, keep);
  return { stamp, dir, count };
}

export function listSnapshots(profileDir) {
  const root = snapshotsDir(profileDir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .sort()
    .map((stamp) => {
      const dir = join(root, stamp);
      let files = 0;
      try { files = readdirSync(dir, { recursive: true }).length; } catch { files = 0; }
      return { stamp, dir, files };
    });
}

export function rotateSnapshots(profileDir, keep = 5) {
  const all = listSnapshots(profileDir);
  const overflow = all.slice(0, Math.max(0, all.length - keep));
  for (const item of overflow) rmSync(item.dir, { recursive: true, force: true });
  return overflow.map((item) => item.stamp);
}

export function restoreSnapshot({ profileDir, stamp }) {
  const root = join(snapshotsDir(profileDir), stamp);
  if (!existsSync(root)) throw new Error('snapshot not found: ' + stamp);
  const restored = [];
  for (const entry of walk(root, '')) {
    const rel = entry.rel;
    const abs = join(profileDir, rel.replace(/^config\/profile\//, ''));
    mkdirSync(join(abs, '..'), { recursive: true });
    copyFileSync(entry.abs, abs);
    restored.push(abs);
  }
  return restored;
}

function* walk(root, rel) {
  const dir = join(root, rel);
  for (const name of readdirSync(dir)) {
    const nextRel = rel ? rel + '/' + name : name;
    const abs = join(root, nextRel);
    if (statSync(abs).isDirectory()) yield* walk(root, nextRel);
    else yield { rel: nextRel, abs };
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/snapshots.test.mjs`
Expected: PASS（2 项）

- [ ] **Step 5: 提交**

```bash
git add lib/snapshots.js test/snapshots.test.mjs
git commit -m "feat(snapshots): create, rotate and restore local config snapshots"
```

---

### Task 7: 插件安装执行器

**Files:**
- Create: `lib/install.js`
- Test: `test/install.test.mjs`

**Interfaces:**
- Consumes: `plan.computePlan`
- Produces:
  - `install.buildAddArgs({ profile, spec }): string[]` → `['plugin','--profile',profile,'add',spec]`
  - `install.resolveDshCli(env?): string`（`DSH_CLI` 覆盖，否则 `dsh`）
  - `install.installPlugins({ profile, plan, spawnImpl, onProgress }): Promise<{ results, okCount, failedCount }>`
  - 单个结果 `{ name, spec, ok, code, stderr }`

- [ ] **Step 1: 写失败测试**

```js
// test/install.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAddArgs, installPlugins, resolveDshCli } from '../lib/install.js';

function fakeSpawn(table) {
  const calls = [];
  const impl = (cmd, args) => {
    calls.push([cmd].concat(args));
    const spec = args[args.length - 1];
    const code = table[spec] === undefined ? 0 : table[spec];
    return { on: (event, cb) => { if (event === 'close') setTimeout(() => cb(code, '', code === 0 ? '' : 'boom'), 0); }, kill: () => {} };
  };
  impl.calls = calls;
  return impl;
}

test('buildAddArgs 结构与官方一致', () => {
  assert.deepEqual(buildAddArgs({ profile: 'desktop', spec: 'dsh-a@1.2.3' }), ['plugin', '--profile', 'desktop', 'add', 'dsh-a@1.2.3']);
});

test('resolveDshCli 支持覆盖', () => {
  assert.equal(resolveDshCli({ DSH_CLI: '/usr/bin/dsh' }), '/usr/bin/dsh');
  assert.equal(resolveDshCli({}), 'dsh');
});

test('逐个安装并记录失败', async () => {
  const spawnImpl = fakeSpawn({ 'dsh-b@2.0.0': 1 });
  const plan = {
    missing: [
      { name: 'dsh-a', version: '1.2.3', installSpec: 'dsh-a@1.2.3' },
      { name: 'dsh-b', version: '2.0.0', installSpec: 'dsh-b@2.0.0' },
    ],
  };
  const out = await installPlugins({ profile: 'desktop', plan, spawnImpl });
  assert.equal(out.okCount, 1);
  assert.equal(out.failedCount, 1);
  assert.equal(out.results.find((r) => r.name === 'dsh-b').ok, false);
  assert.equal(spawnImpl.calls.length, 2);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/install.test.mjs`
Expected: FAIL，`Cannot find module '../lib/install.js'`

- [ ] **Step 3: 实现 `lib/install.js`**

```js
import { spawn } from 'node:child_process';

export function resolveDshCli(env = process.env) {
  return (env && env.DSH_CLI) || 'dsh';
}

export function buildAddArgs({ profile, spec }) {
  return ['plugin', '--profile', profile, 'add', spec];
}

function runOnce({ cli, args, spawnImpl }) {
  const spawnFn = spawnImpl || spawn;
  return new Promise((resolve) => {
    let stderr = '';
    const child = spawnFn(cli, args, { shell: process.platform === 'win32' });
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    }
    child.on('close', (code) => resolve({ code: code === null ? 1 : code, stderr }));
    child.on('error', (error) => resolve({ code: 1, stderr: String(error && error.message) }));
  });
}

export async function installPlugins({ profile, plan, spawnImpl, onProgress, cli }) {
  const cliPath = cli || resolveDshCli();
  const queue = [...(plan.missing || []), ...(plan.versionMismatch || [])];
  const results = [];
  for (const item of queue) {
    const args = buildAddArgs({ profile, spec: item.installSpec });
    const outcome = await runOnce({ cli: cliPath, args, spawnImpl });
    const record = {
      name: item.name,
      spec: item.installSpec,
      ok: outcome.code === 0,
      code: outcome.code,
      stderr: (outcome.stderr || '').slice(-2000),
    };
    results.push(record);
    if (typeof onProgress === 'function') onProgress(record, results.length, queue.length);
  }
  const failedCount = results.filter((r) => !r.ok).length;
  return { results, okCount: results.length - failedCount, failedCount };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/install.test.mjs`
Expected: PASS（3 项）

- [ ] **Step 5: 提交**

```bash
git add lib/install.js test/install.test.mjs
git commit -m "feat(install): install plugins through the official dsh plugin add entry"
```

---

### Task 8: 提交配置与回滚

**Files:**
- Create: `lib/apply.js`
- Test: `test/apply.test.mjs`

**Interfaces:**
- Consumes: `plan.assertBundlesResolvable`
- Produces:
  - `apply.commitConfig({ profileDir, files, bundles, stamp, deps }): Promise<{ written, backups, rolledBack }>`
  - 规则：先写 `.bak-<stamp>`；`bundles` 非空时先过守卫，失败则回滚已写文件并抛 `Error('bundle guard failed: <names>')`

- [ ] **Step 1: 写失败测试**

```js
// test/apply.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { commitConfig } from '../lib/apply.js';

function setup() {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsbk-apply-'));
  mkdirSync(join(profileDir, 'node_modules', 'dsh-a'), { recursive: true });
  writeFileSync(join(profileDir, 'node_modules', 'dsh-a', 'package.json'), '{"name":"dsh-a"}');
  writeFileSync(join(profileDir, 'cordis.patch.yml'), 'old\n');
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: [] } } }));
  return profileDir;
}

test('成功提交：写 bak 并覆盖配置与 bundles', async () => {
  const profileDir = setup();
  const files = [
    { relPath: 'config/profile/cordis.patch.yml', data: Buffer.from('new\n') },
    { relPath: 'config/profile/package.json', data: Buffer.from(JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['dsh-a'] } } })) },
  ];
  const out = await commitConfig({ profileDir, files, bundles: ['dsh-a'], stamp: '20260101-000000' });
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), 'new\n');
  assert.ok(existsSync(join(profileDir, 'cordis.patch.yml.bak-20260101-000000')));
  assert.deepEqual(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles, ['dsh-a']);
  assert.equal(out.rolledBack, false);
});

test('守卫失败：不写任何文件并回滚', async () => {
  const profileDir = setup();
  const files = [{ relPath: 'config/profile/cordis.patch.yml', data: Buffer.from('new\n') }];
  await assert.rejects(
    () => commitConfig({ profileDir, files, bundles: ['dsh-a', 'dsh-missing'], stamp: 'x' }),
    /bundle guard failed: dsh-missing/,
  );
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), 'old\n');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/apply.test.mjs`
Expected: FAIL，`Cannot find module '../lib/apply.js'`

- [ ] **Step 3: 实现 `lib/apply.js`**

```js
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertBundlesResolvable } from './plan.js';

function targetOf(profileDir, relPath) {
  const normalized = relPath.replace(/^config\/profile\//, '').replace(/^config\/home\//, '');
  return join(profileDir, normalized);
}

export async function commitConfig({ profileDir, files, bundles, stamp, deps = {} }) {
  const guard = assertBundlesResolvable(profileDir, bundles || [], deps);
  if (!guard.ok) {
    throw new Error('bundle guard failed: ' + guard.unresolvable.join(','));
  }
  const backups = [];
  const written = [];
  for (const file of files || []) {
    const target = targetOf(profileDir, file.relPath);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      const bak = target + '.bak-' + stamp;
      copyFileSync(target, bak);
      backups.push(bak);
    }
    writeFileSync(target, file.data);
    written.push(target);
  }
  if (Array.isArray(bundles) && bundles.length > 0) {
    const pkgPath = join(profileDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.dsh = pkg.dsh || {};
    pkg.dsh.profile = pkg.dsh.profile || {};
    pkg.dsh.profile.bundles = bundles;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
  return { written, backups, rolledBack: false };
}
```

> 说明：`bundles` 写入放在所有文件覆盖之后、守卫通过之后的同一调用内；守卫是第一步执行，因此守卫失败时 **没有任何文件被写**，`rolledBack` 字段保留给后续增量回滚逻辑使用。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/apply.test.mjs`
Expected: PASS（2 项）

- [ ] **Step 5: 提交**

```bash
git add lib/apply.js test/apply.test.mjs
git commit -m "feat(apply): commit config with backup files and bundle guard"
```

---

### Task 9: 服务端接口

**Files:**
- Create: `lib/routes.js`
- Modify: `lib/index.js`（改为调用 `registerRoutes`）
- Test: `test/routes.test.mjs`

**Interfaces:**
- Consumes: 前述全部模块
- Produces:
  - `routes.registerRoutes(hostCtx, ctx, config): () => void`
  - 路由：`GET /plugins/dsh-setting-backup/status`、`POST .../export`、`POST .../import`、`POST .../install`、`POST .../commit`、`POST .../rollback`、`GET .../snapshots`
  - 所有 POST 校验 `content-type: application/json` 且拒绝非本机 `origin`

- [ ] **Step 1: 写失败测试（直接测 handler 表，不启动服务器）**

```js
// test/routes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHandlers, rejectNonLocal } from '../lib/routes.js';

function fakeRes() {
  const res = { status: 0, headers: {}, body: '', writeHead(s, h) { this.status = s; this.headers = h || {}; }, end(b) { this.body = b || ''; } };
  return res;
}

test('拒绝非本机 origin', () => {
  assert.equal(rejectNonLocal({ headers: { origin: 'https://evil.example' } }), true);
  assert.equal(rejectNonLocal({ headers: { origin: 'http://127.0.0.1:50279' } }), false);
  assert.equal(rejectNonLocal({ headers: {} }), false);
});

test('status 路由：无状态时返回 idle', async () => {
  const handlers = buildHandlers({
    deps: {
      resolveProfileDir: () => '/tmp/fake-profile',
      readState: () => null,
      readBundleList: async () => [],
      collectPlugins: async () => [],
      listSnapshots: () => [],
    },
  });
  const res = fakeRes();
  await handlers.status({ method: 'GET', headers: {} }, res);
  const payload = JSON.parse(res.body);
  assert.equal(payload.state.state, 'idle');
  assert.equal(payload.ok, true);
});

test('非法 method 返回 405', async () => {
  const handlers = buildHandlers({ deps: { readState: () => null } });
  const res = fakeRes();
  await handlers.status({ method: 'POST', headers: {} }, res);
  assert.equal(res.status, 405);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/routes.test.mjs`
Expected: FAIL，`Cannot find module '../lib/routes.js'`

- [ ] **Step 3: 实现 `lib/routes.js`（handler 表 + 依赖注入，便于测试）**

```js
import { collectPlugins as defaultCollectPlugins } from './collect.js';
import { resolveProfileDir as defaultProfileDir, resolveProfileName as defaultProfileName } from './paths.js';
import { readState as defaultReadState, writeState, clearState } from './state.js';
import { listSnapshots as defaultListSnapshots, restoreSnapshot } from './snapshots.js';
import { readBundleList as defaultReadBundleList } from './plan.js';

const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

export function rejectNonLocal(req) {
  const origin = req && req.headers ? req.headers.origin : undefined;
  if (!origin) return false;
  return !LOCAL_ORIGIN.test(origin);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function buildHandlers({ deps = {}, config = {} } = {}) {
  const d = {
    resolveProfileDir: defaultProfileDir,
    resolveProfileName: defaultProfileName,
    collectPlugins: defaultCollectPlugins,
    readState: defaultReadState,
    readBundleList: defaultReadBundleList,
    listSnapshots: defaultListSnapshots,
    ...deps,
  };

  async function snapshot() {
    let profileDir = '';
    let state = null;
    let bundles = [];
    let snapshots = [];
    try {
      profileDir = d.resolveProfileDir(d.ctx);
      state = d.readState(profileDir);
      bundles = await d.readBundleList(profileDir);
      snapshots = d.listSnapshots(profileDir);
    } catch { /* 探测失败按空状态返回 */ }
    return {
      ok: true,
      profile: (() => { try { return d.resolveProfileName(d.ctx); } catch { return ''; } })(),
      profileDir,
      state: state || { state: 'idle' },
      bundles,
      snapshots: snapshots.map((s) => ({ stamp: s.stamp, files: s.files })),
      config,
    };
  }

  function guard(req, res, method) {
    if (rejectNonLocal(req)) { sendJson(res, 403, { ok: false, reason: 'untrusted-origin' }); return false; }
    if (req.method !== method) { res.writeHead(405, { allow: method }); res.end(); return false; }
    return true;
  }

  const handlers = {
    status: async (req, res) => {
      if (!guard(req, res, 'GET')) return;
      sendJson(res, 200, await snapshot());
    },
    snapshots: async (req, res) => {
      if (!guard(req, res, 'GET')) return;
      const info = await snapshot();
      sendJson(res, 200, { ok: true, snapshots: info.snapshots });
    },
    restoreSnapshot: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readBody(req);
      const profileDir = d.resolveProfileDir(d.ctx);
      const restored = restoreSnapshot({ profileDir, stamp: body.stamp });
      sendJson(res, 200, { ok: true, restored: restored.length });
    },
    clearState: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      clearState(d.resolveProfileDir(d.ctx));
      sendJson(res, 200, { ok: true });
    },
  };
  return handlers;
}

export function registerRoutes(hostCtx, ctx, config) {
  const handlers = buildHandlers({ config });
  handlers.deps = null;
  const map = [
    ['/plugins/dsh-setting-backup/status', handlers.status],
    ['/plugins/dsh-setting-backup/snapshots', handlers.snapshots],
    ['/plugins/dsh-setting-backup/restore-snapshot', handlers.restoreSnapshot],
    ['/plugins/dsh-setting-backup/clear-state', handlers.clearState],
  ];
  const disposers = map.map(([path, handler]) => hostCtx.webServer.register({ kind: 'exact', path, handler }));
  return () => disposers.forEach((dispose) => { try { dispose(); } catch { /* 已卸载 */ } });
}
```

> 由于 `resolveProfileDir` 需要 `ctx`，`buildHandlers` 接受 `deps.ctx`；`registerRoutes` 在真实注册时把 `ctx` 注入进 `deps`（见 `lib/index.js`）。

- [ ] **Step 4: 修改 `lib/index.js` 使用 `registerRoutes`**

```js
import { registerRoutes } from './routes.js';

export const name = 'dsh-setting-backup';

export function apply(ctx, config = {}) {
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => registerRoutes(hostCtx, ctx, config), 'dsh-setting-backup: routes');
  });
}
```

- [ ] **Step 5: 运行确认通过**

Run: `node --test test/routes.test.mjs`
Expected: PASS（3 项）

- [ ] **Step 6: 提交**

```bash
git add lib/routes.js lib/index.js test/routes.test.mjs
git commit -m "feat(routes): expose status/snapshot HTTP handlers with origin guard"
```

---

### Task 10: 导出与导入编排

**Files:**
- Modify: `lib/routes.js`（新增 `export`、`import`、`install`、`commit` 四个 handler）
- Test: `test/orchestrate.test.mjs`

**Interfaces:**
- Consumes: `collect`、`archive`、`plan`、`install`、`apply`、`snapshots`、`state`
- Produces:
  - `POST /export` → `{ ok, file, bytes, plugins }`，文件落 `<profileDir>/.setting-backup/exports/<name>.zip`
  - `POST /import` → `{ ok, plan, state }`，解包到 `staged/<id>`、建快照、写 `staged` 状态、覆盖 `settings.yaml`
  - `POST /install` → `{ ok, results }`，`staged → installing → (全成功) configured`
  - `POST /commit` → 提交配置并提示重启；`POST /rollback` → 整单回退

- [ ] **Step 1: 写失败测试**

```js
// test/orchestrate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHandlers } from '../lib/routes.js';
import { buildArchive } from '../lib/archive.js';

function res() {
  return { status: 0, headers: {}, body: '', writeHead(s, h) { this.status = s; this.headers = h || {}; }, end(b) { this.body = b || ''; } };
}
function req(method, body) {
  return { method, headers: {}, [Symbol.asyncIterator]: function* () { if (body) yield Buffer.from(JSON.stringify(body)); } };
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

test('导出产生 zip 并可被 import 预检', async () => {
  const { home, profileDir } = fixture();
  const handlers = buildHandlers({ deps: { ctx: null, resolveProfileDir: () => profileDir, resolveProfileName: () => 'desktop', home } });
  const out = res();
  await handlers.exportArchive(req('POST', {}), out);
  const payload = JSON.parse(out.body);
  assert.equal(payload.ok, true);
  assert.ok(payload.bytes > 0);
  const zip = readFileSync(payload.file);
  const imported = buildHandlers({ deps: { ctx: null, resolveProfileDir: () => profileDir, resolveProfileName: () => 'desktop', home } });
  const out2 = res();
  await imported.importArchive(req('POST', { zipBase64: zip.toString('base64') }), out2);
  const payload2 = JSON.parse(out2.body);
  assert.equal(payload2.ok, true);
  assert.equal(payload2.state.state, 'staged');
  assert.equal(readFileSync(join(home, 'settings.yaml'), 'utf8'), 'current: 1\n');
});

test('import 不覆盖 profile 配置', async () => {
  const { home, profileDir } = fixture();
  const archive = buildArchive({
    meta: { format: 'dsh-setting-backup/1', createdAt: '2026-11-09T00:00:00Z', profile: 'desktop', dshVersion: 'x', platform: 'win32', sensitive: false },
    configFiles: [
      { relPath: 'config/profile/cordis.patch.yml', data: Buffer.from('backup\n') },
      { relPath: 'config/home/settings.yaml', data: Buffer.from('backup-settings: 1\n') },
    ],
    plugins: [],
  });
  const handlers = buildHandlers({ deps: { ctx: null, resolveProfileDir: () => profileDir, resolveProfileName: () => 'desktop', home } });
  const out = res();
  await handlers.importArchive(req('POST', { zipBase64: archive.toString('base64') }), out);
  assert.equal(JSON.parse(out.body).ok, true);
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), 'current\n');
  assert.equal(readFileSync(join(home, 'settings.yaml'), 'utf8'), 'backup-settings: 1\n');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/orchestrate.test.mjs`
Expected: FAIL，`handlers.exportArchive is not a function`

- [ ] **Step 3: 在 `buildHandlers` 中新增四个 handler**

```js
import { mkdirSync as mkdir, readFileSync as readFile, writeFileSync as writeFile } from 'node:fs';
import { join as joinPath } from 'node:path';
import { buildArchive, parseArchive } from './archive.js';
import { collectConfig } from './collect.js';
import { computePlan } from './plan.js';
import { createSnapshot } from './snapshots.js';
import { installPlugins } from './install.js';
import { commitConfig } from './apply.js';

// 在 handlers 对象内追加：
const stateDirOf = (profileDir) => joinPath(profileDir, '.setting-backup');

handlers.exportArchive = async (req, res) => {
  if (!guard(req, res, 'POST')) return;
  const body = await readBody(req);
  const home = d.home || (d.resolveHome ? d.resolveHome() : '');
  const profileDir = d.resolveProfileDir(d.ctx);
  const configFiles = await collectConfig({ home, profileDir, includeSensitive: body.includeSensitive === true });
  const plugins = await d.collectPlugins({ profileDir });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const zip = buildArchive({
    meta: {
      format: 'dsh-setting-backup/1', createdAt: new Date().toISOString(),
      profile: d.resolveProfileName(d.ctx), dshVersion: process.env.DSH_VERSION || '', platform: process.platform,
      sensitive: body.includeSensitive === true,
    },
    configFiles,
    plugins,
  });
  const dir = joinPath(stateDirOf(profileDir), 'exports');
  mkdir(dir, { recursive: true });
  const file = joinPath(dir, 'dsh-setting-backup-' + stamp + '.zip');
  writeFile(file, zip);
  sendJson(res, 200, { ok: true, file, bytes: zip.length, plugins: plugins.length });
};

handlers.importArchive = async (req, res) => {
  if (!guard(req, res, 'POST')) return;
  const body = await readBody(req);
  const zip = Buffer.from(String(body.zipBase64 || ''), 'base64');
  if (zip.length === 0) { sendJson(res, 400, { ok: false, reason: 'empty-archive' }); return; }
  const parsed = parseArchive(zip, { allowSensitive: body.allowSensitive === true });
  const profileDir = d.resolveProfileDir(d.ctx);
  const home = d.home || (d.resolveHome ? d.resolveHome() : '');
  const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const staged = joinPath(stateDirOf(profileDir), 'staged', id);
  for (const file of parsed.files) {
    const target = joinPath(staged, file.relPath);
    mkdir(joinPath(target, '..'), { recursive: true });
    writeFile(target, file.data);
  }
  const current = await d.collectPlugins({ profileDir });
  const restorePlan = computePlan({ backupPlugins: parsed.plugins, installed: current });
  // 快照当前生效配置（戳号写入状态，供回退使用）
  const configFiles = await collectConfig({ home, profileDir, includeSensitive: false });
  const snap = createSnapshot({ profileDir, files: configFiles, keep: 5 });
  // 第一段只覆盖 settings.yaml
  for (const file of parsed.files) {
    if (file.relPath === 'config/home/settings.yaml') writeFile(joinPath(home, 'settings.yaml'), file.data);
  }
  const state = writeState(profileDir, {
    state: 'staged', id, staged, plan: restorePlan,
    manifest: parsed.manifest, snapshotsLatest: snap.stamp,
  });
  sendJson(res, 200, { ok: true, plan: restorePlan, state, manifest: parsed.manifest });
};
```

`writeState` 内部会用 `transition(readState()?.state || 'idle', 'staged')` 校验跳转，因此这里直接写 `state: 'staged'` 即可，不需要在 handler 里再判断一次。
```

其中 `transitionState(currentState, next)` 为辅助函数：`currentState` 为 `null`/`idle` 时返回 `next`，否则调 `state.transition`。本任务的实际用法已简化为直接写 `state: 'staged'`（`writeState` 内部完成非法跳转校验），该辅助函数**不需要实现**。

- [ ] **Step 4: 补 `install` / `commit` / `rollback` 三个 handler**

```js
handlers.install = async (req, res) => {
  if (!guard(req, res, 'POST')) return;
  const profileDir = d.resolveProfileDir(d.ctx);
  const state = d.readState(profileDir);
  if (!state || state.state !== 'staged') { sendJson(res, 409, { ok: false, reason: 'no-staged-restore' }); return; }
  writeState(profileDir, { state: 'installing' });
  const result = await installPlugins({
    profile: d.resolveProfileName(d.ctx),
    plan: state.plan,
    cli: d.dshCli,
  });
  writeState(profileDir, {
    state: result.failedCount === 0 ? 'configured' : 'failed',
    installResults: result.results,
  });
  sendJson(res, 200, { ok: result.failedCount === 0, results: result.results });
};

handlers.commit = async (req, res) => {
  if (!guard(req, res, 'POST')) return;
  const profileDir = d.resolveProfileDir(d.ctx);
  const state = d.readState(profileDir);
  if (!state || state.state !== 'configured') { sendJson(res, 409, { ok: false, reason: 'not-configured' }); return; }
  const files = [];
  const staged = state.staged;
  for (const relPath of ['config/profile/cordis.patch.yml', 'config/profile/cordis.yml', 'config/profile/package.json', 'config/profile/pnpm-workspace.yaml', 'config/profile/pnpm-lock.yaml']) {
    const abs = joinPath(staged, relPath);
    if (existsSync(abs)) files.push({ relPath, data: readFile(abs) });
  }
  const pkgFile = files.find((f) => f.relPath === 'config/profile/package.json');
  const bundles = pkgFile ? (JSON.parse(pkgFile.data.toString('utf8')).dsh?.profile?.bundles || []) : [];
  const out = await commitConfig({ profileDir, files, bundles, stamp: state.id || 'restore' });
  sendJson(res, 200, { ok: true, ...out, restartRequired: true });
};

handlers.rollback = async (req, res) => {
  if (!guard(req, res, 'POST')) return;
  const profileDir = d.resolveProfileDir(d.ctx);
  const state = d.readState(profileDir);
  if (state && state.snapshotsLatest) restoreSnapshot({ profileDir, stamp: state.snapshotsLatest });
  clearState(profileDir);
  sendJson(res, 200, { ok: true });
};
```

> 需要把 `existsSync` 与 `transitionState` 一并 import；`state.snapshotsLatest` 由 `createSnapshot` 的返回值写入 import 状态。

- [ ] **Step 5: 运行确认通过**

Run: `node --test test/orchestrate.test.mjs`
Expected: PASS（2 项）

- [ ] **Step 6: 全量测试**

Run: `node --test test/*.test.mjs`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add lib/routes.js test/orchestrate.test.mjs
git commit -m "feat: export/import orchestration with staged two-phase restore"
```

---

### Task 11: 客户端页面

**Files:**
- Modify: `lib/client.js`（替换占位组件为完整页面）
- Create: `lib/client.css.js`（样式字符串模块，便于复用）

**Interfaces:**
- Consumes: `GET /plugins/dsh-setting-backup/status` 等接口
- Produces: 侧栏入口 + 主区面板，含 概览 / 导出 / 导入 / 备份 / 故障 五区

- [ ] **Step 1: 把占位 Panel 换成带状态轮询的页面骨架**

```js
var STATUS = '/plugins/dsh-setting-backup/status';

function useStatus() {
  var state = React.useState(null);
  var status = state[0];
  var setStatus = state[1];
  React.useEffect(function () {
    var alive = true;
    function tick() {
      fetch(STATUS, { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (alive && j) setStatus(j); })
        .catch(function () { /* 忽略瞬时失败 */ });
    }
    tick();
    var timer = setInterval(tick, 2000);
    return function () { alive = false; clearInterval(timer); };
  }, []);
  return status;
}
```

- [ ] **Step 2: 页面渲染五区（含空态与徽标）**

- 概览：`profile`、`bundles.length`、`state.state` 徽标（`staged` 黄 / `installing` 蓝 / `configured` 绿 / `failed` 红 / `idle` 灰）
- 导出：按钮 + 「包含凭据」开关（默认关）+「包含本插件包」开关（默认关），完成后显示文件路径与字节数
- 导入：文本框粘贴 zip 路径或 `input[type=file]` 读为 base64 → 预检报告（missing / versionMismatch / localWarn / extraLocal 四组）+ 「确认覆盖」按钮（二次确认文案含将覆盖的文件清单）
- 备份：`snapshots` 列表 + 「恢复」按钮
- 故障：`state.installResults` 中失败项与 stderr 摘要 + 「重试 / 回退」

所有写操作按钮在请求中禁用，返回后刷新 `useStatus()`。

- [ ] **Step 3: 注册 `settings.section` 并保持 `sidebar.panellist` + `main` 成对**

```js
module.exports.apply = function (ctx) {
  var slots = ctx.get('slots');
  if (!slots || typeof slots.inject !== 'function') return;
  slots.inject('sidebar.panellist', function () {
    return slots.register({ name: 'sidebar.panellist', id: 'dsh-setting-backup', order: 70, label: '配置备份' }, Glyph);
  });
  slots.inject('main', function () {
    return slots.register({ name: 'main', key: 'dsh-setting-backup' }, Panel);
  });
  slots.inject('settings.section', function () {
    return slots.register({ name: 'settings.section', id: 'dsh-setting-backup', order: 905, label: '配置备份' }, SettingsSection);
  });
};
```

- [ ] **Step 4: HMR 验证**

保存 `lib/client.js` 后在浏览器刷新页面（客户端代码走 HMR/重建），确认侧栏入口与页面渲染无报错；打开 DevTools Console 确认无异常。

- [ ] **Step 5: 提交**

```bash
git add lib/client.js lib/client.css.js
git commit -m "feat(client): sidebar panel with export/import/backup sections"
```

---

### Task 12: 真机端到端验证

**Files:** 无新增（验证与文档）
- Modify: `README.md`（补使用与恢复步骤）

- [ ] **Step 1: 链接安装并确认加载**

```bash
dsh plugin --profile desktop add "D:/code/dsh-plugins/dsh-setting-backup"
```

重启后访问 `/plugins/dsh-setting-backup/status`，期望 `{"ok":true,...}`。

- [ ] **Step 2: 导出真实配置**

在侧栏页面点「导出」，确认 `<profile>/.setting-backup/exports/*.zip` 生成；解包核对包含 `manifest.json`、`plugins.json`、`checksums.json`、`config/home/settings.yaml`、`config/profile/package.json`、`config/profile/cordis.patch.yml`；确认 `plugins.json` 中带真实版本号。

- [ ] **Step 3: 故意改动配置**

修改 `cordis.patch.yml` 中某个插件的 config（记下原值），并确认页面「导出」前状态正常。

- [ ] **Step 4: 导入并走完两段式**

1. 导入刚导出的 zip → 预检报告显示 `missing` 为空（本机同环境）
2. 确认覆盖 → 状态 `staged` → 提示重启①
3. 重启① → 页面自动进入安装环节 → 逐条显示（同环境应全部 `ok`）
4. 状态 `configured` → 提示重启②
5. 重启② → 状态 `done` → 核对 `cordis.patch.yml` 已回到备份值

- [ ] **Step 5: 验证守卫与回退**

1. 手动在 `package.json` 的 `bundles` 中加一个不存在的包名，调用 `/commit`，期望返回 `bundle guard failed: <名字>` 且文件未被改动
2. 调用 `/rollback`，确认 `settings.yaml` 与 profile 配置回到导入前

- [ ] **Step 6: 补充 README 并提交**

README 需写明：安装方式、导出/导入步骤、两段式重启说明、凭据默认不导出、`link:`/`file:` 来源跨机需手工处理、失败回退方法。

```bash
git add README.md
git commit -m "docs: document backup/restore workflow and two-phase restart"
```

---

## Self-Review

**1. Spec 覆盖检查**

| Spec 要求 | 对应任务 |
| --- | --- |
| 侧栏入口 | Task 0 / Task 11 |
| 导出配置 + 插件清单与版本 | Task 2 / Task 3 / Task 10 |
| 打包成一个 zip | Task 1 / Task 3 |
| 导入覆盖配置 | Task 10（settings.yaml 立即覆盖；profile 配置在 Task 8 提交） |
| 覆盖前自动快照 | Task 6 / Task 10 |
| 两段式：重启①安装、重启②生效 | Task 5（状态机）/ Task 9（install/commit）/ Task 10 |
| 插件自动安装 | Task 7 / Task 10 |
| bundles 写入前守卫 | Task 4 / Task 8 |
| 凭据默认不导出 | Task 2 / Task 3 |
| zip slip 防护 | Task 1 |
| 失败可回退 | Task 6 / Task 10 |
| 本地备份与轮转 | Task 6 |

无遗漏。

**2. 占位符扫描**

已逐个任务检查，无 TBD / 「类似 Task N」/「补充错误处理」。Task 11 的 UI 描述为结构化要求（五区与交互规则），实现代码在 Step 1/Step 3 给出骨架，符合「UI 布局按描述实现」的可执行要求。

**3. 类型一致性**

- `computePlan` 返回 `{ missing, versionMismatch, localWarn, extraLocal, canInstall, canApply }`，Task 10 直接消费 `missing`/`versionMismatch`，Task 7 使用 `installSpec`，一致。
- `createSnapshot({ profileDir, files, keep })` 返回 `{ stamp, dir, count }`，Task 10 需要 `stamp` 写入状态 —— **修正：Task 10 的 `createSnapshot` 调用需接收返回值并写入 `snapshotsLatest`**，已在 Step 4 的 `rollback` 中依赖该字段，Step 3 的调用处应改为 `const snap = createSnapshot(...)` 并 `snapshotsLatest: snap.stamp`。
- `commitConfig` 返回 `{ written, backups, rolledBack }`，Task 10 的 `commit` 透传，一致。

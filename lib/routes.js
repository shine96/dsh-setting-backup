import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildArchive, parseArchive } from './archive.js';
import { collectConfig, collectPlugins } from './collect.js';
import { computePlan, readBundleList } from './plan.js';
import { createSnapshot, listSnapshots, restoreSnapshot as restoreSnapshotInto } from './snapshots.js';
import { installPlugins } from './install.js';
import { commitConfig } from './apply.js';
import { readState, writeState, clearState } from './state.js';
import { resolveHome, resolveProfileDir, resolveProfileName, stateDir } from './paths.js';
import { stampNow, formatStamp } from './time.js';

const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
// 导出文件名白名单：首字符必须是字母数字（挡掉 "." 开头与 ".."），且只含安全字符
const SAFE_EXPORT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeExportName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 128 &&
    SAFE_EXPORT_NAME.test(name) &&
    !name.includes('..') &&
    name.endsWith('.zip')
  );
}

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
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

function listStagedFiles(stagedDir) {
  if (!existsSync(stagedDir)) return [];
  const out = [];
  for (const rel of readdirSync(stagedDir, { recursive: true })) {
    const normalized = String(rel).replace(/\\/g, '/');
    if (!normalized.startsWith('config/')) continue;
    const abs = join(stagedDir, normalized);
    try {
      if (!statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ relPath: normalized, data: readFileSync(abs) });
  }
  return out;
}

export function buildHandlers({ deps = {}, config = {} } = {}) {
  const d = {
    resolveHome,
    resolveProfileDir,
    resolveProfileName,
    collectConfig,
    collectPlugins,
    readState,
    writeState,
    clearState,
    readBundleList,
    listSnapshots,
    createSnapshot,
    restoreSnapshot: restoreSnapshotInto,
    installPlugins,
    commitConfig,
    ...deps,
  };

  const homeOf = () => (typeof d.home === 'string' && d.home ? d.home : d.resolveHome());
  const profileDirOf = () => d.resolveProfileDir(d.ctx);
  const profileNameOf = () => d.resolveProfileName(d.ctx);
  // 安装是后台任务：同一 profile 同时只允许一个，避免两次导入并发调用包管理器
  const installJob = { runningFor: null };

  function guard(req, res, method) {
    if (rejectNonLocal(req)) {
      sendJson(res, 403, { ok: false, reason: 'untrusted-origin' });
      return false;
    }
    if (req.method !== method) {
      res.writeHead(405, { allow: method });
      res.end();
      return false;
    }
    return true;
  }

  const handlers = {
    async status(req, res) {
      if (!guard(req, res, 'GET')) return;
      const profileDir = profileDirOf();
      const state = d.readState(profileDir);
      const bundles = await d.readBundleList(profileDir);
      const snapshots = d.listSnapshots(profileDir).map((item) => ({
        stamp: item.stamp,
        label: formatStamp(item.stamp),
        files: item.files,
      }));
      sendJson(res, 200, {
        ok: true,
        profile: profileNameOf(),
        profileDir,
        home: homeOf(),
        state: state
          ? { ...state, updatedAtLabel: formatStamp(state.updatedAt) }
          : { state: 'idle' },
        bundles,
        snapshots,
        config,
      });
    },

    async exportArchive(req, res) {
      if (!guard(req, res, 'POST')) return;
      try {
        const body = await readBody(req);
        const profileDir = profileDirOf();
        const home = homeOf();
        const includeSensitive = body.includeSensitive === true;
        const configFiles = await d.collectConfig({ home, profileDir, includeSensitive });
        const plugins = await d.collectPlugins({ profileDir });
        const stamp = stampNow();
        const zip = buildArchive({
          meta: {
            format: 'dsh-setting-backup/1',
            createdAt: new Date().toISOString(),
            profile: profileNameOf(),
            dshVersion: process.env.DSH_VERSION || '',
            platform: process.platform,
            sensitive: includeSensitive,
            counts: { plugins: plugins.length, configFiles: configFiles.length },
          },
          configFiles,
          plugins,
        });
        // 导出包放在 DSH_HOME 下而不是 profile 里：profile 可能被重建，
        // 而 zip 是用户要带走的资产，不能跟着 profile 一起消失。
        const dir = join(homeOf(), 'setting-backup', 'exports');
        mkdirSync(dir, { recursive: true });
        // 文件名用「日期_时间」而不是 ISO 的 T 分隔符：终端与资源管理器里更好读
        const name = 'dsh-setting-backup-' + stamp.replace('T', '_') + '.zip';
        const file = join(dir, name);
        writeFileSync(file, zip);
        sendJson(res, 200, {
          ok: true,
          file,
          name,
          bytes: zip.length,
          plugins: plugins.length,
          configFiles: configFiles.length,
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, reason: String(error && error.message) });
      }
    },

    // 预检：只解析并返回元数据，不落盘、不改配置、不回传任何文件内容。
    // 敏感包也允许预检（否则用户看不到它敏感），但导入仍需显式同意。
    async preview(req, res) {
      if (!guard(req, res, 'POST')) return;
      try {
        const body = await readBody(req);
        const raw = String(body.zipBase64 || '');
        if (!raw) {
          sendJson(res, 400, { ok: false, reason: 'empty-archive' });
          return;
        }
        const parsed = parseArchive(Buffer.from(raw, 'base64'), { allowSensitive: true });
        const profileDir = profileDirOf();
        const installed = await d.collectPlugins({ profileDir });
        const plan = computePlan({ backupPlugins: parsed.plugins, installed });
        sendJson(res, 200, {
          ok: true,
          manifest: { ...parsed.manifest, createdAtLabel: formatStamp(parsed.manifest.createdAt) },
          pluginCount: parsed.plugins.length,
          files: parsed.files.map((file) => ({ relPath: file.relPath, bytes: file.data.length })),
          plan,
        });
      } catch (error) {
        sendJson(res, 400, { ok: false, reason: String(error && error.message) });
      }
    },

    async importArchive(req, res) {
      if (!guard(req, res, 'POST')) return;
      try {
        const body = await readBody(req);
        const raw = String(body.zipBase64 || '');
        if (!raw) {
          sendJson(res, 400, { ok: false, reason: 'empty-archive' });
          return;
        }
        const profileDir = profileDirOf();
        const existing = d.readState(profileDir);
        if (existing && existing.state === 'installing') {
          sendJson(res, 409, { ok: false, reason: 'restore-in-progress' });
          return;
        }
        const parsed = parseArchive(Buffer.from(raw, 'base64'), { allowSensitive: body.allowSensitive === true });
        const home = homeOf();
        const id = stampNow();
        const staged = join(stateDir(profileDir), 'staged', id);
        for (const file of parsed.files) {
          const target = join(staged, file.relPath);
          mkdirSync(join(target, '..'), { recursive: true });
          writeFileSync(target, file.data);
        }
        const currentPlugins = await d.collectPlugins({ profileDir });
        const plan = computePlan({ backupPlugins: parsed.plugins, installed: currentPlugins });

        const currentConfig = await d.collectConfig({ home, profileDir, includeSensitive: false });
        const snap = d.createSnapshot({ profileDir, files: currentConfig, keep: 5 });

        // 第一段只覆盖 settings.yaml：profile 侧的插件配置一律等插件装齐后再提交
        for (const file of parsed.files) {
          if (file.relPath === 'config/home/settings.yaml') {
            writeFileSync(join(home, 'settings.yaml'), file.data);
          }
        }

        // 任何残留状态都先清掉：done/failed/installed 直接写 staged 会触发非法跳转，
        // 而一次新导入本身就是一次全新的恢复会话。
        if (existing && existing.state !== 'idle') d.clearState(profileDir);
        const state = d.writeState(profileDir, {
          state: 'staged',
          id,
          staged,
          plan,
          manifest: parsed.manifest,
          snapshotsLatest: snap.stamp,
        });
        sendJson(res, 200, { ok: true, plan, state, manifest: parsed.manifest });
      } catch (error) {
        sendJson(res, 400, { ok: false, reason: String(error && error.message) });
      }
    },

    async install(req, res) {
      if (!guard(req, res, 'POST')) return;
      try {
        const profileDir = profileDirOf();
        const state = d.readState(profileDir);
        const allowedFrom = ['staged', 'failed', 'installed'];
        if (!state || !allowedFrom.includes(state.state)) {
          sendJson(res, 409, { ok: false, reason: 'no-restore-to-install' });
          return;
        }
        if (installJob.runningFor === profileDir) {
          sendJson(res, 409, { ok: false, reason: 'install-running' });
          return;
        }
        d.writeState(profileDir, { state: 'installing', installResults: [], installError: null });
        installJob.runningFor = profileDir;
        // 立即返回：真实环境下 pnpm add 可能耗时数分钟，同步等待会把请求挂死
        sendJson(res, 202, { ok: true, started: true });

        const plan = state.plan || {};
        Promise.resolve()
          .then(() => d.installPlugins({
            profile: profileNameOf(),
            plan,
            onProgress: (record, done, total) => {
              try {
                const current = d.readState(profileDir) || {};
                d.writeState(profileDir, {
                  installResults: [...(current.installResults || []), record],
                  installProgress: { done, total },
                });
              } catch {
                /* 进度写失败不影响安装本身 */
              }
            },
          }))
          .then((outcome) => {
            d.writeState(profileDir, {
              state: outcome.failedCount === 0 ? 'installed' : 'failed',
              installResults: outcome.results,
              installProgress: { done: outcome.results.length, total: outcome.results.length },
            });
          })
          .catch((error) => {
            try {
              d.writeState(profileDir, { state: 'failed', installError: String(error && error.message) });
            } catch {
              /* 状态已不可写，交给下次启动兜底 */
            }
          })
          .finally(() => {
            installJob.runningFor = null;
          });
      } catch (error) {
        sendJson(res, 500, { ok: false, reason: String(error && error.message) });
      }
    },

    async commit(req, res) {
      if (!guard(req, res, 'POST')) return;
      const profileDir = profileDirOf();
      const state = d.readState(profileDir);
      if (!state || state.state !== 'installed') {
        sendJson(res, 409, { ok: false, reason: 'not-installed' });
        return;
      }
      try {
        const files = listStagedFiles(state.staged);
        const pkgFile = files.find((file) => file.relPath === 'config/profile/package.json');
        const bundles = pkgFile
          ? ((JSON.parse(pkgFile.data.toString('utf8')).dsh || {}).profile || {}).bundles || []
          : [];
        const outcome = await d.commitConfig({
          home: homeOf(),
          profileDir,
          files,
          bundles,
          stamp: state.id || stampNow(),
        });
        d.writeState(profileDir, { state: 'configured', committedAt: new Date().toISOString() });
        sendJson(res, 200, { ok: true, ...outcome, restartRequired: true });
      } catch (error) {
        sendJson(res, 400, { ok: false, reason: String(error && error.message) });
      }
    },

    async rollback(req, res) {
      if (!guard(req, res, 'POST')) return;
      try {
        const profileDir = profileDirOf();
        const state = d.readState(profileDir);
        let restored = 0;
        if (state && state.snapshotsLatest) {
          const list = d.restoreSnapshot({ home: homeOf(), profileDir, stamp: state.snapshotsLatest });
          restored = Array.isArray(list) ? list.length : 0;
        }
        d.clearState(profileDir);
        sendJson(res, 200, { ok: true, restored });
      } catch (error) {
        sendJson(res, 500, { ok: false, reason: String(error && error.message) });
      }
    },

    // 「另存为」用的下载口：只允许取 exports 目录里的 zip，文件名经过白名单校验，
    // 因此既不能穿越目录，也不能读到别的文件。
    async download(req, res) {
      if (!guard(req, res, 'GET')) return;
      try {
        const url = new URL(String(req.url || '/'), 'http://127.0.0.1');
        const name = String(url.searchParams.get('name') || '');
        if (!isSafeExportName(name)) {
          sendJson(res, 400, { ok: false, reason: 'bad-name' });
          return;
        }
        const file = join(homeOf(), 'setting-backup', 'exports', name);
        if (!existsSync(file)) {
          sendJson(res, 404, { ok: false, reason: 'not-found' });
          return;
        }
        const data = readFileSync(file);
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': data.length,
          'content-disposition': 'attachment; filename="' + name + '"',
        });
        res.end(data);
      } catch (error) {
        sendJson(res, 500, { ok: false, reason: String(error && error.message) });
      }
    },

    async markDone(req, res) {
      if (!guard(req, res, 'POST')) return;
      const profileDir = profileDirOf();
      const state = d.readState(profileDir);
      if (!state || state.state !== 'configured') {
        sendJson(res, 409, { ok: false, reason: 'not-configured' });
        return;
      }
      // 配置已生效，暂存区不再需要；.bak 与快照保留，作为回退依据
      try {
        if (state.staged) rmSync(state.staged, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响收尾 */
      }
      sendJson(res, 200, { ok: true, state: d.writeState(profileDir, { state: 'done', staged: null }) });
    },

    async restoreSnapshotHandler(req, res) {
      if (!guard(req, res, 'POST')) return;
      try {
        const body = await readBody(req);
        if (!body.stamp) {
          sendJson(res, 400, { ok: false, reason: 'stamp-required' });
          return;
        }
        const restored = d.restoreSnapshot({ home: homeOf(), profileDir: profileDirOf(), stamp: body.stamp });
        sendJson(res, 200, { ok: true, restored: Array.isArray(restored) ? restored.length : 0 });
      } catch (error) {
        sendJson(res, 400, { ok: false, reason: String(error && error.message) });
      }
    },

    async deleteSnapshot(req, res) {
      if (!guard(req, res, 'POST')) return;
      try {
        const body = await readBody(req);
        if (!body.stamp) {
          sendJson(res, 400, { ok: false, reason: 'stamp-required' });
          return;
        }
        const dir = join(stateDir(profileDirOf()), 'snapshots', String(body.stamp));
        rmSync(dir, { recursive: true, force: true });
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { ok: false, reason: String(error && error.message) });
      }
    },
  };

  return handlers;
}

export function registerRoutes(hostCtx, ctx, config = {}, deps = {}) {
  const handlers = buildHandlers({ deps: { ...deps, ctx }, config });
  const map = [
    ['/plugins/dsh-setting-backup/status', handlers.status],
    ['/plugins/dsh-setting-backup/export', handlers.exportArchive],
    ['/plugins/dsh-setting-backup/download', handlers.download],
    ['/plugins/dsh-setting-backup/preview', handlers.preview],
    ['/plugins/dsh-setting-backup/import', handlers.importArchive],
    ['/plugins/dsh-setting-backup/install', handlers.install],
    ['/plugins/dsh-setting-backup/commit', handlers.commit],
    ['/plugins/dsh-setting-backup/rollback', handlers.rollback],
    ['/plugins/dsh-setting-backup/done', handlers.markDone],
    ['/plugins/dsh-setting-backup/restore-snapshot', handlers.restoreSnapshotHandler],
    ['/plugins/dsh-setting-backup/delete-snapshot', handlers.deleteSnapshot],
  ];
  const disposers = map.map(([path, handler]) => hostCtx.webServer.register({ kind: 'exact', path, handler }));
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* 已卸载 */
      }
    }
  };
}

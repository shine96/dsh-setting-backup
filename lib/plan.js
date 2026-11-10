import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 计算还原差异。
 * - missing：备份里有、本机没装（registry 来源）
 * - versionMismatch：本机装了但版本与备份不一致
 * - localWarn：备份来源是 link/file/github/tarball，跨机不保证可还原
 * - extraLocal：本机有、备份里没有（默认保留，不卸载）
 */
export function computePlan({ backupPlugins, installed }) {
  const installedMap = new Map((installed || []).map((plugin) => [plugin.name, plugin]));
  const backupNames = new Set((backupPlugins || []).map((plugin) => plugin.name));
  const missing = [];
  const versionMismatch = [];
  const localWarn = [];
  const extraLocal = (installed || []).filter((plugin) => !backupNames.has(plugin.name));

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

/**
 * bundles 守卫：名单里每一个包都必须在 node_modules 下存在，否则 DSH 启动会被
 * bundle 解析检查判为 cannot resolve 而拒绝启动。这是整个还原流程不可让渡的前提。
 *
 * 例外由官方口径决定（dsh-undo-savepoint 的 HOST_MANAGED_BUNDLE_RE）：
 * 桌面 profile 的 @deepseek-ai/dsh-* 由宿主自带，本机在 node_modules 里解析不到属正常，
 * 例如 @deepseek-ai/dsh-base、dsh-web-app；把它们判成缺失会让任何真实环境的提交都被拒。
 * 该豁免只在「包确实不在 node_modules」时生效，已安装的包照常按存在处理。
 */
const HOST_MANAGED_BUNDLE_RE = /^@deepseek-ai\/dsh(?:-|$)/;

export function assertBundlesResolvable(profileDir, bundles, deps = {}) {
  const exists = deps.exists || existsSync;
  const unresolvable = [];
  for (const name of bundles || []) {
    if (!name) continue;
    const pkgPath = join(profileDir, 'node_modules', name, 'package.json');
    if (exists(pkgPath)) continue;
    if (HOST_MANAGED_BUNDLE_RE.test(name)) continue;
    unresolvable.push(name);
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

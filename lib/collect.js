import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const PROFILE_FILES = [
  'package.json',
  'cordis.patch.yml',
  'cordis.yml',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
];
const HOME_FILES = ['settings.yaml'];
const SENSITIVE_FILES = ['.credentials.yaml', '.env'];
// DSH_HOME 根下由插件自己落盘的小配置文件；缓存/状态/索引类不纳入备份。
const HOME_PLUGIN_CONFIG_SKIP = /(cache|state|market|sync|log)/i;

export function classifySource(declared) {
  const raw = String(declared || '').trim();
  if (raw.startsWith('link:')) return 'link';
  if (raw.startsWith('file:')) return 'file';
  if (raw.startsWith('github:') || raw.startsWith('git+') || raw.includes('github.com')) return 'github';
  if (/^https?:\/\//.test(raw)) return 'tarball';
  return 'registry';
}

async function readIfExists(absPath) {
  try {
    return await readFile(absPath);
  } catch {
    return null;
  }
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
  try {
    entries = await readdir(home);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.startsWith('.')) continue;
    if (HOME_PLUGIN_CONFIG_SKIP.test(entry)) continue;
    await push('config/home/' + entry, join(home, entry));
  }
  return out;
}

export async function collectPlugins({ profileDir }) {
  const raw = await readIfExists(join(profileDir, 'package.json'));
  if (!raw) return [];
  let pkg = {};
  try {
    pkg = JSON.parse(raw.toString('utf8'));
  } catch {
    return [];
  }
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
      } catch {
        /* 安装物损坏按未安装处理 */
      }
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

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertBundlesResolvable } from './plan.js';

function targetOf({ home, profileDir }, relPath) {
  if (relPath.startsWith('config/home/')) return join(home, relPath.slice('config/home/'.length));
  if (relPath.startsWith('config/profile/')) return join(profileDir, relPath.slice('config/profile/'.length));
  return join(profileDir, relPath);
}

/**
 * 提交配置（第二段）。顺序固定：
 *   ① bundles 守卫（不可解析即抛错，此时一个文件都还没写）
 *   ② 逐个覆盖目标文件，覆盖前留 .bak-<stamp>
 *   ③ 写 dsh.profile.bundles
 */
export async function commitConfig({ home, profileDir, files, bundles, stamp, deps = {} }) {
  const guard = assertBundlesResolvable(profileDir, bundles || [], deps);
  if (!guard.ok) {
    throw new Error('bundle guard failed: ' + guard.unresolvable.join(','));
  }

  const backups = [];
  const written = [];
  for (const file of files || []) {
    const target = targetOf({ home, profileDir }, file.relPath);
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

/** 用 .bak-<stamp> 把刚覆盖的文件还原回去。 */
export function rollbackBackups(backups) {
  const restored = [];
  for (const bak of backups || []) {
    const original = bak.replace(/\.bak-[^.]+$/, '');
    if (!existsSync(bak) || original === bak) continue;
    copyFileSync(bak, original);
    restored.push(original);
  }
  return restored;
}

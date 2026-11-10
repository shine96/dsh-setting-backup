import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { snapshotsDir } from './paths.js';
import { stampNow } from './time.js';

export function createSnapshot({ profileDir, files, keep = 5 }) {
  const stamp = stampNow();
  const dir = join(snapshotsDir(profileDir), stamp);
  mkdirSync(dir, { recursive: true });
  let count = 0;
  for (const file of files || []) {
    if (!file.absPath || !existsSync(file.absPath)) continue;
    const dest = join(dir, file.relPath);
    mkdirSync(dirname(dest), { recursive: true });
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
    .filter((name) => {
      try {
        return statSync(join(root, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .map((stamp) => {
      const dir = join(root, stamp);
      let files = 0;
      try {
        files = readdirSync(dir, { recursive: true }).length;
      } catch {
        files = 0;
      }
      return { stamp, dir, files };
    });
}

export function rotateSnapshots(profileDir, keep = 5) {
  const all = listSnapshots(profileDir);
  const overflow = all.slice(0, Math.max(0, all.length - keep));
  for (const item of overflow) rmSync(item.dir, { recursive: true, force: true });
  return overflow.map((item) => item.stamp);
}

function* walk(root, rel) {
  const dir = rel ? join(root, rel) : root;
  for (const name of readdirSync(dir)) {
    const nextRel = rel ? rel + '/' + name : name;
    const abs = join(root, nextRel);
    if (statSync(abs).isDirectory()) yield* walk(root, nextRel);
    else yield { rel: nextRel, abs };
  }
}

/**
 * 按快照内的相对前缀还原到原位：
 *   config/home/...    -> <home>/...
 *   config/profile/... -> <profileDir>/...
 */
export function restoreSnapshot({ home, profileDir, stamp }) {
  const root = join(snapshotsDir(profileDir), stamp);
  if (!existsSync(root)) throw new Error('snapshot not found: ' + stamp);
  const restored = [];
  for (const entry of walk(root, '')) {
    let dest = null;
    if (entry.rel.startsWith('config/home/')) dest = join(home, entry.rel.slice('config/home/'.length));
    else if (entry.rel.startsWith('config/profile/')) dest = join(profileDir, entry.rel.slice('config/profile/'.length));
    if (!dest) continue;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(entry.abs, dest);
    restored.push(dest);
  }
  return restored;
}

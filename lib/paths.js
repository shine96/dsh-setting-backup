import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveHome(env = process.env) {
  if (env && env.DSH_HOME) return env.DSH_HOME;
  const base = env && env.USERPROFILE ? env.USERPROFILE : homedir();
  return join(base, '.dsh');
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

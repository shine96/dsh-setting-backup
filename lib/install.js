import { spawn } from 'node:child_process';

export function resolveDshCli(env = process.env) {
  return (env && env.DSH_CLI) || 'dsh';
}

/**
 * 官方安装入口：`dsh plugin --profile <name> add <spec>`。
 * 它把参数转发给 profile 目录下的 pnpm，并由 add 步骤维护依赖与 bundle 列表，
 * 因此不要自己往 profile 目录里跑包管理器。
 */
export function buildAddArgs({ profile, spec }) {
  return ['plugin', '--profile', profile, 'add', spec];
}

function runOnce({ cli, args, spawnImpl }) {
  const spawnFn = spawnImpl || spawn;
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const done = (code, message) => {
      if (settled) return;
      settled = true;
      resolve({ code: code === null || code === undefined ? 1 : code, stderr: message });
    };
    let child;
    try {
      child = spawnFn(cli, args, { shell: process.platform === 'win32', windowsHide: true });
    } catch (error) {
      done(1, String(error && error.message));
      return;
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
    }
    child.on('close', (code) => done(code, stderr));
    child.on('error', (error) => done(1, String(error && error.message)));
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
      stderr: String(outcome.stderr || '').slice(-2000),
    };
    results.push(record);
    if (typeof onProgress === 'function') onProgress(record, results.length, queue.length);
  }
  const failedCount = results.filter((record) => !record.ok).length;
  return { results, okCount: results.length - failedCount, failedCount };
}

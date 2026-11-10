// test/all.mjs —— 同一进程内依次 import 所有测试文件。
// 原因：本机沙箱禁止 `node --test` 为每个文件 spawn 子进程（spawn EPERM），
// 而 node:test 的断言与报告在同进程内完全一致。
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

for (const name of files) {
  await import(pathToFileURL(join(here, name)).href);
}

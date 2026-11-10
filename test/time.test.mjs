import test from 'node:test';
import assert from 'node:assert/strict';
import { stampNow, formatStamp } from '../lib/time.js';

const pad = (n) => String(n).padStart(2, '0');

test('stampNow 用本地时间，格式为 YYYY-MM-DDTHH-mm-ss（文件系统安全、可排序）', () => {
  const local = new Date(2026, 10, 9, 17, 5, 8);
  assert.equal(stampNow(local.getTime()), '2026-11-09T17-05-08');
});

test('formatStamp 把本地 stamp 显示为 yyyy-MM-dd HH:mm:ss', () => {
  assert.equal(formatStamp('2026-11-09T17-05-08'), '2026-11-09 17:05:08');
});

test('formatStamp 兼容真 ISO（含时区）并转成本地时间显示', () => {
  const d = new Date('2026-11-09T09:05:08Z');
  const expected =
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  assert.equal(formatStamp('2026-11-09T09:05:08Z'), expected);
});

test('formatStamp 对空值与不可解析值原样兜底', () => {
  assert.equal(formatStamp(''), '');
  assert.equal(formatStamp(null), '');
  assert.equal(formatStamp('not-a-time'), 'not-a-time');
});

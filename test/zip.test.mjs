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

test('writeZip 在写入阶段就拒绝越界条目', () => {
  assert.throws(() => writeZip([{ path: '../evil.txt', data: Buffer.from('x') }]), /unsafe/);
});

test('readZip 对篡改后的越界条目名抛错（纵深防御）', () => {
  // 用一个等长（7 字节）的合法名写入，再把名字原地改成 ../evil，模拟外部构造的恶意包
  const evil = Buffer.from(writeZip([{ path: 'aab.txt', data: Buffer.from('x') }]));
  let idx = evil.indexOf('aab.txt');
  while (idx >= 0) {
    evil.write('../evil', idx, 'utf8');
    idx = evil.indexOf('aab.txt', idx + 7);
  }
  assert.throws(() => readZip(evil), /unsafe/);
});

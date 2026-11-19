import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { readPack, type PackedObject } from '../git-pack.ts';

const base = Buffer.from('hello world');
const first = Buffer.from('hello there');
const second = Buffer.from('hello there!');
const delta1 = Buffer.concat([Buffer.from([11, 11, 0x90, 6, 5]), Buffer.from('there')]);
const delta2 = Buffer.from([11, 12, 0x90, 11, 1, 33]);
const id = (data: Buffer) => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
const repo = () => ({ objects: new Map<string, PackedObject>() });

function header(code: number, size: number): Buffer {
  const bytes = [(code << 4) | (size & 15)];
  size = Math.floor(size / 16);
  while (size) {
    bytes[bytes.length - 1] |= 128;
    bytes.push(size & 127);
    size = Math.floor(size / 128);
  }
  return Buffer.from(bytes);
}

function entry(code: number, data: Buffer, extra = Buffer.alloc(0)): Buffer {
  return Buffer.concat([header(code, data.length), extra, deflateSync(data)]);
}

function pack(entries: Buffer[]): Buffer {
  const start = Buffer.alloc(12);
  start.write('PACK');
  start.writeUInt32BE(2, 4);
  start.writeUInt32BE(entries.length, 8);
  const data = Buffer.concat([start, ...entries]);
  return Buffer.concat([data, createHash('sha1').update(data).digest()]);
}

function offset(value: number): Buffer {
  const bytes = [value & 127];
  while ((value = Math.floor(value / 128))) {
    value--;
    bytes.unshift(128 | (value & 127));
  }
  return Buffer.from(bytes);
}

test('pack decoder resolves chained offset deltas with exact object hashes', () => {
  const store = repo();
  const plain = entry(3, base);
  const changed = entry(6, delta1, offset(plain.length));
  const changedAgain = entry(6, delta2, offset(changed.length));
  readPack(pack([plain, changed, changedAgain]), store);
  assert.equal(store.objects.size, 3);
  assert.deepEqual(store.objects.get(id(base))?.data, base);
  assert.deepEqual(store.objects.get(id(first))?.data, first);
  assert.deepEqual(store.objects.get(id(second))?.data, second);
});

test('pack decoder resolves forward reference deltas and thin-pack external bases', () => {
  const forward = repo();
  readPack(pack([entry(7, delta1, Buffer.from(id(base), 'hex')), entry(3, base)]), forward);
  assert.deepEqual(forward.objects.get(id(first))?.data, first);
  const thin = repo();
  thin.objects.set(id(base), { type: 'blob', data: base });
  readPack(pack([entry(7, delta1, Buffer.from(id(base), 'hex'))]), thin);
  assert.deepEqual(thin.objects.get(id(first))?.data, first);
});

test('pack decoder rejects checksum errors without publishing any objects', () => {
  const store = repo();
  const damaged = pack([entry(3, base)]);
  damaged[damaged.length - 1] ^= 1;
  assert.throws(() => readPack(damaged, store), /checksum/);
  assert.equal(store.objects.size, 0);
});

test('pack decoder rejects missing bases and invalid delta copies atomically', () => {
  const store = repo();
  assert.throws(() => readPack(pack([entry(3, base), entry(7, delta1, Buffer.alloc(20, 42))]), store), /missing/);
  assert.equal(store.objects.size, 0);
  const invalidCopy = Buffer.from([11, 1, 0x91, 255, 1]);
  assert.throws(() => readPack(pack([entry(3, base), entry(7, invalidCopy, Buffer.from(id(base), 'hex'))]), store), /bounds/);
  assert.equal(store.objects.size, 0);
});

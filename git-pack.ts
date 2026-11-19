import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface PackedObject { type: ObjectType; data: Buffer }
type ObjectStore = { objects: Map<string, PackedObject> };
interface Entry {
  offset: number;
  code: number;
  data: Buffer;
  baseOffset?: number;
  baseId?: string;
  resolved?: PackedObject;
}

const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_PACK_BYTES = 128 * 1024 * 1024;
const MAX_DECODED_BYTES = 256 * 1024 * 1024;
const TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function objectId(object: PackedObject): string {
  return createHash('sha1').update(`${object.type} ${object.data.length}\0`).update(object.data).digest('hex');
}

/** Apply Git's delta instruction format, validating every read and output extent. */
function delta(base: Buffer, instructions: Buffer): Buffer {
  let cursor = 0;
  function byte(): number {
    if (cursor >= instructions.length) throw new Error('truncated delta');
    return instructions[cursor++];
  }
  function variable(): number {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 8; index++) {
      const next = byte();
      value += (next & 127) * multiplier;
      if (!Number.isSafeInteger(value) || value > MAX_OBJECT_BYTES) throw new Error('delta size limit');
      if (!(next & 128)) return value;
      multiplier *= 128;
    }
    throw new Error('invalid delta size');
  }
  if (variable() !== base.length) throw new Error('delta base size mismatch');
  const size = variable();
  const result = Buffer.alloc(size);
  let written = 0;
  while (cursor < instructions.length) {
    const opcode = byte();
    if (opcode & 128) {
      let offset = 0;
      let count = 0;
      for (let index = 0; index < 4; index++) if (opcode & (1 << index)) offset += byte() * 2 ** (8 * index);
      for (let index = 0; index < 3; index++) if (opcode & (1 << (index + 4))) count += byte() * 2 ** (8 * index);
      if (!count) count = 65536;
      if (offset + count > base.length || written + count > size) throw new Error('delta copy out of bounds');
      base.copy(result, written, offset, offset + count);
      written += count;
    } else {
      if (!opcode || cursor + opcode > instructions.length || written + opcode > size) throw new Error('invalid delta insert');
      instructions.copy(result, written, cursor, cursor + opcode);
      cursor += opcode;
      written += opcode;
    }
  }
  if (written !== size) throw new Error('delta target size mismatch');
  return result;
}

/** Decode a complete pack. Objects are published only after checksum and delta validation succeed. */
export function readPack(pack: Buffer, repo: ObjectStore): void {
  if (pack.length < 32 || pack.length > MAX_PACK_BYTES || pack.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('invalid pack header');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = pack.readUInt32BE(8);
  if (count > 100_000) throw new Error('pack object count limit');
  const end = pack.length - 20;
  const digest = createHash('sha1').update(pack.subarray(0, end)).digest();
  if (!digest.equals(pack.subarray(end))) throw new Error('pack checksum mismatch');

  let cursor = 12;
  let decodedBytes = 0;
  function byte(): number {
    if (cursor >= end) throw new Error('truncated pack object');
    return pack[cursor++];
  }
  const entries: Entry[] = [];
  const offsets = new Map<number, Entry>();
  for (let index = 0; index < count; index++) {
    const offset = cursor;
    let header = byte();
    const code = (header >> 4) & 7;
    if (!TYPES[code] && code !== 6 && code !== 7) throw new Error('unsupported pack object type');
    let size = header & 15;
    let multiplier = 16;
    let headerBytes = 1;
    while (header & 128) {
      if (++headerBytes > 8) throw new Error('invalid pack object size');
      header = byte();
      size += (header & 127) * multiplier;
      multiplier *= 128;
      if (!Number.isSafeInteger(size) || size > MAX_OBJECT_BYTES) throw new Error('pack object size limit');
    }
    let baseOffset: number | undefined;
    let baseId: string | undefined;
    if (code === 6) {
      let next = byte();
      let distance = next & 127;
      let width = 1;
      while (next & 128) {
        if (++width > 8) throw new Error('invalid delta offset');
        next = byte();
        distance = (distance + 1) * 128 + (next & 127);
        if (!Number.isSafeInteger(distance) || distance > offset - 12) throw new Error('invalid delta offset');
      }
      baseOffset = offset - distance;
      if (!distance || !offsets.has(baseOffset)) throw new Error('missing offset delta base');
    } else if (code === 7) {
      if (cursor + 20 > end) throw new Error('truncated delta object id');
      baseId = pack.subarray(cursor, cursor + 20).toString('hex');
      cursor += 20;
    }
    const inflated = inflateSync(pack.subarray(cursor, end), { info: true, maxOutputLength: MAX_OBJECT_BYTES }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== size) throw new Error('pack object size mismatch');
    const consumed = inflated.engine.bytesWritten;
    if (!Number.isInteger(consumed) || consumed <= 0 || cursor + consumed > end) throw new Error('invalid compressed object');
    cursor += consumed;
    decodedBytes += inflated.buffer.length;
    if (decodedBytes > MAX_DECODED_BYTES) throw new Error('pack decoded size limit');
    const entry: Entry = { offset, code, data: inflated.buffer, baseOffset, baseId };
    offsets.set(offset, entry);
    entries.push(entry);
  }
  if (cursor !== end) throw new Error('trailing pack data');

  const staged = new Map<string, PackedObject>();
  function publish(entry: Entry, object: PackedObject): void {
    const id = objectId(object);
    const stored = repo.objects.get(id) ?? staged.get(id) ?? object;
    entry.resolved = stored;
    staged.set(id, stored);
  }
  let pending: Entry[] = [];
  for (const entry of entries) {
    if (TYPES[entry.code]) publish(entry, { type: TYPES[entry.code], data: entry.data });
    else pending.push(entry);
  }
  while (pending.length) {
    const remaining: Entry[] = [];
    for (const entry of pending) {
      const base = entry.baseOffset !== undefined
        ? offsets.get(entry.baseOffset)?.resolved
        : staged.get(entry.baseId!) ?? repo.objects.get(entry.baseId!);
      if (!base) {
        remaining.push(entry);
        continue;
      }
      const data = delta(base.data, entry.data);
      decodedBytes += data.length;
      if (decodedBytes > MAX_DECODED_BYTES) throw new Error('pack decoded size limit');
      publish(entry, { type: base.type, data });
    }
    if (remaining.length === pending.length) throw new Error('missing or cyclic reference delta base');
    pending = remaining;
  }
  for (const [id, object] of staged) repo.objects.set(id, object);
}

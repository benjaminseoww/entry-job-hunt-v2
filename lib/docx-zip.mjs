/**
 * lib/docx-zip.mjs — a minimal, dependency-free ZIP writer and reader, just
 * enough for an Office Open XML package (.docx).
 *
 * Deterministic on purpose: entry order is the caller's order and every entry
 * carries the same fixed timestamp, so the same input produces the same bytes
 * (the generator's tests rely on it).
 *
 * Reading handles only what this module writes and what Word writes for a
 * plain document: stored and deflated entries, no encryption, no ZIP64.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';

// 1980-01-01 00:00:00 in DOS date/time.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** @param {Uint8Array} buf @returns {number} */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function assertSafeZipName(name) {
  if (typeof name !== 'string'
    || name.length === 0
    || name.startsWith('/')
    || name.includes('\\')
    || name.includes('..')
    || name.includes('\0')
    || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Unsafe zip entry name: ${JSON.stringify(name)}`);
  }
}

/**
 * @param {{name: string, data: Buffer|string}[]} entries
 * @returns {Buffer}
 */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    assertSafeZipName(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** Refuse to inflate a single entry larger than this. */
export const MAX_ZIP_ENTRY_BYTES = 20 * 1024 * 1024;
/** Refuse a zip whose raw bytes are larger than this. */
export const MAX_ZIP_BYTES = 25 * 1024 * 1024;

function u16(buf, off) {
  if (off < 0 || off + 2 > buf.length) throw new Error('Corrupt zip: truncated header');
  return buf.readUInt16LE(off);
}

function u32(buf, off) {
  if (off < 0 || off + 4 > buf.length) throw new Error('Corrupt zip: truncated header');
  return buf.readUInt32LE(off);
}

function findEocd(buf) {
  if (!buf || buf.length < 22) throw new Error('Not a zip file: end-of-central-directory record not found');
  if (buf.length > MAX_ZIP_BYTES) throw new Error(`Corrupt zip: file exceeds ${MAX_ZIP_BYTES} bytes`);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file: end-of-central-directory record not found');
  return eocd;
}

/** Central-directory rows. Names only; nothing is inflated. */
function* zipDirectory(buf) {
  const eocd = findEocd(buf);
  const count = u16(buf, eocd + 10);
  let p = u32(buf, eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length) throw new Error('Corrupt zip: truncated central directory');
    if (u32(buf, p) !== 0x02014b50) throw new Error('Corrupt zip: bad central directory entry');
    const method = u16(buf, p + 10);
    const crc = u32(buf, p + 16);
    const compSize = u32(buf, p + 20);
    const uncompSize = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const localOffset = u32(buf, p + 42);
    if (p + 46 + nameLen > buf.length) throw new Error('Corrupt zip: truncated central directory');
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (p > buf.length) throw new Error('Corrupt zip: truncated central directory');
    yield { name, method, crc, compSize, uncompSize, localOffset };
  }
}

/** Entry names in the zip, without inflating any of them. */
export function listZipNames(buf) {
  return [...zipDirectoryMap(buf).keys()];
}

/**
 * Central-directory rows keyed by name. Parsed once so a caller can inflate
 * selected parts without walking the directory again.
 *
 * @param {Buffer} buf
 * @returns {Map<string, {name: string, method: number, crc: number, compSize: number, uncompSize: number, localOffset: number}>}
 */
export function zipDirectoryMap(buf) {
  const byName = new Map();
  for (const entry of zipDirectory(buf)) byName.set(entry.name, entry);
  return byName;
}

/**
 * Inflate one central-directory row. `entry` comes from `zipDirectoryMap`.
 *
 * @param {Buffer} buf
 * @param {{name: string, method: number, crc: number, compSize: number, uncompSize: number, localOffset: number}} entry
 * @param {{maxBytes?: number}} [opts]
 * @returns {Buffer}
 */
export function inflateZipEntry(buf, entry, { maxBytes = MAX_ZIP_ENTRY_BYTES } = {}) {
  const { name, method, crc, compSize, uncompSize, localOffset } = entry;
  if (uncompSize > maxBytes || compSize > maxBytes) {
    throw new Error(`Corrupt zip: entry ${name} exceeds ${maxBytes} bytes`);
  }
  if (localOffset + 30 > buf.length) throw new Error(`Corrupt zip: truncated local header for ${name}`);
  if (u32(buf, localOffset) !== 0x04034b50) throw new Error(`Corrupt zip: bad local header for ${name}`);
  const lName = u16(buf, localOffset + 26);
  const lExtra = u16(buf, localOffset + 28);
  const start = localOffset + 30 + lName + lExtra;
  if (start < 0 || start + compSize > buf.length) {
    throw new Error(`Corrupt zip: truncated data for ${name}`);
  }
  const body = buf.subarray(start, start + compSize);
  let data;
  try {
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = inflateRawSync(body, { maxOutputLength: maxBytes });
    else throw new Error(`Unsupported zip compression method ${method} for ${name}`);
  } catch (err) {
    if (err && /Unsupported zip compression/.test(err.message)) throw err;
    throw new Error(`Corrupt zip: cannot inflate ${name}`);
  }
  if (data.length > maxBytes) throw new Error(`Corrupt zip: entry ${name} exceeds ${maxBytes} bytes`);
  if (crc32(data) !== crc) throw new Error(`Corrupt zip: checksum mismatch for ${name}`);
  return data;
}

/**
 * Inflate selected zip entries. `names` omitted (or null) inflates every
 * entry, the same as `readZip`. A listed name that is missing is skipped.
 * An entry whose declared uncompressed (or compressed) size exceeds
 * `maxBytes` is refused before inflate.
 *
 * @param {Buffer} buf
 * @param {Iterable<string>|null} [names]
 * @param {{maxBytes?: number}} [opts]
 * @returns {Map<string, Buffer>}
 */
export function readZipEntries(buf, names = null, { maxBytes = MAX_ZIP_ENTRY_BYTES } = {}) {
  const wanted = names == null ? null : new Set(names);
  const out = new Map();
  for (const entry of zipDirectoryMap(buf).values()) {
    if (wanted && !wanted.has(entry.name)) continue;
    out.set(entry.name, inflateZipEntry(buf, entry, { maxBytes }));
  }
  return out;
}

/**
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>} entry name → uncompressed bytes
 */
export function readZip(buf) {
  return readZipEntries(buf);
}

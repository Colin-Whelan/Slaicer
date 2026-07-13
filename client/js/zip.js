// Minimal ZIP writer (store / no compression — PNGs are already compressed).
// No dependencies. Pure: makeZip(files) -> Uint8Array. Unit-testable in node.

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const w16 = (a, v) => { a.push(v & 0xff, (v >>> 8) & 0xff); };
const w32 = (a, v) => { a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); };

/**
 * @param {Array<{name:string,data:Uint8Array}>} files
 * @returns {Uint8Array} zip archive bytes
 */
export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = []; // Uint8Arrays of local headers + names + data
  const central = []; // bytes of central directory
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);

    const lh = [];
    w32(lh, 0x04034b50); w16(lh, 20); w16(lh, 0); w16(lh, 0); // sig, ver, flags, method(store)
    w16(lh, 0); w16(lh, 0); // modtime, moddate
    w32(lh, crc); w32(lh, data.length); w32(lh, data.length);
    w16(lh, name.length); w16(lh, 0);
    const lhBytes = new Uint8Array(lh);
    parts.push(lhBytes, name, data);

    w32(central, 0x02014b50); w16(central, 20); w16(central, 20); w16(central, 0); w16(central, 0);
    w16(central, 0); w16(central, 0); // modtime, moddate
    w32(central, crc); w32(central, data.length); w32(central, data.length);
    w16(central, name.length); w16(central, 0); w16(central, 0); // namelen, extralen, commentlen
    w16(central, 0); w16(central, 0); w32(central, 0); // diskStart, intAttr, extAttr
    w32(central, offset);
    for (const b of name) central.push(b);

    offset += lhBytes.length + name.length + data.length;
  }

  const centralBytes = new Uint8Array(central);
  const end = [];
  w32(end, 0x06054b50); w16(end, 0); w16(end, 0);
  w16(end, files.length); w16(end, files.length);
  w32(end, centralBytes.length); w32(end, offset); w16(end, 0);
  const endBytes = new Uint8Array(end);

  const total = offset + centralBytes.length + endBytes.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  out.set(centralBytes, p); p += centralBytes.length;
  out.set(endBytes, p);
  return out;
}

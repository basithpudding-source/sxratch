// js/zip.js
// Standard PKZip 2.0 archive writer (Method 0: Store) for bundling stems & project files.

// Precompute CRC32 lookup table
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}

export function crc32(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Creates a standard PKZip Blob from an array of files.
 * @param {Array<{ name: string, data: Uint8Array | ArrayBuffer | Blob }>} files
 * @returns {Promise<Blob>}
 */
export async function createZip(files) {
  const fileEntries = [];
  const enc = new TextEncoder();

  for (const f of files) {
    let bytes;
    if (f.data instanceof Blob) {
      bytes = new Uint8Array(await f.data.arrayBuffer());
    } else if (f.data instanceof Uint8Array) {
      bytes = f.data;
    } else if (f.data instanceof ArrayBuffer) {
      bytes = new Uint8Array(f.data);
    } else {
      throw new Error(`Unsupported data type for zip file: ${f.name}`);
    }

    const nameBytes = enc.encode(f.name.replace(/\\/g, "/"));
    const crc = crc32(bytes);
    const size = bytes.length;

    fileEntries.push({
      nameBytes,
      bytes,
      crc,
      size,
    });
  }

  let localTotal = 0;
  let cdTotal = 0;
  for (const entry of fileEntries) {
    localTotal += 30 + entry.nameBytes.length + entry.size;
    cdTotal += 46 + entry.nameBytes.length;
  }
  const eocdSize = 22;
  const out = new Uint8Array(localTotal + cdTotal + eocdSize);
  const view = new DataView(out.buffer);

  let localOffset = 0;
  const offsets = [];

  // Write local headers and file payloads
  for (const entry of fileEntries) {
    offsets.push(localOffset);

    // Signature 0x04034b50
    view.setUint32(localOffset, 0x04034b50, true);
    view.setUint16(localOffset + 4, 20, true); // Version 2.0
    view.setUint16(localOffset + 6, 0x0800, true); // General purpose flag: UTF-8 filenames
    view.setUint16(localOffset + 8, 0, true); // Compression method: 0 (Stored)
    view.setUint16(localOffset + 10, 0, true); // Last mod time
    view.setUint16(localOffset + 12, 0, true); // Last mod date
    view.setUint32(localOffset + 14, entry.crc, true);
    view.setUint32(localOffset + 18, entry.size, true); // Compressed size
    view.setUint32(localOffset + 22, entry.size, true); // Uncompressed size
    view.setUint16(localOffset + 26, entry.nameBytes.length, true);
    view.setUint16(localOffset + 28, 0, true); // Extra field length

    out.set(entry.nameBytes, localOffset + 30);
    out.set(entry.bytes, localOffset + 30 + entry.nameBytes.length);

    localOffset += 30 + entry.nameBytes.length + entry.size;
  }

  // Write Central Directory headers
  const cdOffset = localOffset;
  let cdPtr = cdOffset;

  for (let i = 0; i < fileEntries.length; i++) {
    const entry = fileEntries[i];
    const off = offsets[i];

    // Signature 0x02014b50
    view.setUint32(cdPtr, 0x02014b50, true);
    view.setUint16(cdPtr + 4, 20, true); // Version made by
    view.setUint16(cdPtr + 6, 20, true); // Version needed to extract
    view.setUint16(cdPtr + 8, 0x0800, true); // UTF-8
    view.setUint16(cdPtr + 10, 0, true); // Method: Stored
    view.setUint16(cdPtr + 12, 0, true); // Time
    view.setUint16(cdPtr + 14, 0, true); // Date
    view.setUint32(cdPtr + 16, entry.crc, true);
    view.setUint32(cdPtr + 20, entry.size, true);
    view.setUint32(cdPtr + 24, entry.size, true);
    view.setUint16(cdPtr + 28, entry.nameBytes.length, true);
    view.setUint16(cdPtr + 30, 0, true); // Extra field length
    view.setUint16(cdPtr + 32, 0, true); // Comment length
    view.setUint16(cdPtr + 34, 0, true); // Disk number start
    view.setUint16(cdPtr + 36, 0, true); // Internal attributes
    view.setUint32(cdPtr + 38, 0, true); // External attributes
    view.setUint32(cdPtr + 42, off, true); // Relative offset of local header

    out.set(entry.nameBytes, cdPtr + 46);
    cdPtr += 46 + entry.nameBytes.length;
  }

  // Write End of Central Directory (EOCD) record
  // Signature 0x06054b50
  view.setUint32(cdPtr, 0x06054b50, true);
  view.setUint16(cdPtr + 4, 0, true); // Disk number
  view.setUint16(cdPtr + 6, 0, true); // Disk with CD
  view.setUint16(cdPtr + 8, fileEntries.length, true); // Records on this disk
  view.setUint16(cdPtr + 10, fileEntries.length, true); // Total records
  view.setUint32(cdPtr + 12, cdTotal, true); // CD size
  view.setUint32(cdPtr + 16, cdOffset, true); // CD offset
  view.setUint16(cdPtr + 20, 0, true); // Comment length

  return new Blob([out], { type: "application/zip" });
}

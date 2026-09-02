import test from "node:test";
import assert from "node:assert/strict";
import { crc32, createZip } from "../js/zip.js";

test("crc32 calculates standard checksum for known vectors", () => {
  const enc = new TextEncoder();
  // Standard CRC32 check value for ASCII "123456789" is 0xCBF43926
  const data = enc.encode("123456789");
  const crc = crc32(data);
  assert.equal(crc, 0xcbf43926);
});

test("createZip generates a valid PKZip archive containing entries", async () => {
  const enc = new TextEncoder();
  const file1 = { name: "kick.wav", data: enc.encode("RIFF...WAVEfmt...kick") };
  const file2 = { name: "snare.wav", data: enc.encode("RIFF...WAVEfmt...snare") };

  const zipBlob = await createZip([file1, file2]);
  assert.ok(zipBlob instanceof Blob);
  assert.equal(zipBlob.type, "application/zip");

  const buf = new Uint8Array(await zipBlob.arrayBuffer());
  const view = new DataView(buf.buffer);

  // First local file header signature: 0x04034b50 ("PK\x03\x04")
  assert.equal(view.getUint32(0, true), 0x04034b50);

  // EOCD record signature at the end: 0x06054b50 ("PK\x05\x06")
  const eocdSig = view.getUint32(buf.length - 22, true);
  assert.equal(eocdSig, 0x06054b50);

  // Total entries reported in EOCD
  const totalEntries = view.getUint16(buf.length - 22 + 10, true);
  assert.equal(totalEntries, 2);
});

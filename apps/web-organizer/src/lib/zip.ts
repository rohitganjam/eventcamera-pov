interface ZipFileEntry {
  fileName: string;
  data: Uint8Array;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sanitizeZipEntryName(input: string): string {
  const normalized = input
    .replace(/\\/g, '/')
    .replace(/^\.+/, '')
    .replace(/\/{2,}/g, '/')
    .trim();
  return normalized || `file-${Date.now()}`;
}

function writeUint16(view: DataView, offset: number, value: number): number {
  view.setUint16(offset, value & 0xffff, true);
  return offset + 2;
}

function writeUint32(view: DataView, offset: number, value: number): number {
  view.setUint32(offset, value >>> 0, true);
  return offset + 4;
}

export function createZipBlob(entries: ZipFileEntry[]): Blob {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];

  let localOffset = 0;

  for (const entry of entries) {
    const fileName = sanitizeZipEntryName(entry.fileName);
    const fileNameBytes = encoder.encode(fileName);
    const fileData = entry.data;
    const crc = crc32(fileData);

    const localHeader = new Uint8Array(30 + fileNameBytes.length);
    const localHeaderView = new DataView(localHeader.buffer);
    let p = 0;
    p = writeUint32(localHeaderView, p, 0x04034b50);
    p = writeUint16(localHeaderView, p, 20); // version needed
    p = writeUint16(localHeaderView, p, 0); // flags
    p = writeUint16(localHeaderView, p, 0); // compression method (store)
    p = writeUint16(localHeaderView, p, 0); // mod time
    p = writeUint16(localHeaderView, p, 0); // mod date
    p = writeUint32(localHeaderView, p, crc);
    p = writeUint32(localHeaderView, p, fileData.length);
    p = writeUint32(localHeaderView, p, fileData.length);
    p = writeUint16(localHeaderView, p, fileNameBytes.length);
    p = writeUint16(localHeaderView, p, 0); // extra length
    localHeader.set(fileNameBytes, p);

    localParts.push(localHeader, fileData);

    const centralHeader = new Uint8Array(46 + fileNameBytes.length);
    const centralHeaderView = new DataView(centralHeader.buffer);
    p = 0;
    p = writeUint32(centralHeaderView, p, 0x02014b50);
    p = writeUint16(centralHeaderView, p, 20); // version made by
    p = writeUint16(centralHeaderView, p, 20); // version needed
    p = writeUint16(centralHeaderView, p, 0); // flags
    p = writeUint16(centralHeaderView, p, 0); // compression method
    p = writeUint16(centralHeaderView, p, 0); // mod time
    p = writeUint16(centralHeaderView, p, 0); // mod date
    p = writeUint32(centralHeaderView, p, crc);
    p = writeUint32(centralHeaderView, p, fileData.length);
    p = writeUint32(centralHeaderView, p, fileData.length);
    p = writeUint16(centralHeaderView, p, fileNameBytes.length);
    p = writeUint16(centralHeaderView, p, 0); // extra length
    p = writeUint16(centralHeaderView, p, 0); // comment length
    p = writeUint16(centralHeaderView, p, 0); // disk start
    p = writeUint16(centralHeaderView, p, 0); // internal attrs
    p = writeUint32(centralHeaderView, p, 0); // external attrs
    p = writeUint32(centralHeaderView, p, localOffset);
    centralHeader.set(fileNameBytes, p);
    centralParts.push(centralHeader);

    localOffset += localHeader.length + fileData.length;
  }

  const centralDirectorySize = centralParts.reduce((acc, part) => acc + part.length, 0);
  const endOfCentralDirectory = new Uint8Array(22);
  const eocdView = new DataView(endOfCentralDirectory.buffer);
  let p = 0;
  p = writeUint32(eocdView, p, 0x06054b50);
  p = writeUint16(eocdView, p, 0); // disk number
  p = writeUint16(eocdView, p, 0); // central dir disk
  p = writeUint16(eocdView, p, entries.length);
  p = writeUint16(eocdView, p, entries.length);
  p = writeUint32(eocdView, p, centralDirectorySize);
  p = writeUint32(eocdView, p, localOffset);
  p = writeUint16(eocdView, p, 0); // zip comment length

  const blobParts: BlobPart[] = [];
  for (const part of [...localParts, ...centralParts, endOfCentralDirectory]) {
    const copied = new Uint8Array(part.byteLength);
    copied.set(part);
    blobParts.push(copied);
  }

  return new Blob(blobParts, {
    type: 'application/zip'
  });
}

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectImageFormat,
  stripImageMetadata,
  hasStrippableMetadata,
  UnsupportedImageFormatError,
  MalformedImageError,
} from "./imageStrip";

// ── byte-construction helpers ────────────────────────────────────────────────

/** A JPEG APPn/COM segment: FF <marker> <u16be len incl. these 2 bytes> <data>. */
function jpegSeg(marker: number, data: Buffer | string): Buffer {
  const d = typeof data === "string" ? Buffer.from(data, "latin1") : data;
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(d.length + 2, 2);
  return Buffer.concat([head, d]);
}

/** A PNG chunk: <u32be len> <4-ascii type> <data> <u32 crc>. CRC is not validated. */
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, data, Buffer.from([0, 0, 0, 0])]);
}

/** A WebP RIFF chunk: <4-ascii fourcc> <u32le declaredSize> <data> [pad to even]. */
function webpChunk(fourcc: string, data: Buffer, declaredSize?: number): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, "ascii");
  head.writeUInt32LE(declaredSize ?? data.length, 4);
  const pad = data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([head, data, pad]);
}

function webpFile(chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(4 + body.length, 4);
  head.write("WEBP", 8, "ascii");
  return Buffer.concat([head, body]);
}

const SOI = Buffer.from([0xff, 0xd8]); // JPEG start-of-image
const EOI = Buffer.from([0xff, 0xd9]);
const SOS = jpegSeg(0xda, Buffer.from([0x01, 0x00])); // minimal scan header
const SCAN = Buffer.from([0x11, 0x22, 0x33, 0x44]); // entropy data, no 0xFF
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ── format detection ─────────────────────────────────────────────────────────

test("detectImageFormat identifies jpeg/png/webp/heic/unknown", () => {
  assert.equal(detectImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0x00])), "jpeg");
  assert.equal(detectImageFormat(PNG_SIG), "png");
  assert.equal(detectImageFormat(webpFile([])), "webp");

  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(16)]);
  assert.equal(detectImageFormat(heic), "heic");
  const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypavif"), Buffer.alloc(16)]);
  assert.equal(detectImageFormat(avif), "heic");

  assert.equal(detectImageFormat(Buffer.from("GIF89a not an image")), "unknown");
});

// ── fail-closed: formats we cannot strip throw, and assert reports dirty ───────

test("HEIC/unknown throw UnsupportedImageFormatError (no silent EXIF pass-through)", () => {
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(64)]);
  assert.throws(() => stripImageMetadata(heic), (e: unknown) => {
    assert.ok(e instanceof UnsupportedImageFormatError);
    assert.equal((e as UnsupportedImageFormatError).format, "heic");
    return true;
  });
  assert.equal(hasStrippableMetadata(heic), true);

  const gif = Buffer.from("GIF89a\x01\x00\x01\x00 pixels and a comment", "latin1");
  assert.throws(() => stripImageMetadata(gif), UnsupportedImageFormatError);
  assert.equal(hasStrippableMetadata(gif), true);
});

// ── fail-closed: malformed *supported* containers throw (never leak the tail) ──

test("stripJpeg fails CLOSED on a bad segment length (review repro) — throws, not leaks", () => {
  // FF D8 | FF E1 FF FE (APP1, len=0xFFFE overruns) | "Exif..GPS" | SOS | scan | EOI
  const img = Buffer.concat([
    SOI,
    Buffer.from([0xff, 0xe1, 0xff, 0xfe]),
    Buffer.from("Exif\0\0GPS 51.5N 0.1W", "latin1"),
    Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x00]),
    Buffer.from([0x11, 0x22]),
    EOI,
  ]);
  assert.equal(detectImageFormat(img), "jpeg");
  assert.throws(() => stripImageMetadata(img), (e: unknown) => {
    assert.ok(e instanceof MalformedImageError);
    return true;
  });
  // The unsound-backstop bug: the assert must NOT report this leaky input clean.
  assert.equal(hasStrippableMetadata(img), true);
});

test("stripJpeg fails CLOSED on a stray non-0xFF byte where a marker is expected", () => {
  const img = Buffer.concat([
    SOI,
    jpegSeg(0xe0, "JFIF\0\x01\x02\0\0\x01\0\x01\0\0"),
    Buffer.from("\x00GPS-secret-after-stray-byte", "latin1"), // stray 0x00, then "metadata"
  ]);
  assert.throws(() => stripImageMetadata(img), MalformedImageError);
  assert.equal(hasStrippableMetadata(img), true);
});

test("truncated PNG / overrunning WebP chunk fail CLOSED (throw), assert reports dirty", () => {
  const truncPng = Buffer.concat([PNG_SIG, pngChunk("IHDR", Buffer.alloc(13, 7)), Buffer.from([0, 0, 0, 0x40])]);
  assert.throws(() => stripImageMetadata(truncPng), MalformedImageError);
  assert.equal(hasStrippableMetadata(truncPng), true);

  // VP8 chunk declares a size that overruns the buffer.
  const overrun = webpFile([webpChunk("VP8 ", Buffer.from([1, 2, 3, 4]), 0xffffff)]);
  assert.throws(() => stripImageMetadata(overrun), MalformedImageError);
  assert.equal(hasStrippableMetadata(overrun), true);
});

// ── JPEG: EXIF, vendor APPn, COM, trailer dropped; ICC + scan preserved ───────

test("stripJpeg drops EXIF/vendor-APPn/COM + post-EOI trailer, keeps JFIF/ICC + scan", () => {
  const app0 = jpegSeg(0xe0, "JFIF\0jfif-density"); // keep (identifier)
  const app1 = jpegSeg(0xe1, "Exif\0\0GPS 51.5N device=iPhone"); // drop
  const app2 = jpegSeg(0xe2, "ICC_PROFILE\0 colour-profile-data"); // keep (identifier)
  const app4 = jpegSeg(0xe4, "VENDOR depth-map payload"); // drop (allowlist)
  const com = jpegSeg(0xfe, "a prompt in a comment"); // drop
  const trailer = Buffer.from("MOTIONPHOTO an entire mp4 clip", "latin1"); // drop
  const img = Buffer.concat([SOI, app0, app1, app2, app4, com, SOS, SCAN, EOI, trailer]);

  assert.equal(hasStrippableMetadata(img), true);
  const out = stripImageMetadata(img);
  assert.equal(hasStrippableMetadata(out), false);
  assert.ok(out.includes(Buffer.from("colour-profile-data")), "ICC (APP2) kept");
  assert.ok(out.includes(Buffer.from("jfif-density")), "JFIF (APP0) kept");
  assert.ok(!out.includes(Buffer.from("Exif")), "EXIF (APP1) dropped");
  assert.ok(!out.includes(Buffer.from("VENDOR")), "vendor APP4 dropped");
  assert.ok(!out.includes(Buffer.from("prompt")), "COM dropped");
  assert.ok(!out.includes(Buffer.from("MOTIONPHOTO")), "post-EOI trailer dropped");
  assert.ok(out.includes(SCAN), "scan data preserved");
  assert.equal(out[out.length - 1], 0xd9, "ends at EOI");
  // Idempotent: stripping a clean image is a no-op that stays clean.
  assert.deepEqual(stripImageMetadata(out), out);
});

test("stripJpeg APPn allowlist gates on IDENTIFIER not marker number (JFXX/MPF dropped)", () => {
  const jfif = jpegSeg(0xe0, "JFIF\0keepme-jfif"); // keep
  const jfxx = jpegSeg(0xe0, "JFXX\0thumbnail-pixels"); // drop — APP0 but not JFIF
  const icc = jpegSeg(0xe2, "ICC_PROFILE\0keepme-icc"); // keep
  const mpf = jpegSeg(0xe2, "MPF\0multipicture-offsets"); // drop — APP2 but not ICC
  const img = Buffer.concat([SOI, jfif, jfxx, icc, mpf, SOS, SCAN, EOI]);

  const out = stripImageMetadata(img);
  assert.equal(hasStrippableMetadata(out), false);
  assert.ok(out.includes(Buffer.from("keepme-jfif")), "JFIF kept");
  assert.ok(out.includes(Buffer.from("keepme-icc")), "ICC kept");
  assert.ok(!out.includes(Buffer.from("thumbnail-pixels")), "JFXX thumbnail dropped");
  assert.ok(!out.includes(Buffer.from("multipicture-offsets")), "MPF dropped");
});

test("stripJpeg drops metadata AFTER SOS (untrusted input) and multi-APP1 / APP13", () => {
  // APP1 EXIF *and* APP1 XMP before SOS; another APP1 injected after SOS in the scan.
  const exif = jpegSeg(0xe1, "Exif\0\0gps-before-sos");
  const xmp = jpegSeg(0xe1, "http://ns.adobe.com/xap/1.0/\0<xmp>secret</xmp>");
  const iptc = jpegSeg(0xed, "Photoshop 3.0\0iptc-caption"); // APP13
  const postSos = jpegSeg(0xe1, "Exif\0\0gps-after-sos");
  const img = Buffer.concat([SOI, exif, xmp, iptc, SOS, Buffer.from([0x11, 0x22]), postSos, EOI]);

  assert.equal(hasStrippableMetadata(img), true);
  const out = stripImageMetadata(img);
  assert.equal(hasStrippableMetadata(out), false);
  assert.ok(!out.includes(Buffer.from("gps-before-sos")), "APP1 EXIF dropped");
  assert.ok(!out.includes(Buffer.from("<xmp>secret")), "APP1 XMP dropped");
  assert.ok(!out.includes(Buffer.from("iptc-caption")), "APP13 IPTC dropped");
  assert.ok(!out.includes(Buffer.from("gps-after-sos")), "post-SOS APP1 dropped");
});

test("stripJpeg handles fill bytes (FF FF ...) before a metadata marker", () => {
  const app1 = jpegSeg(0xe1, "Exif\0\0secret-gps");
  const img = Buffer.concat([SOI, Buffer.from([0xff, 0xff, 0xff]), app1, SOS, Buffer.from([0x11, 0x22]), EOI]);
  const out = stripImageMetadata(img);
  assert.ok(!out.includes(Buffer.from("Exif")), "padded APP1 does not slip through");
  assert.equal(hasStrippableMetadata(out), false);
});

// ── PNG: prompt text chunks dropped, pixels byte-identical ────────────────────

test("stripPng drops tEXt/eXIf, keeps IHDR/IDAT/IEND with pixels byte-identical", () => {
  const ihdr = pngChunk("IHDR", Buffer.alloc(13, 7));
  const text = pngChunk("tEXt", Buffer.from("parameters\0a very long SD prompt"));
  const exif = pngChunk("eXIf", Buffer.from("II*\0 exif payload"));
  const idat = pngChunk("IDAT", Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]));
  const iend = pngChunk("IEND", Buffer.alloc(0));
  const img = Buffer.concat([PNG_SIG, ihdr, text, exif, idat, iend]);

  assert.equal(hasStrippableMetadata(img), true);
  const out = stripImageMetadata(img);
  assert.equal(hasStrippableMetadata(out), false);
  assert.ok(!out.includes(Buffer.from("parameters")), "tEXt prompt dropped");
  assert.ok(!out.includes(Buffer.from("exif payload")), "eXIf dropped");
  assert.ok(out.includes(idat), "IDAT pixel chunk byte-identical");
  assert.deepEqual(out, Buffer.concat([PNG_SIG, ihdr, idat, iend]));
});

// ── WebP: allowlist drops EXIF/XMP/unknown, clears VP8X flags (no fast-path) ───

test("stripWebp keeps VP8/VP8X, clears EXIF/XMP flags, drops metadata + unknown chunks", () => {
  const vp8x = webpChunk("VP8X", Buffer.concat([Buffer.from([0x0c]), Buffer.alloc(9)])); // flags: EXIF|XMP
  const vp8 = webpChunk("VP8 ", Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]));
  const exif = webpChunk("EXIF", Buffer.from("II*\0 gps here"));
  const xmp = webpChunk("XMP ", Buffer.from("<x:xmpmeta>...</x:xmpmeta>"));
  const junk = webpChunk("JUNK", Buffer.from("unanticipated vendor chunk"));
  const img = webpFile([vp8x, vp8, exif, xmp, junk]);

  assert.equal(detectImageFormat(img), "webp");
  assert.equal(hasStrippableMetadata(img), true);
  const out = stripImageMetadata(img);
  assert.equal(hasStrippableMetadata(out), false);
  assert.ok(out.includes(Buffer.from([0xaa, 0xbb, 0xcc, 0xdd])), "VP8 pixel data kept");
  assert.ok(!out.includes(Buffer.from("gps here")), "EXIF dropped");
  assert.ok(!out.includes(Buffer.from("xmpmeta")), "XMP dropped");
  assert.ok(!out.includes(Buffer.from("vendor chunk")), "unknown chunk dropped");
  assert.equal(out[20] & 0x0c, 0, "VP8X EXIF/XMP flag bits cleared");
});

test("stripWebp clears VP8X flags even when every chunk is allowlisted (no fast-path leak)", () => {
  const vp8x = webpChunk("VP8X", Buffer.concat([Buffer.from([0x0c]), Buffer.alloc(9)])); // flags set
  const vp8 = webpChunk("VP8 ", Buffer.from([0x01, 0x02]));
  const img = webpFile([vp8x, vp8]); // nothing to *drop*, but flags lie about metadata
  assert.equal(hasStrippableMetadata(img), true, "flagged VP8X counts as metadata");
  const out = stripImageMetadata(img);
  assert.equal(out[20] & 0x0c, 0, "flags cleared on the all-allowlisted path too");
  assert.equal(hasStrippableMetadata(out), false);
});

// ── format-override param: a wrong override must fail closed, never mis-parse ──

test("format override that mismatches the real container fails closed", () => {
  const png = Buffer.concat([PNG_SIG, pngChunk("IHDR", Buffer.alloc(13, 7)), pngChunk("IEND", Buffer.alloc(0))]);
  // Forcing 'jpeg' on a PNG runs the wrong parser — must throw, not leak.
  assert.throws(() => stripImageMetadata(png, "jpeg"), MalformedImageError);
  // Forcing 'heic' rejects outright.
  assert.throws(() => stripImageMetadata(png, "heic"), UnsupportedImageFormatError);
});

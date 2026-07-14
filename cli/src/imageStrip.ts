/**
 * Origin-side image metadata stripping — pure JS, no native deps, lossless
 * (pixels untouched). Strips EXIF (GPS, device, timestamp), XMP, IPTC, JPEG
 * comments, and PNG text chunks at the container/byte level — metadata that
 * can carry a generation prompt (Stable Diffusion/ComfyUI/A1111) or identify
 * the source device/location. For consumer-upload and operator-output strip
 * paths.
 *
 * FAIL-CLOSED: one parser backs both `stripImageMetadata` and
 * `hasStrippableMetadata` so they can't disagree. A supported container
 * (JPEG/PNG/WebP) that fails to parse throws `MalformedImageError` instead of
 * blind-copying the remainder; HEIC/HEIF/AVIF or an unrecognized container
 * throws `UnsupportedImageFormatError`. `hasStrippableMetadata` never reports
 * a false "clean" for either case.
 *
 * JPEG APPn segments are gated on identifier, not just marker number: APP0
 * kept only as `JFIF`, APP2 only as `ICC_PROFILE`, APP14 only as `Adobe`;
 * everything else (EXIF/XMP/IPTC, JFXX, MPF, FPXR, vendor APPn) is dropped.
 *
 * Caveats: EXIF Orientation is dropped without rotating pixels (rotated
 * JPEGs keep stored orientation); a kept ICC profile can carry free-text
 * tags (desc/cprt/device) — a fingerprint channel, not GPS-class.
 */

export type ImageFormat = "jpeg" | "png" | "webp" | "heic" | "unknown";

/**
 * Thrown by `stripImageMetadata` for a format it cannot strip at all
 * (`heic` = HEIC/HEIF/AVIF, or `unknown`). Fail-closed: never send the original.
 */
export class UnsupportedImageFormatError extends Error {
  readonly format: ImageFormat;
  constructor(format: ImageFormat, message: string) {
    super(message);
    this.name = "UnsupportedImageFormatError";
    this.format = format;
  }
}

/**
 * Thrown by `stripImageMetadata` when a *supported* container (JPEG/PNG/WebP)
 * cannot be fully parsed to a clean terminal state, so a lossless strip cannot
 * be guaranteed. Fail-closed: never blind-copy the un-parsed remainder.
 */
export class MalformedImageError extends Error {
  readonly format: ImageFormat;
  constructor(format: ImageFormat, message: string) {
    super(message);
    this.name = "MalformedImageError";
    this.format = format;
  }
}

// ISO-BMFF (`ftyp`-boxed) brands we treat as un-strippable-at-byte-level:
// HEIC/HEIF (iOS camera default) and AVIF. EXIF/XMP live in nested `meta` boxes
// with absolute offsets that a surgical byte strip cannot safely rewrite.
const HEIF_BRANDS = new Set<string>([
  "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs",
  "mif1", "msf1", "avif", "avis", "heif",
]);

/** Identify the container from magic bytes (never trusts a caller-supplied MIME). */
export function detectImageFormat(buf: Uint8Array): ImageFormat {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "jpeg";
  }
  if (buf.length >= 8 && hasPngSignature(buf)) {
    return "png";
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // "RIFF"
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // "WEBP"
  ) {
    return "webp";
  }
  // ISO-BMFF: "....ftyp<brand>". HEIC/HEIF/AVIF — the iOS default capture format.
  if (
    buf.length >= 12 &&
    buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70 // "ftyp"
  ) {
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
    if (HEIF_BRANDS.has(brand)) return "heic";
  }
  return "unknown";
}

/** Kept bytes + whether the parse reached a clean terminal state + saw metadata. */
interface ParseResult {
  kept: Buffer;
  /** True iff the whole input parsed to a proper end with no un-parsed remainder. */
  clean: boolean;
  /** True iff at least one strippable segment/chunk/trailer was present. */
  hadMetadata: boolean;
}

/**
 * Strip metadata from an image, returning a new Buffer. Throws
 * `MalformedImageError` if a supported container cannot be fully parsed, or
 * `UnsupportedImageFormatError` for HEIC/HEIF/AVIF or an unrecognized format —
 * the caller must reject or transcode rather than send unstripped bytes.
 */
export function stripImageMetadata(buf: Buffer, format?: ImageFormat): Buffer {
  const fmt = format && format !== "unknown" ? format : detectImageFormat(buf);
  let r: ParseResult;
  switch (fmt) {
    case "jpeg":
      r = parseJpeg(buf);
      break;
    case "png":
      r = parsePng(buf);
      break;
    case "webp":
      r = parseWebp(buf);
      break;
    case "heic":
      throw new UnsupportedImageFormatError(
        "heic",
        "HEIC/HEIF/AVIF cannot be stripped losslessly at the byte level; " +
          "reject the upload or transcode to PNG/JPEG/WebP first.",
      );
    default:
      throw new UnsupportedImageFormatError(
        "unknown",
        "Unrecognized image format; refusing to send unstripped bytes (would " +
          "leak metadata). Transcode to PNG/JPEG/WebP first.",
      );
  }
  if (!r.clean) {
    throw new MalformedImageError(
      fmt,
      `Malformed ${fmt}: could not be fully parsed, so a lossless metadata ` +
        "strip cannot be guaranteed. Reject the upload or transcode first.",
    );
  }
  return r.kept;
}

/**
 * True if the buffer still contains strippable metadata OR cannot be proven
 * clean. Derived from the SAME parser as `stripImageMetadata`, so a post-strip
 * assertion can never report "clean" on bytes the stripper would leak. Returns
 * `true` for HEIC/unknown and for any un-parseable supported container.
 */
export function hasStrippableMetadata(buf: Buffer): boolean {
  const fmt = detectImageFormat(buf);
  switch (fmt) {
    case "jpeg": {
      const r = parseJpeg(buf);
      return !r.clean || r.hadMetadata;
    }
    case "png": {
      const r = parsePng(buf);
      return !r.clean || r.hadMetadata;
    }
    case "webp": {
      const r = parseWebp(buf);
      return !r.clean || r.hadMetadata;
    }
    default:
      // heic / unknown — cannot assert cleanliness.
      return true;
  }
}

// ── JPEG ─────────────────────────────────────────────────────────────────────

const JPEG_COM = 0xfe; // free-text comment — always dropped
const JPEG_APP0 = 0xe0; // JFIF (kept) vs JFXX thumbnail (dropped)
const JPEG_APP2 = 0xe2; // ICC profile (kept) vs MPF / FPXR (dropped)
const JPEG_APP14 = 0xee; // Adobe colour transform (kept)

function payloadStartsWith(buf: Buffer, start: number, end: number, sig: string): boolean {
  if (end - start < sig.length) return false;
  for (let k = 0; k < sig.length; k++) {
    if (buf[start + k] !== sig.charCodeAt(k)) return false;
  }
  return true;
}

/**
 * True for a JPEG marker segment that carries strippable metadata (drop it).
 * APPn are gated on their identifier string, not just the marker number, so a
 * JFXX thumbnail (APP0), MPF/FPXR (APP2), etc. don't ride through as "JFIF"/"ICC".
 */
function jpegSegmentIsMetadata(buf: Buffer, i: number, segEnd: number, marker: number): boolean {
  if (marker === JPEG_COM) return true;
  if (marker < 0xe0 || marker > 0xef) return false; // not APPn → structural, keep
  const p = i + 4; // payload starts after FF marker len-hi len-lo
  if (marker === JPEG_APP0 && payloadStartsWith(buf, p, segEnd, "JFIF\0")) return false;
  if (marker === JPEG_APP2 && payloadStartsWith(buf, p, segEnd, "ICC_PROFILE\0")) return false;
  if (marker === JPEG_APP14 && payloadStartsWith(buf, p, segEnd, "Adobe")) return false;
  return true; // EXIF/XMP (APP1), IPTC (APP13), JFXX, MPF, FPXR, vendor APPn → drop
}

/**
 * JPEG: FFD8 (SOI), a sequence of marker segments, SOS (FFDA) then entropy-coded
 * scan data (walked with byte-stuffing awareness — FF00 and FF D0–D7 are data),
 * possibly more scans (progressive), then EOI (FFD9). Metadata (APPn/COM) is
 * dropped wherever it appears; any trailer after EOI is dropped. Fails closed:
 * a stray byte, bad length, or missing EOI ⇒ clean=false (caller throws).
 */
function parseJpeg(buf: Buffer): ParseResult {
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return { kept: Buffer.alloc(0), clean: false, hadMetadata: false };
  }
  const out: Buffer[] = [buf.subarray(0, 2)]; // SOI
  let hadMetadata = false;
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) {
      // Stray byte where a marker is expected — cannot parse cleanly.
      return { kept: Buffer.concat(out), clean: false, hadMetadata };
    }
    // Skip fill bytes (FF FF …) — spec-legal padding before a marker.
    let marker = buf[i + 1];
    while (marker === 0xff) {
      i += 1;
      if (i + 1 >= buf.length) return { kept: Buffer.concat(out), clean: false, hadMetadata };
      marker = buf[i + 1];
    }
    if (marker === 0xd9) {
      // EOI: keep it, drop any trailer, done.
      out.push(buf.subarray(i, i + 2));
      if (i + 2 < buf.length) hadMetadata = true; // trailer present (dropped)
      return { kept: Buffer.concat(out), clean: true, hadMetadata };
    }
    // Standalone markers with no payload: TEM (01), RSTn (D0–D7).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > buf.length) return { kept: Buffer.concat(out), clean: false, hadMetadata };
    const len = buf.readUInt16BE(i + 2); // includes the 2 length bytes
    const segEnd = i + 2 + len;
    if (len < 2 || segEnd > buf.length) {
      return { kept: Buffer.concat(out), clean: false, hadMetadata };
    }
    if (marker === 0xda) {
      // SOS: keep the scan header, then walk entropy data to the next marker.
      out.push(buf.subarray(i, segEnd));
      let j = segEnd;
      while (j + 1 < buf.length) {
        if (buf[j] === 0xff) {
          const m = buf[j + 1];
          if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) {
            j += 2; // FF00 stuffing or RSTn — part of the scan
            continue;
          }
          break; // a real marker ends the scan
        }
        j += 1;
      }
      out.push(buf.subarray(segEnd, j)); // entropy-coded scan bytes (pixels)
      i = j;
      continue;
    }
    if (jpegSegmentIsMetadata(buf, i, segEnd, marker)) hadMetadata = true; // drop
    else out.push(buf.subarray(i, segEnd));
    i = segEnd;
  }
  // Ran off the end without reaching EOI.
  return { kept: Buffer.concat(out), clean: false, hadMetadata };
}

// ── PNG ──────────────────────────────────────────────────────────────────────

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hasPngSignature(buf: Uint8Array): boolean {
  if (buf.length < 8) return false;
  for (let k = 0; k < 8; k++) if (buf[k] !== PNG_SIG[k]) return false;
  return true;
}

// PNG chunks we KEEP: critical (IHDR/PLTE/IDAT/IEND) + transparency + colour.
// Everything else — tEXt/zTXt/iTXt (the prompt), eXIf, tIME, pHYs, … — is dropped.
const PNG_KEEP = new Set<string>([
  "IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT",
]);

function parsePng(buf: Buffer): ParseResult {
  if (!hasPngSignature(buf)) {
    return { kept: Buffer.alloc(0), clean: false, hadMetadata: false };
  }
  const out: Buffer[] = [buf.subarray(0, 8)]; // signature
  let hadMetadata = false;
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("ascii", i + 4, i + 8);
    const chunkEnd = i + 12 + len; // len(4) + type(4) + data(len) + crc(4)
    if (chunkEnd > buf.length) {
      // Truncated chunk — can't parse cleanly; drop the tail (fail closed).
      return { kept: Buffer.concat(out), clean: false, hadMetadata };
    }
    if (PNG_KEEP.has(type)) out.push(buf.subarray(i, chunkEnd));
    else hadMetadata = true; // dropped a metadata/ancillary chunk
    if (type === "IEND") {
      if (chunkEnd < buf.length) hadMetadata = true; // trailer after IEND (dropped)
      return { kept: Buffer.concat(out), clean: true, hadMetadata };
    }
    i = chunkEnd;
  }
  // Ran off the end without IEND.
  return { kept: Buffer.concat(out), clean: false, hadMetadata };
}

// ── WebP ─────────────────────────────────────────────────────────────────────

// WebP RIFF chunks we KEEP — image data, transparency, animation, colour.
// Everything else (EXIF, "XMP ", unknown chunks) is dropped: an allowlist to
// match the PNG stance, so unknown metadata containers can't ride through.
const WEBP_KEEP = new Set<string>([
  "VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP",
]);
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

function hasWebpSignature(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // RIFF
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // WEBP
  );
}

/**
 * WebP: "RIFF" + u32le size + "WEBP" + chunks (fourcc + u32le size + data,
 * padded to even). Keeps only allowlisted chunks, clears the VP8X EXIF/XMP flag
 * bits (always — never a fast-path return that leaves them set), and rewrites
 * the RIFF size. Fails closed: an overrunning chunk or trailing partial header
 * ⇒ clean=false (caller throws) — never returns the original buffer intact.
 */
function parseWebp(buf: Buffer): ParseResult {
  if (!hasWebpSignature(buf)) {
    return { kept: Buffer.alloc(0), clean: false, hadMetadata: false };
  }
  const kept: Buffer[] = [];
  let hadMetadata = false;
  let i = 12;
  while (i + 8 <= buf.length) {
    const fourcc = buf.toString("ascii", i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const dataEnd = i + 8 + size;
    if (dataEnd > buf.length) break; // overrun — stop; clean check below fails
    const padded = dataEnd + (size % 2); // chunk bodies are padded to even length
    if (WEBP_KEEP.has(fourcc)) {
      const part = Buffer.from(buf.subarray(i, Math.min(padded, buf.length)));
      if (fourcc === "VP8X" && part.length >= 9) {
        // Flags byte sits right after the 8-byte chunk header (index 8 here).
        if (part[8] & (VP8X_EXIF_FLAG | VP8X_XMP_FLAG)) hadMetadata = true;
        part[8] = part[8] & ~VP8X_EXIF_FLAG & ~VP8X_XMP_FLAG;
      }
      kept.push(part);
    } else {
      hadMetadata = true; // dropped a non-allowlisted (metadata/unknown) chunk
    }
    i = padded;
  }
  const clean = i === buf.length; // every chunk consumed exactly, no overrun/tail
  const body = Buffer.concat(kept);
  const out = Buffer.alloc(12 + body.length);
  buf.copy(out, 0, 0, 12); // "RIFF" + size + "WEBP"
  body.copy(out, 12);
  out.writeUInt32LE(4 + body.length, 4); // RIFF payload size = "WEBP" + chunks
  return { kept: out, clean, hadMetadata };
}

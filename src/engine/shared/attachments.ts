// Attachment validation — the SINGLE gate shared by the browser composer, the
// server submit route, the harness run, snapshots, and the transport.
//
// This module is deliberately browser-safe: it uses no Node API and no DOM API,
// so the frontend can validate a File's base64 payload before upload while the
// server re-validates the exact same value on the way in (never trust a client).
//
// Contract (frozen cross-worker):
//   - `validateAttachments(value, limits?)` returns detached copies of
//     well-formed attachments, `[]` for `undefined`, and throws a plain `Error`
//     on anything malformed. It never returns the caller's objects.
//   - `limits` is the trust PROFILE: `UPLOAD_ATTACHMENT_LIMITS` (default: 4 MiB
//     per file, 8 MiB per turn, 4 files — the public composer/submit contract,
//     unchanged) or `DOWNLOAD_ATTACHMENT_LIMITS` (20 MiB per file, for media a
//     tool fetched itself). The profile changes ONLY the byte/count gates:
//     grammar, MIME tables, magic signatures and canonical base64 are common,
//     so a download is never held to a looser standard than an upload.
//   - `data` is RAW canonical base64 (no `data:` prefix, no whitespace).
//   - `size` is the DECODED byte length and must agree with `data`.
//   - ids and markers are unique within one turn.
//   - marker grammar is `[Image 1]`, `[Video 2]`, `[Audio 1]`, `[PDF 1]`,
//     `[File 3]` (pdf also accepts the `[File n]` alias).
//   - known media must carry a matching MIME and a matching magic signature.
//   - unknown `kind: 'file'` entries are representable here but the transport
//     refuses them later with an explicit unsupported error (see
//     ../transport/openai.ts); they are never stringified into text.
//   - filesystem paths and URLs are not representable: `name` is a plain file
//     name and `data` must be canonical base64.
//
// Cross-references:
//   - ../types/index.ts          — HarnessAttachment (single type owner)
//   - ../core/snapshot.ts        — re-validates persisted user attachments
//   - ../core/agent.ts           — validates user()/stream() input before append
//   - ../harness.ts              — validates HarnessRunOptions.attachments
//   - ../transport/openai.ts     — maps attachments onto provider parts
//   - ../core/tool-media.ts      — the tool-media profiles' main consumer
//   - ../tools/webdownload/download.tool.ts — produces download media
//   - ./index.ts                 — public shared barrel

import type { HarnessAttachment, HarnessAttachmentLimits } from '../types';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

// One turn may carry at most four attachments. A composer that adds a fifth is
// rejected before any bytes reach the submit route.
export const MAX_ATTACHMENTS_PER_TURN = 4;

// Decoded size of one attachment: 4 MiB.
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

// Decoded size of every attachment in one turn together: 8 MiB.
export const MAX_TOTAL_ATTACHMENT_BYTES = 8 * 1024 * 1024;

// Whole JSON submit body bound (base64 grows ~4/3 plus multiple attachments).
// The server uses this when reading a request body; the composer uses it as the
// client-side ceiling. Kept here so both sides quote one number.
export const MAX_SUBMIT_BODY_BYTES = 16 * 1024 * 1024;

// The public UPLOAD profile. These are the numbers a browser composer and the
// HTTP submit route enforce, and they are the DEFAULT of `validateAttachments`,
// so every existing caller (composer, submit route, agent, snapshot, transport)
// keeps validating byte-for-byte what it always did.
export const UPLOAD_ATTACHMENT_LIMITS: HarnessAttachmentLimits = {
    perAttachmentBytes: MAX_ATTACHMENT_BYTES,
    totalBytes: MAX_TOTAL_ATTACHMENT_BYTES,
    count: MAX_ATTACHMENTS_PER_TURN
};

// One file the `download` tool fetched for the model: 20 MiB DECODED bytes.
//
// Binary units, matching every other byte bound in this package (4 MiB and
// 8 MiB above, the 64 KiB result budget, the 8 MiB fork history budget) — "20mb"
// in a user request means 20 * 1024 * 1024 here.
//
// Larger than the upload cap ON PURPOSE: these bytes were fetched by this
// process through a streamed, capped transfer, so the submit-body argument
// does not apply to them. They are a separate trust class, which is why they
// get their own profile instead of a raised public limit — a public 20 MiB
// upload cap would let a browser push 4 * 20 MiB of base64 into one request
// body and into every later model request.
export const MAX_DOWNLOAD_ATTACHMENT_BYTES = 20 * 1024 * 1024;

// The trusted DOWNLOAD profile, used for media attached to a `tool` message.
//
// `count`/`totalBytes` are wider than one download because ONE validated list
// is also what the transport builds when it aggregates the media of a whole
// contiguous tool block (up to four 20 MiB files may legitimately land in one
// block). The per-file cap is the one the user asked for; it is enforced
// against RAW bytes, never against the base64 text, so the ~4/3 base64
// expansion can never collide with the upload caps.
export const DOWNLOAD_ATTACHMENT_LIMITS: HarnessAttachmentLimits = {
    perAttachmentBytes: MAX_DOWNLOAD_ATTACHMENT_BYTES,
    totalBytes: 4 * MAX_DOWNLOAD_ATTACHMENT_BYTES,
    count: 4
};

// Marker label per kind. PDF also accepts "File" so a composer that treats a
// document as a generic file still produces a marker this validator accepts.
const MARKER_LABELS: Record<HarnessAttachment['kind'], readonly string[]> = {
    image: ['Image'],
    video: ['Video'],
    audio: ['Audio'],
    pdf: ['PDF', 'File'],
    file: ['File']
};

// The marker grammar, checked after the label/kind agreement above.
const MARKER_PATTERN = /^\[(Image|Video|Audio|PDF|File) ([1-9][0-9]*)\]$/;

// MIME allowlist per kind. Unknown `file` entries deliberately have no list:
// they may be represented, but the transport will refuse to send them.
const MIME_BY_KIND: Record<HarnessAttachment['kind'], readonly string[]> = {
    image: ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'],
    video: ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'],
    audio: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3'],
    pdf: ['application/pdf'],
    file: []
};

// A MIME type without parameters. `File.type` is already lowercase; requiring a
// canonical lowercase value keeps snapshots byte-stable across browsers.
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

// A filename, never a path or URL: no separators, no drive colon, no scheme.
const NAME_PATTERN = /^[^\u0000-\u001f\u007f/\\:]{1,200}$/;

// An opaque id: printable ASCII without spaces, bounded so a snapshot stays small.
const ID_PATTERN = /^[\u0021-\u007e]{1,100}$/;

// Pre-regex bounds. Checked BEFORE any pattern test or interpolated error, so a
// hostile multi-kilobyte MIME/marker cannot be scanned without bound and can
// never make an error message huge enough to become its own payload.
const MAX_MIME_LENGTH = 128;
const MAX_MARKER_LENGTH = 32;

// ---------------------------------------------------------------------------
// Marker helper (exported so the composer and validator cannot drift)
// ---------------------------------------------------------------------------

// Build the text marker a composer inserts into the prompt. The index starts at
// 1 for the first attachment of that label; the validator only requires the
// grammar and uniqueness, not a particular sequence.
export const attachmentMarker = (
    kind: HarnessAttachment['kind'],
    index: number,
    // Allow a pdf composer to call this with `'File'` explicitly when it wants a
    // generic document marker.
    label?: string
): string => {
    if (!Number.isSafeInteger(index) || index < 1) {
        throw new Error(`Attachment marker index must be a positive safe integer; received ${String(index)}.`);
    }

    const labels = MARKER_LABELS[kind];
    const resolved = label ?? labels[0];

    if (!labels.includes(resolved)) {
        throw new Error(`Attachment marker label "${resolved}" is not valid for kind "${kind}".`);
    }

    return `[${resolved} ${index}]`;
};

// ---------------------------------------------------------------------------
// MIME -> kind classification (shared by the download tool's policy and its test)
// ---------------------------------------------------------------------------

// The kinds a MIME table can CLAIM a payload for, in the order the table is
// consulted. `file` is excluded because its list is empty by design: an unknown
// type is never classified as a known kind, it falls through to `file` in the
// caller.
const CLASSIFIABLE_KINDS: readonly HarnessAttachment['kind'][] = ['image', 'video', 'audio', 'pdf'];

// Which known kind (if any) this MIME belongs to, read from the SAME
// `MIME_BY_KIND` table `readAttachment` enforces. A tool that classifies with
// this rule cannot produce an attachment the validator then refuses for a MIME
// mismatch, and the focused test pins that the two tables cannot drift.
//
// Returns `undefined` for anything the table does not claim, including the
// empty/missing MIME a server may send.
export const attachmentKindOfMime = (mime: string): HarnessAttachment['kind'] | undefined => {
    for (const kind of CLASSIFIABLE_KINDS) {
        if (MIME_BY_KIND[kind].includes(mime)) return kind;
    }

    return undefined;
};

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

// The standard alphabet. URL-safe characters are intentionally absent: the wire
// format and snapshots use canonical base64 only.
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// O(1) char-code lookup for the hot validation loop. `indexOf` over a 64-char
// alphabet was correct but needlessly quadratic-looking on multi-MiB payloads;
// a 128-entry table keeps a full per-turn validation linear and constant-factor
// cheap. Any code >= 128 is outside canonical base64.
const BASE64_VALUES = (() => {
    const table = new Int16Array(128);
    table.fill(-1);

    for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
        table[BASE64_ALPHABET.charCodeAt(index)] = index;
    }

    return table;
})();

// Canonical base64: whole 4-character groups plus at most two trailing `=`, with
// the DISCARDED tail bits zero. A decoder ignores those bits, so 'AB==' and
// 'AAB=' decode to the same bytes as 'AA=='/'AAA=' — accepting them would mean
// two encodings for one payload and break byte-stable snapshots/dedupe.
//
// Linear scan, not regex: a multi-megabyte payload would otherwise risk the V8
// regexp backtracking stack on the repeated group.
const isCanonicalBase64 = (value: string): boolean => {
    if (value.length === 0 || value.length % 4 !== 0) return false;

    let end = value.length;
    let padding = 0;

    while (end > 0 && value.charCodeAt(end - 1) === 0x3d) {
        padding += 1;
        end -= 1;
    }

    if (padding > 2) return false;

    for (let index = 0; index < end; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 128 || BASE64_VALUES[code] < 0) return false;
    }

    // A trailing group must be one of the legal lengths for its padding.
    if (end % 4 !== (padding === 0 ? 0 : 4 - padding)) return false;

    if (padding === 0) return true;

    // Padding 2: the second data char carries one byte; its low 4 bits must be
    // zero. Padding 1: the third data char carries the last two bits of byte 2
    // plus 2 discarded bits; those low 2 bits must be zero.
    const lastValue = BASE64_VALUES[value.charCodeAt(end - 1)];
    return padding === 2 ? (lastValue & 0x0f) === 0 : (lastValue & 0x03) === 0;
};

// Decode just enough leading bytes to check a media signature. A full decode is
// never needed at validation time, and this stays identical in Node and browser.
const decodeBase64Prefix = (value: string, maxBytes: number): Uint8Array => {
    const out = new Uint8Array(maxBytes);
    let length = 0;
    let buffer = 0;
    let bits = 0;

    for (const character of value) {
        const index = BASE64_ALPHABET.indexOf(character);
        if (index < 0) break;

        buffer = (buffer << 6) | index;
        bits += 6;

        if (bits >= 8) {
            bits -= 8;
            if (length < maxBytes) out[length] = (buffer >> bits) & 0xff;
            length += 1;
            if (length >= maxBytes) break;
        }
    }

    return out.subarray(0, Math.min(length, maxBytes));
};

// Decoded byte length of canonical base64, without allocating the bytes.
const decodedBytes = (value: string): number => {
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    return (value.length / 4) * 3 - padding;
};

const ascii = (value: string): Uint8Array =>
    Uint8Array.from(value.split('').map((character) => character.charCodeAt(0)));

const startsWith = (bytes: Uint8Array, signature: Uint8Array): boolean =>
    signature.every((byte, index) => bytes[index] === byte);

// Byte slices used by the signature checks below.
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Uint8Array.from([0xff, 0xd8, 0xff]);
const GIF87_SIGNATURE = ascii('GIF87a');
const GIF89_SIGNATURE = ascii('GIF89a');
const WEBP_RIFF = ascii('RIFF');
const WEBP_WEBP = ascii('WEBP');
const WAV_RIFF = ascii('RIFF');
const WAV_WAVE = ascii('WAVE');
const PDF_SIGNATURE = ascii('%PDF-');
const MP4_FTYP = ascii('ftyp');
const WEBM_SIGNATURE = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]);
const OGG_SIGNATURE = ascii('OggS');

const matchesAt = (bytes: Uint8Array, offset: number, signature: Uint8Array): boolean =>
    signature.every((byte, index) => bytes[offset + index] === byte);

// Verify a known media payload's magic bytes. A MIME that claims png but carries
// a jpeg body is a real mismatch (a renamed file, a mislabelled upload), so it is
// rejected rather than forwarded to a provider that would fail less clearly.
const verifySignature = (mime: string, bytes: Uint8Array, label: string): void => {
    const fail = (): never => {
        throw new Error(`${label}.data does not match its declared MIME "${mime}" (magic signature mismatch).`);
    };

    switch (mime) {
        case 'image/png':
            if (!startsWith(bytes, PNG_SIGNATURE)) fail();
            return;

        case 'image/jpeg':
        case 'image/jpg':
            if (!startsWith(bytes, JPEG_SIGNATURE)) fail();
            return;

        case 'image/gif':
            if (!startsWith(bytes, GIF87_SIGNATURE) && !startsWith(bytes, GIF89_SIGNATURE)) fail();
            return;

        case 'image/webp':
            // RIFF container with the WEBP fourcc at offset 8.
            if (!startsWith(bytes, WEBP_RIFF) || !matchesAt(bytes, 8, WEBP_WEBP)) fail();
            return;

        case 'application/pdf':
            // The header may have a little leading junk in the wild, but a clean
            // upload starts with %PDF-; require it so a text blob cannot pose as a
            // document.
            if (!startsWith(bytes, PDF_SIGNATURE)) fail();
            return;

        case 'audio/wav':
        case 'audio/x-wav':
        case 'audio/wave':
            // RIFF container with the WAVE fourcc at offset 8.
            if (!startsWith(bytes, WAV_RIFF) || !matchesAt(bytes, 8, WAV_WAVE)) fail();
            return;

        case 'audio/mpeg':
        case 'audio/mp3':
            // MP3 is either an ID3-tagged file or a bare frame sync (0xFF Ex).
            if (!startsWith(bytes, ascii('ID3')) && !(bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
                fail();
            }
            return;

        case 'video/mp4':
        case 'video/quicktime':
            // ISO base media: a `ftyp` box begins at offset 4.
            if (!matchesAt(bytes, 4, MP4_FTYP)) fail();
            return;

        case 'video/webm':
            if (!startsWith(bytes, WEBM_SIGNATURE)) fail();
            return;

        case 'video/ogg':
            if (!startsWith(bytes, OGG_SIGNATURE)) fail();
            return;

        default:
            // `file` has no signature contract; the transport refuses it anyway.
            return;
    }
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Read one record exactly: every field present and no unknown field, mirroring
// the snapshot readers (a silently dropped field would be silent data loss).
// `limits` is the caller's PROFILE (upload by default); only the byte/count
// gates read it, so an upload and a download file are checked by the SAME
// grammar, MIME, signature and canonical-base64 rules.
const readAttachment = (
    value: unknown,
    index: number,
    limits: HarnessAttachmentLimits
): HarnessAttachment => {
    const label = `attachments[${index}]`;

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }

    const record = value as Record<string, unknown>;
    const allowed = ['id', 'kind', 'marker', 'name', 'mime', 'size', 'data'];

    for (const key of Object.keys(record)) {
        if (!allowed.includes(key)) {
            throw new Error(`${label} has an unknown field "${key}".`);
        }
    }

    for (const key of allowed) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) {
            throw new Error(`${label} is missing the field "${key}".`);
        }
    }

    const id = record.id;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
        throw new Error(`${label}.id must be a non-empty printable id of at most 100 characters.`);
    }

    const kind = record.kind;
    if (kind !== 'image' && kind !== 'video' && kind !== 'audio' && kind !== 'pdf' && kind !== 'file') {
        throw new Error(`${label}.kind must be one of: image, video, audio, pdf, file.`);
    }

    const marker = record.marker;
    if (typeof marker !== 'string') {
        throw new Error(`${label}.marker must be a string.`);
    }

    if (marker.length > MAX_MARKER_LENGTH) {
        throw new Error(`${label}.marker must be at most ${MAX_MARKER_LENGTH} characters.`);
    }

    const markerMatch = MARKER_PATTERN.exec(marker);
    if (markerMatch === null) {
        throw new Error(`${label}.marker must match the pattern "[Image 1]" (also Video, Audio, PDF, File).`);
    }

    // Even inside the grammar a 17+ digit index is beyond a safe integer; check
    // it now so downstream numeric use can never see a lossy value.
    if (!Number.isSafeInteger(Number(markerMatch[2]))) {
        throw new Error(`${label}.marker index is too large.`);
    }

    const markerLabel = markerMatch[1];
    if (!MARKER_LABELS[kind].includes(markerLabel)) {
        throw new Error(`${label}.marker "${marker}" does not match kind "${kind}".`);
    }

    const name = record.name;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
        throw new Error(`${label}.name must be a plain file name (no path separators or URL scheme).`);
    }

    const mime = record.mime;
    if (typeof mime !== 'string') {
        throw new Error(`${label}.mime must be a lowercase MIME type without parameters.`);
    }

    if (mime.length > MAX_MIME_LENGTH) {
        throw new Error(`${label}.mime must be at most ${MAX_MIME_LENGTH} characters.`);
    }

    if (!MIME_PATTERN.test(mime)) {
        throw new Error(`${label}.mime must be a lowercase MIME type without parameters.`);
    }

    const allowedMime = MIME_BY_KIND[kind];
    if (allowedMime.length > 0 && !allowedMime.includes(mime)) {
        throw new Error(`${label}.mime "${mime}" is not valid for kind "${kind}".`);
    }

    const size = record.size;
    if (!Number.isSafeInteger(size) || (size as number) < 1) {
        throw new Error(`${label}.size must be a positive safe integer (decoded bytes).`);
    }

    const data = record.data;
    if (typeof data !== 'string' || data.length === 0) {
        throw new Error(`${label}.data must be non-empty raw base64 text.`);
    }

    // Cheap ceiling before the regex so a hostile multi-megabyte string cannot
    // spend time matching beyond anything that could be accepted. The ceiling is
    // derived from the PROFILE's decoded-byte cap, so a 20 MiB download (about
    // 26.7 MB of base64) is measured against the download bound and never
    // collides with the 4 MiB upload cap.
    if (data.length > Math.ceil(limits.perAttachmentBytes / 3) * 4 + 4) {
        throw new Error(`${label}.data exceeds the ${limits.perAttachmentBytes}-byte attachment limit.`);
    }

    if (!isCanonicalBase64(data)) {
        throw new Error(`${label}.data must be canonical base64 (no data: prefix or whitespace).`);
    }

    const bytes = decodedBytes(data);
    if (bytes < 1) {
        throw new Error(`${label}.data must decode to at least one byte.`);
    }

    if (bytes > limits.perAttachmentBytes) {
        throw new Error(`${label}.data is ${bytes} bytes, above the ${limits.perAttachmentBytes}-byte attachment limit.`);
    }

    if ((size as number) !== bytes) {
        throw new Error(`${label}.size is ${String(size)}, but its data decodes to ${bytes} bytes.`);
    }

    // Signature checks only need the first 16 bytes (ftyp at offset 4).
    verifySignature(mime, decodeBase64Prefix(data, 16), label);

    return { id, kind, marker, name, mime, size: size as number, data };
};

// Validate one attachment list and return detached copies. `undefined` is the
// historical text-only call and yields `[]`; anything else is checked completely
// before the caller mutates history or sends a request.
//
// `limits` defaults to UPLOAD_ATTACHMENT_LIMITS, which is the exact historical
// behaviour of every existing caller (composer, submit route, agent user(),
// snapshot user attachments, transport). A caller that validates tool media
// passes DOWNLOAD_ATTACHMENT_LIMITS; nothing else about the check changes —
// grammar, MIME tables, magic signatures and canonical base64 are shared, so a
// download cannot be more sloppy about its bytes than an upload is.
export const validateAttachments = (
    value: unknown,
    limits: HarnessAttachmentLimits = UPLOAD_ATTACHMENT_LIMITS
): HarnessAttachment[] => {
    if (value === undefined) return [];

    if (!Array.isArray(value)) {
        throw new Error('attachments must be an array.');
    }

    if (value.length > limits.count) {
        throw new Error(`attachments may contain at most ${limits.count} entries; received ${value.length}.`);
    }

    const attachments = value.map((entry, index) => readAttachment(entry, index, limits));
    const seenIds = new Set<string>();
    const seenMarkers = new Set<string>();
    let totalBytes = 0;

    for (const attachment of attachments) {
        if (seenIds.has(attachment.id)) {
            throw new Error(`attachments contain the duplicate id "${attachment.id}".`);
        }

        if (seenMarkers.has(attachment.marker)) {
            throw new Error(`attachments contain the duplicate marker "${attachment.marker}".`);
        }

        seenIds.add(attachment.id);
        seenMarkers.add(attachment.marker);
        totalBytes += attachment.size;
    }

    if (totalBytes > limits.totalBytes) {
        throw new Error(
            `attachments total ${totalBytes} bytes, above the ${limits.totalBytes}-byte per-turn limit.`
        );
    }

    return attachments;
};

// client/src/services/uploadService.ts

export interface UploadOptions {
  fileUri: string;
  recipients: string[];
  expiryTimeSeconds: number; // e.g. 3600 for 1 hour
  viewLimit: number;        // e.g. 1, 3, 5
}

export interface UploadResponse {
  mediaId: string;
  status: 'PENDING_PREPARATION' | 'READY';
  expiresAt: string;
}

export type SupportedImageMimeType = 'image/jpeg' | 'image/png';

export interface StrippedImage {
  buffer: ArrayBuffer;
  mimeType: SupportedImageMimeType;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function detectImageMimeType(buffer: ArrayBuffer): SupportedImageMimeType {
  const bytes = new Uint8Array(buffer);

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'image/jpeg';
  }

  if (bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    return 'image/png';
  }

  throw new Error('Unsupported image format: expected JPEG or PNG');
}

/**
 * Strips EXIF/GPS metadata from a raw JPEG ArrayBuffer in-memory.
 * Zeroes out APP1 (EXIF) segment bytes before network upload.
 */
function stripJpegMetadata(buffer: ArrayBuffer): ArrayBuffer {
  const dataView = new DataView(buffer);
  let offset = 2;

  while (offset < dataView.byteLength - 2) {
    const marker = dataView.getUint16(offset, false);

    if (marker === 0xffe1) {
      const length = dataView.getUint16(offset + 2, false);
      for (let i = 0; i < length + 2; i++) {
        dataView.setUint8(offset + i, 0);
      }
      offset += length + 2;
    } else if ((marker & 0xff00) === 0xff00) {
      const length = dataView.getUint16(offset + 2, false);
      offset += length + 2;
    } else {
      break;
    }
  }

  return buffer;
}

// Ancillary PNG chunk types that can carry metadata (EXIF, textual, timestamp).
const PNG_METADATA_CHUNK_TYPES = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

/**
 * Strips metadata-bearing chunks from a raw PNG ArrayBuffer by rebuilding
 * the chunk stream without them (chunks can't be zero-filled in place —
 * each has its own length/type/CRC, so removal must drop the whole chunk).
 */
function stripPngMetadata(buffer: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(buffer);
  const dataView = new DataView(buffer);
  const SIGNATURE_LENGTH = 8;

  const keptChunks: Array<{ start: number; end: number }> = [];
  let offset = SIGNATURE_LENGTH;

  while (offset + 8 <= bytes.length) {
    const length = dataView.getUint32(offset, false);
    const type = String.fromCharCode(
      bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]
    );
    const chunkEnd = offset + 8 + length + 4; // length field + type + data + CRC

    if (chunkEnd > bytes.length) break; // truncated/malformed — stop defensively

    if (!PNG_METADATA_CHUNK_TYPES.has(type)) {
      keptChunks.push({ start: offset, end: chunkEnd });
    }

    offset = chunkEnd;
    if (type === 'IEND') break;
  }

  const totalLength =
    SIGNATURE_LENGTH + keptChunks.reduce((sum, c) => sum + (c.end - c.start), 0);
  const output = new Uint8Array(totalLength);
  output.set(bytes.subarray(0, SIGNATURE_LENGTH), 0);

  let writeOffset = SIGNATURE_LENGTH;
  for (const chunk of keptChunks) {
    output.set(bytes.subarray(chunk.start, chunk.end), writeOffset);
    writeOffset += chunk.end - chunk.start;
  }

  return output.buffer;
}

/**
 * Strips metadata from a raw JPEG or PNG ArrayBuffer in-memory, returning
 * the cleaned buffer along with the detected MIME type.
 */
export function stripExifMetadata(buffer: ArrayBuffer): StrippedImage {
  const mimeType = detectImageMimeType(buffer);
  const stripped =
    mimeType === 'image/jpeg' ? stripJpegMetadata(buffer) : stripPngMetadata(buffer);

  return { buffer: stripped, mimeType };
}

/**
 * Encapsulates the network transaction over TLS with ephemeral lifecycle guarantees.
 */
export async function uploadSecureMedia(
  options: UploadOptions,
  rawBuffer: ArrayBuffer,
  authToken: string,
  apiEndpoint: string
): Promise<UploadResponse> {
  // 1. In-memory metadata stripping
  const { buffer: cleanBuffer, mimeType } = stripExifMetadata(rawBuffer);

  // 2. Prepare Multipart Form payload
  const formData = new FormData();
  const extension = mimeType === 'image/png' ? 'png' : 'jpg';
  const blob = new Blob([cleanBuffer], { type: mimeType });

  formData.append('image', blob, `secure_payload.${extension}`);
  formData.append('recipients', JSON.stringify(options.recipients));
  formData.append('expiryTimeSeconds', options.expiryTimeSeconds.toString());
  formData.append('viewLimit', options.viewLimit.toString());

  // 3. Dispatch over HTTPS/TLS
  const response = await fetch(`${apiEndpoint}/api/v1/media/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'X-Client-Timestamp': new Date().toISOString()
    },
    body: formData
  });

  if (!response.ok) {
    const errorMsg = await response.text();
    throw new Error(`Upload failed [${response.status}]: ${errorMsg}`);
  }

  return await response.json() as UploadResponse;
}

// server/src/routes/upload.ts

import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// ---- Limits -------------------------------------------------------------
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB
const MAX_PIXELS = 50_000_000; // guards against decompression bombs
const MAX_RECIPIENTS = 50;
const MAX_EXPIRY_SECONDS = 7 * 86400;
const MAX_VIEW_LIMIT = 100;
const RECIPIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
// Verified against the actual bytes via sharp metadata, not just the client-declared MIME type
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif']);

class UnsupportedTypeError extends Error {}

// Memory-only storage ensures no unencrypted intermediate files hit the disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: 1,
    fields: 5,
    parts: 6,
    fieldSize: 16 * 1024
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new UnsupportedTypeError('Unsupported file type'));
  }
});

// Wrap multer so its errors become proper 4xx JSON responses instead of generic 500s
function singleImage(req: Request, res: Response, next: NextFunction): void {
  upload.single('image')(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      res.status(status).json({ error: `Upload rejected: ${err.code}` });
      return;
    }
    if (err instanceof UnsupportedTypeError) {
      res.status(415).json({ error: 'Unsupported file type. Use JPEG, PNG, WebP or HEIC.' });
      return;
    }
    next(err);
  });
}

// ---- Parsing helpers ----------------------------------------------------
interface UploadRequestBody {
  recipients?: unknown;
  expiryTimeSeconds?: unknown;
  viewLimit?: unknown;
}

// Strict integer parsing: rejects "10abc", "1e3", "", arrays (duplicate form fields), etc.
function parseStrictInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

function parseRecipients(value: unknown): string[] | null {
  if (typeof value !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((r) => typeof r === 'string' && RECIPIENT_ID_PATTERN.test(r))) return null;
  const unique = Array.from(new Set(parsed as string[]));
  return unique.length >= 1 && unique.length <= MAX_RECIPIENTS ? unique : null;
}

// ---- Route --------------------------------------------------------------
// NOTE: mount behind authentication + rate limiting middleware. Each request can
// hold up to 15MB in memory and trigger an image decode.
router.post(
  '/upload',
  singleImage,
  async (req: Request<{}, {}, UploadRequestBody>, res: Response): Promise<void> => {
    try {
      if (!req.file || !req.file.buffer) {
        res.status(400).json({ error: 'Missing binary payload' });
        return;
      }

      const body = req.body ?? {};

      // Cheap validation first, before spending CPU on image decoding
      const recipients = parseRecipients(body.recipients);
      if (!recipients) {
        res.status(400).json({
          error: `recipients must be a JSON array of 1-${MAX_RECIPIENTS} valid user IDs.`
        });
        return;
      }

      const expiryTimeSeconds = parseStrictInt(body.expiryTimeSeconds, 1, MAX_EXPIRY_SECONDS);
      if (expiryTimeSeconds === null) {
        res.status(400).json({ error: 'Invalid expiry duration (must be between 1s and 7 days).' });
        return;
      }

      const viewLimit = parseStrictInt(body.viewLimit, 1, MAX_VIEW_LIMIT);
      if (viewLimit === null) {
        res.status(400).json({ error: `Invalid view limit (must be between 1 and ${MAX_VIEW_LIMIT}).` });
        return;
      }

      // Image sanitization. Bad/corrupt images are a client error (422), not a server error.
      let sanitizedImageBuffer: Buffer;
      try {
        const image = sharp(req.file.buffer, { limitInputPixels: MAX_PIXELS, failOn: 'error' });

        const meta = await image.metadata();
        if (!meta.format || !ALLOWED_FORMATS.has(meta.format)) {
          res.status(415).json({ error: 'Unsupported image format.' });
          return;
        }

        // sharp strips ALL metadata (EXIF/GPS, XMP, IPTC, ICC) by default.
        // Do NOT call .withMetadata(): it opts IN to keeping metadata.
        // .rotate() bakes the EXIF orientation into the pixels before it is dropped.
        sanitizedImageBuffer = await image
          .rotate()
          .flatten({ background: '#ffffff' }) // transparent PNG/WebP would otherwise turn black in JPEG
          .jpeg({ quality: 95 })
          .toBuffer();
      } catch (imgErr) {
        console.warn('Stage 1 image rejected:', imgErr instanceof Error ? imgErr.message : imgErr);
        res.status(422).json({ error: 'Image could not be read or is too large.' });
        return;
      }

      const mediaId = `med_${uuidv4()}`;
      const expiresAt = new Date(Date.now() + expiryTimeSeconds * 1000).toISOString();

      // TODO (Stage 2): hand off sanitizedImageBuffer, recipients, viewLimit, expiresAt and
      // mediaId to server preparation (queue / encrypted storage) and `await` it BEFORE
      // responding. Until that exists, the 202 below is not truthful: nothing is stored.

      res.status(202).json({
        mediaId,
        status: 'PENDING_PREPARATION',
        recipientsCount: recipients.length,
        expiresAt,
        viewLimit
      });
    } catch (err: unknown) {
      // Log the message only, never request bodies or buffers
      console.error('Stage 1 Upload error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Internal server error processing payload' });
    }
  }
);

export default router;
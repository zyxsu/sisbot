import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export class SessionEncryptionError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionEncryptionError';
  }
}

export class SessionDecryptionError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionDecryptionError';
  }
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH_BYTES = 16; // 128-bit tag
const VERSION_PREFIX = 'v1';

/**
 * Normalizes an arbitrary secret string or passphrase into a 32-byte AES key.
 * If a 64-character hex string is supplied, it is decoded directly.
 * Otherwise, SHA-256 is used to derive a consistent 256-bit key.
 */
export function deriveKey(secretKey: string): Buffer {
  if (typeof secretKey !== 'string' || secretKey.trim().length === 0) {
    throw new SessionEncryptionError('Encryption key must be a non-empty string');
  }

  const trimmed = secretKey.trim();

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  return createHash('sha256').update(trimmed, 'utf8').digest();
}

/**
 * Encrypts a string using AES-256-GCM.
 * Output format: `v1:<iv_hex>:<auth_tag_hex>:<ciphertext_hex>`
 */
export function encryptString(plaintext: string, secretKey: string): string {
  try {
    const key = deriveKey(secretKey);
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `${VERSION_PREFIX}:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
  } catch (error) {
    if (error instanceof SessionEncryptionError) {
      throw error;
    }
    throw new SessionEncryptionError('Failed to encrypt payload', { cause: error });
  }
}

/**
 * Decrypts a string encrypted with `encryptString`.
 */
export function decryptString(encryptedEnvelope: string, secretKey: string): string {
  try {
    const key = deriveKey(secretKey);

    if (
      typeof encryptedEnvelope !== 'string' ||
      !encryptedEnvelope.startsWith(`${VERSION_PREFIX}:`)
    ) {
      throw new SessionDecryptionError('Invalid or unsupported encryption envelope format');
    }

    const parts = encryptedEnvelope.split(':');
    if (parts.length !== 4) {
      throw new SessionDecryptionError('Malformed encryption envelope parts');
    }

    const [, ivHex, tagHex, ciphertextHex] = parts;
    if (ivHex === undefined || tagHex === undefined || ciphertextHex === undefined) {
      throw new SessionDecryptionError('Missing fields in encryption envelope');
    }

    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');

    if (iv.length !== IV_LENGTH_BYTES || tag.length !== AUTH_TAG_LENGTH_BYTES) {
      throw new SessionDecryptionError('Invalid IV or auth tag length in encryption envelope');
    }

    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return decrypted.toString('utf8');
  } catch (error) {
    if (error instanceof SessionDecryptionError) {
      throw error;
    }
    throw new SessionDecryptionError('Failed to decrypt or verify payload integrity', {
      cause: error,
    });
  }
}

/**
 * Encrypts any JSON-serializable payload into a tamper-proof envelope.
 */
export function encryptPayload(payload: unknown, secretKey: string): string {
  const jsonString = JSON.stringify(payload);
  return encryptString(jsonString, secretKey);
}

/**
 * Decrypts and parses a JSON payload encrypted with `encryptPayload`.
 */
export function decryptPayload(encryptedEnvelope: string, secretKey: string): unknown {
  const decryptedString = decryptString(encryptedEnvelope, secretKey);
  try {
    return JSON.parse(decryptedString) as unknown;
  } catch (error) {
    throw new SessionDecryptionError('Failed to parse decrypted JSON payload', {
      cause: error,
    });
  }
}

import { describe, expect, it } from 'vitest';
import {
  decryptPayload,
  decryptString,
  deriveKey,
  encryptPayload,
  encryptString,
  SessionDecryptionError,
  SessionEncryptionError,
} from '../../src/security/encryption.js';

describe('AES-256-GCM Session Encryption', () => {
  const sampleKey = 'my-super-secret-passphrase-for-tests-12345';
  const sampleHexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('derives a 32-byte key from a passphrase or 64-character hex string', () => {
    const key1 = deriveKey(sampleKey);
    expect(key1).toHaveLength(32);

    const key2 = deriveKey(sampleHexKey);
    expect(key2).toHaveLength(32);
    expect(key2.toString('hex')).toBe(sampleHexKey);
  });

  it('rejects empty encryption keys', () => {
    expect(() => deriveKey('')).toThrow(SessionEncryptionError);
    expect(() => deriveKey('   ')).toThrow(SessionEncryptionError);
  });

  it('encrypts and decrypts a plain string', () => {
    const message = 'JSESSIONID=abcdef123456; PS_TOKEN=token123';
    const encrypted = encryptString(message, sampleKey);

    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(encrypted.split(':')).toHaveLength(4);

    const decrypted = decryptString(encrypted, sampleKey);
    expect(decrypted).toBe(message);
  });

  it('encrypts and decrypts structured JSON payloads', () => {
    const payload = {
      cookies: ['JSESSIONID=123', 'PS_TOKEN=abc'],
      icsid: 'icsid-val-999',
      issuedAt: '2026-08-26T18:00:00.000Z',
    };

    const encrypted = encryptPayload(payload, sampleKey);
    const decrypted = decryptPayload(encrypted, sampleKey) as typeof payload;

    expect(decrypted).toEqual(payload);
  });

  it('fails decryption when wrong key is provided (authentication tag verification fails)', () => {
    const message = 'secret-data';
    const encrypted = encryptString(message, sampleKey);
    const wrongKey = 'completely-different-key-for-decryption';

    expect(() => decryptString(encrypted, wrongKey)).toThrow(SessionDecryptionError);
  });

  it('fails decryption when ciphertext is tampered with', () => {
    const message = 'sensitive-credentials';
    const encrypted = encryptString(message, sampleKey);
    const parts = encrypted.split(':');
    const version = parts[0] ?? 'v1';
    const iv = parts[1] ?? '';
    const tag = parts[2] ?? '';
    const ciphertext = parts[3] ?? '';

    // Tamper with the ciphertext
    const tamperedCiphertext = ciphertext.slice(0, -2) + (ciphertext.endsWith('a') ? 'b' : 'a');
    const tamperedEnvelope = `${version}:${iv}:${tag}:${tamperedCiphertext}`;

    expect(() => decryptString(tamperedEnvelope, sampleKey)).toThrow(SessionDecryptionError);
  });

  it('fails decryption when envelope format is malformed or wrong version', () => {
    expect(() => decryptString('invalid-envelope', sampleKey)).toThrow(SessionDecryptionError);
    expect(() => decryptString('v2:iv:tag:ciphertext', sampleKey)).toThrow(SessionDecryptionError);
    expect(() => decryptString('v1:short:tag:cipher', sampleKey)).toThrow(SessionDecryptionError);
  });

  it('fails JSON parsing when decrypted content is not valid JSON', () => {
    const notJsonEncrypted = encryptString('hello world (not json)', sampleKey);
    expect(() => decryptPayload(notJsonEncrypted, sampleKey)).toThrow(SessionDecryptionError);
  });
});

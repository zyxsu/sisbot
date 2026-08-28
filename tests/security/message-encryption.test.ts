import { describe, expect, it } from 'vitest';
import {
  decryptArchivedMessage,
  encryptArchivedMessage,
} from '../../src/security/message-encryption.js';

describe('archived Telegram message encryption', () => {
  it('uses authenticated encryption and a message-specific key domain', () => {
    const key = 'secured-master-key-for-testing';
    const payload = { text: 'secret message', caption: null, metadata: { type: 'text' } };
    const ciphertext = encryptArchivedMessage(payload, key);
    expect(ciphertext).toMatch(/^v1:/);
    expect(ciphertext).not.toContain('secret message');
    expect(decryptArchivedMessage(ciphertext, key)).toEqual(payload);
    expect(() => decryptArchivedMessage(ciphertext, 'wrong-key')).toThrow();
  });
});

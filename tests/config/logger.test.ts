import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createLogger } from '../../src/config/logger.js';

describe('createLogger', () => {
  it('redacts structured headers and secrets embedded in messages', () => {
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString('utf8'));
        callback();
      },
    });
    const logger = createLogger(destination);
    const headerSecret = 'logger-authorization-secret-for-test';
    const cookieSecret = 'logger-cookie-secret-for-test';

    logger.info(
      { headers: { Authorization: `Bearer ${headerSecret}` } },
      `Cookie: PS_TOKEN=${cookieSecret}`,
    );

    const output = chunks.join('');
    expect(output).not.toContain(headerSecret);
    expect(output).not.toContain(cookieSecret);
    expect(output).toContain('[REDACTED]');
  });
});

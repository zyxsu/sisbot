import { decryptPayload, encryptPayload } from './encryption.js';

const MESSAGE_KEY_CONTEXT = 'auib-user-messages:aes-256-gcm:v1:';

export interface ArchivedMessagePayload {
  text: string | null;
  caption: string | null;
  metadata: Record<string, unknown>;
}

function domainSeparatedKey(masterKey: string): string {
  return `${MESSAGE_KEY_CONTEXT}${masterKey}`;
}

export function encryptArchivedMessage(payload: ArchivedMessagePayload, masterKey: string): string {
  return encryptPayload(payload, domainSeparatedKey(masterKey));
}

export function decryptArchivedMessage(
  ciphertext: string,
  masterKey: string,
): ArchivedMessagePayload {
  return decryptPayload(ciphertext, domainSeparatedKey(masterKey)) as ArchivedMessagePayload;
}

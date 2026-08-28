import postgres from 'postgres';
import { loadEnvironment } from '../config/env.js';
import { encryptArchivedMessage } from '../security/message-encryption.js';

interface LegacyMessage {
  id: string;
  text: string | null;
  caption: string | null;
  metadata: Record<string, unknown> | null;
}

async function run(): Promise<void> {
  const environment = loadEnvironment();
  const masterKey = environment.SESSION_ENCRYPTION_KEY;
  if (masterKey === undefined) throw new Error('SESSION_ENCRYPTION_KEY is required');
  const sql = postgres(environment.DATABASE_URL, { max: 1, connect_timeout: 10 });
  try {
    const rows = await sql<LegacyMessage[]>`
      SELECT id, text, caption, metadata
      FROM user_messages
      WHERE encrypted_payload IS NULL
    `;
    for (const row of rows) {
      const encryptedPayload = encryptArchivedMessage(
        { text: row.text, caption: row.caption, metadata: row.metadata ?? {} },
        masterKey,
      );
      await sql`
        UPDATE user_messages
        SET encrypted_payload = ${encryptedPayload},
            encryption_version = 'aes-256-gcm-v1',
            text = NULL,
            caption = NULL,
            metadata = NULL
        WHERE id = ${row.id}
      `;
    }
    console.log(`Encrypted ${String(rows.length)} existing user message(s).`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

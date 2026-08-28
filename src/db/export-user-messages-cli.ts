import { writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { loadEnvironment } from '../config/env.js';
import { decryptArchivedMessage } from '../security/message-encryption.js';

interface MessageExportRow {
  id: string;
  userId: string;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  chatId: string;
  telegramMessageId: string;
  telegramUpdateId: string;
  messageType: string;
  text: string | null;
  caption: string | null;
  metadata: Record<string, unknown> | null;
  encryptedPayload: string | null;
  encryptionVersion: string | null;
  sentAt: Date;
  createdAt: Date;
}

export interface DecryptedMessageRecord {
  id: string;
  userId: string;
  user: {
    telegramId: string;
    username: string | null;
    firstName: string | null;
  };
  chatId: string;
  telegramMessageId: string;
  telegramUpdateId: string;
  messageType: string;
  decryptedContent: {
    text: string | null;
    caption: string | null;
    metadata: Record<string, unknown>;
  };
  encryptionVersion: string | null;
  sentAt: string;
  createdAt: string;
}

function parseArgs(args: string[]): {
  userQuery?: string | undefined;
  limit: number;
  format: 'text' | 'json';
  outFile?: string | undefined;
} {
  let userQuery: string | undefined;
  let limit = 100;
  let format: 'text' | 'json' = 'text';
  let outFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--user' || arg === '-u') && i + 1 < args.length) {
      userQuery = args[++i];
    } else if ((arg === '--limit' || arg === '-l') && i + 1 < args.length) {
      const parsed = Number.parseInt(args[++i] ?? '', 10);
      if (!Number.isNaN(parsed) && parsed > 0) limit = parsed;
    } else if (arg === '--format' && i + 1 < args.length) {
      const val = args[++i];
      if (val === 'json' || val === 'text') format = val;
    } else if ((arg === '--out' || arg === '-o') && i + 1 < args.length) {
      outFile = args[++i];
    }
  }

  return { userQuery, limit, format, outFile };
}

export function decryptRow(row: MessageExportRow, masterKey: string): DecryptedMessageRecord {
  let content = {
    text: row.text,
    caption: row.caption,
    metadata: row.metadata ?? {},
  };

  if (typeof row.encryptedPayload === 'string' && row.encryptedPayload.length > 0) {
    try {
      content = decryptArchivedMessage(row.encryptedPayload, masterKey);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      content = {
        text: `[DECRYPTION_ERROR: ${msg}]`,
        caption: null,
        metadata: { rawError: msg },
      };
    }
  }

  return {
    id: row.id,
    userId: row.userId,
    user: {
      telegramId: row.telegramId,
      username: row.username,
      firstName: row.firstName,
    },
    chatId: row.chatId,
    telegramMessageId: row.telegramMessageId,
    telegramUpdateId: row.telegramUpdateId,
    messageType: row.messageType,
    decryptedContent: content,
    encryptionVersion: row.encryptionVersion,
    sentAt: row.sentAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

async function run(): Promise<void> {
  const env = loadEnvironment();
  const masterKey = env.SESSION_ENCRYPTION_KEY;
  if (masterKey === undefined) {
    throw new Error('SESSION_ENCRYPTION_KEY is required to decrypt messages');
  }

  const { userQuery, limit, format, outFile } = parseArgs(process.argv.slice(2));
  const sql = postgres(env.DATABASE_URL, { max: 1, connect_timeout: 10 });

  try {
    let rows: MessageExportRow[];

    if (userQuery !== undefined && userQuery.trim().length > 0) {
      const q = userQuery.trim();
      const cleanQ = q.replace(/^@/, '');
      const isNumber = /^\d+$/.test(q);
      const isUuid = /^[0-9a-fA-F-]{36}$/.test(q);

      const condition = isUuid
        ? sql`u.id = ${q}::uuid`
        : isNumber
          ? sql`u.telegram_id = ${q}::bigint`
          : sql`u.username ILIKE ${cleanQ} OR u.first_name ILIKE ${cleanQ} OR (u.first_name || ' ' || COALESCE(u.username, '')) ILIKE ${'%' + cleanQ + '%'}`;

      rows = await sql<MessageExportRow[]>`
        SELECT 
          m.id,
          m.user_id as "userId",
          u.telegram_id::text as "telegramId",
          u.username,
          u.first_name as "firstName",
          m.chat_id::text as "chatId",
          m.telegram_message_id::text as "telegramMessageId",
          m.telegram_update_id::text as "telegramUpdateId",
          m.message_type as "messageType",
          m.text,
          m.caption,
          m.metadata,
          m.encrypted_payload as "encryptedPayload",
          m.encryption_version as "encryptionVersion",
          m.sent_at as "sentAt",
          m.created_at as "createdAt"
        FROM user_messages m
        JOIN users u ON u.id = m.user_id
        WHERE ${condition}
        ORDER BY m.sent_at ASC
        LIMIT ${limit}
      `;
    } else {
      rows = await sql<MessageExportRow[]>`
        SELECT 
          m.id,
          m.user_id as "userId",
          u.telegram_id::text as "telegramId",
          u.username,
          u.first_name as "firstName",
          m.chat_id::text as "chatId",
          m.telegram_message_id::text as "telegramMessageId",
          m.telegram_update_id::text as "telegramUpdateId",
          m.message_type as "messageType",
          m.text,
          m.caption,
          m.metadata,
          m.encrypted_payload as "encryptedPayload",
          m.encryption_version as "encryptionVersion",
          m.sent_at as "sentAt",
          m.created_at as "createdAt"
        FROM user_messages m
        JOIN users u ON u.id = m.user_id
        ORDER BY m.sent_at DESC
        LIMIT ${limit}
      `;
    }

    const decrypted = rows.map((r) => decryptRow(r, masterKey));

    let outputString = '';
    if (format === 'json') {
      outputString = JSON.stringify(decrypted, null, 2);
    } else {
      const lines: string[] = [
        `========================================================================`,
        ` LEGAL & COMPLIANCE MESSAGE DECRYPTION AUDIT REPORT`,
        ` Total Messages Decrypted: ${String(decrypted.length)}`,
        ` Generated At: ${new Date().toISOString()}`,
        `========================================================================\n`,
      ];

      for (const msg of decrypted) {
        const sender = msg.user.username
          ? `@${msg.user.username} (${msg.user.firstName ?? 'Unknown'}, ID: ${msg.user.telegramId})`
          : `${msg.user.firstName ?? 'Unknown'} (ID: ${msg.user.telegramId})`;

        lines.push(`------------------------------------------------------------------------`);
        lines.push(`Date/Time : ${msg.sentAt}`);
        lines.push(`Sender    : ${sender}`);
        lines.push(`Chat ID   : ${msg.chatId} | Message ID: ${msg.telegramMessageId}`);
        lines.push(`Type      : ${msg.messageType} | Security: ${msg.encryptionVersion ?? 'plaintext'}`);
        if (msg.decryptedContent.text !== null) {
          lines.push(`Text      : ${msg.decryptedContent.text}`);
        }
        if (msg.decryptedContent.caption !== null) {
          lines.push(`Caption   : ${msg.decryptedContent.caption}`);
        }
        if (Object.keys(msg.decryptedContent.metadata).length > 0) {
          lines.push(`Metadata  : ${JSON.stringify(msg.decryptedContent.metadata)}`);
        }
      }
      lines.push(`------------------------------------------------------------------------`);
      outputString = lines.join('\n');
    }

    if (outFile !== undefined) {
      writeFileSync(outFile, outputString, 'utf8');
      console.log(`Successfully exported and decrypted ${String(decrypted.length)} message(s) to ${outFile}`);
    } else {
      console.log(outputString);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1]?.endsWith('export-user-messages-cli.ts') || process.argv[1]?.endsWith('export-user-messages-cli.js')) {
  void run().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}

import { describe, expect, it, vi } from 'vitest';
import type { AuibAuthenticator, LoginResult } from '../../src/auth/types.js';
import {
  clearLoginState,
  getActiveLoginState,
  handleCancel,
  handleLogin,
  loginConversationMiddleware,
} from '../../src/telegram/handlers/login.js';
import type { BotContext, BotServices } from '../../src/telegram/types.js';

describe('Telegram Interactive Login Handler', () => {
  const encryptionKey = 'test-encryption-key-for-login-32chars';
  const telegramUserId = BigInt(987654321);

  function createMockLoginContext(
    text = '',
    messageId = 101,
  ): {
    ctx: BotContext;
    replies: { text: string; options?: unknown }[];
    deletedMessages: number[];
    savedSessions: { userId: string; sessionData: unknown; encryptionKey: string }[];
    startLoginFn: ReturnType<typeof vi.fn>;
    submit2FaFn: ReturnType<typeof vi.fn>;
  } {
    const replies: { text: string; options?: unknown }[] = [];
    const deletedMessages: number[] = [];
    const savedSessions: { userId: string; sessionData: unknown; encryptionKey: string }[] = [];

    const startLoginFn = vi.fn().mockResolvedValue({
      status: 'SUCCESS',
      cookies: 'PS_TOKEN=test-token; JSESSIONID=abc',
    });
    const submit2FaFn = vi.fn().mockResolvedValue({
      status: 'SUCCESS',
      cookies: 'PS_TOKEN=verified-2fa-token; JSESSIONID=abc',
    });

    const mockAuthenticator: AuibAuthenticator = {
      startLogin: (email, password) => startLoginFn(email, password) as Promise<LoginResult>,
      submit2Fa: (challengeContext, code) =>
        submit2FaFn(challengeContext, code) as Promise<LoginResult>,
    };

    const mockServices: BotServices = {
      repositories: {
        userRepository: {} as BotServices['repositories']['userRepository'],
        userSessionRepository: {
          saveUserSession: vi
            .fn()
            .mockImplementation(
              (input: { userId: string; sessionData: unknown; encryptionKey: string }) => {
                savedSessions.push(input);
                return Promise.resolve({
                  id: 'sess-1',
                  userId: input.userId,
                  encryptedData: 'v1:mock_encrypted_envelope',
                  status: 'ACTIVE',
                  lastUsedAt: null,
                  expiresAt: null,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                });
              },
            ),
        } as unknown as BotServices['repositories']['userSessionRepository'],
        sectionRepository: {} as BotServices['repositories']['sectionRepository'],
        subscriptionRepository: {} as BotServices['repositories']['subscriptionRepository'],
        notificationLogRepository: {} as BotServices['repositories']['notificationLogRepository'],
        userMessageRepository: {} as BotServices['repositories']['userMessageRepository'],
      },
      config: {
        encryptionKey,
        defaultTerm: '2701',
        defaultTermLabel: '2026/2027 Fall',
      },
      authenticator: mockAuthenticator,
    };

    const ctx = {
      from: {
        id: Number(telegramUserId),
        is_bot: false,
        first_name: 'Zaid',
        username: 'zaid_student',
      },
      chat: { id: 12345, type: 'private' },
      message: {
        message_id: messageId,
        text,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 12345, type: 'private' },
      },
      user: {
        id: 'usr-1',
        telegramId: telegramUserId,
        username: 'zaid_student',
        firstName: 'Zaid',
        isBlocked: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      services: mockServices,
      reply: vi.fn().mockImplementation((replyText: string, options?: unknown) => {
        replies.push({ text: replyText, options });
        return Promise.resolve({ message_id: 200 + replies.length });
      }),
      api: {
        deleteMessage: vi.fn().mockImplementation((_chatId: number, msgId: number) => {
          deletedMessages.push(msgId);
          return Promise.resolve(true);
        }),
        editMessageText: vi
          .fn()
          .mockImplementation((_chatId: number, _msgId: number, editContent: string) => {
            replies.push({ text: editContent });
            return Promise.resolve(true);
          }),
      },
    } as unknown as BotContext;

    return {
      ctx,
      replies,
      deletedMessages,
      savedSessions,
      startLoginFn,
      submit2FaFn,
    };
  }

  it('starts login wizard on /login and prompts for email', async () => {
    clearLoginState(Number(telegramUserId));
    const { ctx, replies } = createMockLoginContext();

    await handleLogin(ctx);

    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toContain('AUIB SIS Automated Login');
    expect(replies[0]?.text).toContain('student email');

    const state = getActiveLoginState(Number(telegramUserId));
    expect(state?.step).toBe('AWAITING_EMAIL');
  });

  it('handles multi-step flow without 2FA: email -> password -> success & deletes sensitive message', async () => {
    clearLoginState(Number(telegramUserId));

    // 1. Trigger /login
    const { ctx: loginCtx } = createMockLoginContext();
    await handleLogin(loginCtx);

    // 2. User sends email
    const {
      ctx: emailCtx,
      replies: emailReplies,
      deletedMessages: emailDeleted,
    } = createMockLoginContext('student@auib.edu.iq', 102);
    await loginConversationMiddleware(emailCtx, vi.fn());

    expect(emailDeleted).toContain(102);
    expect(emailReplies).toHaveLength(1);
    expect(emailReplies[0]?.text).toContain('Enter Your Password');

    const stateAfterEmail = getActiveLoginState(Number(telegramUserId));
    expect(stateAfterEmail?.step).toBe('AWAITING_PASSWORD');
    expect(stateAfterEmail?.email).toBe('student@auib.edu.iq');

    // 3. User sends password
    const {
      ctx: passCtx,
      replies: passReplies,
      deletedMessages: passDeleted,
      savedSessions,
      startLoginFn,
    } = createMockLoginContext('MySecretPassword123!', 103);
    await loginConversationMiddleware(passCtx, vi.fn());

    // Password message MUST be deleted immediately
    expect(passDeleted).toContain(103);
    expect(startLoginFn).toHaveBeenCalledWith('student@auib.edu.iq', 'MySecretPassword123!');

    // Session must be saved in DB with encryption key
    expect(savedSessions).toHaveLength(1);
    expect(savedSessions[0]?.userId).toBe('usr-1');
    expect(savedSessions[0]?.encryptionKey).toBe(encryptionKey);

    expect(passReplies.some((r) => r.text.includes('Login Successful!'))).toBe(true);

    // State is cleared after completion
    expect(getActiveLoginState(Number(telegramUserId))).toBeNull();
  });

  it('handles multi-step flow with 2FA requirement: email -> password -> 2FA code -> success', async () => {
    clearLoginState(Number(telegramUserId));

    // 1. /login
    const { ctx: loginCtx } = createMockLoginContext();
    await handleLogin(loginCtx);

    // 2. Email
    const { ctx: emailCtx } = createMockLoginContext('student@auib.edu.iq', 104);
    await loginConversationMiddleware(emailCtx, vi.fn());

    // 3. Password -> returns REQUIRES_2FA
    const {
      ctx: passCtx,
      replies: passReplies,
      deletedMessages: passDeleted,
      startLoginFn,
    } = createMockLoginContext('MySecretPassword123!', 105);

    startLoginFn.mockResolvedValueOnce({
      status: 'REQUIRES_2FA',
      method: 'OTP',
      message:
        '🔐 Two-Factor Authentication Required\n\nEnter 6-digit code from Microsoft Authenticator',
      challengeContext: { actionUrl: 'https://sis.auib.edu.iq/2fa' },
    });

    await loginConversationMiddleware(passCtx, vi.fn());

    expect(passDeleted).toContain(105);
    expect(passReplies.some((r) => r.text.includes('Two-Factor Authentication Required'))).toBe(
      true,
    );

    const stateAfter2FaPrompt = getActiveLoginState(Number(telegramUserId));
    expect(stateAfter2FaPrompt?.step).toBe('AWAITING_2FA');

    // 4. User sends 2FA code
    const {
      ctx: twoFaCtx,
      replies: twoFaReplies,
      deletedMessages: twoFaDeleted,
      savedSessions,
      submit2FaFn,
    } = createMockLoginContext('654321', 106);

    await loginConversationMiddleware(twoFaCtx, vi.fn());

    // 2FA message must be deleted
    expect(twoFaDeleted).toContain(106);
    expect(submit2FaFn).toHaveBeenCalledWith(
      { actionUrl: 'https://sis.auib.edu.iq/2fa' },
      '654321',
    );

    expect(savedSessions).toHaveLength(1);
    expect(twoFaReplies.some((r) => r.text.includes('Login Successful!'))).toBe(true);
    expect(getActiveLoginState(Number(telegramUserId))).toBeNull();
  });

  it('allows cancelling an active login flow via /cancel', async () => {
    clearLoginState(Number(telegramUserId));

    const { ctx: loginCtx } = createMockLoginContext();
    await handleLogin(loginCtx);
    expect(getActiveLoginState(Number(telegramUserId))).not.toBeNull();

    const { ctx: cancelCtx, replies: cancelReplies } = createMockLoginContext();
    await handleCancel(cancelCtx);

    expect(cancelReplies[0]?.text).toContain('Login cancelled');
    expect(getActiveLoginState(Number(telegramUserId))).toBeNull();
  });
});

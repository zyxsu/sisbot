import { z } from 'zod';

const booleanFromEnvironment = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }

  if (value.toLowerCase() === 'true') {
    return true;
  }

  if (value.toLowerCase() === 'false' || value === '') {
    return false;
  }

  return value;
}, z.boolean());

const integerFromEnvironment = (minimum: number) => z.coerce.number().int().min(minimum);

const optionalNonEmptyString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

export const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z
      .string()
      .min(1)
      .default('postgresql://postgres:postgres@localhost:5432/auib_monitor'),
    TELEGRAM_BOT_TOKEN: optionalNonEmptyString,
    ADMIN_TELEGRAM_CHAT_ID: optionalNonEmptyString,
    SESSION_ENCRYPTION_KEY: optionalNonEmptyString,
    POLL_INTERVAL_SECONDS: integerFromEnvironment(10).default(300),
    POLL_JITTER_SECONDS: integerFromEnvironment(0).default(15),
    MIN_REQUEST_DELAY_MS: integerFromEnvironment(0).default(1000),
    MAX_CONCURRENT_SESSIONS: integerFromEnvironment(1).default(2),
    PEOPLESOFT_BASE_URL: z.url().default('https://sis.auib.edu.iq'),
    PEOPLESOFT_LIVE_ENABLED: booleanFromEnvironment.default(false),
  })
  .superRefine((environment, context) => {
    if (environment.PEOPLESOFT_LIVE_ENABLED && environment.SESSION_ENCRYPTION_KEY === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['SESSION_ENCRYPTION_KEY'],
        message: 'SESSION_ENCRYPTION_KEY is required when PeopleSoft live mode is enabled',
      });
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(
  source: Record<string, string | undefined> = process.env,
): Environment {
  return environmentSchema.parse(source);
}

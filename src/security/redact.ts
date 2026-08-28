export const REDACTED_VALUE = '[REDACTED]' as const;

const sensitiveKeyNames = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'pstoken',
  'jsessionid',
  'icsid',
  'cfclearance',
  'userid',
  'telegramid',
  'sessionid',
]);

const sensitiveJsonStringField =
  /("(?:authorization|cookie|set-cookie|ps_token|jsessionid|icsid|cf_clearance)"\s*:\s*)"(?:\\.|[^"\\])*"/giu;
const sensitiveSingleQuotedField =
  /('(?:authorization|cookie|set-cookie|ps_token|jsessionid|icsid|cf_clearance)'\s*:\s*)'(?:\\.|[^'\\])*'/giu;
const sensitiveHeaderLine = /(^|\r?\n)(\s*(?:authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/giu;
const namedCookiePair =
  /(\b(?:ps_token|jsessionid|icsid|cf_clearance)\s*=\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;,&}\]]+)/giu;
const namedSecretField =
  /(\b(?:ps_token|jsessionid|icsid|cf_clearance)\b\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/giu;

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replaceAll('-', '').replaceAll('_', '');
}

/** Returns whether a structured-log field name contains session material. */
export function isSensitiveLogKey(key: string): boolean {
  return sensitiveKeyNames.has(normalizeKey(key));
}

/**
 * Redacts common PeopleSoft and proxy credentials from an arbitrary log string.
 *
 * This is a defense-in-depth helper for messages assembled before structured
 * logging. Callers should still avoid logging complete PeopleSoft headers.
 */
export function redactString(value: string): string {
  return value
    .replace(sensitiveJsonStringField, `$1"${REDACTED_VALUE}"`)
    .replace(sensitiveSingleQuotedField, `$1'${REDACTED_VALUE}'`)
    .replace(sensitiveHeaderLine, `$1$2${REDACTED_VALUE}`)
    .replace(namedCookiePair, `$1${REDACTED_VALUE}`)
    .replace(namedSecretField, `$1${REDACTED_VALUE}`);
}

/**
 * Produces a logging-safe copy of arrays and plain objects.
 *
 * Sensitive keys are replaced wholesale, while strings under other keys are
 * scanned for embedded header or cookie material. The input is never mutated.
 * Error instances are copied with sanitized messages/stacks. Headers, URLs,
 * Maps, Sets, and enumerable custom-object fields are also traversed so a
 * transport wrapper cannot bypass redaction merely by using a class instance.
 */
export function redactSecrets<T>(value: T): T {
  return redactValue(value, new WeakMap<object, unknown>()) as T;
}

function redactValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const previousCopy = seen.get(value);
  if (previousCopy !== undefined) {
    return previousCopy;
  }

  if (value instanceof Error) {
    const copy = new Error(redactString(value.message));
    seen.set(value, copy);
    copy.name = value.name;

    if (value.stack !== undefined) {
      copy.stack = redactString(value.stack);
    }

    if (value.cause !== undefined) {
      copy.cause = redactValue(value.cause, seen);
    }

    return copy;
  }

  if (value instanceof Headers) {
    const copy = new Headers();
    seen.set(value, copy);

    for (const [key, nestedValue] of value.entries()) {
      copy.set(key, isSensitiveLogKey(key) ? REDACTED_VALUE : redactString(nestedValue));
    }

    return copy;
  }

  if (value instanceof URL) {
    const copy = new URL(value.toString());
    seen.set(value, copy);

    if (copy.username.length > 0) {
      copy.username = REDACTED_VALUE;
    }

    if (copy.password.length > 0) {
      copy.password = REDACTED_VALUE;
    }

    for (const [key, nestedValue] of copy.searchParams.entries()) {
      if (isSensitiveLogKey(key)) {
        copy.searchParams.set(key, REDACTED_VALUE);
      } else {
        copy.searchParams.set(key, redactString(nestedValue));
      }
    }

    return copy;
  }

  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    seen.set(value, copy);

    for (const [key, nestedValue] of value.entries()) {
      copy.set(
        key,
        typeof key === 'string' && isSensitiveLogKey(key)
          ? REDACTED_VALUE
          : redactValue(nestedValue, seen),
      );
    }

    return copy;
  }

  if (value instanceof Set) {
    const copy = new Set<unknown>();
    seen.set(value, copy);

    for (const nestedValue of value.values()) {
      copy.add(redactValue(nestedValue, seen));
    }

    return copy;
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);

    for (const item of value) {
      copy.push(redactValue(item, seen));
    }

    return copy;
  }

  if (value instanceof Date) {
    return value;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);

  for (const [key, nestedValue] of Object.entries(value)) {
    copy[key] = isSensitiveLogKey(key) ? REDACTED_VALUE : redactValue(nestedValue, seen);
  }

  return copy;
}

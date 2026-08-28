import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import { redactSecrets } from '../security/redact.js';

const safeLoggerOptions: LoggerOptions = {
  level: 'info',
  hooks: {
    logMethod(arguments_, method) {
      for (const [index, argument] of arguments_.entries()) {
        arguments_[index] = redactSecrets(argument);
      }

      method.apply(this, arguments_);
    },
  },
};

/**
 * Creates a structured logger whose arguments are sanitized before Pino sees
 * them. Callers must still log selected metadata rather than complete headers.
 */
export function createLogger(destination?: DestinationStream): Logger {
  return destination === undefined ? pino(safeLoggerOptions) : pino(safeLoggerOptions, destination);
}

export const logger = createLogger();

import type { LogLevel } from "./config.js";

const LOG_LEVEL_VALUES: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export function redactText(value: string, secrets: readonly string[] = []): string {
  let redacted = value.replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]");
  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted;
}

function safeContext(
  context: Record<string, unknown> | undefined,
  secrets: readonly string[],
): string {
  if (!context) {
    return "";
  }
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(context, (_key, value: unknown) => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      if (value instanceof Error) {
        return { name: value.name, message: value.message };
      }
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }
      return value;
    });
    return ` ${redactText(json, secrets)}`;
  } catch {
    return ' {"serializationError":"context could not be serialized"}';
  }
}

export function safeErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  if (error instanceof Error) {
    return redactText(error.message, secrets);
  }
  return redactText(String(error), secrets);
}

export function createLogger(
  level: LogLevel,
  options: { secrets?: readonly string[]; write?: (line: string) => void } = {},
): Logger {
  const secrets = options.secrets ?? [];
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));

  const log = (
    eventLevel: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ): void => {
    if (LOG_LEVEL_VALUES[eventLevel] < LOG_LEVEL_VALUES[level]) {
      return;
    }
    write(
      `${new Date().toISOString()} ${eventLevel.toUpperCase()} ${redactText(message, secrets)}` +
        safeContext(context, secrets),
    );
  };

  return {
    debug: (message, context) => log("debug", message, context),
    info: (message, context) => log("info", message, context),
    warn: (message, context) => log("warn", message, context),
    error: (message, context) => log("error", message, context),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

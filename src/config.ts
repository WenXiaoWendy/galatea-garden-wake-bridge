import {
  isWakeReason,
  MAX_WAKE_MESSAGE_LENGTH,
  MAX_WAKE_REASON_LENGTH,
  type WakeReason,
} from "./protocol.js";
import { isAbsolute } from "node:path";

export interface BridgeTimeouts {
  readonly connectMs: number;
  readonly readIdleMs: number;
  readonly checkMs: number;
  readonly stableConnectionMs: number;
  readonly runtimeDeliveryMs: number;
  readonly runtimeCloseMs: number;
}

export const DEFAULT_TIMEOUTS: Readonly<BridgeTimeouts> = Object.freeze({
  connectMs: 10_000,
  readIdleMs: 75_000,
  checkMs: 10_000,
  stableConnectionMs: 10_000,
  runtimeDeliveryMs: 15 * 60_000,
  runtimeCloseMs: 10_000,
});

export type LogLevel = "debug" | "info" | "warn" | "error";
export type WakeMessageMap = Readonly<Record<WakeReason, string>>;

export interface InjectorConfig {
  readonly executable: string | undefined;
  readonly args: readonly string[];
  readonly workingDirectory: string | undefined;
}

export interface BridgeConfig {
  readonly baseUrl: URL;
  readonly machineToken: string;
  readonly wakeMessageMap: WakeMessageMap;
  readonly injector: Readonly<InjectorConfig>;
  readonly logLevel: LogLevel;
  readonly timeouts: Readonly<BridgeTimeouts>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function requireValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigError(`${name} is required`);
  }
  return value;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function validateGardenBaseUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(raw.toString());
  } catch {
    throw new ConfigError("GARDEN_BASE_URL must be a valid URL");
  }

  if (url.username || url.password) {
    throw new ConfigError("GARDEN_BASE_URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new ConfigError("GARDEN_BASE_URL must not contain a query or fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHostname(url.hostname))) {
    throw new ConfigError("GARDEN_BASE_URL must use HTTPS unless it points to localhost");
  }
  return url;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim() || "info";
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  throw new ConfigError("GARDEN_LOG_LEVEL must be debug, info, warn, or error");
}

function parseWakeMessageMap(raw: string | undefined): WakeMessageMap {
  if (!raw?.trim()) {
    return Object.freeze({});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("GARDEN_WAKE_MESSAGE_MAP must be valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError("GARDEN_WAKE_MESSAGE_MAP must be a JSON object");
  }

  const messageMap: Record<WakeReason, string> = {};
  for (const [reason, message] of Object.entries(parsed)) {
    if (!isWakeReason(reason)) {
      throw new ConfigError(
        `GARDEN_WAKE_MESSAGE_MAP reason must be a non-empty string up to ${MAX_WAKE_REASON_LENGTH} characters`,
      );
    }
    if (
      typeof message !== "string" ||
      message.trim().length === 0 ||
      message.length > MAX_WAKE_MESSAGE_LENGTH
    ) {
      throw new ConfigError(
        `GARDEN_WAKE_MESSAGE_MAP.${reason} must be a non-empty string up to ${MAX_WAKE_MESSAGE_LENGTH} characters`,
      );
    }
    messageMap[reason] = message;
  }

  return Object.freeze(messageMap);
}

function parseInjectorWorkingDirectory(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  if (!isAbsolute(value)) {
    throw new ConfigError("GARDEN_INJECTOR_WORKING_DIRECTORY must be an absolute path");
  }
  return value;
}

function parseInjectorArgs(raw: string | undefined): readonly string[] {
  if (!raw?.trim()) {
    return Object.freeze([]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("GARDEN_INJECTOR_ARGS_JSON must be valid JSON");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((value) => typeof value !== "string" || value.includes("\0"))
  ) {
    throw new ConfigError("GARDEN_INJECTOR_ARGS_JSON must be a JSON array of strings");
  }
  return Object.freeze([...parsed]);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    baseUrl: validateGardenBaseUrl(requireValue(env, "GARDEN_BASE_URL")),
    machineToken: requireValue(env, "GARDEN_MACHINE_TOKEN"),
    wakeMessageMap: parseWakeMessageMap(env.GARDEN_WAKE_MESSAGE_MAP),
    injector: Object.freeze({
      executable: env.GARDEN_INJECTOR_EXECUTABLE?.trim() || undefined,
      args: parseInjectorArgs(env.GARDEN_INJECTOR_ARGS_JSON),
      workingDirectory: parseInjectorWorkingDirectory(
        env.GARDEN_INJECTOR_WORKING_DIRECTORY,
      ),
    }),
    logLevel: parseLogLevel(env.GARDEN_LOG_LEVEL),
    timeouts: DEFAULT_TIMEOUTS,
  };
}

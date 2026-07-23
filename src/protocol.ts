import type { SseEvent } from "./sse/parser.js";

export const GARDEN_PROTOCOL = {
  version: 1,
  streamPath: "/api/machine-events/stream",
  events: {
    connected: "connected",
    wake: "wake",
  },
  reasons: {
    gameTurnRequired: "game_turn_required",
    notificationAvailable: "notification_available",
  },
} as const;

export type WakeReason = string;

export const MAX_WAKE_MESSAGE_LENGTH = 4_096;
export const MAX_WAKE_REASON_LENGTH = 128;

export type RuntimeWake = Readonly<{
  reason: WakeReason;
  message: string;
}>;

export interface ProtocolDiagnostic<
  Severity extends "debug" | "warn" | "terminal" = "debug" | "warn" | "terminal",
> {
  readonly cause: string;
  readonly severity: Severity;
}

export type GardenProtocolEvent =
  | { kind: "connected"; version: number }
  | ({ kind: "wake" } & RuntimeWake)
  | ({ kind: "ignored" } & ProtocolDiagnostic);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWakeReason(value: unknown): value is WakeReason {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_WAKE_REASON_LENGTH &&
    value.trim() === value
  );
}

function isWakeMessage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_WAKE_MESSAGE_LENGTH
  );
}

export function decodeGardenEvent(event: SseEvent): GardenProtocolEvent {
  if (
    event.event !== GARDEN_PROTOCOL.events.connected &&
    event.event !== GARDEN_PROTOCOL.events.wake
  ) {
    return {
      kind: "ignored",
      cause: `unknown event type: ${event.event}`,
      severity: "debug",
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(event.data);
  } catch {
    return {
      kind: "ignored",
      cause: `invalid JSON for ${event.event}`,
      severity: event.event === GARDEN_PROTOCOL.events.connected ? "terminal" : "warn",
    };
  }

  if (!isRecord(payload)) {
    return {
      kind: "ignored",
      cause: `invalid payload for ${event.event}`,
      severity: event.event === GARDEN_PROTOCOL.events.connected ? "terminal" : "warn",
    };
  }

  if (event.event === GARDEN_PROTOCOL.events.connected) {
    if (payload.version !== GARDEN_PROTOCOL.version) {
      return {
        kind: "ignored",
        cause: "unsupported protocol version",
        severity: "terminal",
      };
    }
    return { kind: "connected", version: GARDEN_PROTOCOL.version };
  }

  if (!isWakeReason(payload.reason)) {
    return { kind: "ignored", cause: "unknown wake reason", severity: "warn" };
  }

  if (!isWakeMessage(payload.message)) {
    return { kind: "ignored", cause: "invalid wake message", severity: "warn" };
  }

  return {
    kind: "wake",
    reason: payload.reason,
    message: payload.message,
  };
}

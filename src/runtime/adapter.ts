import type { RuntimeWake } from "../protocol.js";

export type RuntimeWakeInput = RuntimeWake & Readonly<{ signal: AbortSignal }>;

export interface RuntimeAdapter {
  wake(input: RuntimeWakeInput): Promise<void>;
  close?(): Promise<void>;
}

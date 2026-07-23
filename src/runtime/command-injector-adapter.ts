import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { Logger } from "../logging.js";
import type { RuntimeAdapter, RuntimeWakeInput } from "./adapter.js";

const MAX_STDERR_LENGTH = 8_192;

interface SpawnedInjectorProcess {
  readonly stdin: Writable;
  readonly stderr: Readable;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

interface InjectorSpawnOptions {
  readonly shell: false;
  readonly signal: AbortSignal;
  readonly stdio: ["pipe", "ignore", "pipe"];
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface InstalledInjectorConfig {
  readonly executable: string;
  readonly args: readonly string[];
  readonly workingDirectory: string | undefined;
}

export type SpawnInjector = (
  executable: string,
  args: readonly string[],
  options: InjectorSpawnOptions,
) => SpawnedInjectorProcess;

const spawnInjector: SpawnInjector = (executable, args, options) =>
  spawn(executable, [...args], options) as SpawnedInjectorProcess;

export class InjectorDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InjectorDeliveryError";
  }
}

export class CommandInjectorAdapter implements RuntimeAdapter {
  readonly #config: Readonly<InstalledInjectorConfig>;
  readonly #logger: Logger;
  readonly #spawn: SpawnInjector;

  constructor(
    config: Readonly<InstalledInjectorConfig>,
    logger: Logger,
    spawnImpl: SpawnInjector = spawnInjector,
  ) {
    this.#config = config;
    this.#logger = logger;
    this.#spawn = spawnImpl;
  }

  async wake(input: RuntimeWakeInput): Promise<void> {
    input.signal.throwIfAborted();
    this.#logger.info("starting injector delivery", { reason: input.reason });

    await new Promise<void>((resolve, reject) => {
      const childEnv = { ...process.env };
      delete childEnv.GARDEN_MACHINE_TOKEN;
      const child = this.#spawn(this.#config.executable, this.#config.args, {
        ...(this.#config.workingDirectory
          ? { cwd: this.#config.workingDirectory }
          : {}),
        env: childEnv,
        shell: false,
        signal: input.signal,
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      let settled = false;

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve();
      };

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-MAX_STDERR_LENGTH);
      });
      child.stdin.on("error", () => undefined);
      child.once("error", (error) => finish(error));
      child.once("exit", (code, signal) => {
        if (code === 0) {
          finish();
          return;
        }
        const details = stderr.trim();
        finish(
          new InjectorDeliveryError(
            `injector exited with code ${String(code)}, signal ${String(signal)}` +
              (details ? `: ${details}` : ""),
          ),
        );
      });

      const payload = {
        version: 1,
        type: "garden_wake",
        reason: input.reason,
        message: input.message,
      } as const;
      try {
        child.stdin.end(`${JSON.stringify(payload)}\n`, "utf8");
      } catch (error) {
        child.kill();
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });

    this.#logger.info("injector delivery completed", { reason: input.reason });
  }
}

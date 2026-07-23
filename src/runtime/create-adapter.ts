import { ConfigError, type BridgeConfig } from "../config.js";
import type { Logger } from "../logging.js";
import type { RuntimeAdapter } from "./adapter.js";
import { CommandInjectorAdapter } from "./command-injector-adapter.js";

export function createRuntimeAdapter(config: BridgeConfig, logger: Logger): RuntimeAdapter {
  if (!config.injector.executable) {
    throw new ConfigError("GARDEN_INJECTOR_EXECUTABLE is required for the run command");
  }
  return new CommandInjectorAdapter(
    {
      executable: config.injector.executable,
      args: config.injector.args,
      workingDirectory: config.injector.workingDirectory,
    },
    logger,
  );
}

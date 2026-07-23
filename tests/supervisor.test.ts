import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SYSTEMD_UNIT = new URL("../deploy/systemd/garden-wake.service", import.meta.url);
const POWERSHELL_WATCHDOG = new URL("../scripts/run-watchdog.ps1", import.meta.url);

test("systemd unit restarts transient failures but stops on permanent errors", async () => {
  const unit = await readFile(SYSTEMD_UNIT, "utf8");

  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^RestartPreventExitStatus=2$/m);
  assert.match(unit, /^RestartSec=5$/m);
  assert.match(unit, /^KillSignal=SIGTERM$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/galatea-garden-wake\.env$/m);
  assert.match(unit, /^User=garden-wake$/m);
  assert.doesNotMatch(unit, /GARDEN_MACHINE_TOKEN=/);
});

test("PowerShell watchdog uses bounded restart backoff and honors permanent exit", async () => {
  const script = await readFile(POWERSHELL_WATCHDOG, "utf8");

  assert.match(script, /\$exitCode -eq 0/);
  assert.match(script, /\$exitCode -eq 2/);
  assert.match(script, /\[Math\]::Min\(\$delaySeconds \* 2, \$MaxDelaySeconds\)/);
  assert.match(script, /dist\/cli\.js/);
  assert.doesNotMatch(script, /GARDEN_MACHINE_TOKEN\s*=/);
});

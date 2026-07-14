export const KNOWN_COMMANDS = new Set([
  "setup",
  "run",
  "serve",
  "pay",
  "consume",
  "vault",
  "link",
  "status",
  "doctor",
  "service",
]);

/** Long-running commands self-update on heartbeat; other known commands update before dispatch. */
export const LONG_RUNNING_COMMANDS = new Set(["run", "serve", "consume"]);

/** Pre-dispatch updates apply only to recognized short-lived commands; unknown commands stay side-effect-free. */
export function shouldPreRunUpdate(cmd: string): boolean {
  return KNOWN_COMMANDS.has(cmd) && !LONG_RUNNING_COMMANDS.has(cmd);
}

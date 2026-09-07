export const KNOWN_COMMANDS = new Set([
  "setup",
  "login",
  "logout",
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

export const READ_ONLY_DIAGNOSTIC_COMMANDS = new Set(["status", "doctor"]);

/** Pre-dispatch updates apply only to recognized short-lived commands; unknown commands stay side-effect-free. */
export function shouldPreRunUpdate(cmd: string): boolean {
  return (
    KNOWN_COMMANDS.has(cmd) &&
    !LONG_RUNNING_COMMANDS.has(cmd) &&
    !READ_ONLY_DIAGNOSTIC_COMMANDS.has(cmd)
  );
}

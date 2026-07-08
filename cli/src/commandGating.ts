/**
 * Every command the CLI dispatch switch (index.ts) handles. Must be kept in sync
 * with that switch: a command missing from here still dispatches, but skips the
 * pre-run update check. The set exists so an UNRECOGNIZED command does not
 * trigger that check — otherwise a typo on a managed install that's due for an
 * update silently builds/promotes/relaunches (~/.halo/src mutation + process
 * restart) before "unknown command" is printed.
 */
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

/**
 * Long-running commands (run/serve/consume) start an auto-update monitor and
 * restart on their own heartbeat via a graceful drain. Every OTHER known command
 * is short-lived and updates before doing work.
 */
export const LONG_RUNNING_COMMANDS = new Set(["run", "serve", "consume"]);

/**
 * Whether to run the pre-dispatch update check for `cmd`: true only for a
 * recognized, short-lived command. Long-running commands (they update on their
 * heartbeat) and unrecognized commands (a typo must fall straight through to the
 * "unknown command" error, side-effect-free) both return false. Among KNOWN
 * commands, short-lived is expressed as the inverse of the small long-running
 * set, so adding a long-running command is a one-line edit here.
 */
export function shouldPreRunUpdate(cmd: string): boolean {
  return KNOWN_COMMANDS.has(cmd) && !LONG_RUNNING_COMMANDS.has(cmd);
}

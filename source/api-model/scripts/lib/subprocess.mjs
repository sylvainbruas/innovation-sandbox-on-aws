// Small helpers for interpreting spawnSync results, shared by the verification
// commands.

/** Coerces a spawn result stream (Buffer/undefined/string) to a string. */
export function text(value) {
  if (value === undefined || value === null) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

/** Runs a command, throwing if it could not be spawned at all. */
export function run(runner, command, args, options = {}) {
  const result = runner(command, args, options);
  if (result.error) {
    throw new Error(`could not run ${command}: ${result.error.message}`);
  }
  return result;
}

/** Throws a descriptive error unless the spawn result exited zero. */
export function requireSuccess(result, description) {
  if (result.status !== 0) {
    const detail = text(result.stderr).trim() || text(result.stdout).trim();
    throw new Error(
      `${description} failed with exit ${result.status ?? "unknown"}` +
        (detail ? `: ${detail}` : ""),
    );
  }
}

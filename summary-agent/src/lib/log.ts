// Tiny timestamped logger. Silent under vitest so test output stays readable.
const QUIET = Boolean(process.env.VITEST);

export function log(...args: unknown[]): void {
  if (QUIET) return;
  console.log(new Date().toISOString(), ...args);
}

export function logError(...args: unknown[]): void {
  if (QUIET) return;
  console.error(new Date().toISOString(), ...args);
}

/** Empty-poll lines are chatty; suppress them with QUIET_POLLS=true. */
export const QUIET_POLLS = /^(1|true|yes)$/i.test(process.env.QUIET_POLLS || "");

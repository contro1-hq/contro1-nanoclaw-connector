/**
 * TEST STUB - NOT INSTALLED INTO NANOCLAW. Mirrors `readEnvFile` from NanoClaw
 * v2.3.0 `src/env.ts`: returns requested keys, never touches process.env.
 */
export const stubEnv: Record<string, string> = {};

export function readEnvFile(keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) if (stubEnv[key]) out[key] = stubEnv[key];
  return out;
}

/** TEST STUB - NOT INSTALLED INTO NANOCLAW. Mirrors the `log` export of NanoClaw v2.3.0 `src/log.ts`. */
const noop = (_msg: string, _data?: Record<string, unknown>): void => {};

export const log = { debug: noop, info: noop, warn: noop, error: noop };

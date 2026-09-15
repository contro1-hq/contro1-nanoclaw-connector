/**
 * TEST STUB - NOT INSTALLED INTO NANOCLAW. Mirrors the registration entry point
 * of NanoClaw v2.3.0 `src/channels/channel-registry.ts`.
 */
import type { ChannelRegistration } from './adapter.js';

export const registered = new Map<string, ChannelRegistration>();

export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registered.set(name, registration);
}

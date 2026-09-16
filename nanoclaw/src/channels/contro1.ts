/**
 * Contro1 channel for NanoClaw: routes admin approvals to Contro1 for a human
 * decision, role routing and audit evidence.
 *
 * Installed by the add-contro1 skill (copied into src/channels/ and imported
 * from the channel barrel). All logic lives in ./contro1-governance.ts; this
 * file only reads the host `.env` and registers the adapter.
 *
 * Settings come from `.env` through NanoClaw's own reader, which never loads
 * them into process.env, so the Agent Credential cannot leak to child
 * processes or containers. It is handed only to the `contro1` CLI child.
 */
import { registerChannelAdapter } from './channel-registry.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import {
  CHANNEL_TYPE,
  CONTRO1_DEFAULTS,
  ENV_KEYS,
  contro1BrokerPort,
  createContro1Adapter,
  nclPort,
  settingsFromEnv,
} from './contro1-governance.js';

registerChannelAdapter(CHANNEL_TYPE, {
  defaults: CONTRO1_DEFAULTS,
  factory: () => {
    const settings = settingsFromEnv(readEnvFile([...ENV_KEYS]), { cwd: process.cwd(), env: process.env });
    if (!settings) return null;
    return createContro1Adapter({
      settings,
      contro1: contro1BrokerPort(settings),
      nanoclaw: nclPort(settings, process.env),
      log,
    });
  },
});

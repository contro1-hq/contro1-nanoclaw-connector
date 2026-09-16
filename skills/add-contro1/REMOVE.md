# Remove Contro1 approvals

1. Hand approvals back to a person before removing the channel, or open approvals
   routed to Contro1 will have nobody to decide them:

   ```bash
   ncl roles list
   ncl roles revoke --user contro1:approvals --role admin --group <agent-group-id>
   ```

2. Remove the import line `import './contro1.js';` from `src/channels/index.ts`.
3. Delete `src/channels/contro1.ts` and `src/channels/contro1-governance.ts`.
4. Remove the `CONTRO1_*` and `NANOCLAW_NCL` keys from `.env`, including the
   mapping file path.
5. `pnpm run build` and restart the service.
6. Run `contro1 disconnect nanoclaw` to revoke the runtime connections.

Open Contro1 requests for this host can be cancelled from the Contro1 queue.
Past decisions and audit records stay in Contro1.

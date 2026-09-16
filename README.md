# Contro1 NanoClaw Connector

**NanoClaw already stops before an agent uses a credential or changes itself. Contro1 decides who approves it, routes it to the right reviewer, and keeps the evidence.** This connector is a NanoClaw channel that makes Contro1 the approver for NanoClaw's admin approvals.

Repository description:

> NanoClaw channel that routes admin approvals (OneCLI credential use, package installs, MCP server changes, new agents) to Contro1 for human decisions, role routing and signed audit evidence, resolving them through NanoClaw's own approval handler.

## Links

- Website: https://contro1.com
- Documentation: https://contro1.com/docs/nanoclaw-human-approval
- Contro1 CLI: https://contro1.com/docs/cli

## How it works

NanoClaw runs each agent in its own container and gates sensitive operations
behind an admin approval: when an agent asks to use a credential through the
OneCLI gateway, install packages, add an MCP server or create another agent,
NanoClaw sends an approval card to one approver's DM and applies the change only
when that approver clicks Approve.

This connector adds a `contro1` channel and makes it that approver.

```text
agent container ── asks for install_packages ──> NanoClaw host
NanoClaw host ── approval card (ask_question) ──> contro1 channel
contro1 channel ── contro1 requests create --runtime ──> Contro1 queue ──> human reviewer
contro1 channel <── decision (polled) ──────────── Contro1
contro1 channel ── onAction(approve | reject) ──> NanoClaw approval handler ──> applies or declines
```

- **No core patch.** It is a channel adapter, installed the way NanoClaw installs
  Slack or Telegram: two files and one import line.
- **NanoClaw still enforces.** Only the routed approver may resolve a card, each
  card resolves once, and an approved self-modification is re-validated against
  current state by NanoClaw itself.
- **Bound to the exact action.** The request carries a sha256 over the facts
  NanoClaw recorded for the approval (action, payload, agent group, session). The
  row is re-read and re-hashed before the approve click; any change rejects it.
- **Fail closed.** Contro1 denied, timed out or unreachable means no approve
  click. NanoClaw's own expiry stays the final word, and a card NanoClaw closes
  cancels the Contro1 request.
- **No state to lose.** NanoClaw's `pending_approvals` table is the record of
  what is open and the Contro1 request id is deterministic
  (`nanoclaw:<action>:<approval_id>`), so a host restart resumes without
  duplicate requests.
- **No credential in NanoClaw.** The Contro1 broker owns the non-exportable
  identity; NanoClaw receives only a per-group local endpoint mapping.

## Install

Follow [skills/add-contro1/SKILL.md](skills/add-contro1/SKILL.md). In short:

1. Run `contro1 connect nanoclaw`. It discovers groups, obtains owner approval,
   installs the broker, and writes the host-only mapping file.
2. Copy `nanoclaw/src/channels/contro1.ts` and `contro1-governance.ts` into
   `src/channels/`, add `import './contro1.js';` to `src/channels/index.ts`.
3. Set `CONTRO1_PLATFORM_MAPPING_FILE` in `.env` to the mapping file `contro1 connect`
   created (Linux: `/etc/contro1/platforms/nanoclaw.json`), build, restart.
4. `ncl users create --id contro1:approvals --kind contro1` and
   `ncl roles grant --user contro1:approvals --role admin --group <agent-group-id>`.

## Coverage

NanoClaw chooses the approver for every card. Credential approvals go to the
group's admin first, so they reach Contro1. Self-modification approvals first
prefer an admin or owner on the platform the request came from; keep human
approver identities off your agents' platforms for full coverage. The channel
logs every other approver at startup. See the skill for details.

## Audit events

`nanoclaw.approval.requested`, `approved`, `denied`, `timed_out`, `cancelled`,
`expired`, `binding_mismatch`, `not_governed`.

## Development

```bash
npm install
npm test                                   # unit and adapter tests
CONTRO1_CLI_BIN=/path/to/contro1 npm test  # adds end-to-end tests through the real CLI
```

`nanoclaw/src/channels/adapter.ts`, `channel-registry.ts`, `src/env.ts` and
`src/log.ts` are test stubs of NanoClaw's contract (v2.3.0) and are not
installed. The adapter tests model NanoClaw's approval handler rules: only the
routed approver may resolve, and a row resolves once.

Compatibility: NanoClaw **v2.3.0** and the `contro1` CLI **0.2.0** or later.

## License

MIT

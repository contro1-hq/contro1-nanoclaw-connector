---
name: add-contro1
description: Route NanoClaw admin approvals (credential use, package installs, MCP server changes, new agents) to Contro1 for a human decision, role routing and audit evidence.
---

# Add Contro1 approvals

Adds a `contro1` channel. NanoClaw already sends every admin approval as a card
to one approver's DM and applies it when that approver clicks a button. This
channel makes Contro1 that approver: the card becomes a Contro1 approval
request, and the decision a human makes in Contro1 is clicked back into
NanoClaw. NanoClaw's own checks still run on every click (only the routed
approver may resolve, a row resolves once, an approved action is re-validated
against current state).

Nothing in NanoClaw core is changed. The skill copies two files and appends one
import line, like any channel skill. The steps are idempotent.

## Prerequisites

1. **Owner-approved connection:** run `contro1 connect nanoclaw`. It discovers
   groups, gets owner approval, installs the broker and writes the mapping file.
2. **The `contro1` CLI** on the host, version 0.2.0 or later (it must have
   `requests ... --runtime` and `activity report`):
   `contro1 --version`.

## Apply

### 1. Connect and check before wiring anything

```bash
contro1 connect nanoclaw
contro1 doctor nanoclaw --format json
```

Every check must be `ok`. The mapping is per group; an unmapped group fails
closed and never falls back to a host identity.

### 2. Copy the channel into NanoClaw

Pin the connector to a release tag. Use v0.2.0 or later: earlier releases read a
static credential and do not understand the mapping file.

```bash
REF=v0.2.0
BASE=https://raw.githubusercontent.com/contro1-hq/contro1-nanoclaw-connector/$REF/nanoclaw/src/channels
curl -fsSL "$BASE/contro1.ts" -o src/channels/contro1.ts
curl -fsSL "$BASE/contro1-governance.ts" -o src/channels/contro1-governance.ts
```

### 3. Register the channel

Append the self-registration import to the channel barrel (skip if present):

```nc:append to:src/channels/index.ts
import './contro1.js';
```

### 4. Configure

Set the mapping file that `contro1 connect nanoclaw` created:
`/etc/contro1/platforms/nanoclaw.json` on Linux (shown),
`/Library/Application Support/Contro1/platforms/nanoclaw.json` on macOS. Add nothing else from Contro1 to `.env`: the channel refuses to start if a
static Contro1 credential is present.

```nc:env-set
CONTRO1_PLATFORM_MAPPING_FILE=/etc/contro1/platforms/nanoclaw.json
CONTRO1_NANOCLAW_HANDLE=approvals
```

Optional keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `CONTRO1_REQUIRED_ROLE` | none | Contro1 reviewer role every NanoClaw approval routes to, e.g. `security` |
| `CONTRO1_API_URL` | CLI profile | Contro1 API origin, for a staging or self-hosted stack |
| `CONTRO1_CLI` | `contro1` | Path to the CLI binary |
| `NANOCLAW_NCL` | `<checkout>/bin/ncl` | Path to NanoClaw's admin CLI |
| `CONTRO1_POLL_INTERVAL_MS` | `5000` | How often decisions are read back |
| `CONTRO1_EXPIRY_MINUTES` | `1440` | Contro1 expiry for approvals NanoClaw does not time out itself |

### 5. Build

```nc:run effect:build
pnpm run build
```

### 6. Make Contro1 an approver

Create the Contro1 identity and make it the admin of each agent group it should
govern (`ncl groups list` shows the ids):

```bash
ncl users create --id contro1:approvals --kind contro1 --display-name "Contro1 approvals"
ncl roles grant --user contro1:approvals --role admin --group <agent-group-id>
```

Restart the service. The startup log shows `Channel adapter started` for
`contro1`, and warns if another person can still receive approvals.

## Which approvals reach Contro1

NanoClaw, not this channel, picks the approver for each card:

- **Credential use (OneCLI):** the first reachable of the group's admins, then
  global admins, then owners. With `contro1:approvals` as the group's admin,
  these always reach Contro1.
- **Self-modification (`install_packages`, `add_mcp_server`, `create_agent`):**
  NanoClaw first prefers an admin or owner on the *same platform* the request
  came from. If your owner account is on Telegram and the agent was asked on
  Telegram, that card goes to the owner, not to Contro1.

For full coverage, keep human owner and admin identities off the platforms your
agents are used on, or remove their roles once Contro1 is in place
(`ncl roles list` shows who holds one). The channel logs a warning at startup
naming every other approver.

Channel registration and unknown-sender cards are not approval rows; if one
reaches Contro1 it is reported as `nanoclaw.approval.not_governed` and left for
NanoClaw to expire.

## Verify

Ask an agent to install a package (for example "install the npm package
left-pad"). A request titled `NanoClaw: Install packages` appears in the
Contro1 queue. Approve it: within a few seconds NanoClaw applies the install and
the agent is notified. Reject a second one: the agent is told it was declined.

## Troubleshooting

**No request appears.** Check the startup log. `Contro1 is not an approver`
means step 6 was skipped. `Other NanoClaw approvers can still receive approvals`
means the card went to a person (see the routing rules above).
`Channel credentials missing, skipping` for `contro1` means
`CONTRO1_PLATFORM_MAPPING_FILE` is not set in `.env`.

**`contro1 requests create failed`.** Run `contro1 doctor nanoclaw`; the group
must have a current mapping and reachable broker endpoint.

**`Static Contro1 credentials are unsupported`.** Remove `CONTRO1_AGENT_TOKEN_FILE`,
`CONTRO1_AGENT_TOKEN` or `CONTRO1_TOKEN` from `.env`; the connection comes only
from the mapping file.

**A group is refused as not connected.** It was added after `contro1 connect
nanoclaw` ran. Run `contro1 connect nanoclaw` again; it adds new groups without
duplicating existing ones.

**Approved in Contro1 but nothing happened.** The approval had already expired or
been resolved in NanoClaw (`nanoclaw.approval.expired`), or it changed after the
reviewer saw it and was rejected (`nanoclaw.approval.binding_mismatch`). Both
are recorded in Contro1.

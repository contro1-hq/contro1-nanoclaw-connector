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

1. **A Contro1 Agent Credential** for this NanoClaw host: in Contro1, register an
   agent (for example `NanoClaw - home server`) and create an Agent Credential
   for it under **Settings > Agent credentials** with the scopes
   `requests:create`, `requests:read`, `requests:cancel_own` and `audit:write`.
   The secret is shown once.
2. **The `contro1` CLI** on the host, version 0.2.0 or later (it must have
   `requests ... --runtime` and `activity report`):
   `contro1 --version`.

## Apply

### 1. Store the credential on the host

Write the secret to a file only the NanoClaw service user can read. It is never
mounted into agent containers.

```bash
sudo install -d -m 700 /etc/contro1
sudo sh -c 'umask 077; cat > /etc/contro1/nanoclaw-agent.token'   # paste, then Ctrl-D
sudo chown "$(id -un)" /etc/contro1/nanoclaw-agent.token
```

### 2. Check the credential before wiring anything

```bash
CONTRO1_AGENT_TOKEN_FILE=/etc/contro1/nanoclaw-agent.token \
  contro1 bridge doctor --target nanoclaw --ncl ./bin/ncl --format json
```

Every check must be `ok`. A `cco_cli_` token (from `contro1 auth login`) is
refused on purpose: approvals are decided as the agent credential, never as
whoever is logged in on the host.

### 3. Copy the channel into NanoClaw

Pin the connector to a release tag.

```bash
REF=v0.1.0
BASE=https://raw.githubusercontent.com/contro1-hq/contro1-nanoclaw-connector/$REF/nanoclaw/src/channels
curl -fsSL "$BASE/contro1.ts" -o src/channels/contro1.ts
curl -fsSL "$BASE/contro1-governance.ts" -o src/channels/contro1-governance.ts
```

### 4. Register the channel

Append the self-registration import to the channel barrel (skip if present):

```nc:append to:src/channels/index.ts
import './contro1.js';
```

### 5. Configure

```nc:env-set
CONTRO1_AGENT_TOKEN_FILE=/etc/contro1/nanoclaw-agent.token
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

### 6. Build

```nc:run effect:build
pnpm run build
```

### 7. Make Contro1 an approver

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
means step 7 was skipped. `Other NanoClaw approvers can still receive approvals`
means the card went to a person (see the routing rules above).
`Channel credentials missing, skipping` for `contro1` means neither
`CONTRO1_AGENT_TOKEN_FILE` nor `CONTRO1_AGENT_TOKEN` is set in `.env`.

**`contro1 requests create failed (exit 10)`.** The token is not an agent-bound
runtime credential. Create an Agent Credential; do not use a CLI login token or
an organization-wide key.

**`exit 4`.** The credential is missing a scope; `contro1 bridge doctor` names it.

**Approved in Contro1 but nothing happened.** The approval had already expired or
been resolved in NanoClaw (`nanoclaw.approval.expired`), or it changed after the
reviewer saw it and was rejected (`nanoclaw.approval.binding_mismatch`). Both
are recorded in Contro1.

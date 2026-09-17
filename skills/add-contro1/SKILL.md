---
name: add-contro1
description: Route NanoClaw admin approvals (credential use, package installs, MCP server changes, new agents) to Contro1 for a human decision, role routing and audit evidence.
---

# Add Contro1 approvals

Contro1 wraps your NanoClaw agents. Every action NanoClaw holds for an admin
(credential use through OneCLI, package installs, new MCP servers, new agents)
comes to Contro1 as an approval request, in order: Contro1 decides who in your
organization reviews it, keeps the decision bound to the exact action, and adds
it to the audit trail. Optionally, the Contro1 MCP server becomes the way your
agents reach company applications, so application access is decided in Contro1
too.

Under the hood this adds a `contro1` channel and makes it the approver NanoClaw
delivers cards to. The decision a person makes in Contro1 is clicked back into
NanoClaw, and NanoClaw's own checks still run on every click (only the routed
approver may resolve, a row resolves once, an approved action is re-validated
against current state). The steps are idempotent.

## Prerequisites

1. **The `contro1` CLI** on the host, version 0.2.0 or later: `contro1 --version`.
2. **An owner-approved connection:** step 1 runs `contro1 connect nanoclaw`, which
   gives each agent group its own connection and writes the mapping file.

## Apply

### 1. Connect and check before wiring anything

```bash
contro1 auth login
contro1 connect nanoclaw
contro1 doctor nanoclaw --format json
```

Run `contro1 connect` as yourself, not with `sudo`: it asks for administrator
approval itself for the one step that installs the Contro1 service. Role changes
in NanoClaw need a person at a terminal (`--confirm-roles`); `--yes` never covers
them. Every doctor check should be `ok`. The mapping is per group; an unmapped
group fails closed and never falls back to a host identity.

### 2. Copy the channel into NanoClaw

Pin the connector to a release tag. Use v0.2.2 or later: earlier releases read a
static credential and do not understand the mapping file.

```bash
REF=v0.2.2
BASE=https://raw.githubusercontent.com/contro1-hq/contro1-nanoclaw-connector/$REF/nanoclaw/src/channels
curl -fsSL "$BASE/contro1.ts" -o src/channels/contro1.ts
curl -fsSL "$BASE/contro1-governance.ts" -o src/channels/contro1-governance.ts
```

### 3. Register the channel

Append the self-registration import to the channel barrel (skip if present):

```nc:append to:src/channels/index.ts
import './contro1.js';
```

### 4. Deliver approval cards to Contro1 first

NanoClaw normally delivers a card to an approver on the same chat platform the
request came from, so a request made in WhatsApp goes to the owner's WhatsApp
even when Contro1 is an approver. Make approval cards prefer a reachable
`contro1:` approver. This touches the two approval flows only; unknown-sender and
channel-registration cards keep going to the origin platform.

In `src/modules/approvals/primitive.ts`, give `pickApprovalDelivery` a
preference that is tried before the origin platform:

```ts
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
  options: { preferChannelTypes?: string[] } = {},
): Promise<{ userId: string; messagingGroup: MessagingGroup } | null> {
  for (const preferred of options.preferChannelTypes ?? []) {
    for (const userId of approvers) {
      if (channelTypeOf(userId) !== preferred) continue;
      const mg = await ensureUserDm(userId);
      if (mg) return { userId, messagingGroup: mg };
    }
  }
  // ...the existing origin-platform and first-reachable loops stay as they are
```

Then pass the preference from the two approval flows:

```ts
// src/modules/approvals/primitive.ts, in requestApproval()
const target = await pickApprovalDelivery(approvers, originChannelType, { preferChannelTypes: ['contro1'] });

// src/modules/approvals/onecli-approvals.ts
const target = await pickApprovalDelivery(approvers, '', { preferChannelTypes: ['contro1'] });
```

With no `contro1:` approver the preference finds nobody and delivery behaves
exactly as before, so this is safe to keep if the channel is removed.

### 5. Configure

The channel finds the mapping file `contro1 connect nanoclaw` created in its
default place (`/etc/contro1/platforms/nanoclaw.json` on Linux,
`/Library/Application Support/Contro1/platforms/nanoclaw.json` on macOS). Set it
explicitly only if it lives elsewhere. Add nothing else from Contro1 to `.env`:
the channel refuses to start if a static Contro1 credential is present.

```nc:env-set
CONTRO1_NANOCLAW_HANDLE=approvals
```

Optional keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `CONTRO1_PLATFORM_MAPPING_FILE` | default path above | Where `contro1 connect nanoclaw` wrote the mapping |
| `CONTRO1_REQUIRED_ROLE` | none | Narrow review to one Contro1 role, e.g. `security`. Without it, requests go to the reviewer chosen for each agent in Contro1: its accountable owner, or whoever the owner routed approvals to |
| `CONTRO1_API_URL` | CLI profile | Contro1 API origin, for a staging or self-hosted stack |
| `CONTRO1_CLI` | `contro1` | Path to the CLI binary |
| `NANOCLAW_NCL` | `<checkout>/bin/ncl` | Path to NanoClaw's admin CLI |
| `CONTRO1_POLL_INTERVAL_MS` | `5000` | How often decisions are read back |
| `CONTRO1_EXPIRY_MINUTES` | `1440` | Contro1 expiry for approvals NanoClaw does not time out itself |

### 6. Build

```nc:run effect:build
pnpm run build
```

If your NanoClaw checks an upgrade stamp after a build, stamp it as your install
normally does before restarting, or the host stops at its own tripwire.

### 7. Make Contro1 an approver

`contro1 connect nanoclaw --confirm-roles` does this for you at a terminal. By
hand, create the Contro1 identity and make it the admin of each agent group it
should govern (`ncl groups list` shows the ids). Run `ncl` as the user NanoClaw
runs as, so it has that user's PATH:

```bash
ncl users create --id contro1:approvals --kind contro1 --display-name "Contro1 approvals"
ncl roles grant --user contro1:approvals --role admin --group <agent-group-id>
```

Restart the service. The startup log shows `Channel adapter started` for
`contro1`, and warns if another person can still receive approvals.

### 8. Optional: reach company applications through Contro1 (MCP)

Approvals cover what NanoClaw itself holds. To let a group's agents use company
applications (mail, calendar, tickets) with Contro1 deciding what they may do,
give the group the Contro1 MCP server:

1. In Contro1, open the agent and allow applications for its connection, then
   choose the application actions it may use (an administrator grants; anyone
   else sends a request that grants nothing until approved).
2. Add the server to that group. It runs `contro1 mcp serve` against the group's
   own endpoint from the mapping file, so the group can only ever act as itself:

```bash
ENDPOINT=$(jq -r '.entries[] | select(.platform_subject=="<agent-group-id>") | .endpoint' /etc/contro1/platforms/nanoclaw.json)
ncl config add-mcp-server --id <agent-group-id> --name contro1 \
  --command contro1 --args "[\"mcp\",\"serve\",\"--broker-endpoint\",\"$ENDPOINT\"]"
ncl groups restart --id <agent-group-id>
```

The server runs inside the group's container, so the container needs the
`contro1` binary and that one group's endpoint socket mounted, and nothing else
from Contro1. Adding an MCP server is itself an approval in NanoClaw, so this
request arrives in Contro1 like any other.

## Which approvals reach Contro1

With step 4 applied and `contro1:approvals` an admin of a group, every approval
card for that group reaches Contro1: credential use (OneCLI), `install_packages`,
`add_mcp_server` and `create_agent`. Inside Contro1 the request goes to the
agent's reviewer (its accountable owner by default, or the person the owner
routed approvals to), or to `CONTRO1_REQUIRED_ROLE` when set.

Channel registration and unknown-sender cards are not approval rows; if one
reaches Contro1 it is reported as `nanoclaw.approval.not_governed` and left for
NanoClaw to expire.

## Verify

Check that NanoClaw actually created an approval, not just that an agent said it
did: ask an agent to install a package (for example "install the npm package
left-pad"), then run `ncl approvals list`. A row there means a real card. A
request titled `NanoClaw: Install packages` then appears in the Contro1 queue.
Approve it: within a few seconds NanoClaw applies the install and the agent is
notified. Reject a second one: the agent is told it was declined.

## Troubleshooting

**No request appears.** First run `ncl approvals list`: no row means NanoClaw never
created an approval, whatever the agent said. With a row, check the startup log. `Contro1 is not an approver`
means step 7 was skipped. `Other NanoClaw approvers can still receive approvals`
means the card went to a person: step 4 is missing or was undone by an update.
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

**`ENOENT ... ncl.sock` at startup.** NanoClaw starts channels before its admin
socket is listening. The channel waits for it; a single warning at boot is start-up
order, not a broken connection.

**`contro1 connect` left files owned by root.** It was run with `sudo`. Run it as
yourself; current versions refuse `sudo` and ask for administrator approval only
for the service install.

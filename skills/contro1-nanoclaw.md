---
name: contro1-nanoclaw
description: Connect a NanoClaw install to Contro1 so NanoClaw admin approvals (credential use, package installs, MCP server changes, new agents) are decided by a human in Contro1, bound to the exact action and audited.
---

# Contro1 for NanoClaw

Use this skill when a user wants NanoClaw's admin approvals to go through Contro1.

## What you are building

A NanoClaw channel named `contro1` that NanoClaw routes approval cards to. The
channel opens a Contro1 approval request for each card and clicks the reviewer's
decision back into NanoClaw through the normal channel interface. Do not patch
NanoClaw core, do not write to its database, and do not give any agent
container the Contro1 credential.

## Inspect first

- The NanoClaw version (`package.json`): the connector targets v2.3.0.
- `src/channels/index.ts` exists and channels are registered by import.
- `ncl roles list`: who can approve today, and on which platforms.
- `ncl groups list`: the agent groups to govern.
- `contro1 --version` on the host: 0.2.0 or later.

## Build

Follow `skills/add-contro1/SKILL.md` from
https://github.com/contro1-hq/contro1-nanoclaw-connector exactly:

1. Ask the user to create a Contro1 Agent Credential (scopes `requests:create`,
   `requests:read`, `requests:cancel_own`, `audit:write`) and store it in a
   host-only file. Never paste it into chat, code or a container config.
2. Run `contro1 bridge doctor --target nanoclaw --ncl ./bin/ncl` with
   `CONTRO1_AGENT_TOKEN_FILE` set. Stop if any check fails.
3. Copy `nanoclaw/src/channels/contro1.ts` and `contro1-governance.ts` into
   `src/channels/`, append `import './contro1.js';` to `src/channels/index.ts`.
4. Set `CONTRO1_AGENT_TOKEN_FILE` (and optionally `CONTRO1_REQUIRED_ROLE`) in
   `.env`. Build with `pnpm run build`.
5. `ncl users create --id contro1:approvals --kind contro1` and
   `ncl roles grant --user contro1:approvals --role admin --group <id>` for each
   governed group. Restart the service.

## Rules

- Only `CONTRO1_AGENT_TOKEN_FILE` or `CONTRO1_AGENT_TOKEN` configure the channel.
  Never use a `cco_cli_` login token or an organization-wide API key.
- Explain routing to the user: credential approvals go to the group admin
  first; self-modification approvals first prefer an admin or owner on the
  platform the request came from. Show them `ncl roles list` and name every
  other approver who could still receive cards.
- Do not remove a human's role without the user's explicit instruction.

## Verify and report

Ask an agent to install a harmless npm package, confirm the request appears in
Contro1, approve it, and confirm NanoClaw applied it. Reject a second one and
confirm the agent was told. Report: governed groups, other approvers still
reachable, the reviewer role used, and the startup log lines for `contro1`.

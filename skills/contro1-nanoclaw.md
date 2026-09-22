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
container a Contro1 credential.

## Inspect first

- The NanoClaw version (`package.json`): the connector targets v2.3.0.
- `src/channels/index.ts` exists and channels are registered by import.
- `ncl roles list`: who can approve today, and on which platforms.
- `ncl groups list`: the agent groups to govern.
- `contro1 --version` on the host: 0.2.0 or later.

## Build

Follow `skills/add-contro1/SKILL.md` from
https://github.com/contro1-hq/contro1-nanoclaw-connector exactly:

1. Run `contro1 connect nanoclaw`; it discovers groups, gets owner approval,
   installs the local broker and writes a host-only mapping file.
2. Run `contro1 doctor nanoclaw --format json`. Stop if any check fails.
3. Copy `nanoclaw/src/channels/contro1.ts` and `contro1-governance.ts` into
   `src/channels/`, append `import './contro1.js';` to `src/channels/index.ts`.
4. Apply step 4 of the skill: `pickApprovalDelivery` prefers `contro1` for
   `requestApproval()` and OneCLI cards only. Without it, a request made on the
   owner's chat platform goes to the owner there instead of Contro1.
5. Pin the channel files to a connector release with the NanoClaw MCP host-claim
   flow. The mapping file is found
   in its default place; set `CONTRO1_PLATFORM_MAPPING_FILE` only if it moved.
   Build with `pnpm run build`, and stamp NanoClaw's upgrade state if it has one.
6. `ncl users create --id contro1:approvals --kind contro1` and
   `ncl roles grant --user contro1:approvals --role admin --group <id>` for each
   governed group, run as the NanoClaw user. Restart the service.
7. If the user wants agents to use company applications, follow step 8 of the
   skill: the agent requests the remote MCP URL from chat and the accountable
   owner approves the host-only OneCLI grant in Contro1. Do not install a
   stdio MCP server or mount the host broker socket into the container.

## Rules

- Only `CONTRO1_PLATFORM_MAPPING_FILE` configures the channel. Never add a
  Contro1 credential to NanoClaw, a container or `.env`.
- Never run `contro1 connect` with sudo, and never answer the NanoClaw role
  confirmation for the user: it needs them at a terminal.
- Show the user `ncl roles list` and name every other approver who could still
  receive cards.
- Do not remove a human's role without the user's explicit instruction.

## Verify and report

Ask an agent to install a harmless npm package, confirm `ncl approvals list`
shows a row (an agent saying it sent a card is not a card), confirm the request
appears in Contro1, approve it, and confirm NanoClaw applied it. Reject a second one and
confirm the agent was told. Report: governed groups, other approvers still
reachable, the reviewer role used, and the startup log lines for `contro1`.

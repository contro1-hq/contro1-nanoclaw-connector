# Contro1 NanoClaw Connector

**Contro1 wraps your NanoClaw agents.** Every action NanoClaw holds for an admin (credential use, package installs, new MCP servers, new agents) comes to Contro1 as an approval request: Contro1 routes it to the right person in your organization, binds the decision to the exact action, and keeps the audit trail. Add the Contro1 MCP server and your agents reach company applications through Contro1 too, with Contro1 deciding what each one may use.

Repository description:

> NanoClaw channel that routes admin approvals (OneCLI credential use, package installs, MCP server changes, new agents) to Contro1 for human decisions, role routing and signed audit evidence, resolving them through NanoClaw's own approval handler.

## Links

- Website: https://contro1.com
- Documentation: https://contro1.com/docs/nanoclaw-human-approval
- Contro1 CLI: https://contro1.com/docs/cli

## The problem this solves

You run an assistant in NanoClaw. You give it access to your mailbox, because you
talk to it in a private chat about work and you want it to read threads for you.
That works, and it is the reason you connected it.

A week later you add the same assistant to a group chat: a project with a
client, a trip with friends, a channel with contractors. Somebody in that group
types a message to it.

**The assistant answers. It has no way to know that the person asking is not
you.** It runs the action with its own authority, so from where it stands the
request from the group chat and the request from your private chat look
identical. Anyone in that group can now ask it what is in your mailbox. No
permission was changed. Nothing was inherited. The agent simply answered the
room it was put in.

This is the confused deputy problem, and it applies to any agent that more than
one person can instruct while it holds standing access to one person's data. A
chat group is the common case, a shared gateway is another. It is not specific
to NanoClaw, and it is not a misconfiguration: it is what happens when the unit
of authorization is the agent but the unit of exposure is the conversation.

### How Contro1 solves it

**1. Contro1 asks which places the agent answers in, before anything is
granted.** The connector reads NanoClaw's own wiring table, so the approval
screen names every conversation the agent is reachable from and says which of
them are group chats:

```text
This agent answers in 3 conversations:
  Sales             direct message
  Berlin trip       group chat: anyone in it can instruct this agent
  Contractors       group chat: anyone in it can instruct this agent
```

That is the decision you were making anyway, made with the facts in front of
you instead of behind you.

**2. An agent other people can instruct cannot use a personal account on its
own.** Organization accounts are unaffected: they are already bounded by a
resource boundary somebody approved. The gate is specifically about one
person's account being borrowed by software that answers to several. You can
allow it anyway, and that decision is recorded with your name and the date, so a
later question about how a mailbox was read has somebody to ask.

**3. Every request says which conversation it came from.** The reviewer sees
`requested_from: Berlin trip` beside the action, not just the action. The same
command means something different depending on the room it came from, and the
person deciding is the one who should judge that.

**4. Not knowing is never read as safety.** If NanoClaw cannot be reached, or a
conversation cannot be classified, the request says so in plain words and the
agent is treated as reachable by other people. Silence never earns privacy.

The checks run at the moment of the action and not at connection time, because
the set of conversations an agent answers in changes afterwards, with no
reconnect and no event Contro1 would otherwise see.

### What an approval covers, whether or not you use Contro1

NanoClaw already holds sensitive operations for an admin, and that is a real
control. It is worth knowing exactly what an approval there covers.

**An approval applies to the agent group.** A group answers in every
conversation it is wired to, and `sender_scope` defaults to `all`, meaning it
answers everyone in those conversations rather than a named list. A credential
approved once for a group is therefore usable on behalf of whoever instructs
that group next: in a conversation added a week later, by somebody who was never
part of the decision. Nothing went wrong for this to happen. It is what
group-level authorization means.

NanoClaw does ship controls for this: `sender_scope: known`,
`agent_group_members`, and `unknown_sender_policy`. They sit off the fast path,
so most installations never change them.

**Contro1 does not make the grant finer.** The unit is still the agent group,
and saying otherwise would be a claim this connector cannot keep. What changes:

- the exposure is visible before the decision rather than after it
- personal accounts are refused to a group-facing agent unless its owner allows
  it by name, and that decision is recorded with a name and a date
- the request reaches the accountable person rather than whoever holds the admin DM
- there is a record to read afterwards

> The question is not whether an agent group is a coarse unit. It is whether
> anyone saw that, decided it deliberately, and can be asked about it later.

### One limit worth naming

Contro1 shows which conversation an approval request came from, read from
NanoClaw's own session on the host. It cannot yet **enforce** on it: one agent
group serves several conversations through a single connection, and an Action
call carries no conversation at all. The only thing that could supply one is the
model, which is the same as letting the agent vouch for itself. So "only in my
private chat" is not offered, because nothing would hold it up.

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

Six steps. Two ask a person to decide something in a browser, one asks for an
administrator on this computer, and the rest are commands.

Steps 1, 2, 4, 5 and 6 take a minute. **Step 3 is the long one**: it installs the
Contro1 channel into NanoClaw itself, which copies two files into NanoClaw's
source, adds an import, and changes where approval cards are delivered. We have
asked NanoClaw for a supported way to do that without editing their code; until
then it is a real step and we would rather say so than bury it.

**Skipping step 3 or step 4 is the failure worth knowing about**, because nothing
looks wrong. The connection is live, the agent reports that it is connected, and
not one approval is ever routed. `contro1 doctor nanoclaw` reports both by name
under "Approvals reach Contro1", and `contro1 connect` tells you what it did not
finish instead of declaring success.

### Hand this to a coding agent

```text
Set up Contro1 governance for NanoClaw on this machine.

Rules: do not run sudo unless a step says to. Do not edit config by hand.
If a command fails, stop and report the exact output rather than working around it.

1. Install and sign in
   curl -fsSL https://contro1.com/install.sh | sh
   contro1 version
   contro1 login

2. See which agent groups exist. Connect ONLY the ones you were told to.
   ncl groups list
   contro1 connect nanoclaw --agent <agent-group-id>

   This asks for an administrator once, to register the agent key with the
   local Contro1 service. The person running it types their own password.
   It then prints a code and waits for the owner to approve in a browser.

3. Install the Contro1 channel into NanoClaw.
   Follow skills/add-contro1/SKILL.md in this repository.
   It copies two files into src/channels/, adds one import, and makes
   approval cards prefer Contro1. Then build and restart NanoClaw.

4. Make Contro1 an approver of the group
   contro1 connect nanoclaw --confirm-roles --agent <agent-group-id>

5. Check it. Every line should be ok.
   contro1 doctor nanoclaw

   The line to read carefully is "Approvals reach Contro1". If it is not ok,
   step 3 or 4 is incomplete, and nothing will be governed until it is.

6. Only if this agent should use company applications:
   contro1 apps enable nanoclaw --agent <agent-group-id>

   This opens a page for the owner to allow applications and choose which.
   Wait for them. Then confirm the local changes it lists.

Report back: the output of contro1 doctor nanoclaw, and any step that failed.
```

> `contro1 connect nanoclaw` without `--agent` connects nothing until you name
> which groups. On a host with several it lists them and stops, rather than
> connecting all of them.

### The same steps, longer

Follow [skills/add-contro1/SKILL.md](skills/add-contro1/SKILL.md). In short:

1. Run `contro1 connect nanoclaw` (as yourself, not with sudo). Each agent group
   gets its own owner-approved connection; no key is copied into NanoClaw.
2. Copy `nanoclaw/src/channels/contro1.ts` and `contro1-governance.ts` into
   `src/channels/`, add `import './contro1.js';` to `src/channels/index.ts`.
3. Make approval cards prefer Contro1, so a request made in WhatsApp or Telegram
   still comes to Contro1 (a small change to NanoClaw's approval delivery, step 4
   of the skill).
4. Build and restart. The mapping file is found in its default place.
5. `ncl users create --id contro1:approvals --kind contro1` and
   `ncl roles grant --user contro1:approvals --role admin --group <agent-group-id>`
   (or `contro1 connect nanoclaw --confirm-roles` at a terminal).
6. Optional: give a group the Contro1 MCP server to reach company applications
   through Contro1 (step 8 of the skill).

## Coverage

With the delivery change applied and `contro1:approvals` an admin of a group,
every approval card for that group reaches Contro1: credential use,
`install_packages`, `add_mcp_server` and `create_agent`. In Contro1 each request
goes to the agent's reviewer: its accountable owner, or whoever the owner chose
when approving the connection. The channel logs any other approver at startup.

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

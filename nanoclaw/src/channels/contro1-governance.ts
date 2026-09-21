/**
 * Contro1 governance for NanoClaw approvals.
 *
 * WHAT IT DOES FOR A PERSON. Contro1 wraps the NanoClaw agents: every action
 * NanoClaw holds for an admin (credential use, package installs, MCP servers,
 * new agents) becomes a Contro1 approval request, routed to the right reviewer
 * in the organization and kept in the audit trail. For that to hold for every
 * card, NanoClaw must deliver approval cards to Contro1 first; the add-contro1
 * skill applies that one change (see "Route approvals to Contro1").
 *
 * HOW IT PLUGS IN. NanoClaw routes every admin approval (credential use through
 * OneCLI, install_packages, add_mcp_server, create_agent, ...) as an
 * `ask_question` card to the DM of one approver, and resolves it when that
 * approver clicks a button: the channel adapter calls `onAction(questionId,
 * value, userId)` and NanoClaw's own response handler takes it from there. This
 * adapter is a channel whose "DM" is Contro1. It receives the card, opens a
 * Contro1 approval request, and clicks the button a human chose in Contro1.
 * It never writes to NanoClaw's database or bypasses its approval handler.
 *
 * WHAT NANOCLAW STILL ENFORCES. Only the approver the card was routed to may
 * resolve it (`approver_user_id`), a row resolves once, and an approved replay
 * re-runs NanoClaw's own guard against current state. This adapter adds the
 * Contro1 side: a human decision, role routing, and a binding check that the
 * approval still describes the same action the reviewer saw.
 *
 * WHAT IT NEVER HOLDS. No Contro1 credential, anywhere in NanoClaw. `contro1
 * connect nanoclaw` gives each agent group its own owner-approved connection;
 * the key stays with the local Contro1 service, and this channel only reads a
 * mapping from group to that group's local endpoint. A static credential in
 * `.env` is refused so it cannot quietly become a shared identity.
 *
 * Only this file and contro1.ts are copied into a NanoClaw checkout. It imports
 * nothing from NanoClaw except the channel adapter types.
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';

export const CHANNEL_TYPE = 'contro1';

const NOT_READY = /ENOENT|ECONNREFUSED|ncl\.sock/u;

/** Retries while NanoClaw's admin socket is not up yet; returns either way. */
export async function waitForNanoClaw(probe: () => Promise<unknown>, attempts = 10, delayMs = 1500): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await probe();
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!NOT_READY.test(message) || i === attempts - 1) return;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
const INTEGRATION = 'nanoclaw';
const CARD_MESSAGE_PREFIX = 'contro1-card:';

/** Reviewer-facing labels and default risk for approval actions NanoClaw ships. */
const KNOWN_ACTIONS: Record<string, { label: string; family: string; risk: RiskLevel }> = {
  onecli_credential: { label: 'Credential use', family: 'credential_use', risk: 'high' },
  install_packages: { label: 'Install packages', family: 'self_modification', risk: 'high' },
  add_mcp_server: { label: 'Add MCP server', family: 'self_modification', risk: 'critical' },
  create_agent: { label: 'Create agent', family: 'self_modification', risk: 'high' },
};

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

// ── Settings ──

export interface Contro1NanoClawSettings {
  /** Approver handle. NanoClaw user id is `contro1:<handle>`, and the DM platform id is the handle. */
  handle: string;
  contro1Cli: string;
  apiUrl?: string;
  /** argv prefix for the NanoClaw admin CLI, e.g. ['/opt/nanoclaw/bin/ncl']. */
  ncl: string[];
  pollIntervalMs: number;
  requiredRole?: string;
  /** Contro1 expiry for approvals NanoClaw does not time out itself (self-modification). */
  expiryMinutes: number;
  /** OneCLI delivers the card before writing its row; wait this long for the row. */
  rowGraceMs: number;
  /** Non-secret environment passed to the Contro1 CLI child. */
  cliEnv: Record<string, string>;
  /**
   * Owner-approved connections: the mapping file the Contro1 service wrote,
   * one entry and one endpoint per agent group.
   */
  mappingFile: string;
}

export const ENV_KEYS = [
  'CONTRO1_PLATFORM_MAPPING_FILE',
  // Rejected explicitly so a stale static credential cannot silently win.
  'CONTRO1_AGENT_TOKEN_FILE',
  'CONTRO1_AGENT_TOKEN',
  'CONTRO1_TOKEN',
  'CONTRO1_API_URL',
  'CONTRO1_CLI',
  'CONTRO1_NANOCLAW_HANDLE',
  'CONTRO1_REQUIRED_ROLE',
  'CONTRO1_POLL_INTERVAL_MS',
  'CONTRO1_EXPIRY_MINUTES',
  'NANOCLAW_NCL',
] as const;

/** Variables the CLI child needs to run at all. Copied from the host process, never secrets. */
const PASSTHROUGH_ENV = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP'];

/**
 * Build settings from the host `.env` values. Returns null when no connection
 * mapping is configured, which NanoClaw reports as "credentials missing" and
 * skips the channel: an unconfigured Contro1 channel must not accept approvals
 * it can never decide.
 *
 * Static runtime credentials are deliberately unsupported: a shared host
 * credential loses group ownership and audit attribution.
 */
/** Where `contro1 connect nanoclaw` writes the mapping on each operating system. */
export function defaultMappingFile(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  if (platform === 'linux') return '/etc/contro1/platforms/nanoclaw.json';
  if (platform === 'darwin') return '/Library/Application Support/Contro1/platforms/nanoclaw.json';
  if (platform === 'win32') return `${env.ProgramData || 'C:\\ProgramData'}\\Contro1\\platforms\\nanoclaw.json`;
  return undefined;
}

export function settingsFromEnv(
  values: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  host: { cwd: string; env: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exists?: (path: string) => boolean },
): Contro1NanoClawSettings | null {
  // An explicit setting wins. Without one, the file contro1 connect wrote is
  // used when it exists, so a connected host works without a manual .env step.
  let mappingFile = values.CONTRO1_PLATFORM_MAPPING_FILE?.trim();
  if (!mappingFile && host.exists && host.platform) {
    const fallback = defaultMappingFile(host.platform, host.env);
    if (fallback && host.exists(fallback)) mappingFile = fallback;
  }
  if (!mappingFile) return null;
  if (values.CONTRO1_AGENT_TOKEN_FILE?.trim() || values.CONTRO1_AGENT_TOKEN?.trim() || values.CONTRO1_TOKEN?.trim()) {
    throw new Error('Static Contro1 credentials are unsupported. Run `contro1 connect nanoclaw` and set only CONTRO1_PLATFORM_MAPPING_FILE.');
  }

  const cliEnv: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = host.env[key];
    if (value) cliEnv[key] = value;
  }

  const handle = (values.CONTRO1_NANOCLAW_HANDLE || 'approvals').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(handle)) {
    throw new Error('CONTRO1_NANOCLAW_HANDLE must be 1-64 characters of letters, digits, dot, dash or underscore');
  }

  return {
    handle,
    contro1Cli: values.CONTRO1_CLI?.trim() || 'contro1',
    apiUrl: values.CONTRO1_API_URL?.trim() || undefined,
    ncl: [values.NANOCLAW_NCL?.trim() || `${host.cwd}/bin/ncl`],
    pollIntervalMs: positiveInt(values.CONTRO1_POLL_INTERVAL_MS, 5000),
    requiredRole: values.CONTRO1_REQUIRED_ROLE?.trim() || undefined,
    expiryMinutes: positiveInt(values.CONTRO1_EXPIRY_MINUTES, 24 * 60),
    rowGraceMs: 20_000,
    cliEnv,
    mappingFile,
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// ── Cards ──

export interface ApprovalCard {
  questionId: string;
  title: string;
  question: string;
  optionValues: string[];
}

/** An `ask_question` card as NanoClaw's approvals module delivers it. */
export function parseApprovalCard(message: OutboundMessage): ApprovalCard | null {
  const content = asRecord(message.content);
  if (!content || content.type !== 'ask_question' || typeof content.questionId !== 'string') return null;
  const options = Array.isArray(content.options) ? content.options : [];
  return {
    questionId: content.questionId,
    title: typeof content.title === 'string' ? content.title : '',
    question: typeof content.question === 'string' ? content.question : '',
    optionValues: options.map((o) => asRecord(o)?.value).filter((v): v is string => typeof v === 'string'),
  };
}

/** The card edit NanoClaw sends when an approval times out or resolves elsewhere. */
export function parseCardEdit(message: OutboundMessage): { questionId: string; resolution: string } | null {
  const content = asRecord(message.content);
  if (!content || content.operation !== 'edit' || typeof content.messageId !== 'string') return null;
  if (!content.messageId.startsWith(CARD_MESSAGE_PREFIX)) return null;
  const terminal = asRecord(content.terminalCard);
  const resolution = typeof terminal?.resolution === 'string' ? terminal.resolution : String(content.text ?? '');
  return { questionId: content.messageId.slice(CARD_MESSAGE_PREFIX.length), resolution };
}

// ── NanoClaw approval rows ──

/** A `pending_approvals` row as `ncl approvals get --json` returns it. */
export interface ApprovalRow {
  approval_id: string;
  action: string;
  payload: unknown;
  status: string | null;
  agent_group_id: string | null;
  session_id: string | null;
  channel_type: string | null;
  platform_id: string | null;
  title: string | null;
  /** NanoClaw's card text, kept in its table. Display only, never bound. */
  question?: string | null;
  /**
   * The conversation the instruction came from. NOT `platform_id` on the row:
   * that is where the approval CARD is delivered, which is this channel's own
   * handle. The origin is reached through the session.
   */
  origin?: ApprovalOrigin;
  expires_at: string | null;
  created_at: string | null;
}

/**
 * Where an instruction came from, and how exposed that place is.
 *
 * This is what separates "my sales conversation asked" from "somebody in a
 * group chat asked". The agent itself cannot tell them apart: it answers both
 * with its own authority, so the reviewer has to be told which one it was.
 *
 * `context_id` is NanoClaw's internal `mg-` id. The WhatsApp JID is a phone
 * number or a group address and is deliberately never carried here.
 */
export interface ApprovalOrigin {
  context_id: string;
  label?: string;
  kind: 'private' | 'shared' | 'unknown';
}

export function normalizeRow(raw: unknown): ApprovalRow | null {
  const r = asRecord(raw);
  if (!r || typeof r.approval_id !== 'string' || typeof r.action !== 'string') return null;
  return {
    approval_id: r.approval_id,
    action: r.action,
    payload: parseMaybeJson(r.payload),
    status: str(r.status),
    agent_group_id: str(r.agent_group_id),
    session_id: str(r.session_id),
    channel_type: str(r.channel_type),
    platform_id: str(r.platform_id),
    title: str(r.title),
    question: str(r.question),
    expires_at: str(r.expires_at),
    created_at: str(r.created_at),
  };
}

/**
 * Open means exactly 'pending' (the column is NOT NULL DEFAULT 'pending').
 * 'approved' is a row mid-apply and 'rejected'/'expired' are closed; anything
 * unrecognised is treated as closed, never as a card still waiting for a click.
 */
export function rowIsOpen(row: ApprovalRow): boolean {
  return row.status === 'pending';
}

/**
 * The binding: sha256 over the facts NanoClaw itself recorded for this approval.
 * Every field comes from the host's own row, none from text an agent wrote, and
 * all of them are re-readable, so the hash can be recomputed immediately before
 * the button is clicked. The card's question text is display only.
 */
export function bindingFor(row: ApprovalRow): string {
  return `sha256:${createHash('sha256')
    .update(
      canonicalJson({
        approval_id: row.approval_id,
        action: row.action,
        payload: row.payload ?? null,
        agent_group_id: row.agent_group_id,
        session_id: row.session_id,
        title: row.title,
      }),
    )
    .digest('hex')}`;
}

// ── Approval routing coverage ──

export interface RoleRow {
  user_id: string;
  role: string;
  agent_group_id: string | null;
}

export interface CoverageReport {
  /** Contro1 holds some approver role, so NanoClaw can route cards to it at all. */
  isApprover: boolean;
  global: boolean;
  scopedGroups: string[];
  /**
   * Other people NanoClaw can also route to. Routing is NanoClaw's decision:
   * credential approvals go to the first reachable of scoped admin, global
   * admin, owner; self-modification approvals first prefer any of those on the
   * same platform the request came from. Each of these can therefore receive
   * approvals that never reach Contro1.
   */
  otherApprovers: Array<{ user_id: string; role: string; agent_group_id: string | null; platform: string }>;
}

export function coverageReport(roles: RoleRow[], approverUserId: string): CoverageReport {
  const mine = roles.filter((r) => r.user_id === approverUserId);
  return {
    isApprover: mine.length > 0,
    global: mine.some((r) => r.agent_group_id === null),
    scopedGroups: mine.filter((r) => r.agent_group_id !== null).map((r) => r.agent_group_id!),
    otherApprovers: roles
      .filter((r) => r.user_id !== approverUserId)
      .map((r) => ({ ...r, platform: r.user_id.includes(':') ? r.user_id.slice(0, r.user_id.indexOf(':')) : 'unknown' })),
  };
}

// ── Contro1 decisions ──

export type Contro1Decision = 'approved' | 'denied' | 'timed_out' | 'cancelled';

const DECIDED_STATES = new Set(['answered', 'callback_pending', 'callback_delivered', 'callback_failed', 'closed']);

/**
 * `state` says WHETHER a human decided; the API's derived `status` says WHAT
 * they decided. Neither is enough alone: `status` reads `timed_out` for a
 * request nobody has answered yet. Anything but an explicit approval denies.
 */
export function classifyContro1Request(request: Record<string, unknown>): Contro1Decision | 'pending' {
  const state = String(request.state ?? '').toLowerCase();
  if (state === 'expired') return 'timed_out';
  if (state === 'cancelled') return 'cancelled';
  if (!DECIDED_STATES.has(state)) return 'pending';
  const protocol = asRecord(request.protocol_response) ?? {};
  const status = String(request.status ?? protocol.status ?? '').toLowerCase();
  return status === 'approved' ? 'approved' : 'denied';
}

/**
 * What a reviewer needs to decide, built from the facts NanoClaw recorded.
 *
 * The card NanoClaw renders is not always available: after a restart the channel
 * re-reads approvals from NanoClaw's table, which keeps the payload but not
 * always the card text. So the summary and the facts come from the payload, per
 * action, and never fall back to an id nobody can decide on.
 */
export function reviewerView(row: Pick<ApprovalRow, 'action' | 'payload' | 'agent_group_id'>): {
  summary: string;
  facts: Record<string, string>;
  reason?: string;
} {
  const p = payloadObject(row.payload) ?? {};
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : []);
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const reason = text(p.reason);
  const group = row.agent_group_id ?? 'an agent group';

  switch (row.action) {
    case 'install_packages': {
      const npm = list(p.npm);
      const apt = list(p.apt);
      const parts = [...npm.map((x) => `npm: ${x}`), ...apt.map((x) => `apt: ${x}`)];
      return {
        summary: `Install ${parts.length ? parts.join(', ') : 'packages'} and rebuild the agent's container`,
        facts: {
          ...(npm.length ? { npm_packages: npm.join(', ') } : {}),
          ...(apt.length ? { apt_packages: apt.join(', ') } : {}),
        },
        ...(reason ? { reason } : {}),
      };
    }
    case 'add_mcp_server': {
      const name = text(p.name) ?? 'an MCP server';
      const target = text(p.url) ?? [text(p.command), ...list(p.args)].filter(Boolean).join(' ');
      return {
        summary: `Add the MCP server "${name}"${target ? ` (${target})` : ''} to the agent`,
        facts: { mcp_server: name, ...(target ? { runs: target } : {}) },
        ...(reason ? { reason } : {}),
      };
    }
    case 'create_agent': {
      const name = text(p.name) ?? 'a new agent';
      return {
        summary: `Create a new sub-agent "${name}" with its own workspace and container`,
        facts: { new_agent: name },
        ...(text(p.instructions) ? { reason: text(p.instructions) } : reason ? { reason } : {}),
      };
    }
    case 'onecli_credential': {
      const method = text(p.method) ?? 'A request';
      const host = text(p.host) ?? 'an external service';
      const path = text(p.path) ?? '';
      return {
        summary: `Use a stored credential for ${method} ${host}${path}`,
        facts: { method, host, ...(path ? { path } : {}) },
      };
    }
    default: {
      // The request already names its agent; a group id is not a fact a reviewer decides on.
      const facts: Record<string, string> = {};
      for (const [key, value] of Object.entries(p)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') facts[key] = String(value);
        else if (list(value).length) facts[key] = list(value).join(', ');
        if (Object.keys(facts).length >= 6) break;
      }
      return { summary: `NanoClaw ${row.action.replace(/_/g, ' ')} for ${group}`, facts, ...(reason ? { reason } : {}) };
    }
  }
}

export function buildContro1Request(input: {
  row: ApprovalRow;
  card?: ApprovalCard;
  binding: string;
  settings: Pick<Contro1NanoClawSettings, 'requiredRole' | 'expiryMinutes'>;
  now: Date;
}): Record<string, unknown> {
  const { row, card, binding, settings, now } = input;
  const known = KNOWN_ACTIONS[row.action];
  const label = known?.label ?? row.action;
  const risk: RiskLevel = known?.risk ?? 'medium';
  const expiresAt = row.expires_at ?? new Date(now.getTime() + settings.expiryMinutes * 60_000).toISOString();
  const view = reviewerView(row);
  // NanoClaw's own card text when it is available (live, or kept in its table),
  // otherwise a summary built from the recorded payload.
  const summary = card?.question || row.question || view.summary;

  return {
    title: truncate(`NanoClaw: ${label}${row.title && row.title !== label ? ` - ${row.title}` : ''}`, 200),
    description: truncate(summary, 4000),
    request_type: 'approval',
    external_request_id: externalRequestId(row),
    correlation_id: row.session_id ?? row.agent_group_id ?? row.approval_id,
    source: {
      integration: INTEGRATION,
      framework: 'nanoclaw',
      workflow_id: row.agent_group_id ?? undefined,
      run_id: row.approval_id,
      session_id: row.session_id ?? undefined,
    },
    routing: {
      required_role: settings.requiredRole,
      priority: risk === 'critical' || risk === 'high' ? 'urgent' : 'normal',
    },
    context: {
      action_type: `nanoclaw.${row.action}`,
      tool_name: `nanoclaw.${row.action}`,
      resource: row.agent_group_id ?? undefined,
      summary: truncate(summary, 4000),
      // Shown to the reviewer as the facts of the action. Where the
      // instruction came from leads, because on a shared surface it changes
      // what the same action means.
      tool_input: { ...originFacts(row.origin), ...view.facts },
      // Written by the agent, so shown as its claim, never as a fact.
      ...(view.reason ? { agent_reported: { justification: truncate(view.reason, 2000) } } : {}),
      // Facts NanoClaw's host recorded. The card question is NanoClaw-rendered
      // too, but only these are bound.
      machine_observed: {
        approval_id: row.approval_id,
        action: row.action,
        family: known?.family ?? 'other',
        agent_group_id: row.agent_group_id,
        session_id: row.session_id,
        payload: row.payload ?? null,
        binding_hash: binding,
      },
    },
    continuation: { mode: 'decision', expires_at: expiresAt },
    risk_level: risk,
    policy_trigger: `nanoclaw.${row.action}`,
    policy_context: {
      source: 'nanoclaw_host',
      policy_name: 'nanoclaw-admin-approvals',
      rule_id: row.action,
      rule_reason: `NanoClaw requires admin approval for ${label.toLowerCase()}.`,
      enforcement: 'require_approval',
    },
    // The API's tool call is {name, input?, outcome?: success|failure|partial}.
    // Nothing has run yet, so there is no outcome; the payload is the input.
    tool_calls: [{ name: `nanoclaw.${row.action}`, ...(payloadObject(row.payload) ? { input: payloadObject(row.payload) } : {}) }],
    metadata: { nanoclaw: { binding_hash: binding, card_title: card?.title ?? null } },
  };
}

/** NanoClaw stores the payload as JSON text; the API wants an object. */
export function payloadObject(payload: unknown): Record<string, unknown> | undefined {
  let value = payload;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * NanoClaw's requestApproval() (install_packages, add_mcp_server, create_agent)
 * records the session but not the agent group; only OneCLI cards carry the
 * group. The group decides which Contro1 connection the request belongs to, so
 * it is read from the session when the row lacks it.
 */
export async function withAgentGroup(
  row: ApprovalRow,
  groupOfSession: (sessionId: string) => Promise<string | null>,
): Promise<ApprovalRow> {
  if (row.agent_group_id || !row.session_id) return row;
  const group = await groupOfSession(row.session_id);
  return group ? { ...row, agent_group_id: group } : row;
}

/** What a NanoClaw session says about where it lives. */
export interface SessionContext {
  agent_group_id: string | null;
  messaging_group_id: string | null;
}

/** What a NanoClaw messaging group says about itself. */
export interface MessagingGroup {
  name: string | null;
  is_group: boolean;
}

/**
 * Attach the conversation an instruction came from.
 *
 * Two hops, because NanoClaw splits the question: the session says which
 * conversation it belongs to, and the conversation says whether other people
 * are in it. Neither alone answers "who could have asked for this".
 *
 * Every failure leaves the origin `unknown` rather than dropping it. A reviewer
 * being told "we could not tell where this came from" is the useful answer; an
 * absent origin would read as an ordinary private request, which is the exact
 * mistake this exists to prevent.
 */
export async function withOrigin(
  row: ApprovalRow,
  lookup: {
    sessionContext: (sessionId: string) => Promise<SessionContext | null>;
    messagingGroup: (messagingGroupId: string) => Promise<MessagingGroup | null>;
  },
): Promise<ApprovalRow> {
  if (row.origin || !row.session_id) return row;
  const session = await lookup.sessionContext(row.session_id).catch(() => null);
  const contextId = session?.messaging_group_id;
  if (!contextId) return row;

  const group = await lookup.messagingGroup(contextId).catch(() => null);
  const origin: ApprovalOrigin = group
    ? {
      context_id: contextId,
      ...(group.name ? { label: group.name } : {}),
      kind: group.is_group ? 'shared' : 'private',
    }
    : { context_id: contextId, kind: 'unknown' };
  return { ...row, origin };
}

/** How the origin reads on a reviewer's card. */
export function originFacts(origin: ApprovalOrigin | undefined): Record<string, string> {
  if (!origin) return { requested_from: 'unknown conversation' };
  const where = origin.label || origin.context_id;
  if (origin.kind === 'shared') {
    return { requested_from: where, conversation: 'group chat: anyone in it can instruct this agent' };
  }
  if (origin.kind === 'private') return { requested_from: where, conversation: 'direct message' };
  return { requested_from: where, conversation: 'unknown: Contro1 could not tell who can reach this agent here' };
}

/**
 * Notice when an agent gains a room it did not have.
 *
 * WHY THIS EXISTS. `contro1 connect` reads every conversation an agent answers
 * in, so whatever is true at that moment is recorded completely. What it cannot
 * see is what happens next, and what happens next is the ordinary case: NanoClaw
 * asks, in a DM, whether to attach the main agent to a new group or deploy a
 * fresh one. That question arrives weeks after anybody granted the agent access
 * to a mailbox, on a phone, and it reads as an operational detail. Answering
 * "the main one" quietly turns a private assistant into one a room can instruct.
 *
 * NOTHING IS POLLED FROM THE SERVER. The reach is computed here, from NanoClaw's
 * own tables, on a tick this channel already runs. Contro1 hears about it only
 * when the answer changes, so an agent sitting still costs one local read and no
 * request at all.
 *
 * ONLY EVER TIGHTENING. A report can say a surface became shared; it cannot say
 * one became private, because the server refuses that from an agent credential
 * and should. So the dangerous direction is caught within a tick, and the
 * harmless one waits for a reconnect, which is the right way round.
 */
export function reachDigest(contexts: readonly ReachContext[]): string {
  const ordered = [...contexts]
    .map((c) => `${c.context_id}:${c.kind}:${c.participants_known ? 1 : 0}`)
    .sort();
  return createHash('sha256').update(ordered.join('\n')).digest('hex').slice(0, 32);
}

/** Whether this reach would leave the agent reachable by people nobody named. */
export function isSharedSurface(contexts: readonly ReachContext[]): boolean {
  if (contexts.length === 0) return true;
  return contexts.some((c) => c.kind !== 'private' || !c.participants_known);
}

export class ReachWatcher {
  private lastDigest: string | null = null;

  constructor(
    private readonly deps: {
      nanoclaw: Pick<NanoClawPort, 'listReach'>;
      contro1: Pick<Contro1Port, 'declareReach'>;
      log: Logger;
    },
  ) {}

  /**
   * One check. Reports only a change, and only one that tightens.
   *
   * Returns what it did, so a caller can log it and a test can assert it.
   */
  async check(agentGroupId: string): Promise<'unchanged' | 'reported' | 'ignored' | 'failed'> {
    let contexts: ReachContext[];
    try {
      contexts = await this.deps.nanoclaw.listReach(agentGroupId);
    } catch (err) {
      // A read that failed is not a reach that changed. Saying nothing leaves
      // Contro1 with the last answer it trusted, which is the safe one.
      this.deps.log.warn('Contro1 could not re-read which conversations this agent answers in', {
        err: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }

    const digest = reachDigest(contexts);
    if (digest === this.lastDigest) return 'unchanged';

    if (!isSharedSurface(contexts)) {
      // Nothing to report: the server will not accept a claim of privacy from
      // an agent's own credential, and it is right not to. Remembered anyway,
      // so a later move back into a group is still seen as a change.
      this.lastDigest = digest;
      return 'ignored';
    }

    try {
      await this.deps.contro1.declareReach(contexts, { agent_group_id: agentGroupId });
      this.lastDigest = digest;
      const shared = contexts.filter((c) => c.kind !== 'private');
      this.deps.log.info('Contro1 was told this agent now answers where other people can instruct it', {
        conversations: shared.map((c) => c.label || c.context_id),
      });
      return 'reported';
    } catch (err) {
      // Not remembered, so the next tick tries again.
      this.deps.log.warn('Contro1 could not be told that this agent gained a shared conversation', {
        err: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }
  }
}

export function externalRequestId(row: Pick<ApprovalRow, 'action' | 'approval_id'>): string {
  return `nanoclaw:${row.action}:${row.approval_id}`.replace(/[^A-Za-z0-9:._-]/g, '_').slice(0, 200);
}

// ── Ports ──

/** Which NanoClaw agent group a call belongs to. Decides the Contro1 identity. */
export interface GroupScope {
  agent_group_id: string | null;
}

export interface Contro1Port {
  /** Tell Contro1 who can instruct this agent. Only ever makes it stricter. */
  declareReach(contexts: ReachContext[], scope: GroupScope): Promise<void>;
  /** The agent groups connected on this computer, from the mapping file. */
  connectedAgentGroups(): string[];
  createRequest(body: Record<string, unknown>, scope: GroupScope): Promise<string>;
  getRequest(requestId: string, scope: GroupScope): Promise<Record<string, unknown>>;
  cancelRequest(requestId: string, scope: GroupScope): Promise<void>;
  report(record: Record<string, unknown>, scope: GroupScope): Promise<void>;
}

export interface NanoClawPort {
  /** The row, or null when NanoClaw no longer has it (resolved, expired or never an approval). */
  getApproval(approvalId: string): Promise<ApprovalRow | null>;
  listApprovals(): Promise<ApprovalRow[]>;
  listRoles(): Promise<RoleRow[]>;
  /** Every conversation wired to one agent group, and whether each is a group chat. */
  listReach(agentGroupId: string): Promise<ReachContext[]>;
}

export interface ReachContext {
  context_id: string;
  label?: string;
  kind: 'private' | 'shared' | 'unknown';
  participants_known: boolean;
}

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// ── The governor ──

type Tracked = {
  questionId: string;
  card?: ApprovalCard;
  firstSeenMs: number;
  requestId?: string;
  binding?: string;
  row?: ApprovalRow;
};

export type TickResult = { tracked: number; requested: number; resolved: number; failed: number };

/**
 * Tracks approvals routed to the Contro1 approver and drives each to exactly
 * one outcome. Holds no durable state of its own: NanoClaw's pending_approvals
 * table is the record of what is open, and the Contro1 request carries a
 * deterministic external_request_id, so after a restart `recover()` re-tracks
 * open rows and re-creating a request returns the one that already exists.
 */
export class ApprovalGovernor {
  private readonly tracked = new Map<string, Tracked>();
  private ticking = false;

  constructor(
    private readonly deps: {
      settings: Contro1NanoClawSettings;
      contro1: Contro1Port;
      nanoclaw: NanoClawPort;
      log: Logger;
      now?: () => number;
    },
  ) {}

  get approverUserId(): string {
    return `${CHANNEL_TYPE}:${this.deps.settings.handle}`;
  }

  get size(): number {
    return this.tracked.size;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** A card was delivered to the Contro1 approver. */
  track(card: ApprovalCard): void {
    const existing = this.tracked.get(card.questionId);
    if (existing) {
      existing.card = card;
      return;
    }
    this.tracked.set(card.questionId, { questionId: card.questionId, card, firstSeenMs: this.now() });
  }

  /** NanoClaw closed the card itself (timeout or restart). The Contro1 request must not outlive it. */
  async closedByNanoClaw(questionId: string, resolution: string): Promise<void> {
    const item = this.tracked.get(questionId);
    if (!item) return;
    this.tracked.delete(questionId);
    if (item.requestId) {
      await this.safe(() => this.deps.contro1.cancelRequest(item.requestId!, scopeOf(item)), 'cancel Contro1 request');
    }
    await this.audit(item, 'nanoclaw.approval.expired', 'denied', `NanoClaw closed the approval: ${resolution}`);
  }

  /** Re-track open approvals routed to this approver, e.g. after a host restart. */
  async recover(): Promise<number> {
    const rows = await this.deps.nanoclaw.listApprovals();
    let added = 0;
    for (const row of rows) {
      if (row.channel_type !== CHANNEL_TYPE || row.platform_id !== this.deps.settings.handle || !rowIsOpen(row)) continue;
      if (this.tracked.has(row.approval_id)) continue;
      this.tracked.set(row.approval_id, { questionId: row.approval_id, firstSeenMs: this.now(), row });
      added += 1;
    }
    return added;
  }

  /**
   * One pass over every tracked approval. Never overlaps itself: a second call
   * while one runs is a no-op, so an approval can never be clicked twice.
   */
  async tick(onAction: ChannelSetup['onAction']): Promise<TickResult> {
    const result: TickResult = { tracked: this.tracked.size, requested: 0, resolved: 0, failed: 0 };
    if (this.ticking) return result;
    this.ticking = true;
    try {
      for (const item of [...this.tracked.values()]) {
        try {
          if (!item.requestId) {
            if (await this.open(item)) result.requested += 1;
          } else if (await this.settle(item, onAction)) {
            result.resolved += 1;
          }
        } catch (err) {
          // A failure leaves the approval unresolved in NanoClaw, which denies
          // or times it out on its own. It is retried on the next pass.
          result.failed += 1;
          this.deps.log.error('Contro1 approval step failed', {
            approvalId: item.questionId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this.ticking = false;
    }
    return result;
  }

  private async open(item: Tracked): Promise<boolean> {
    const row = await this.deps.nanoclaw.getApproval(item.questionId);
    if (!row) {
      if (this.now() - item.firstSeenMs < this.deps.settings.rowGraceMs) return false;
      // Not an approvals row: channel registration and sender cards live in
      // other tables and are not governed here. Say so instead of hanging.
      this.tracked.delete(item.questionId);
      this.deps.log.warn('Card routed to Contro1 has no NanoClaw approval row; not governed', {
        questionId: item.questionId,
        title: item.card?.title,
      });
      await this.audit(item, 'nanoclaw.approval.not_governed', 'failure', 'A card reached the Contro1 approver without a NanoClaw approval row; it was left for NanoClaw to expire.');
      return false;
    }
    if (!rowIsOpen(row)) {
      this.tracked.delete(item.questionId);
      return false;
    }
    const binding = bindingFor(row);
    const requestId = await this.deps.contro1.createRequest(
      buildContro1Request({ row, card: item.card, binding, settings: this.deps.settings, now: new Date(this.now()) }),
      { agent_group_id: row.agent_group_id },
    );
    item.row = row;
    item.binding = binding;
    item.requestId = requestId;
    await this.audit(item, 'nanoclaw.approval.requested', 'success', `Routed NanoClaw ${row.action} approval to Contro1.`);
    return true;
  }

  private async settle(item: Tracked, onAction: ChannelSetup['onAction']): Promise<boolean> {
    const decision = classifyContro1Request(await this.deps.contro1.getRequest(item.requestId!, scopeOf(item)));
    if (decision === 'pending') return false;

    if (decision !== 'approved') {
      this.tracked.delete(item.questionId);
      onAction(item.questionId, 'reject', this.approverUserId);
      const event = decision === 'denied' ? 'nanoclaw.approval.denied' : `nanoclaw.approval.${decision}`;
      await this.audit(item, event, 'denied', `Contro1 decision was ${decision}; NanoClaw approval rejected.`);
      return true;
    }

    // Approved in Contro1. Re-read the row and confirm it is still open and
    // still the exact action the reviewer saw before clicking approve.
    const current = await this.deps.nanoclaw.getApproval(item.questionId);
    if (!current || !rowIsOpen(current)) {
      this.tracked.delete(item.questionId);
      await this.audit(item, 'nanoclaw.approval.expired', 'denied', 'Approved in Contro1, but NanoClaw no longer had the approval open; nothing was applied.');
      return true;
    }
    if (bindingFor(current) !== item.binding) {
      this.tracked.delete(item.questionId);
      onAction(item.questionId, 'reject', this.approverUserId);
      await this.audit(item, 'nanoclaw.approval.binding_mismatch', 'denied', 'The NanoClaw approval changed after the reviewer saw it; it was rejected.', {
        bound_hash: item.binding,
        current_hash: bindingFor(current),
      });
      return true;
    }

    this.tracked.delete(item.questionId);
    onAction(item.questionId, 'approve', this.approverUserId);
    await this.audit(item, 'nanoclaw.approval.approved', 'success', `Contro1 approved; NanoClaw ${current.action} approval applied.`);
    return true;
  }

  private async audit(
    item: Tracked,
    action: string,
    outcome: 'success' | 'failure' | 'denied',
    summary: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    const row = item.row;
    await this.safe(
      () =>
        this.deps.contro1.report({
          action,
          summary,
          source: { integration: INTEGRATION, workflow_id: row?.agent_group_id ?? undefined, run_id: item.questionId },
          resource: { type: 'nanoclaw.approval', id: item.questionId },
          outcome,
          severity: outcome === 'success' ? 'info' : 'warning',
          correlation_id: row?.session_id ?? row?.agent_group_id ?? item.questionId,
          external_request_id: `${action}:${item.questionId}`.replace(/[^A-Za-z0-9:._-]/g, '_').slice(0, 200),
          in_reply_to: item.requestId ? { type: 'request', id: item.requestId } : undefined,
          metadata: {
            machine_observed: row ? { action: row.action, agent_group_id: row.agent_group_id, binding_hash: item.binding } : undefined,
            ...extra,
          },
        }, scopeOf(item)),
      'write Contro1 audit record',
    );
  }

  private async safe(fn: () => Promise<void>, what: string): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.deps.log.warn(`Could not ${what}`, { err: err instanceof Error ? err.message : String(err) });
    }
  }
}

function scopeOf(item: Tracked): GroupScope {
  return { agent_group_id: item.row?.agent_group_id ?? null };
}

// ── The channel adapter ──

export const CONTRO1_DEFAULTS: ChannelDefaults = {
  // Contro1 never sends chat into NanoClaw: nothing engages, strangers are refused.
  dm: { engageMode: 'pattern', engagePattern: '(?!)', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '(?!)', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'never',
};

export function createContro1Adapter(deps: {
  settings: Contro1NanoClawSettings;
  contro1: Contro1Port;
  nanoclaw: NanoClawPort;
  log: Logger;
}): ChannelAdapter & { governor: ApprovalGovernor } {
  const governor = new ApprovalGovernor(deps);
  let setup: ChannelSetup | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  // Start-up checks wait for NanoClaw's admin socket, which NanoClaw opens only
  // after channels are set up. Blocking setup on it would only delay the host,
  // so they run on the tick and stay quiet while the socket is not there yet.
  let ready = false;
  let ticks = 0;
  let warnedStartup = false;
  const RECOVER_EVERY_TICKS = 12;
  // Same slow cadence as recover. One local read of NanoClaw's own tables, and
  // a request to Contro1 only when the answer changed.
  const reachWatcher = new ReachWatcher({ nanoclaw: deps.nanoclaw, contro1: deps.contro1, log: deps.log });

  const startupChecks = async (): Promise<void> => {
    const coverage = coverageReport(await deps.nanoclaw.listRoles(), governor.approverUserId);
    if (!coverage.isApprover) {
      deps.log.error('Contro1 is not an approver: no NanoClaw approval can reach it', {
        fix: `ncl roles grant --user ${governor.approverUserId} --role admin --group <agent-group-id>`,
      });
    } else if (coverage.otherApprovers.length > 0) {
      deps.log.warn('Other NanoClaw approvers can still receive approvals outside Contro1', {
        contro1: { global: coverage.global, groups: coverage.scopedGroups },
        others: coverage.otherApprovers,
      });
    }
  };

  const runTick = async (): Promise<void> => {
    if (!setup) return;
    ticks += 1;
    let recoverNow = ticks % RECOVER_EVERY_TICKS === 0;
    if (!ready) {
      try {
        await startupChecks();
        ready = true;
        recoverNow = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!NOT_READY.test(message) && !warnedStartup) {
          warnedStartup = true;
          deps.log.warn('Contro1 could not check approval routing coverage', { err: message });
        }
        if (NOT_READY.test(message)) return;
      }
    }
    // Re-reading open approvals now and then picks up a card that was routed
    // while the channel could not see it, instead of waiting for it to be sent again.
    if (recoverNow) {
      // Noticing that this agent was added to a group since it was connected.
      // NanoClaw asks that question in a DM, long after anybody decided what
      // the agent may reach, and answering it casually is how a private
      // assistant becomes one a room can instruct.
      for (const agentGroupId of deps.contro1.connectedAgentGroups()) {
        await reachWatcher.check(agentGroupId);
      }
      try {
        const recovered = await governor.recover();
        if (recovered) deps.log.info('Contro1 re-tracked open approvals', { recovered });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!NOT_READY.test(message)) deps.log.warn('Contro1 could not list open approvals', { err: message });
      }
    }
    const result = await governor.tick(setup.onAction);
    if (result.requested || result.resolved) deps.log.info('Contro1 approvals', result);
  };

  return {
    name: 'Contro1',
    channelType: CHANNEL_TYPE,
    supportsThreads: false,
    defaults: CONTRO1_DEFAULTS,
    governor,

    async setup(config: ChannelSetup): Promise<void> {
      setup = config;
      // Never waits on NanoClaw: its admin socket opens only after channels are
      // set up. The coverage check and recovery run on the ticks instead.
      timer = setInterval(() => void runTick(), deps.settings.pollIntervalMs);
      timer.unref?.();
      void runTick();
    },

    async teardown(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = null;
      setup = null;
    },

    isConnected(): boolean {
      return setup !== null;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (platformId !== deps.settings.handle) return undefined;
      const edit = parseCardEdit(message);
      if (edit) {
        await governor.closedByNanoClaw(edit.questionId, edit.resolution);
        return undefined;
      }
      const card = parseApprovalCard(message);
      if (!card) return undefined; // notifications and chat: nothing to decide
      governor.track(card);
      void runTick();
      return `${CARD_MESSAGE_PREFIX}${card.questionId}`;
    },
  };
}

// ── CLI-backed ports ──

const CLI_TIMEOUT_MS = 30_000;
const CLI_MAX_OUTPUT = 1024 * 1024;

type BrokerEntry = { platform_subject: string; agent_id: string; endpoint: string; server_principal?: string };

/**
 * Owner-approved connections: each agent group reaches Contro1 through ITS OWN
 * endpoint. A call without a group, or for a group that is not in the mapping,
 * is refused. There is no host default identity.
 */
export function contro1BrokerPort(settings: Contro1NanoClawSettings, readMapping: () => string = () => readFileSync(settings.mappingFile!, 'utf8')): Contro1Port {
  const entryFor = (scope: GroupScope): BrokerEntry => {
    if (!scope.agent_group_id) {
      throw new Error('Contro1: this approval has no NanoClaw agent group, so it cannot be attributed to a connected agent');
    }
    let parsed: { schema_version?: number; entries?: BrokerEntry[] };
    try {
      parsed = JSON.parse(readMapping());
    } catch (err) {
      throw new Error(`Contro1: cannot read the mapping file: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed.schema_version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error('Contro1: the mapping file has an unsupported format; run contro1 doctor nanoclaw');
    }
    const entry = parsed.entries.find((e) => e.platform_subject === scope.agent_group_id);
    if (!entry) {
      throw new Error(`Contro1: agent group ${scope.agent_group_id} is not connected on this computer; run contro1 connect nanoclaw`);
    }
    return entry;
  };
  const envFor = (scope: GroupScope): Record<string, string> => {
    const entry = entryFor(scope);
    const env: Record<string, string> = {};
    for (const key of PASSTHROUGH_ENV) {
      if (settings.cliEnv[key]) env[key] = settings.cliEnv[key]!;
    }
    env.CONTRO1_BROKER_ENDPOINT = entry.endpoint;
    if (entry.server_principal) env.CONTRO1_BROKER_PRINCIPAL = entry.server_principal;
    return env;
  };
  return {
    connectedAgentGroups: () => {
      // Best effort by design: an unreadable mapping is already reported
      // loudly everywhere else, and the drift watch is not the place to
      // start failing ticks over it.
      try {
        const parsed = JSON.parse(readMapping()) as { entries?: BrokerEntry[] };
        return (parsed.entries ?? []).map((e) => e.platform_subject).filter(Boolean);
      } catch {
        return [];
      }
    },
    declareReach: async (contexts, scope) => cliPortWithEnv(settings, envFor(scope)).declareReach(contexts, scope),
    createRequest: async (body, scope) => cliPortWithEnv(settings, envFor(scope)).createRequest(body, scope),
    getRequest: async (id, scope) => cliPortWithEnv(settings, envFor(scope)).getRequest(id, scope),
    cancelRequest: async (id, scope) => cliPortWithEnv(settings, envFor(scope)).cancelRequest(id, scope),
    report: async (record, scope) => cliPortWithEnv(settings, envFor(scope)).report(record, scope),
  };
}

function cliPortWithEnv(settings: Contro1NanoClawSettings, env: Record<string, string>): Contro1Port {
  const run = (args: string[], stdin?: unknown) =>
    runJson(settings.contro1Cli, [...args, ...(settings.apiUrl ? ['--api-url', settings.apiUrl] : []), '--format', 'json', '--quiet'], env, stdin);
  return {
    async createRequest(body) {
      const { code, json, stderr } = await run(['requests', 'create', '--runtime', '--file', '-'], body);
      const created = asRecord(json);
      const id = created ? str(created.request_id) ?? str(created.id) : null;
      if (code !== 0 || !id) throw new Error(`contro1 requests create failed (exit ${code}): ${redact(stderr)}`);
      return id;
    },
    async getRequest(requestId) {
      const { code, json, stderr } = await run(['requests', 'get', '--runtime', requestId]);
      const request = asRecord(json);
      if (code !== 0 || !request) throw new Error(`contro1 requests get failed (exit ${code}): ${redact(stderr)}`);
      return request;
    },
    async cancelRequest(requestId) {
      const { code, stderr } = await run(['requests', 'cancel', '--runtime', requestId]);
      if (code !== 0) throw new Error(`contro1 requests cancel failed (exit ${code}): ${redact(stderr)}`);
    },
    async report(record) {
      const { code, stderr } = await run(['activity', 'report', '--file', '-'], record);
      if (code !== 0) throw new Error(`contro1 activity report failed (exit ${code}): ${redact(stderr)}`);
    },
    // Not reachable through the CLI, which has no command for it, so it goes
    // over the agent's own endpoint the same way everything else here does.
    async declareReach(contexts) {
      const { code, stderr } = await run(['agents', 'reach', '--file', '-'], { contexts });
      if (code !== 0) throw new Error(`contro1 could not record this agent's reach (exit ${code}): ${redact(stderr)}`);
    },
    connectedAgentGroups: () => [],
  };
}

export function nclPort(settings: Pick<Contro1NanoClawSettings, 'ncl'>, env: NodeJS.ProcessEnv): NanoClawPort {
  const [bin, ...prefix] = settings.ncl;
  const run = (args: string[]) => runJson(bin!, [...prefix, ...args, '--json'], env as Record<string, string>);
  const sessions = new Map<string, SessionContext>();
  const sessionContext = async (sessionId: string): Promise<SessionContext | null> => {
    const cached = sessions.get(sessionId);
    if (cached) return cached;
    const { json } = await run(['sessions', 'get', '--id', sessionId]);
    const frame = asRecord(json);
    if (frame?.ok !== true) return null;
    const data = asRecord(frame.data);
    const context: SessionContext = {
      agent_group_id: str(data?.agent_group_id),
      messaging_group_id: str(data?.messaging_group_id),
    };
    // Neither of a session's groups changes, so a found answer is kept; a miss
    // is not, because the row may simply not have been written yet.
    if (context.agent_group_id || context.messaging_group_id) sessions.set(sessionId, context);
    return context;
  };
  const groupOfSession = async (sessionId: string): Promise<string | null> =>
    (await sessionContext(sessionId))?.agent_group_id ?? null;

  const messagingGroups = new Map<string, MessagingGroup>();
  const messagingGroup = async (messagingGroupId: string): Promise<MessagingGroup | null> => {
    const cached = messagingGroups.get(messagingGroupId);
    if (cached) return cached;
    const { json } = await run(['messaging-groups', 'get', '--id', messagingGroupId]);
    const frame = asRecord(json);
    if (frame?.ok !== true) return null;
    const data = asRecord(frame.data);
    // NEVER reads platform_id: that is the WhatsApp JID, a phone number or a
    // group address, and nothing downstream needs it.
    const group: MessagingGroup = { name: str(data?.name), is_group: Number(data?.is_group) === 1 };
    messagingGroups.set(messagingGroupId, group);
    return group;
  };

  /*
   * Which conversations one agent group answers in, read from NanoClaw itself.
   *
   * Two hops, because NanoClaw splits the question: a wiring says which
   * conversation reaches which agent group and on what terms, and the
   * conversation says whether other people are in it.
   *
   * A direct message counts its participants as known whatever sender_scope
   * says. The default is "all", which in a group means "answer everyone in the
   * room" and is the exposure worth refusing, and in a one to one chat means
   * "answer the one person who can write here", because only one can.
   *
   * The WhatsApp address is never read. It is a phone number or a group
   * address, nothing here needs it, and it would end up stored in Contro1.
   */
  const listReach = async (agentGroupId: string): Promise<ReachContext[]> => {
    const { json } = await run(['wirings', 'list']);
    const frame = asRecord(json);
    if (frame?.ok !== true || !Array.isArray(frame.data)) {
      throw new Error('ncl wirings list did not answer');
    }
    const out: ReachContext[] = [];
    for (const raw of frame.data) {
      const w = asRecord(raw);
      const mgId = str(w?.messaging_group_id);
      if (!w || str(w.agent_group_id) !== agentGroupId || !mgId) continue;
      const entry: ReachContext = {
        context_id: mgId,
        kind: 'unknown',
        participants_known: str(w.sender_scope) === 'known',
      };
      const group = await messagingGroup(mgId).catch(() => null);
      if (group) {
        if (group.name) entry.label = group.name;
        if (group.is_group) {
          entry.kind = 'shared';
        } else {
          entry.kind = 'private';
          entry.participants_known = true;
        }
      }
      out.push(entry);
    }
    return out;
  };

  const enrich = async (row: ApprovalRow | null): Promise<ApprovalRow | null> => {
    if (!row) return null;
    return withOrigin(await withAgentGroup(row, groupOfSession), { sessionContext, messagingGroup });
  };
  return {
    listReach,
    async getApproval(approvalId) {
      const { json, stderr, code } = await run(['approvals', 'get', '--id', approvalId]);
      const frame = asRecord(json);
      if (frame?.ok === true) return enrich(normalizeRow(frame.data));
      const message = String(asRecord(frame?.error)?.message ?? stderr);
      if (/not found/i.test(message)) return null;
      throw new Error(`ncl approvals get failed (exit ${code}): ${message}`);
    },
    async listApprovals() {
      const { json, stderr, code } = await run(['approvals', 'list', '--limit', '500']);
      const frame = asRecord(json);
      if (frame?.ok !== true || !Array.isArray(frame.data)) {
        throw new Error(`ncl approvals list failed (exit ${code}): ${String(asRecord(frame?.error)?.message ?? stderr)}`);
      }
      return frame.data.map(normalizeRow).filter((r): r is ApprovalRow => r !== null);
    },
    async listRoles() {
      const { json, stderr, code } = await run(['roles', 'list', '--limit', '500']);
      const frame = asRecord(json);
      if (frame?.ok !== true || !Array.isArray(frame.data)) {
        throw new Error(`ncl roles list failed (exit ${code}): ${String(asRecord(frame?.error)?.message ?? stderr)}`);
      }
      return frame.data
        .map((raw) => asRecord(raw))
        .filter((r): r is Record<string, unknown> => !!r && typeof r.user_id === 'string' && typeof r.role === 'string')
        .map((r) => ({ user_id: r.user_id as string, role: r.role as string, agent_group_id: str(r.agent_group_id) }));
    },
  };
}

/** Run one fixed command, bounded in time and output. Never through a shell. */
export function runJson(
  bin: string,
  args: string[],
  env: Record<string, string>,
  stdin?: unknown,
): Promise<{ code: number | null; json: unknown; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let done = false;
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(`${bin} timed out after ${CLI_TIMEOUT_MS}ms`)), CLI_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > CLI_MAX_OUTPUT) fail(new Error(`${bin} stdout exceeded limit`));
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > CLI_MAX_OUTPUT) fail(new Error(`${bin} stderr exceeded limit`));
    });
    child.on('error', (err) => fail(err));
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let json: unknown = null;
      try {
        json = stdout.trim() ? JSON.parse(stdout) : null;
      } catch {
        json = null;
      }
      resolve({ code, json, stderr: stderr.slice(0, 2000) });
    });
    child.stdin.end(stdin === undefined ? undefined : JSON.stringify(stdin));
  });
}

// ── helpers ──

export function redact(value: string): string {
  return value
    .replace(/cc_live_[A-Za-z0-9._-]+/g, 'cc_live_[redacted]')
    .replace(/cc_test_[A-Za-z0-9._-]+/g, 'cc_test_[redacted]')
    .replace(/cco_cli_[A-Za-z0-9._-]+/g, 'cco_cli_[redacted]')
    .replace(/ccr_live_[A-Za-z0-9._-]+/g, 'ccr_live_[redacted]');
}

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

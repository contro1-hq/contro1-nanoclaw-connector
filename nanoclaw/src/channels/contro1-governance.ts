/**
 * Contro1 governance for NanoClaw approvals.
 *
 * HOW IT PLUGS IN. NanoClaw routes every admin approval (credential use through
 * OneCLI, install_packages, add_mcp_server, create_agent, ...) as an
 * `ask_question` card to the DM of one approver, and resolves it when that
 * approver clicks a button: the channel adapter calls `onAction(questionId,
 * value, userId)` and NanoClaw's own response handler takes it from there. This
 * adapter is a channel whose "DM" is Contro1. It receives the card, opens a
 * Contro1 approval request, and clicks the button a human chose in Contro1.
 * Nothing in NanoClaw is patched, bypassed or written to directly.
 *
 * WHAT NANOCLAW STILL ENFORCES. Only the approver the card was routed to may
 * resolve it (`approver_user_id`), a row resolves once, and an approved replay
 * re-runs NanoClaw's own guard against current state. This adapter adds the
 * Contro1 side: a human decision, role routing, and a binding check that the
 * approval still describes the same action the reviewer saw.
 *
 * WHAT IT NEVER HOLDS INSIDE A CONTAINER. The Agent Credential stays in the
 * host `.env`; it is handed only to the `contro1` CLI child process, never to
 * process.env and never to agent containers (NanoClaw composes container env
 * explicitly).
 *
 * Only this file and contro1.ts are copied into a NanoClaw checkout. It imports
 * nothing from NanoClaw except the channel adapter types.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';

export const CHANNEL_TYPE = 'contro1';
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
  /** Environment for the contro1 CLI child. Holds the Agent Credential variable and nothing secret besides. */
  cliEnv: Record<string, string>;
}

export const ENV_KEYS = [
  'CONTRO1_AGENT_TOKEN_FILE',
  'CONTRO1_AGENT_TOKEN',
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
 * Build settings from the host `.env` values. Returns null when no Agent
 * Credential is configured, which NanoClaw reports as "credentials missing" and
 * skips the channel: an unconfigured Contro1 channel must not accept approvals
 * it can never decide.
 *
 * Only the two AGENT variables are accepted. CONTRO1_TOKEN is deliberately not:
 * it is the variable a developer's own CLI login uses, and an approval bridge
 * must never act as whoever happens to be logged in on the host.
 */
export function settingsFromEnv(
  values: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  host: { cwd: string; env: NodeJS.ProcessEnv },
): Contro1NanoClawSettings | null {
  const tokenFile = values.CONTRO1_AGENT_TOKEN_FILE?.trim();
  const token = values.CONTRO1_AGENT_TOKEN?.trim();
  if (!tokenFile && !token) return null;

  const cliEnv: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = host.env[key];
    if (value) cliEnv[key] = value;
  }
  if (tokenFile) cliEnv.CONTRO1_AGENT_TOKEN_FILE = tokenFile;
  else if (token) cliEnv.CONTRO1_AGENT_TOKEN = token;

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
  expires_at: string | null;
  created_at: string | null;
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
  const summary = card?.question || `NanoClaw ${label} for agent group ${row.agent_group_id ?? 'unknown'}`;

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
    tool_calls: [{ name: `nanoclaw.${row.action}`, arguments: row.payload ?? {}, outcome: 'pending_approval' }],
    metadata: { nanoclaw: { binding_hash: binding, card_title: card?.title ?? null } },
  };
}

export function externalRequestId(row: Pick<ApprovalRow, 'action' | 'approval_id'>): string {
  return `nanoclaw:${row.action}:${row.approval_id}`.replace(/[^A-Za-z0-9:._-]/g, '_').slice(0, 200);
}

// ── Ports ──

export interface Contro1Port {
  createRequest(body: Record<string, unknown>): Promise<string>;
  getRequest(requestId: string): Promise<Record<string, unknown>>;
  cancelRequest(requestId: string): Promise<void>;
  report(record: Record<string, unknown>): Promise<void>;
}

export interface NanoClawPort {
  /** The row, or null when NanoClaw no longer has it (resolved, expired or never an approval). */
  getApproval(approvalId: string): Promise<ApprovalRow | null>;
  listApprovals(): Promise<ApprovalRow[]>;
  listRoles(): Promise<RoleRow[]>;
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
      await this.safe(() => this.deps.contro1.cancelRequest(item.requestId!), 'cancel Contro1 request');
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
    );
    item.row = row;
    item.binding = binding;
    item.requestId = requestId;
    await this.audit(item, 'nanoclaw.approval.requested', 'success', `Routed NanoClaw ${row.action} approval to Contro1.`);
    return true;
  }

  private async settle(item: Tracked, onAction: ChannelSetup['onAction']): Promise<boolean> {
    const decision = classifyContro1Request(await this.deps.contro1.getRequest(item.requestId!));
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
        }),
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

  const runTick = async (): Promise<void> => {
    if (!setup) return;
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
      try {
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
      } catch (err) {
        deps.log.warn('Contro1 could not check approval routing coverage', { err: err instanceof Error ? err.message : String(err) });
      }
      try {
        const recovered = await governor.recover();
        if (recovered) deps.log.info('Contro1 re-tracked open approvals', { recovered });
      } catch (err) {
        deps.log.warn('Contro1 could not list open approvals at startup', { err: err instanceof Error ? err.message : String(err) });
      }
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

export function contro1CliPort(settings: Contro1NanoClawSettings): Contro1Port {
  const run = (args: string[], stdin?: unknown) =>
    runJson(settings.contro1Cli, [...args, ...(settings.apiUrl ? ['--api-url', settings.apiUrl] : []), '--format', 'json', '--quiet'], settings.cliEnv, stdin);
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
  };
}

export function nclPort(settings: Pick<Contro1NanoClawSettings, 'ncl'>, env: NodeJS.ProcessEnv): NanoClawPort {
  const [bin, ...prefix] = settings.ncl;
  const run = (args: string[]) => runJson(bin!, [...prefix, ...args, '--json'], env as Record<string, string>);
  return {
    async getApproval(approvalId) {
      const { json, stderr, code } = await run(['approvals', 'get', '--id', approvalId]);
      const frame = asRecord(json);
      if (frame?.ok === true) return normalizeRow(frame.data);
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
    .replace(/cco_cli_[A-Za-z0-9._-]+/g, 'cco_cli_[redacted]');
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

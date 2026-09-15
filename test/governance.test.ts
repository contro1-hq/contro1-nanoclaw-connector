import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChannelSetup } from '../nanoclaw/src/channels/adapter.js';
import {
  bindingFor,
  coverageReport,
  buildContro1Request,
  classifyContro1Request,
  createContro1Adapter,
  normalizeRow,
  parseApprovalCard,
  parseCardEdit,
  settingsFromEnv,
  type ApprovalRow,
  type Contro1NanoClawSettings,
  type Contro1Port,
  type NanoClawPort,
} from '../nanoclaw/src/channels/contro1-governance.js';

const HANDLE = 'approvals';
const APPROVER = `contro1:${HANDLE}`;

function settings(overrides: Partial<Contro1NanoClawSettings> = {}): Contro1NanoClawSettings {
  return {
    handle: HANDLE,
    contro1Cli: 'contro1',
    ncl: ['ncl'],
    pollIntervalMs: 60_000,
    expiryMinutes: 60,
    rowGraceMs: 20_000,
    cliEnv: {},
    ...overrides,
  };
}

/**
 * Behaves like NanoClaw v2.3.0's approvals module where it matters: only the
 * approver the card was routed to may resolve it (isAuthorizedApprovalClick),
 * a row resolves once and is then deleted (response-handler.ts).
 */
class FakeNanoClaw implements NanoClawPort {
  rows = new Map<string, ApprovalRow & { approver_user_id: string }>();
  outcomes: Array<{ id: string; value: string; userId: string }> = [];
  ignored: Array<{ id: string; reason: string }> = [];

  add(row: Partial<ApprovalRow> & { approval_id: string; action: string }): ApprovalRow {
    const full = {
      payload: { apt: [], npm: ['left-pad'] },
      status: 'pending',
      agent_group_id: null,
      session_id: 'sess-1',
      channel_type: 'contro1',
      platform_id: HANDLE,
      title: 'Install packages',
      expires_at: null,
      created_at: new Date().toISOString(),
      approver_user_id: APPROVER,
      ...row,
    } as ApprovalRow & { approver_user_id: string };
    this.rows.set(row.approval_id, full);
    return full;
  }

  async getApproval(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async listApprovals() {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }

  roles: Array<{ user_id: string; role: string; agent_group_id: string | null }> = [{ user_id: APPROVER, role: 'admin', agent_group_id: 'g1' }];
  async listRoles() {
    return this.roles;
  }

  onAction: ChannelSetup['onAction'] = (id, value, userId) => {
    const row = this.rows.get(id);
    if (!row) return this.ignored.push({ id, reason: 'unclaimed' }) as unknown as void;
    if (row.approver_user_id !== userId) return this.ignored.push({ id, reason: 'unauthorized' }) as unknown as void;
    this.rows.delete(id);
    this.outcomes.push({ id, value, userId });
  };
}

class FakeContro1 implements Contro1Port {
  requests = new Map<string, { body: Record<string, unknown>; state: string; status: string }>();
  byExternal = new Map<string, string>();
  cancelled: string[] = [];
  reports: Array<Record<string, unknown>> = [];
  failGet = false;

  async createRequest(body: Record<string, unknown>) {
    const ext = String(body.external_request_id);
    const existing = this.byExternal.get(ext);
    if (existing) return existing; // idempotent, like the API
    const id = `req_${this.requests.size + 1}`;
    this.requests.set(id, { body, state: 'queued', status: 'timed_out' });
    this.byExternal.set(ext, id);
    return id;
  }
  async getRequest(id: string) {
    if (this.failGet) throw new Error('contro1 CLI exited with 7');
    const r = this.requests.get(id)!;
    return { id, state: r.state, status: r.status };
  }
  async cancelRequest(id: string) {
    this.cancelled.push(id);
  }
  async report(record: Record<string, unknown>) {
    this.reports.push(record);
  }
  decide(id: string, status: 'approved' | 'denied') {
    const r = this.requests.get(id)!;
    r.state = 'callback_delivered';
    r.status = status;
  }
  events() {
    return this.reports.map((r) => r.action);
  }
}

const silent = { info() {}, warn() {}, error() {} };

function card(questionId: string, title = 'Install packages') {
  return {
    kind: 'chat-sdk',
    content: {
      type: 'ask_question',
      questionId,
      title,
      question: 'Agent "main" wants to install npm: left-pad',
      options: [
        { label: 'Approve', value: 'approve' },
        { label: 'Reject', value: 'reject' },
        { label: 'Reject with reason', value: 'reject_with_reason' },
      ],
    },
  };
}

function rig(opts: { now?: () => number; s?: Partial<Contro1NanoClawSettings> } = {}) {
  const nanoclaw = new FakeNanoClaw();
  const contro1 = new FakeContro1();
  const adapter = createContro1Adapter({ settings: settings(opts.s), contro1, nanoclaw, log: silent });
  const governor = adapter.governor;
  const tick = () => governor.tick(nanoclaw.onAction);
  return { nanoclaw, contro1, adapter, governor, tick };
}

test('settings require an Agent Credential and never accept CONTRO1_TOKEN', () => {
  const host = { cwd: '/opt/nanoclaw', env: { PATH: '/usr/bin', CONTRO1_TOKEN: 'cco_cli_live_dev' } };
  assert.equal(settingsFromEnv({}, host), null, 'no credential means the channel does not start');
  assert.equal(settingsFromEnv({ CONTRO1_API_URL: 'https://api.contro1.com' }, host), null);

  const s = settingsFromEnv({ CONTRO1_AGENT_TOKEN_FILE: '/etc/contro1/token' }, host)!;
  assert.deepEqual(s.cliEnv, { PATH: '/usr/bin', CONTRO1_AGENT_TOKEN_FILE: '/etc/contro1/token' });
  assert.equal('CONTRO1_TOKEN' in s.cliEnv, false, "the developer's CLI login is never handed to the bridge");
  assert.deepEqual(s.ncl, ['/opt/nanoclaw/bin/ncl']);
  assert.equal(s.handle, 'approvals');
  assert.throws(() => settingsFromEnv({ CONTRO1_AGENT_TOKEN: 'cc_live_x', CONTRO1_NANOCLAW_HANDLE: 'a b' }, host));
});

test('cards and card edits parse from the shapes NanoClaw delivers', () => {
  const parsed = parseApprovalCard(card('appr-1') as any)!;
  assert.equal(parsed.questionId, 'appr-1');
  assert.deepEqual(parsed.optionValues, ['approve', 'reject', 'reject_with_reason']);
  assert.equal(parseApprovalCard({ kind: 'chat', content: { text: 'hello' } }), null);

  const edit = parseCardEdit({
    kind: 'chat-sdk',
    content: { operation: 'edit', messageId: 'contro1-card:appr-1', text: 'x', terminalCard: { resolution: 'Timed out' } },
  })!;
  assert.deepEqual(edit, { questionId: 'appr-1', resolution: 'Timed out' });
  assert.equal(parseCardEdit({ kind: 'chat-sdk', content: { operation: 'edit', messageId: 'slack-123' } }), null);
});

test('binding covers every recorded fact and ignores display text', () => {
  const row = normalizeRow({
    approval_id: 'appr-1',
    action: 'install_packages',
    payload: '{"npm":["left-pad"]}',
    status: 'pending',
    session_id: 's1',
    title: 'Install packages',
  })!;
  const bound = bindingFor(row);
  assert.equal(bindingFor({ ...row, payload: { npm: ['left-pad'] } }), bound, 'payload JSON string and object bind the same');
  for (const changed of [
    { ...row, payload: { npm: ['evil'] } },
    { ...row, action: 'add_mcp_server' },
    { ...row, session_id: 's2' },
    { ...row, agent_group_id: 'g2' },
    { ...row, approval_id: 'appr-2' },
    { ...row, title: 'Other' },
  ]) {
    assert.notEqual(bindingFor(changed), bound, JSON.stringify(changed));
  }
  assert.equal(bindingFor({ ...row, expires_at: '2030-01-01T00:00:00Z', status: 'approved' }), bound);
});

test('Contro1 decision classification: state says whether, status says what', () => {
  assert.equal(classifyContro1Request({ state: 'assigned', status: 'timed_out' }), 'pending');
  assert.equal(classifyContro1Request({ state: 'callback_failed', status: 'approved' }), 'approved');
  assert.equal(classifyContro1Request({ state: 'answered', status: 'resolved' }), 'denied');
  assert.equal(classifyContro1Request({ state: 'expired', status: 'timed_out' }), 'timed_out');
});

test('request body carries machine facts, NanoClaw expiry and a deterministic id', () => {
  const row = normalizeRow({ approval_id: 'appr-9', action: 'onecli_credential', payload: { host: 'api.github.com' }, status: 'pending', expires_at: '2030-01-01T00:00:00.000Z', agent_group_id: 'g1' })!;
  const body = buildContro1Request({ row, binding: bindingFor(row), settings: { expiryMinutes: 60, requiredRole: 'security' }, now: new Date(0) });
  assert.equal(body.external_request_id, 'nanoclaw:onecli_credential:appr-9');
  assert.deepEqual(body.continuation, { mode: 'decision', expires_at: '2030-01-01T00:00:00.000Z' });
  assert.equal((body.routing as any).required_role, 'security');
  assert.equal((body.context as any).machine_observed.binding_hash, bindingFor(row));
  assert.equal('actor' in body, false, 'agent identity comes from the credential, never the body');

  const selfMod = normalizeRow({ approval_id: 'appr-10', action: 'install_packages', payload: {}, status: 'pending' })!;
  const b2 = buildContro1Request({ row: selfMod, binding: bindingFor(selfMod), settings: { expiryMinutes: 60 }, now: new Date(0) });
  assert.equal((b2.continuation as any).expires_at, new Date(60 * 60_000).toISOString());
});

test('approved in Contro1 clicks approve as the routed approver, exactly once', async () => {
  const { nanoclaw, contro1, adapter, tick } = rig();
  nanoclaw.add({ approval_id: 'appr-1', action: 'install_packages' });

  const messageId = await adapter.deliver(HANDLE, null, card('appr-1'));
  assert.equal(messageId, 'contro1-card:appr-1');
  await tick();
  assert.equal(contro1.requests.size, 1);

  await tick();
  assert.equal(nanoclaw.outcomes.length, 0, 'nothing is clicked before a human decides');

  contro1.decide('req_1', 'approved');
  await tick();
  await tick();
  assert.deepEqual(nanoclaw.outcomes, [{ id: 'appr-1', value: 'approve', userId: APPROVER }]);
  assert.deepEqual(nanoclaw.ignored, [], 'the click is authorized by NanoClaw');
  assert.deepEqual(contro1.events(), ['nanoclaw.approval.requested', 'nanoclaw.approval.approved']);
});

test('denied in Contro1 rejects in NanoClaw', async () => {
  const { nanoclaw, contro1, adapter, tick } = rig();
  nanoclaw.add({ approval_id: 'appr-2', action: 'add_mcp_server' });
  await adapter.deliver(HANDLE, null, card('appr-2', 'Add MCP server'));
  await tick();
  contro1.decide('req_1', 'denied');
  await tick();
  assert.deepEqual(nanoclaw.outcomes, [{ id: 'appr-2', value: 'reject', userId: APPROVER }]);
  assert.ok(contro1.events().includes('nanoclaw.approval.denied'));
});

test('an approval that changed after the reviewer saw it is rejected, not approved', async () => {
  const { nanoclaw, contro1, adapter, tick } = rig();
  nanoclaw.add({ approval_id: 'appr-3', action: 'install_packages', payload: { npm: ['left-pad'] } });
  await adapter.deliver(HANDLE, null, card('appr-3'));
  await tick();
  nanoclaw.rows.get('appr-3')!.payload = { npm: ['left-pad', 'evil-package'] };
  contro1.decide('req_1', 'approved');
  await tick();
  assert.deepEqual(nanoclaw.outcomes, [{ id: 'appr-3', value: 'reject', userId: APPROVER }]);
  assert.ok(contro1.events().includes('nanoclaw.approval.binding_mismatch'));
});

test('an approval NanoClaw already closed is never clicked', async () => {
  const { nanoclaw, contro1, adapter, tick } = rig();
  nanoclaw.add({ approval_id: 'appr-4', action: 'onecli_credential' });
  await adapter.deliver(HANDLE, null, card('appr-4', 'Credentials Request'));
  await tick();
  nanoclaw.rows.get('appr-4')!.status = 'expired';
  contro1.decide('req_1', 'approved');
  await tick();
  assert.equal(nanoclaw.outcomes.length, 0);
  assert.ok(contro1.events().includes('nanoclaw.approval.expired'));
});

test('NanoClaw timing out the card cancels the Contro1 request', async () => {
  const { nanoclaw, contro1, adapter, governor, tick } = rig();
  nanoclaw.add({ approval_id: 'appr-5', action: 'onecli_credential' });
  await adapter.deliver(HANDLE, null, card('appr-5', 'Credentials Request'));
  await tick();
  await adapter.deliver(HANDLE, null, {
    kind: 'chat-sdk',
    content: { operation: 'edit', messageId: 'contro1-card:appr-5', text: 'Timed out', terminalCard: { resolution: 'Timed out - no response' } },
  });
  assert.deepEqual(contro1.cancelled, ['req_1']);
  assert.equal(governor.size, 0);
  contro1.decide('req_1', 'approved');
  await tick();
  assert.equal(nanoclaw.outcomes.length, 0, 'a late approval for a closed card does nothing');
});

test('OneCLI delivers before writing its row: the card waits, then routes', async () => {
  let now = 1_000_000;
  const nanoclaw = new FakeNanoClaw();
  const contro1 = new FakeContro1();
  const adapter = createContro1Adapter({ settings: settings(), contro1, nanoclaw, log: silent });
  (adapter.governor as any).deps.now = () => now;

  await adapter.deliver(HANDLE, null, card('appr-6', 'Credentials Request'));
  await adapter.governor.tick(nanoclaw.onAction);
  assert.equal(contro1.requests.size, 0);
  assert.equal(adapter.governor.size, 1, 'still tracked while the row is expected');

  nanoclaw.add({ approval_id: 'appr-6', action: 'onecli_credential' });
  now += 1000;
  await adapter.governor.tick(nanoclaw.onAction);
  assert.equal(contro1.requests.size, 1);
});

test('a card with no approval row is reported as not governed after the grace period', async () => {
  let now = 1_000_000;
  const nanoclaw = new FakeNanoClaw();
  const contro1 = new FakeContro1();
  const adapter = createContro1Adapter({ settings: settings(), contro1, nanoclaw, log: silent });
  (adapter.governor as any).deps.now = () => now;
  await adapter.deliver(HANDLE, null, card('channel-reg-1', 'New channel'));
  now += 30_000;
  await adapter.governor.tick(nanoclaw.onAction);
  assert.equal(adapter.governor.size, 0);
  assert.deepEqual(contro1.events(), ['nanoclaw.approval.not_governed']);
  assert.equal(nanoclaw.outcomes.length, 0);
});

test('restart recovery re-tracks open rows and reuses the existing Contro1 request', async () => {
  const nanoclaw = new FakeNanoClaw();
  const contro1 = new FakeContro1();
  const first = createContro1Adapter({ settings: settings(), contro1, nanoclaw, log: silent });
  nanoclaw.add({ approval_id: 'appr-7', action: 'install_packages' });
  nanoclaw.add({ approval_id: 'other-1', action: 'install_packages', channel_type: 'telegram', platform_id: '123' });
  await first.deliver(HANDLE, null, card('appr-7'));
  await first.governor.tick(nanoclaw.onAction);
  assert.equal(contro1.requests.size, 1);

  // Host restarts: in-memory state is gone, NanoClaw's row and the Contro1 request remain.
  const second = createContro1Adapter({ settings: settings(), contro1, nanoclaw, log: silent });
  assert.equal(await second.governor.recover(), 1, 'only rows routed to this approver');
  await second.governor.tick(nanoclaw.onAction);
  assert.equal(contro1.requests.size, 1, 'no duplicate request after restart');
  contro1.decide('req_1', 'approved');
  await second.governor.tick(nanoclaw.onAction);
  assert.deepEqual(nanoclaw.outcomes, [{ id: 'appr-7', value: 'approve', userId: APPROVER }]);
});

test('a Contro1 outage leaves approvals unresolved and retries', async () => {
  const { nanoclaw, contro1, adapter, tick } = rig();
  nanoclaw.add({ approval_id: 'appr-8', action: 'install_packages' });
  await adapter.deliver(HANDLE, null, card('appr-8'));
  await tick();
  contro1.decide('req_1', 'approved');
  contro1.failGet = true;
  const result = await tick();
  assert.equal(result.failed, 1);
  assert.equal(nanoclaw.outcomes.length, 0, 'an unreadable decision is never treated as approval');
  contro1.failGet = false;
  await tick();
  assert.equal(nanoclaw.outcomes.length, 1);
});

test('overlapping ticks cannot click twice', async () => {
  const { nanoclaw, contro1, adapter, governor } = rig();
  nanoclaw.add({ approval_id: 'appr-9', action: 'install_packages' });
  await adapter.deliver(HANDLE, null, card('appr-9'));
  await governor.tick(nanoclaw.onAction);
  contro1.decide('req_1', 'approved');
  await Promise.all([governor.tick(nanoclaw.onAction), governor.tick(nanoclaw.onAction), governor.tick(nanoclaw.onAction)]);
  assert.equal(nanoclaw.outcomes.length, 1);
});

test('deliveries to other platform ids and plain chat are ignored', async () => {
  const { adapter, governor } = rig();
  assert.equal(await adapter.deliver('someone-else', null, card('appr-x')), undefined);
  assert.equal(await adapter.deliver(HANDLE, null, { kind: 'chat', content: { text: 'Your install was approved' } }), undefined);
  assert.equal(governor.size, 0);
});

test('the registration file registers the contro1 channel and stays off without a credential', async () => {
  const { stubEnv } = await import('../nanoclaw/src/env.js');
  const { registered } = await import('../nanoclaw/src/channels/channel-registry.js');
  await import('../nanoclaw/src/channels/contro1.js');
  const registration = registered.get('contro1');
  assert.ok(registration, 'contro1 channel registered');
  assert.equal(registration!.factory(), null, 'no credential: NanoClaw skips the channel');

  stubEnv.CONTRO1_AGENT_TOKEN_FILE = '/etc/contro1/token';
  const adapter = (await registration!.factory()) as any;
  assert.equal(adapter.channelType, 'contro1');
  assert.equal(adapter.supportsThreads, false);
  assert.equal(adapter.openDM, undefined, 'direct-addressable: the handle is the DM platform id');
  delete stubEnv.CONTRO1_AGENT_TOKEN_FILE;
});

test('coverage report names approvers who can receive approvals outside Contro1', () => {
  const none = coverageReport([{ user_id: 'telegram:42', role: 'owner', agent_group_id: null }], APPROVER);
  assert.equal(none.isApprover, false);

  const report = coverageReport(
    [
      { user_id: APPROVER, role: 'admin', agent_group_id: 'g1' },
      { user_id: 'telegram:42', role: 'owner', agent_group_id: null },
    ],
    APPROVER,
  );
  assert.equal(report.isApprover, true);
  assert.deepEqual(report.scopedGroups, ['g1']);
  assert.deepEqual(report.otherApprovers, [{ user_id: 'telegram:42', role: 'owner', agent_group_id: null, platform: 'telegram' }]);
});

test('setup logs an error when Contro1 holds no approver role', async () => {
  const nanoclaw = new FakeNanoClaw();
  nanoclaw.roles = [{ user_id: 'telegram:42', role: 'owner', agent_group_id: null }];
  const errors: string[] = [];
  const adapter = createContro1Adapter({
    settings: settings(),
    contro1: new FakeContro1(),
    nanoclaw,
    log: { info() {}, warn() {}, error: (msg: string) => void errors.push(msg) },
  });
  await adapter.setup({ onAction: nanoclaw.onAction, onInbound() {}, onInboundEvent() {}, onMetadata() {} });
  await adapter.teardown();
  assert.deepEqual(errors, ['Contro1 is not an approver: no NanoClaw approval can reach it']);
});
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
  waitForNanoClaw,
  withAgentGroup,
  reviewerView,
  type ApprovalRow,
  type Contro1NanoClawSettings,
  type Contro1Port,
  type NanoClawPort,
  withOrigin,
  ReachWatcher,
  reachDigest,
  isSharedSurface,
  type ReachContext,
  originFacts,
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
    mappingFile: '/test/contro1-connections.json',
    ...overrides,
  };
}

/**
 * Behaves like NanoClaw v2.3.0's approvals module where it matters: only the
 * approver the card was routed to may resolve it (isAuthorizedApprovalClick),
 * a row resolves once and is then deleted (response-handler.ts).
 */
class FakeNanoClawReachBase {
  reachByGroup: Record<string, ReachContext[]> = {};
  reachError: Error | null = null;
  async listReach(agentGroupId: string): Promise<ReachContext[]> {
    if (this.reachError) throw this.reachError;
    return this.reachByGroup[agentGroupId] ?? [];
  }
}

class FakeNanoClaw extends FakeNanoClawReachBase implements NanoClawPort {
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

class FakeContro1Base {
  declaredReach: Array<{ contexts: ReachContext[]; group: string | null }> = [];
  declareReachError: Error | null = null;
  connectedGroups: string[] = [];
  connectedAgentGroups(): string[] { return this.connectedGroups; }
  async declareReach(contexts: ReachContext[], scope: { agent_group_id?: string | null }): Promise<void> {
    if (this.declareReachError) throw this.declareReachError;
    this.declaredReach.push({ contexts, group: scope.agent_group_id ?? null });
  }
}

class FakeContro1 extends FakeContro1Base implements Contro1Port {
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

test('settings require a broker mapping and reject static credentials', () => {
  const host = { cwd: '/opt/nanoclaw', env: { PATH: '/usr/bin', CONTRO1_TOKEN: 'cco_cli_live_dev' } };
  assert.equal(settingsFromEnv({}, host), null, 'no mapping means the channel does not start');
  assert.equal(settingsFromEnv({ CONTRO1_API_URL: 'https://api.contro1.com' }, host), null);

  const s = settingsFromEnv({ CONTRO1_PLATFORM_MAPPING_FILE: '/etc/contro1/nanoclaw.json' }, { ...host, env: { PATH: '/usr/bin' } })!;
  assert.deepEqual(s.cliEnv, { PATH: '/usr/bin' });
  assert.equal(s.mappingFile, '/etc/contro1/nanoclaw.json');
  assert.deepEqual(s.ncl, ['/opt/nanoclaw/bin/ncl']);
  assert.equal(s.handle, 'approvals');
  assert.throws(() => settingsFromEnv({ CONTRO1_PLATFORM_MAPPING_FILE: '/m.json', CONTRO1_AGENT_TOKEN: 'cc_live_x' }, host), /Static Contro1 credentials/);
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

test('the registration file registers the contro1 channel and stays off without a mapping', async () => {
  const { stubEnv } = await import('../nanoclaw/src/env.js');
  const { registered } = await import('../nanoclaw/src/channels/channel-registry.js');
  await import('../nanoclaw/src/channels/contro1.js');
  const registration = registered.get('contro1');
  assert.ok(registration, 'contro1 channel registered');
  assert.equal(registration!.factory(), null, 'no mapping: NanoClaw skips the channel');

  stubEnv.CONTRO1_PLATFORM_MAPPING_FILE = '/etc/contro1/nanoclaw.json';
  const adapter = (await registration!.factory()) as any;
  assert.equal(adapter.channelType, 'contro1');
  assert.equal(adapter.supportsThreads, false);
  assert.equal(adapter.openDM, undefined, 'direct-addressable: the handle is the DM platform id');
  delete stubEnv.CONTRO1_PLATFORM_MAPPING_FILE;
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
  // The coverage check runs on the first tick, not inside setup.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await adapter.teardown();
  assert.deepEqual(errors, ['Contro1 is not an approver: no NanoClaw approval can reach it']);
});

// Seen on the first live install: every card went to Contro1 and none arrived,
// because the request body broke the API schema at tool_calls.
test('the request body uses the API tool call shape', () => {
  const row = normalizeRow({
    approval_id: 'appr-1', action: 'install_packages', status: 'pending', session_id: 's1', agent_group_id: 'g1',
    payload: JSON.stringify({ apt: [], npm: ['left-pad'] }), channel_type: 'contro1', platform_id: 'approvals', title: 'Install packages',
  })!;
  const body = buildContro1Request({ row, binding: 'sha256:x', settings: { requiredRole: undefined, expiryMinutes: 60 }, now: new Date() });
  const calls = body.tool_calls as Array<Record<string, unknown>>;
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]!).sort(), ['input', 'name'], 'only fields the API accepts, and no outcome for something that has not run');
  assert.deepEqual(calls[0]!.input, { apt: [], npm: ['left-pad'] }, 'the stored JSON payload is sent as an object');
});

test('an approval without a group takes it from its session', async () => {
  const row = normalizeRow({ approval_id: 'appr-2', action: 'install_packages', status: 'pending', session_id: 'sess-9', agent_group_id: null, channel_type: 'contro1', platform_id: 'approvals' })!;
  const lookups: string[] = [];
  const enriched = await withAgentGroup(row, async (id) => { lookups.push(id); return 'ag-nano'; });
  assert.equal(enriched.agent_group_id, 'ag-nano');
  assert.deepEqual(lookups, ['sess-9']);
  const already = await withAgentGroup({ ...row, agent_group_id: 'g1' }, async () => 'other');
  assert.equal(already.agent_group_id, 'g1', 'a group NanoClaw recorded is never replaced');
});

test('start-up does not wait on NanoClaw and a card missed while it was down is picked up', async () => {
  const nanoclaw = new FakeNanoClaw();
  nanoclaw.roles = [{ user_id: APPROVER, role: 'admin', agent_group_id: 'g1' }];
  let socketUp = false;
  const listRoles = nanoclaw.listRoles.bind(nanoclaw);
  nanoclaw.listRoles = async () => { if (!socketUp) throw new Error('connect ENOENT /opt/nanoclaw/data/ncl.sock'); return listRoles(); };
  const warnings: string[] = [];
  const adapter = createContro1Adapter({
    settings: { ...settings(), pollIntervalMs: 5 },
    contro1: new FakeContro1(),
    nanoclaw,
    log: { info() {}, warn: (msg: string) => void warnings.push(msg), error() {} },
  });
  const started = Date.now();
  await adapter.setup({ onAction: nanoclaw.onAction, onInbound() {}, onInboundEvent() {}, onMetadata() {} });
  assert.ok(Date.now() - started < 50, 'setup returns at once');
  await new Promise((resolve) => setTimeout(resolve, 30));
  socketUp = true;
  await new Promise((resolve) => setTimeout(resolve, 60));
  await adapter.teardown();
  assert.deepEqual(warnings, [], 'the socket not being up yet is start-up order, not a warning');
});
test('owner-approved connections: each group uses its own endpoint and unknown groups are refused', async () => {
  const { contro1BrokerPort, settingsFromEnv: fromEnv } = await import('../nanoclaw/src/channels/contro1-governance.js');
  assert.throws(
    () => fromEnv({ CONTRO1_PLATFORM_MAPPING_FILE: '/m.json', CONTRO1_AGENT_TOKEN: 'cc_live_x' }, { cwd: '/x', env: {} }),
    /Static Contro1 credentials/,
    'a mapping and a shared credential are refused',
  );
  const settings = fromEnv({ CONTRO1_PLATFORM_MAPPING_FILE: '/m.json', CONTRO1_CLI: '/nonexistent/contro1' }, { cwd: '/x', env: { PATH: '/bin' } })!;
  assert.equal(settings.mappingFile, '/m.json');
  assert.equal(settings.cliEnv.CONTRO1_AGENT_TOKEN, undefined);

  const mapping = JSON.stringify({ schema_version: 1, entries: [{ platform_subject: 'g1', agent_id: 'agt_g1', endpoint: 'unix:///run/contro1/ep/g1.sock' }] });
  const port = contro1BrokerPort(settings, () => mapping);
  await assert.rejects(port.createRequest({}, { agent_group_id: null }), /no NanoClaw agent group/, 'no group, no identity');
  await assert.rejects(port.createRequest({}, { agent_group_id: 'g2' }), /not connected/, 'an unmapped group is refused, never defaulted');
  // A mapped group reaches the CLI (which does not exist here), proving the lookup passed.
  await assert.rejects(port.createRequest({}, { agent_group_id: 'g1' }), (err: unknown) => !/not connected|no NanoClaw agent group/.test(String(err)));
});

test('the mapping contro1 connect wrote is found without a manual .env step', () => {
  const host = { cwd: '/opt/nanoclaw', env: {}, platform: 'linux' as NodeJS.Platform, exists: (p: string) => p === '/etc/contro1/platforms/nanoclaw.json' };
  const settings = settingsFromEnv({}, host);
  assert.equal(settings?.mappingFile, '/etc/contro1/platforms/nanoclaw.json');
  assert.equal(settingsFromEnv({}, { ...host, exists: () => false }), null, 'no mapping anywhere still means the channel does not start');
  assert.equal(settingsFromEnv({ CONTRO1_PLATFORM_MAPPING_FILE: '/custom.json' }, host)?.mappingFile, '/custom.json', 'an explicit setting wins');
});

test('start-up waits for the NanoClaw admin socket instead of warning', async () => {
  let calls = 0;
  await waitForNanoClaw(async () => {
    calls += 1;
    if (calls < 3) throw new Error('connect ENOENT /opt/nanoclaw/data/ncl.sock');
  }, 5, 1);
  assert.equal(calls, 3);
  let other = 0;
  await waitForNanoClaw(async () => { other += 1; throw new Error('permission denied'); }, 5, 1);
  assert.equal(other, 1, 'a real failure is not retried');
});

// Seen on the first live install: a card recovered after a restart reached the
// reviewer as "NanoClaw Install packages for agent group ag-...", with the
// package list and the agent's reason nowhere on the screen.
test('the reviewer sees what the action does and why, even after a restart', () => {
  const row = normalizeRow({
    approval_id: 'appr-3', action: 'install_packages', status: 'pending', session_id: 's1', agent_group_id: 'ag-nano',
    payload: JSON.stringify({ apt: [], npm: ['left-pad'], reason: 'Ariel asked for left-pad.' }), channel_type: 'contro1', platform_id: 'approvals',
  })!;
  const body = buildContro1Request({ row, binding: 'sha256:x', settings: { requiredRole: undefined, expiryMinutes: 60 }, now: new Date() });
  assert.equal(body.description, "Install npm: left-pad and rebuild the agent's container", 'no card, and still a sentence a reviewer can decide on');
  const context = body.context as Record<string, any>;
  // No origin was resolved for this row, and that is stated rather than
  // omitted: a silent absence would read as an ordinary private request.
  assert.deepEqual(context.tool_input, { requested_from: 'unknown conversation', npm_packages: 'left-pad' });
  assert.equal(context.agent_reported.justification, 'Ariel asked for left-pad.', 'the reason is the agent’s claim, shown as such');
  assert.doesNotMatch(String(body.description), /for agent group ag-/u);

  const withCard = buildContro1Request({ row: { ...row, question: 'Agent "Nano" is attempting to install a package' }, binding: 'sha256:x', settings: { requiredRole: undefined, expiryMinutes: 60 }, now: new Date() });
  assert.match(String(withCard.description), /Agent "Nano"/u, 'NanoClaw’s own card text wins when it is available');
  assert.equal(bindingFor(row), bindingFor({ ...row, question: 'anything' }), 'the card text is display only and never bound');
});

test('every NanoClaw approval action gets a reviewer summary', () => {
  const view = (action: string, payload: Record<string, unknown>) => reviewerView({ action, payload, agent_group_id: 'g1' });
  assert.match(view('add_mcp_server', { name: 'github', command: 'npx', args: ['-y', 'gh-mcp'] }).summary, /Add the MCP server "github" \(npx -y gh-mcp\)/u);
  assert.match(view('create_agent', { name: 'researcher', instructions: 'find papers' }).summary, /sub-agent "researcher"/u);
  assert.match(view('onecli_credential', { method: 'POST', host: 'api.github.com', path: '/repos' }).summary, /POST api.github.com\/repos/u);
  assert.deepEqual(view('something_new', { target: 'x', count: 2 }).facts, { target: 'x', count: '2' });
});

// The scenario the origin exists for: one agent answering both a private sales
// conversation and a group chat with other people in it. The action is
// identical; only the room is different, and the reviewer has to see that.
test('the reviewer is told which conversation asked', async () => {
  const lookup = {
    sessionContext: async (id: string) => ({
      's-sales': { agent_group_id: 'ag-nano', messaging_group_id: 'mg-sales' },
      's-trip': { agent_group_id: 'ag-nano', messaging_group_id: 'mg-trip' },
    }[id] ?? null),
    messagingGroup: async (id: string) => ({
      'mg-sales': { name: 'Sales', is_group: false },
      'mg-trip': { name: 'Berlin trip', is_group: true },
    }[id] ?? null),
  };
  const row = (sessionId: string) => normalizeRow({
    approval_id: 'appr-' + sessionId, action: 'install_packages', status: 'pending',
    session_id: sessionId, agent_group_id: 'ag-nano', payload: '{}', channel_type: 'contro1', platform_id: 'approvals',
  })!;

  const sales = await withOrigin(row('s-sales'), lookup);
  assert.deepEqual(sales.origin, { context_id: 'mg-sales', label: 'Sales', kind: 'private' });
  assert.equal(originFacts(sales.origin).conversation, 'direct message');

  const trip = await withOrigin(row('s-trip'), lookup);
  assert.deepEqual(trip.origin, { context_id: 'mg-trip', label: 'Berlin trip', kind: 'shared' });
  assert.match(originFacts(trip.origin).conversation, /anyone in it can instruct/);
  assert.equal(originFacts(trip.origin).requested_from, 'Berlin trip');
});

test('an origin that cannot be resolved says so instead of disappearing', async () => {
  const row = normalizeRow({
    approval_id: 'appr-x', action: 'install_packages', status: 'pending', session_id: 's1',
    agent_group_id: 'ag-nano', payload: '{}', channel_type: 'contro1', platform_id: 'approvals',
  })!;

  // The conversation is known but unreadable: named, and explicitly unknown.
  const unreadable = await withOrigin(row, {
    sessionContext: async () => ({ agent_group_id: 'ag-nano', messaging_group_id: 'mg-1' }),
    messagingGroup: async () => null,
  });
  assert.deepEqual(unreadable.origin, { context_id: 'mg-1', kind: 'unknown' });
  assert.match(originFacts(unreadable.origin).conversation, /could not tell who can reach/);

  // A lookup that throws must not take the whole request down with it.
  const broken = await withOrigin(row, {
    sessionContext: async () => { throw new Error('ncl is down'); },
    messagingGroup: async () => null,
  });
  assert.equal(broken.origin, undefined);
  assert.equal(originFacts(broken.origin).requested_from, 'unknown conversation');
});

// The gap this closes: `contro1 connect` reads every conversation an agent
// answers in, completely, at that moment. What it cannot see is what happens
// next, and what happens next is NanoClaw asking in a DM whether to attach the
// main agent to a new group. That arrives weeks after anybody decided what the
// agent may reach, and answering it casually turns a private assistant into one
// a room can instruct.
test('a group added after connecting is noticed, and nothing is polled', async () => {
  const nano = new FakeNanoClaw();
  const contro1 = new FakeContro1();
  const log = { info() {}, warn() {}, error() {} };
  const watcher = new ReachWatcher({ nanoclaw: nano, contro1, log });

  // As connected: one direct message, and nothing to report.
  nano.reachByGroup['ag-nano'] = [
    { context_id: 'mg-dm', label: 'Ariel', kind: 'private', participants_known: true },
  ];
  assert.equal(await watcher.check('ag-nano'), 'ignored', 'a private agent has nothing to declare');
  assert.equal(contro1.declaredReach.length, 0);

  // Standing still costs nothing: no change, no request.
  assert.equal(await watcher.check('ag-nano'), 'unchanged');
  assert.equal(contro1.declaredReach.length, 0, 'an agent that did not move must not talk to the server');

  // Somebody answers "the main one" to NanoClaw's question.
  nano.reachByGroup['ag-nano'].push({ context_id: 'mg-trip', label: 'Berlin trip', kind: 'shared', participants_known: false });
  assert.equal(await watcher.check('ag-nano'), 'reported');
  assert.equal(contro1.declaredReach.length, 1);
  assert.equal(contro1.declaredReach[0]!.group, 'ag-nano', 'reported on the agent it is about');
  assert.deepEqual(
    contro1.declaredReach[0]!.contexts.map((c) => c.context_id).sort(),
    ['mg-dm', 'mg-trip'],
    'the whole reach is sent, not just the new room',
  );

  // And then it stops. One report per change, not one per tick.
  assert.equal(await watcher.check('ag-nano'), 'unchanged');
  assert.equal(contro1.declaredReach.length, 1);
});

test('what cannot be established never becomes a claim of privacy', async () => {
  const nano = new FakeNanoClaw();
  const contro1 = new FakeContro1();
  const log = { info() {}, warn() {}, error() {} };
  const watcher = new ReachWatcher({ nanoclaw: nano, contro1, log });

  // A read that failed is not a reach that changed. Saying nothing leaves
  // Contro1 with the last answer it trusted.
  nano.reachError = new Error('ncl is down');
  assert.equal(await watcher.check('ag-nano'), 'failed');
  assert.equal(contro1.declaredReach.length, 0);

  // A report that failed is retried, because it was never remembered.
  nano.reachError = null;
  nano.reachByGroup['ag-nano'] = [{ context_id: 'mg-trip', kind: 'shared', participants_known: false }];
  contro1.declareReachError = new Error('offline');
  assert.equal(await watcher.check('ag-nano'), 'failed');
  contro1.declareReachError = null;
  assert.equal(await watcher.check('ag-nano'), 'reported', 'a failed report must be tried again');
});

test('reach is only ever declared in the direction that tightens', () => {
  // An agent that leaves every group cannot talk its way back to private: the
  // server refuses that from an agent credential, and this does not pretend to.
  assert.equal(isSharedSurface([{ context_id: 'a', kind: 'private', participants_known: true }]), false);
  assert.equal(isSharedSurface([{ context_id: 'a', kind: 'shared', participants_known: false }]), true);
  assert.equal(isSharedSurface([{ context_id: 'a', kind: 'unknown', participants_known: true }]), true);
  // Private but open to unnamed people is still a surface more than one can reach.
  assert.equal(isSharedSurface([{ context_id: 'a', kind: 'private', participants_known: false }]), true);
  // Knowing nothing is not privacy.
  assert.equal(isSharedSurface([]), true);

  // The digest ignores ordering, so a reshuffle is not a change worth a request.
  const a: ReachContext[] = [
    { context_id: 'x', kind: 'private', participants_known: true },
    { context_id: 'y', kind: 'shared', participants_known: false },
  ];
  assert.equal(reachDigest(a), reachDigest([...a].reverse()));
  // A label is display only and must not cause traffic on its own.
  assert.equal(reachDigest(a), reachDigest(a.map((c) => ({ ...c, label: 'renamed' }))));
  // A kind change is exactly what must cause traffic.
  assert.notEqual(reachDigest(a), reachDigest([a[0]!, { ...a[1]!, kind: 'private' as const }]));
});

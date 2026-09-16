/**
 * End to end through the REAL `contro1` CLI binary and a fake `ncl`, against a
 * local stand-in for the Contro1 API. Proves the exact commands the channel
 * runs: --runtime identity, --api-url, the token read from a file, the
 * protocol body, and a decision flowing back into NanoClaw's onAction.
 *
 * Set CONTRO1_CLI_BIN to a built contro1 binary to run it; skipped otherwise.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  contro1BrokerPort,
  createContro1Adapter,
  nclPort,
  settingsFromEnv,
} from '../nanoclaw/src/channels/contro1-governance.js';

const CLI = process.env.CONTRO1_CLI_BIN;
const TOKEN = 'cc_test_nanoclaw_bridge_token';

type Seen = { method: string; path: string; auth: string | undefined; body: any };

function fakeContro1Api(opts: { credentialKind?: string } = {}) {
  const seen: Seen[] = [];
  const requests = new Map<string, { state: string; status: string; body: any }>();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    const path = (req.url || '').split('?')[0]!;
    seen.push({ method: req.method!, path, auth: req.headers.authorization, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized', message: 'bad token' });
    if (req.method === 'GET' && path === '/api/centcom/v1/runtime/status') {
      return send(200, {
        ok: true,
        org: { id: 'org1', name: 'Northbeam' },
        auth: {
          type: 'api_key',
          credential_kind: opts.credentialKind ?? 'agent_runtime',
          agent_id: 'agt_nanoclaw_host',
          scopes: ['requests:create', 'requests:read', 'requests:cancel_own', 'audit:write'],
        },
      });
    }
    if (req.method === 'POST' && path === '/api/centcom/v1/requests') {
      const id = `req_${requests.size + 1}`;
      requests.set(id, { state: 'queued', status: 'timed_out', body });
      return send(201, { id, request_id: id, state: 'queued' });
    }
    const match = path.match(/^\/api\/centcom\/v1\/requests\/([^/]+)$/);
    if (match && req.method === 'GET') {
      const r = requests.get(match[1]!);
      return r ? send(200, { id: match[1], state: r.state, status: r.status }) : send(404, { error: 'not_found', message: 'Request not found' });
    }
    if (match && req.method === 'DELETE') return send(200, { ok: true });
    if (req.method === 'POST' && path === '/api/centcom/v1/audit-records') return send(201, { id: `aud_${seen.length}` });
    return send(404, { error: 'not_found', message: path });
  });
  return { server, seen, requests };
}

const FAKE_NCL = `
import { readFileSync, existsSync } from 'node:fs';
const [, , stateFile, resource, verb, ...rest] = process.argv;
const rows = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const out = (frame, code) => { process.stdout.write(JSON.stringify(frame)); process.exit(code); };
if (resource === 'roles' && verb === 'list') out({ id: 'x', ok: true, data: [{ user_id: 'contro1:approvals', role: 'admin', agent_group_id: null }] }, 0);
if (resource !== 'approvals' || !rest.includes('--json')) out({ id: 'x', ok: false, error: { code: 'invalid-args', message: 'bad' } }, 1);
if (verb === 'get') {
  const id = rest[rest.indexOf('--id') + 1];
  rows[id] ? out({ id: 'x', ok: true, data: rows[id] }, 0) : out({ id: 'x', ok: false, error: { code: 'handler-error', message: 'approval not found: ' + id } }, 1);
}
if (verb === 'list') out({ id: 'x', ok: true, data: Object.values(rows) }, 0);
out({ id: 'x', ok: false, error: { code: 'unknown-command', message: verb } }, 1);
`;

test('full approval round trip through the real contro1 CLI', { skip: CLI ? false : 'set CONTRO1_CLI_BIN to run' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'contro1-nanoclaw-'));
  const api = fakeContro1Api();
  api.server.listen(0);
  await new Promise<void>((r) => api.server.once('listening', () => r()));
  try {
    const apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    const tokenFile = join(dir, 'agent.token');
    writeFileSync(tokenFile, `${TOKEN}\n`);
    const stateFile = join(dir, 'approvals.json');
    const nclScript = join(dir, 'ncl.mjs');
    writeFileSync(nclScript, FAKE_NCL);

    const settings = settingsFromEnv(
      { CONTRO1_PLATFORM_MAPPING_FILE: join(dir, 'connections.json'), CONTRO1_API_URL: apiUrl, CONTRO1_CLI: CLI!, CONTRO1_REQUIRED_ROLE: 'security' },
      // HOME points at an empty dir: no keychain profile exists to fall back to.
      { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, SystemRoot: process.env.SystemRoot } },
    )!;
    settings.ncl = [process.execPath, nclScript, stateFile];

    const rows: Record<string, unknown> = {
      'appr-100': {
        approval_id: 'appr-100',
        action: 'install_packages',
        payload: JSON.stringify({ apt: [], npm: ['left-pad'] }),
        status: 'pending',
        session_id: 'sess-1',
        agent_group_id: null,
        channel_type: 'contro1',
        platform_id: 'approvals',
        title: 'Install packages',
        expires_at: null,
      },
    };
    writeFileSync(stateFile, JSON.stringify(rows));

    const clicks: Array<[string, string, string]> = [];
    writeFileSync(settings.mappingFile, JSON.stringify({ schema_version: 1, entries: [{ platform_subject: 'g1', agent_id: 'agt_g1', endpoint: 'http://127.0.0.1:1' }] }));
    const adapter = createContro1Adapter({
      settings,
      contro1: contro1BrokerPort(settings),
      nanoclaw: nclPort(settings, { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' }),
      log: { info() {}, warn() {}, error() {} },
    });
    const onAction = (id: string, value: string, userId: string) => void clicks.push([id, value, userId]);

    await adapter.deliver('approvals', null, {
      kind: 'chat-sdk',
      content: { type: 'ask_question', questionId: 'appr-100', title: 'Install packages', question: 'Install npm: left-pad?', options: [{ label: 'Approve', value: 'approve' }] },
    });
    const opened = await adapter.governor.tick(onAction);
    assert.equal(opened.failed, 0, 'CLI calls succeeded');
    assert.equal(opened.requested, 1);

    const created = api.seen.find((s) => s.method === 'POST' && s.path === '/api/centcom/v1/requests')!;
    assert.ok(created, 'request reached the API through the CLI');
    assert.equal(created.auth, `Bearer ${TOKEN}`, 'token came from CONTRO1_AGENT_TOKEN_FILE');
    assert.equal(created.body.external_request_id, 'nanoclaw:install_packages:appr-100');
    assert.equal(created.body.request_type, 'approval', 'protocol body sent unchanged');
    assert.equal(created.body.routing.required_role, 'security');
    assert.deepEqual(created.body.context.machine_observed.payload, { apt: [], npm: ['left-pad'] });
    const statusChecks = api.seen.filter((s) => s.path === '/api/centcom/v1/runtime/status').length;
    assert.ok(statusChecks >= 1, '--runtime confirmed an agent_runtime credential before acting');

    // Nothing is clicked while the request is open.
    await adapter.governor.tick(onAction);
    assert.deepEqual(clicks, []);

    api.requests.get('req_1')!.state = 'callback_delivered';
    api.requests.get('req_1')!.status = 'approved';
    await adapter.governor.tick(onAction);
    assert.deepEqual(clicks, [['appr-100', 'approve', 'contro1:approvals']]);

    const audits = api.seen.filter((s) => s.path === '/api/centcom/v1/audit-records').map((s) => s.body.action);
    assert.deepEqual(audits, ['nanoclaw.approval.requested', 'nanoclaw.approval.approved']);
    assert.equal(readFileSync(tokenFile, 'utf8').trim(), TOKEN);
  } finally {
    api.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real CLI refuses an org-wide key: no request is created', { skip: CLI ? false : 'set CONTRO1_CLI_BIN to run' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'contro1-nanoclaw-'));
  const api = fakeContro1Api({ credentialKind: 'organization_integration' });
  api.server.listen(0);
  await new Promise<void>((r) => api.server.once('listening', () => r()));
  try {
    const apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    const settings = settingsFromEnv(
      { CONTRO1_AGENT_TOKEN: TOKEN, CONTRO1_API_URL: apiUrl, CONTRO1_CLI: CLI! },
      { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, SystemRoot: process.env.SystemRoot } },
    )!;
    await assert.rejects(contro1BrokerPort(settings).createRequest({ title: 't', request_type: 'approval', source: { integration: 'nanoclaw' }, continuation: { mode: 'decision' } }, { agent_group_id: 'g1' }));
    assert.equal(api.seen.some((s) => s.method === 'POST'), false, 'refused before any write');
  } finally {
    api.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

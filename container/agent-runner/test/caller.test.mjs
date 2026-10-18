/**
 * Deterministic agent-loop integration test. The model is a scripted local
 * Anthropic-compatible SSE fixture; the real Agent SDK/CLI dispatches MCP tools.
 * Run only in an isolated runtime with empty /workspace/group and /workspace/ipc:
 *   npm run build
 *   NANOCLAW_CALLER_TEST=1 node --test test/caller.test.mjs
 * No Anthropic or Parallel network access/credentials are needed.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const enabled = process.env.NANOCLAW_CALLER_TEST === '1';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const group = '/workspace/group';
const ipc = '/workspace/ipc/input';
const sourceUrl = 'https://example.org/nanoclaw-caller-fixture';
const userAgent = 'NanoClaw (https://nanoclaw.dev)';
let scratch;
let runtime;
let uid;
let gid;
const createdDirectories = [];
const originalOwnership = [];
let fixturePrepared = false;

async function ownTree(file) {
  if (uid === undefined) return;
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink()) return;
  await fs.chown(file, uid, gid);
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(file))
      await ownTree(path.join(file, entry));
  }
}

before(async () => {
  if (!enabled) return;
  // Do not run against an active user's workspace or inherit saved credentials.
  // The input directory may already exist in a freshly built image, but no
  // other IPC state is safe to share with a test.
  for (const directory of [group, path.dirname(ipc), ipc]) {
    try {
      const entries = await fs.readdir(directory);
      assert.deepEqual(
        directory === path.dirname(ipc)
          ? entries.filter((entry) => entry !== 'input')
          : entries,
        [],
        `${directory} must be empty`,
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(directory, { recursive: true });
      createdDirectories.push(directory);
    }
  }
  if (process.getuid?.() === 0) {
    uid = 65534;
    gid = 65534;
  }
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nanoclaw-caller-'));
  runtime = path.join(scratch, 'app');
  await fs.mkdir(runtime);
  await fs.cp(path.join(app, 'dist'), path.join(runtime, 'dist'), {
    recursive: true,
  });
  await fs.copyFile(
    path.join(app, 'package.json'),
    path.join(runtime, 'package.json'),
  );
  // A private copy also permits dropping root in restrictive checkouts.
  await fs.cp(
    path.join(app, 'node_modules'),
    path.join(runtime, 'node_modules'),
    { recursive: true, verbatimSymlinks: true },
  );
  await ownTree(scratch);
  if (uid !== undefined) {
    for (const directory of [group, path.dirname(ipc), ipc]) {
      const stat = await fs.stat(directory);
      if (stat.uid !== uid || stat.gid !== gid) {
        await fs.chown(directory, uid, gid);
        originalOwnership.push({ directory, uid: stat.uid, gid: stat.gid });
      }
    }
  }
  fixturePrepared = true;
});

after(async () => {
  if (!enabled) return;
  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  if (fixturePrepared) await fs.rm(path.join(ipc, '_close'), { force: true });
  for (const directory of createdDirectories.reverse())
    await fs.rmdir(directory);
  if (uid !== undefined) {
    for (const original of originalOwnership.reverse()) {
      if (!createdDirectories.includes(original.directory)) {
        await fs.chown(original.directory, original.uid, original.gid);
      }
    }
  }
});

async function readJson(request) {
  let text = '';
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : {};
}

async function listen(handler) {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.writeHead(500).end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function sendMessage(response, content, stopReason) {
  const event = (type, data) =>
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
    );
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  event('message_start', {
    message: {
      id: `msg_${Math.random().toString(16).slice(2)}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  event('content_block_start', {
    index: 0,
    content_block:
      content.type === 'tool_use'
        ? { ...content, input: {} }
        : { type: 'text', text: '' },
  });
  event('content_block_delta', {
    index: 0,
    delta:
      content.type === 'tool_use'
        ? {
            type: 'input_json_delta',
            partial_json: JSON.stringify(content.input),
          }
        : { type: 'text_delta', text: content.text },
  });
  event('content_block_stop', { index: 0 });
  event('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  event('message_stop', {});
  response.end();
}

async function exercise(mode) {
  await fs.rm(path.join(ipc, '_close'), { force: true });
  const home = path.join(scratch, `home-${mode}`);
  await fs.mkdir(home);
  await ownTree(home);
  const observations = [];
  const modelRequests = [];
  let callStarted;
  const pendingCall = new Promise((resolve) => {
    callStarted = resolve;
  });
  let disconnected = false;
  const mcp = await listen(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const body = await readJson(request);
    observations.push({
      destination: request.url,
      userAgent: request.headers['user-agent'],
      authorization: request.headers.authorization,
      method: body.method,
      params: body.params,
    });
    const answer = (result) =>
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    if (body.method === 'initialize') {
      answer({
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'scripted-search-fixture', version: '1.0.0' },
      });
    } else if (body.method === 'tools/list') {
      answer({
        tools: [
          {
            name: 'web_search',
            description: 'Search for sources.',
            inputSchema: {
              type: 'object',
              properties: {
                objective: { type: 'string' },
                search_queries: { type: 'array', items: { type: 'string' } },
                session_id: { type: 'string' },
              },
              required: ['objective', 'search_queries'],
            },
          },
          {
            name: 'web_fetch',
            description: 'Fetch a source URL.',
            inputSchema: {
              type: 'object',
              properties: {
                urls: { type: 'array', items: { type: 'string' } },
                session_id: { type: 'string' },
              },
              required: ['urls'],
            },
          },
        ],
      });
    } else if (body.method === 'tools/call') {
      callStarted();
      if (mode === 'timeout' || mode === 'cancel') {
        response.on('close', () => {
          disconnected = true;
        });
        return; // Deliberately leave the real MCP call pending.
      }
      if (mode === 'error') {
        answer({
          isError: true,
          content: [
            { type: 'text', text: 'Fixture search service unavailable' },
          ],
        });
      } else {
        answer({
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                body.params.name === 'web_search'
                  ? {
                      results: [
                        {
                          url: sourceUrl,
                          title: 'Fixture source',
                          excerpts: ['Source discovered by fixture search.'],
                        },
                      ],
                    }
                  : {
                      results: [
                        {
                          url: sourceUrl,
                          content: 'Fixture fetched source: the answer is 42.',
                        },
                      ],
                    },
              ),
            },
          ],
        });
      }
    } else {
      response.writeHead(202).end();
    }
  });
  let turn = 0;
  const model = await listen(async (request, response) => {
    const body = await readJson(request);
    if (request.url?.includes('count_tokens')) {
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end('{"input_tokens":100}');
      return;
    }
    modelRequests.push(body);
    const serialized = JSON.stringify(body.messages);
    if (turn === 0) {
      assert.ok(
        body.tools.some(
          (tool) => tool.name === 'mcp__parallel-search__web_search',
        ),
        'actual model request advertises the selected MCP server',
      );
      assert.ok(
        !body.tools.some((tool) =>
          ['WebSearch', 'WebFetch'].includes(tool.name),
        ),
        'builtins are disallowed',
      );
      sendMessage(
        response,
        {
          type: 'tool_use',
          id: 'tool_search_fixture',
          name: 'mcp__parallel-search__web_search',
          input: {
            objective: 'Find the fixture answer',
            search_queries: ['nanoclaw fixture source answer'],
            session_id: 'e641d94e-1d19-43f6-9960-cf827a6c21c1',
          },
        },
        'tool_use',
      );
    } else if (mode === 'normal' && turn === 1) {
      assert.ok(
        serialized.includes(sourceUrl),
        'search result reaches the next model request',
      );
      sendMessage(
        response,
        {
          type: 'tool_use',
          id: 'tool_fetch_fixture',
          name: 'mcp__parallel-search__web_fetch',
          input: {
            urls: [sourceUrl],
            session_id: 'e641d94e-1d19-43f6-9960-cf827a6c21c1',
          },
        },
        'tool_use',
      );
    } else {
      if (mode === 'normal')
        assert.ok(
          serialized.includes('the answer is 42'),
          'fetch content reaches the model',
        );
      if (mode === 'error')
        assert.ok(
          serialized.includes('Fixture search service unavailable'),
          'MCP error reaches the model',
        );
      if (mode === 'timeout')
        assert.match(
          serialized,
          /timed out|timeout/i,
          'timeout reaches the model',
        );
      sendMessage(
        response,
        {
          type: 'text',
          text:
            mode === 'normal'
              ? `Fixture answer: 42. Source: ${sourceUrl}`
              : `Handled ${mode} from the search tool.`,
        },
        'end_turn',
      );
    }
    turn++;
  });
  const child = spawn(process.execPath, [path.join(runtime, 'dist/index.js')], {
    cwd: group,
    uid,
    gid,
    detached: true,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: home,
      ANTHROPIC_BASE_URL: model.url,
      ANTHROPIC_API_KEY: 'scripted-model-fixture-only',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      NANOCLAW_SEARCH_MCP_URL: `${mcp.url}/search-fixture/mcp`,
      MCP_TOOL_TIMEOUT: mode === 'timeout' ? '1000' : '30000',
      ENABLE_TOOL_SEARCH: 'false',
      MAX_THINKING_TOKENS: '0',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let closed = false;
  const completion = new Promise((resolve) =>
    child.on('exit', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    }),
  );
  const timer = setTimeout(() => {
    if (!closed) process.kill(-child.pid, 'SIGKILL');
  }, 45000);
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (
      stdout.includes(
        mode === 'normal' ? 'Fixture answer: 42.' : `Handled ${mode}`,
      )
    ) {
      fs.writeFile(path.join(ipc, '_close'), '').catch(() => {});
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(
    JSON.stringify({
      prompt: 'Use web_search then web_fetch and cite the returned URL.',
      groupFolder: 'caller-fixture',
      chatJid: 'fixture@local',
      isMain: true,
    }),
  );
  try {
    if (mode === 'cancel') {
      await Promise.race([
        pendingCall,
        completion.then((result) => {
          throw new Error(
            `Runner ended before tool dispatch: ${JSON.stringify(result)}\n${stderr}`,
          );
        }),
      ]);
      process.kill(-child.pid, 'SIGTERM');
    }
    const result = await completion;
    assert.notEqual(
      result.signal,
      'SIGKILL',
      `fixture exceeded timeout\n${stderr}\n${stdout}`,
    );
    assert.ok(
      observations.some((item) => item.method === 'initialize'),
      `MCP initialized\n${stderr}`,
    );
    assert.ok(
      observations.some((item) => item.method === 'tools/list'),
      'MCP tools discovered',
    );
    const calls = observations.filter((item) => item.method === 'tools/call');
    assert.ok(calls.length > 0, `real CLI dispatched an MCP call\n${stderr}`);
    for (const item of observations) {
      assert.equal(item.destination, '/search-fixture/mcp');
      assert.equal(item.userAgent, userAgent);
      assert.equal(
        item.authorization,
        undefined,
        'anonymous MCP call has no saved/environment credential',
      );
    }
    if (mode === 'cancel') {
      assert.equal(result.signal, 'SIGTERM');
      // The host's cancellation terminates both runner and SDK/CLI. It is not
      // the IPC close sentinel, which gracefully ends the input stream.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(
        disconnected,
        'host cancellation closes the in-flight HTTP request',
      );
    } else {
      assert.equal(result.code, 0, stderr);
      if (mode === 'timeout')
        assert.ok(disconnected, 'timeout aborts the pending HTTP request');
      assert.ok(
        stdout.includes(
          mode === 'normal'
            ? `Fixture answer: 42. Source: ${sourceUrl}`
            : `Handled ${mode}`,
        ),
        stdout,
      );
      if (mode === 'normal') {
        assert.deepEqual(
          calls.map((call) => call.params.name),
          ['web_search', 'web_fetch'],
        );
        assert.deepEqual(calls[1].params.arguments.urls, [sourceUrl]);
        assert.equal(
          calls[0].params.arguments.session_id,
          calls[1].params.arguments.session_id,
        );
      }
    }
    return {
      mode,
      result,
      observations,
      modelRequestCount: modelRequests.length,
      stdout,
      stderr,
      disconnected,
    };
  } finally {
    clearTimeout(timer);
    if (!closed) process.kill(-child.pid, 'SIGKILL');
    await model.close();
    await mcp.close();
    await fs.rm(path.join(ipc, '_close'), { force: true });
  }
}

for (const mode of ['normal', 'error', 'timeout', 'cancel']) {
  test(
    `actual SDK caller: ${mode} (scripted model, local MCP)`,
    { skip: !enabled, timeout: 60000 },
    async () => {
      const evidence = await exercise(mode);
      if (process.env.NANOCLAW_CALLER_EVIDENCE_DIR) {
        await fs.mkdir(process.env.NANOCLAW_CALLER_EVIDENCE_DIR, {
          recursive: true,
        });
        await fs.writeFile(
          path.join(process.env.NANOCLAW_CALLER_EVIDENCE_DIR, `${mode}.json`),
          JSON.stringify(evidence, null, 2),
        );
      }
    },
  );
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  resolveWebSearch, PARALLEL_SEARCH_URL, SEARCH_USER_AGENT,
} from '../dist/web-search.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { home: path.join(root, 'home'), cwd: path.join(root, 'group'), env: {}, managedSettingsPath: path.join(root, 'managed-settings.json'), managedMcpPath: path.join(root, 'managed-mcp.json') };
  function save(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  }
  return { options, save, resolve: (extra = {}) => resolveWebSearch({ ...options, ...extra }) };
}

test('an unconfigured agent gets anonymous Search MCP and a project User-Agent', (t) => {
  const f = fixture(t);
  const result = f.resolve();
  assert.equal(result.provider, 'parallel');
  assert.deepEqual(result.mcpServers['parallel-search'], {
    type: 'http', url: PARALLEL_SEARCH_URL, headers: { 'User-Agent': SEARCH_USER_AGENT },
  });
  assert.deepEqual(result.allowedTools, ['mcp__parallel-search__*']);
  assert.deepEqual(result.disallowedTools, ['WebSearch', 'WebFetch']);
  assert.match(result.instructions, /Cite the returned source URLs/);
});

test('saved group modes preserve built-in search and disable the new tools', (t) => {
  const f = fixture(t);
  const builtin = f.resolve({ mode: 'builtin' });
  assert.deepEqual(builtin.mcpServers, {});
  assert.deepEqual(builtin.allowedTools, ['WebSearch', 'WebFetch']);
  const disabled = f.resolve({ mode: 'disabled' });
  assert.deepEqual(disabled.mcpServers, {});
  assert.deepEqual(disabled.allowedTools, []);
  assert.deepEqual(disabled.disallowedTools, ['WebSearch', 'WebFetch', 'mcp__parallel-search__*']);
  assert.throws(() => f.resolve({ mode: 'typo' }), /webSearch must be/);
});

test('saved user, project, and local project MCP choices are not replaced', (t) => {
  for (const scope of ['user', 'project', 'local-project']) {
    const f = fixture(t);
    const server = { type: 'http', url: 'https://existing.example/mcp', headers: { Authorization: 'Bearer saved' } };
    if (scope === 'project') f.save(path.join(f.options.cwd, '.mcp.json'), { mcpServers: { chosen: server } });
    else f.save(path.join(f.options.home, '.claude.json'), scope === 'user'
      ? { mcpServers: { chosen: server } }
      : { projects: { [f.options.cwd]: { mcpServers: { chosen: server } } } });
    assert.equal(f.resolve().provider, 'configured', scope);
    assert.deepEqual(f.resolve().mcpServers, {});
    assert.equal(f.resolve({ mode: 'parallel' }).provider, 'parallel', 'an explicit override can opt in');
  }
});

test('an existing Parallel server retains its endpoint and credentials even on explicit selection', (t) => {
  const f = fixture(t);
  const file = path.join(f.options.cwd, '.mcp.json');
  f.save(file, { mcpServers: { 'parallel-search': { type: 'http', url: 'https://chosen.example/mcp' } } });
  const saved = fs.readFileSync(file, 'utf8');
  assert.equal(f.resolve({ mode: 'parallel' }).provider, 'configured');
  assert.deepEqual(f.resolve().mcpServers, {});
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
});

test('permission denials and disabled MCP servers prevent new search registration', (t) => {
  for (const file of ['user', 'project', 'local']) {
    for (const rule of ['WebSearch', 'WebFetch', 'WebSearch(*)', 'mcp__*', 'mcp__parallel-search__*', 'mcp__parallel-search__web_search']) {
      const f = fixture(t);
      const dest = file === 'user' ? path.join(f.options.home, '.claude', 'settings.json')
        : path.join(f.options.cwd, '.claude', file === 'local' ? 'settings.local.json' : 'settings.json');
      f.save(dest, { permissions: { deny: [rule] } });
      assert.deepEqual(f.resolve({ mode: 'parallel' }).mcpServers, {}, `${file}: ${rule}`);
    }
  }
  for (const key of ['disabledMcpServers', 'disabledMcpjsonServers']) {
    const f = fixture(t);
    f.save(path.join(f.options.home, '.claude.json'), { [key]: ['parallel-search'] });
    assert.deepEqual(f.resolve({ mode: 'parallel' }).mcpServers, {});
  }
});

test('explicit endpoints and legacy credentials are retained without mutating environment', (t) => {
  const f = fixture(t);
  const env = { NANOCLAW_SEARCH_MCP_URL: 'https://search.parallel.ai/mcp?mode=fast', PARALLEL_API_KEY: 'existing-key', MCP_TOOL_TIMEOUT: '1500' };
  const result = f.resolve({ env });
  assert.equal(result.mcpServers['parallel-search'].url, env.NANOCLAW_SEARCH_MCP_URL);
  assert.equal(result.mcpServers['parallel-search'].headers.Authorization, 'Bearer existing-key');
  assert.equal(env.MCP_TOOL_TIMEOUT, '1500');
  assert.equal(f.resolve({ env: { NANOCLAW_SEARCH_MCP_URL: 'http://127.0.0.1:1234/mcp' } }).provider, 'parallel');
  for (const url of ['garbage', 'http://remote.example/mcp', 'https://name:secret@search.parallel.ai/mcp', 'https://search.parallel.ai/mcp#fragment', 'file:///tmp/mcp']) {
    assert.throws(() => f.resolve({ env: { NANOCLAW_SEARCH_MCP_URL: url } }), undefined, url);
  }
});

test('managed web denials and MCP restrictions suppress automatic registration', (t) => {
  for (const setting of [
    { permissions: { deny: ['WebSearch'] } },
    { allowedMcpServers: [] },
    { deniedMcpServers: [{ serverName: 'parallel-search' }] },
  ]) {
    const f = fixture(t);
    f.save(f.options.managedSettingsPath, setting);
    assert.deepEqual(f.resolve().mcpServers, {});
  }
});

test('saved settings credentials follow SDK source precedence over inherited environment', (t) => {
  const f = fixture(t);
  const inherited = { PARALLEL_API_KEY: 'inherited-key' };
  f.save(path.join(f.options.home, '.claude.json'), { env: { PARALLEL_API_KEY: 'global-key' } });
  assert.equal(f.resolve({ env: inherited }).mcpServers['parallel-search'].headers.Authorization, 'Bearer global-key');
  const sources = [
    path.join(f.options.cwd, '.claude', 'settings.json'),
    path.join(f.options.home, '.claude', 'settings.json'),
    path.join(f.options.cwd, '.claude', 'settings.local.json'),
    f.options.managedSettingsPath,
  ];
  for (const [index, file] of sources.entries()) {
    f.save(file, { env: { PARALLEL_API_KEY: `saved-key-${index}` } });
    assert.equal(f.resolve({ env: inherited }).mcpServers['parallel-search'].headers.Authorization, `Bearer saved-key-${index}`);
  }
  assert.equal(inherited.PARALLEL_API_KEY, 'inherited-key', 'the supplied SDK environment is not mutated');
  f.save(sources[3], { env: { PARALLEL_API_KEY: '' } });
  assert.equal(f.resolve({ env: inherited }).mcpServers['parallel-search'].headers.Authorization, undefined, 'an intentional empty setting removes authentication');
});

test('legacy global configuration takes precedence over the global fallback', (t) => {
  const f = fixture(t);
  f.save(path.join(f.options.home, '.claude.json'), { env: { PARALLEL_API_KEY: 'fallback-key' } });
  f.save(path.join(f.options.home, '.claude', '.config.json'), { env: { PARALLEL_API_KEY: 'legacy-key' } });
  assert.equal(f.resolve().mcpServers['parallel-search'].headers.Authorization, 'Bearer legacy-key');
  f.save(path.join(f.options.home, '.claude', '.config.json'), { mcpServers: { 'parallel-search': { type: 'http', url: 'https://saved.example/mcp' } } });
  assert.equal(f.resolve({ mode: 'parallel' }).provider, 'configured');
});

test('an explicit Claude config directory preserves its global servers and settings', (t) => {
  const f = fixture(t);
  const configDir = path.join(f.options.home, 'alternate-config');
  const env = { CLAUDE_CONFIG_DIR: configDir, PARALLEL_API_KEY: 'inherited-key' };
  f.save(path.join(configDir, '.claude.json'), { env: { PARALLEL_API_KEY: 'config-global-key' } });
  assert.equal(f.resolve({ env }).mcpServers['parallel-search'].headers.Authorization, 'Bearer config-global-key');
  f.save(path.join(configDir, 'settings.json'), { env: { PARALLEL_API_KEY: 'config-settings-key' } });
  assert.equal(f.resolve({ env }).mcpServers['parallel-search'].headers.Authorization, 'Bearer config-settings-key');
  f.save(path.join(configDir, '.claude.json'), { mcpServers: { chosen: { type: 'http', url: 'https://chosen.example/mcp' } } });
  assert.equal(f.resolve({ env }).provider, 'configured');
});


test('ancestor and repository-root MCP declarations remain configured choices', (t) => {
  const f = fixture(t);
  f.save(path.join(path.dirname(f.options.cwd), '.mcp.json'), { mcpServers: { parent: { type: 'http', url: 'https://parent.example/mcp' } } });
  assert.equal(f.resolve().provider, 'configured');
  fs.rmSync(path.join(path.dirname(f.options.cwd), '.mcp.json'));
  f.save(path.join(f.options.home, '.claude.json'), { projects: { '/saved/repository-root': { mcpServers: { chosen: { type: 'http', url: 'https://root.example/mcp' } } } } });
  assert.equal(f.resolve().provider, 'configured');
});

test('managed MCP and active plugins retain ownership of server registration', (t) => {
  const f = fixture(t);
  f.save(f.options.managedMcpPath, { mcpServers: {} });
  assert.equal(f.resolve({ mode: 'parallel' }).provider, 'configured');
  fs.rmSync(f.options.managedMcpPath);
  f.save(path.join(f.options.home, '.claude', 'settings.json'), { enabledPlugins: { 'research@installed': true } });
  assert.equal(f.resolve({ mode: 'parallel' }).provider, 'configured');
  f.save(path.join(f.options.home, '.claude', 'settings.json'), { enabledPlugins: { 'research@installed': ['^1.0.0'] } });
  assert.equal(f.resolve({ mode: 'parallel' }).provider, 'configured');
  f.save(path.join(f.options.home, '.claude', 'settings.json'), { enabledPlugins: { 'research@installed': false } });
  assert.equal(f.resolve().provider, 'parallel');
});

test('malformed saved configuration fails rather than selecting another provider', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.options.cwd, { recursive: true });
  fs.writeFileSync(path.join(f.options.cwd, '.mcp.json'), '{broken');
  assert.throws(() => f.resolve(), /Cannot read web search configuration/);
  fs.writeFileSync(path.join(f.options.cwd, '.mcp.json'), '{"mcpServers": "broken"}');
  assert.throws(() => f.resolve(), /Cannot read web search configuration/);
});

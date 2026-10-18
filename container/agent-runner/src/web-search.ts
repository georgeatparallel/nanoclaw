import fs from 'fs';
import os from 'os';
import path from 'path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

export type WebSearchMode = 'parallel' | 'builtin' | 'disabled';

export const PARALLEL_SEARCH_URL = 'https://search.parallel.ai/mcp';
export const SEARCH_USER_AGENT = 'NanoClaw (https://nanoclaw.dev)';
const SERVER_NAME = 'parallel-search';
const PARALLEL_TOOLS = `mcp__${SERVER_NAME}__*`;
const BUILTIN_TOOLS = ['WebSearch', 'WebFetch'];

interface SavedConfig {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, SavedConfig>;
  permissions?: { deny?: string[] };
  disabledMcpServers?: string[];
  disabledMcpjsonServers?: string[];
  allowedMcpServers?: unknown[];
  deniedMcpServers?: unknown[];
}

function readConfig(file: string): SavedConfig {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Expected a JSON object');
    }
    for (const key of ['mcpServers', 'projects', 'permissions']) {
      if (
        value[key] !== undefined &&
        (!value[key] ||
          typeof value[key] !== 'object' ||
          Array.isArray(value[key]))
      ) {
        throw new Error(`Expected an object for ${key}`);
      }
    }
    for (const list of [
      value.permissions?.deny,
      value.disabledMcpServers,
      value.disabledMcpjsonServers,
    ]) {
      if (
        list !== undefined &&
        (!Array.isArray(list) || list.some((item) => typeof item !== 'string'))
      ) {
        throw new Error(
          'Expected an array of permission or disabled-server names',
        );
      }
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // A broken saved choice is an error, never permission to change providers.
    throw new Error(`Cannot read web search configuration: ${file}`, {
      cause: error,
    });
  }
}

/** Resolve the skill's default without replacing saved MCP servers or denials. */
export function resolveWebSearch(
  options: {
    mode?: WebSearchMode;
    cwd?: string;
    home?: string;
    env?: NodeJS.ProcessEnv;
    managedSettingsPath?: string;
  } = {},
): {
  provider: WebSearchMode | 'configured';
  mcpServers: Record<string, McpServerConfig>;
  allowedTools: string[];
  disallowedTools: string[];
  instructions: string;
} {
  const cwd = options.cwd ?? '/workspace/group';
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const user = readConfig(path.join(home, '.claude.json'));
  const project = readConfig(path.join(cwd, '.mcp.json'));
  const projectUser = user.projects?.[cwd] ?? {};
  const settings = [
    readConfig(path.join(home, '.claude', 'settings.json')),
    readConfig(path.join(cwd, '.claude', 'settings.json')),
    readConfig(path.join(cwd, '.claude', 'settings.local.json')),
    readConfig(
      options.managedSettingsPath ?? '/etc/claude-code/managed-settings.json',
    ),
  ];
  const savedServers = [user, projectUser, project].flatMap((config) =>
    Object.keys(config.mcpServers ?? {}),
  );
  const denied = settings.flatMap((config) => config.permissions?.deny ?? []);
  const disabledServers = [user, projectUser, ...settings].flatMap((config) => [
    ...(config.disabledMcpServers ?? []),
    ...(config.disabledMcpjsonServers ?? []),
  ]);
  const searchDenied =
    denied.some(
      (rule: unknown) =>
        typeof rule === 'string' &&
        (BUILTIN_TOOLS.includes(rule.split('(')[0]) ||
          rule === 'mcp__*' ||
          rule === `mcp__${SERVER_NAME}` ||
          rule === PARALLEL_TOOLS ||
          rule.startsWith(`mcp__${SERVER_NAME}__`)),
    ) ||
    disabledServers.includes(SERVER_NAME) ||
    settings.some(
      (config) =>
        config.allowedMcpServers !== undefined ||
        config.deniedMcpServers !== undefined,
    );

  const mode = options.mode;
  if (
    mode !== undefined &&
    !['parallel', 'builtin', 'disabled'].includes(mode)
  ) {
    throw new Error('webSearch must be parallel, builtin, or disabled');
  }
  const empty = { mcpServers: {}, instructions: '' };
  if (mode === 'disabled') {
    return {
      ...empty,
      provider: 'disabled',
      allowedTools: [],
      disallowedTools: [...BUILTIN_TOOLS, PARALLEL_TOOLS],
    };
  }
  if (mode === 'builtin' || searchDenied) {
    return {
      ...empty,
      provider: 'builtin',
      allowedTools: BUILTIN_TOOLS,
      disallowedTools: [],
    };
  }
  // Existing MCP configuration is intentional. The SDK continues to load it
  // through its normal settings sources, including authentication and disabling.
  if (
    savedServers.includes(SERVER_NAME) ||
    (mode === undefined && savedServers.length > 0)
  ) {
    return {
      ...empty,
      provider: 'configured',
      allowedTools: [...BUILTIN_TOOLS, PARALLEL_TOOLS],
      disallowedTools: [],
    };
  }

  const url = new URL(env.NANOCLAW_SEARCH_MCP_URL ?? PARALLEL_SEARCH_URL);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  ) {
    throw new Error(
      'Search MCP requires HTTPS (or HTTP on localhost) without URL credentials',
    );
  }
  const headers: Record<string, string> = { 'User-Agent': SEARCH_USER_AGENT };
  // Retain credentials from earlier customized installations when present.
  if (env.PARALLEL_API_KEY)
    headers.Authorization = `Bearer ${env.PARALLEL_API_KEY}`;
  return {
    provider: 'parallel',
    mcpServers: { [SERVER_NAME]: { type: 'http', url: url.href, headers } },
    allowedTools: [PARALLEL_TOOLS],
    disallowedTools: BUILTIN_TOOLS,
    instructions:
      'For web research, use the Parallel Search MCP web_search and web_fetch tools. ' +
      'Cite the returned source URLs. If a request fails, report the error; do not switch providers silently.',
  };
}

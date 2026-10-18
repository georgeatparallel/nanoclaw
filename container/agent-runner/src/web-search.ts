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
  env?: Record<string, string>;
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, SavedConfig>;
  permissions?: { deny?: string[] };
  disabledMcpServers?: string[];
  disabledMcpjsonServers?: string[];
  allowedMcpServers?: unknown[];
  deniedMcpServers?: unknown[];
  enabledPlugins?: Record<string, boolean | string[]>;
}

function readConfig(file: string): SavedConfig {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Expected a JSON object');
    }
    for (const key of [
      'mcpServers',
      'projects',
      'permissions',
      'env',
      'enabledPlugins',
    ]) {
      if (
        value[key] !== undefined &&
        (!value[key] ||
          typeof value[key] !== 'object' ||
          Array.isArray(value[key]))
      ) {
        throw new Error(`Expected an object for ${key}`);
      }
    }
    if (
      value.env &&
      Object.values(value.env).some((item) => typeof item !== 'string')
    ) {
      throw new Error('Expected string environment values');
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

function ancestorDirectories(cwd: string): string[] {
  const roots = [path.resolve(cwd)];
  try {
    roots.push(fs.realpathSync(cwd));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const directories = new Set<string>();
  for (let directory of roots) {
    while (!directories.has(directory)) {
      directories.add(directory);
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return [...directories];
}

/** Resolve the skill's default without replacing saved MCP servers or denials. */
export function resolveWebSearch(
  options: {
    mode?: WebSearchMode;
    cwd?: string;
    home?: string;
    env?: NodeJS.ProcessEnv;
    managedSettingsPath?: string;
    managedMcpPath?: string;
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
  const configDir = path.resolve(
    cwd,
    env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'),
  );
  const legacyConfig = path.join(configDir, '.config.json');
  const user = readConfig(
    fs.existsSync(legacyConfig)
      ? legacyConfig
      : path.join(env.CLAUDE_CONFIG_DIR ? configDir : home, '.claude.json'),
  );
  const projects = ancestorDirectories(cwd).map((directory) =>
    readConfig(path.join(directory, '.mcp.json')),
  );
  // The SDK owns repository-root and realpath keys. Conservatively preserve any
  // saved project MCP declaration instead of guessing which key it will select.
  const projectConfigs = Object.values(user.projects ?? {});
  const settings = [
    readConfig(path.join(cwd, '.claude', 'settings.json')),
    readConfig(path.join(configDir, 'settings.json')),
    readConfig(path.join(cwd, '.claude', 'settings.local.json')),
    readConfig(
      options.managedSettingsPath ?? '/etc/claude-code/managed-settings.json',
    ),
  ];
  // The CLI applies merged settings.env over the inherited environment. Match
  // its explicit project < user < local < managed source order before headers.
  let effectiveEnv = { ...env, ...user.env };
  for (const config of settings)
    effectiveEnv = { ...effectiveEnv, ...config.env };
  const savedServers = [user, ...projectConfigs, ...projects].flatMap(
    (config) => Object.keys(config.mcpServers ?? {}),
  );
  const denied = settings.flatMap((config) => config.permissions?.deny ?? []);
  const disabledServers = [user, ...projectConfigs, ...settings].flatMap(
    (config) => [
      ...(config.disabledMcpServers ?? []),
      ...(config.disabledMcpjsonServers ?? []),
    ],
  );
  const managedMcpPath =
    options.managedMcpPath ?? '/etc/claude-code/managed-mcp.json';
  const managedMcp = fs.existsSync(managedMcpPath);
  if (managedMcp) readConfig(managedMcpPath); // A malformed policy must fail, not fall back.
  const activePlugins = [user, ...settings].some((config) =>
    Object.values(config.enabledPlugins ?? {}).some(
      (enabled) => enabled === true || Array.isArray(enabled),
    ),
  );
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
    managedMcp ||
    activePlugins ||
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

  const url = new URL(
    effectiveEnv.NANOCLAW_SEARCH_MCP_URL ?? PARALLEL_SEARCH_URL,
  );
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
  if (effectiveEnv.PARALLEL_API_KEY)
    headers.Authorization = `Bearer ${effectiveEnv.PARALLEL_API_KEY}`;
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

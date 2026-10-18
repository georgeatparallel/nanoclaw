---
name: add-parallel
description: Add free web search and page fetching to NanoClaw container agents with Parallel Search MCP. Use when installing or updating Parallel web research support.
---

# Parallel web research

Add [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
to the container agent. Anonymous search uses Fast mode and page fetching returns
source excerpts. No Parallel account or API key is required for light use; the
service has free-tier usage limits.

This is a **feature skill**. Its runtime code lives on `skill/parallel`, rather
than being an unconditional addition to NanoClaw core. NanoClaw and its existing
Claude authentication must already be working.

## 1. Merge the feature branch

Check that the working tree is clean. Fetch and merge `skill/parallel` from the
remote that distributes this NanoClaw installation, following
[the feature-skill workflow](../../../CONTRIBUTING.md). For an `upstream` remote:

```bash
git fetch upstream skill/parallel
git merge upstream/skill/parallel
```

The maintainer creates this branch from the feature-skill PR. If it has not been
published, stop here rather than inventing a branch or editing source by hand.
Resolve conflicts by retaining the user's configured MCP servers, Task MCP
integration, credentials and permission rules. Do not replace an existing
`mcpServers` object. The previous version of this skill described manual source
edits; those customizations remain user choices.

## 2. Choose web search behavior

The runtime uses Parallel for an unconfigured group. It does not add a new default
when the group already has saved MCP servers or has denied web tools. Existing
MCP configurations continue through the Claude SDK's normal settings loading,
including their authentication. A failed configured provider does not trigger
fallback to anonymous Parallel.

For a group that needs an explicit choice, set its registered
`containerConfig.webSearch` to one of:

| Value      | Behavior                                                                              |
| ---------- | ------------------------------------------------------------------------------------- |
| `parallel` | Use Parallel Search MCP; retain an existing `parallel-search` server if one is saved. |
| `builtin`  | Keep Claude's built-in `WebSearch` and `WebFetch`.                                    |
| `disabled` | Disable the built-in web tools and this skill's Parallel tools.                       |

Retain all other group settings. Existing web-tool denials and a disabled
`parallel-search` server take precedence over automatic registration, including
when `parallel` is selected. Other custom tools retain their own permissions. Managed MCP allow/deny policies
suppress automatic registration; configure an approved server through the managed
MCP settings instead.
When Parallel is selected, the built-in web tools are unavailable; choose
`builtin` for workflows that depend on their response format or behavior.

The default server is `https://search.parallel.ai/mcp`. An existing
`PARALLEL_API_KEY` in the agent environment is retained as Bearer authentication;
no key is collected or copied into a container by this skill. Existing OneCLI
credential policies remain under the user's control. For a custom endpoint, retain a `parallel-search` server in the group's normal
saved MCP configuration; the resolver leaves its endpoint and authentication
unchanged.

This skill supplies Search MCP only. Keep an existing Task MCP setup and its
approval rules for deep research; do not add or call paid Task tools implicitly.

## 3. Build and restart

Rebuild the image and host application:

```bash
./container/build.sh
npm run build
```

Restart the existing NanoClaw service using its current service manager, then
check the service and container logs. The agent logs its selected provider as
`Web search provider: parallel`, `configured`, `builtin`, or `disabled`.
Do not print credential values while diagnosing the installation.

## 4. Verify in a fresh conversation

Send a question that needs current sources to the assistant, then ask it to read
one of the returned URLs. Verify that `mcp__parallel-search__web_search` and
`mcp__parallel-search__web_fetch` produce useful excerpts and the answer cites
those URLs. Verify the saved `builtin` and `disabled` choices as well.

Search errors, timeouts and service limits should be reported as errors, without
switching providers silently. Cancellation uses the Claude SDK's existing query
and MCP lifecycle. Existing `MCP_TIMEOUT` and `MCP_TOOL_TIMEOUT` settings still
control the SDK transport; the skill does not overwrite them.

## Remove

Set `containerConfig.webSearch` to `builtin` to stop using the skill's default
while retaining the feature branch. To remove the feature completely, revert its
merge commit using the normal feature-skill workflow, rebuild and restart.
Keep unrelated MCP servers and Task research configuration.

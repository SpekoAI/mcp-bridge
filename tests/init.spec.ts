import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCodexConfig,
  buildCursorConfig,
  buildInitPlan,
  buildOpenCodeConfig,
  completeInitArgs,
  DEFAULT_AUTH_MCP_URL,
  DEFAULT_PUBLIC_MCP_URL,
  DEFAULT_SCOPE,
  DEFAULT_SELECTED_TOOLS,
  INIT_HELP_TEXT,
  parseInitArgs,
  type ResolvedInitOptions,
  runInitCommand,
} from '../src/index.js';

describe('spekoai-mcp init', () => {
  it('preselects Claude Code and OpenCode in the interactive wizard', () => {
    expect(DEFAULT_SELECTED_TOOLS).toEqual(['claude', 'opencode']);
  });

  it('defaults the interactive scope prompt to the current project', () => {
    expect(DEFAULT_SCOPE).toBe('project');
  });

  it('describes the two endpoint modes clearly in help output', () => {
    expect(INIT_HELP_TEXT).toContain('full uses');
    expect(INIT_HELP_TEXT).toContain('docs uses');
  });

  it('parses complete non-interactive init flags', () => {
    expect(
      completeInitArgs(
        parseInitArgs([
          '--access',
          'full',
          '--auth',
          'oauth',
          '--tools',
          'claude,codex,opencode,cursor,other',
          '--scope',
          'user',
          '--yes',
        ]),
      ),
    ).toEqual({
      access: 'full',
      auth: 'oauth',
      tools: ['claude', 'codex', 'opencode', 'cursor', 'other'],
      scope: 'user',
      dryRun: false,
      yes: true,
    });
  });

  it('rejects non-interactive init when required flags are missing', () => {
    expect(() => completeInitArgs(parseInitArgs(['--access', 'full']))).toThrow(
      /running non-interactively/,
    );
  });

  it('builds full-access OAuth configs', () => {
    expect(buildCodexConfig('', DEFAULT_AUTH_MCP_URL, false)).toEqual({
      ok: true,
      content: `[mcp_servers.speko]
url = "${DEFAULT_AUTH_MCP_URL}"
`,
    });
    expect(buildOpenCodeConfig('', DEFAULT_AUTH_MCP_URL, false)).toEqual({
      ok: true,
      content: `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "speko": {
      "type": "remote",
      "url": "${DEFAULT_AUTH_MCP_URL}",
      "enabled": true
    }
  }
}
`,
    });
    expect(buildCursorConfig('', DEFAULT_AUTH_MCP_URL, false)).toEqual({
      ok: true,
      content: `{
  "mcpServers": {
    "speko": {
      "url": "${DEFAULT_AUTH_MCP_URL}"
    }
  }
}
`,
    });
  });

  it('builds full-access API-key configs with env var references', () => {
    expect(buildCodexConfig('', DEFAULT_AUTH_MCP_URL, true)).toEqual({
      ok: true,
      content: `[mcp_servers.speko]
url = "${DEFAULT_AUTH_MCP_URL}"
bearer_token_env_var = "SPEKO_API_KEY"
`,
    });
    expect(buildOpenCodeConfig('', DEFAULT_AUTH_MCP_URL, true)).toEqual({
      ok: true,
      content: `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "speko": {
      "type": "remote",
      "url": "${DEFAULT_AUTH_MCP_URL}",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:SPEKO_API_KEY}"
      },
      "enabled": true
    }
  }
}
`,
    });
    expect(buildCursorConfig('', DEFAULT_AUTH_MCP_URL, true)).toEqual({
      ok: true,
      content: `{
  "mcpServers": {
    "speko": {
      "url": "${DEFAULT_AUTH_MCP_URL}",
      "headers": {
        "Authorization": "Bearer \${env:SPEKO_API_KEY}"
      }
    }
  }
}
`,
    });
  });

  it('builds docs-only configs', () => {
    expect(buildCodexConfig('', DEFAULT_PUBLIC_MCP_URL, false)).toEqual({
      ok: true,
      content: `[mcp_servers.speko]
url = "${DEFAULT_PUBLIC_MCP_URL}"
`,
    });
    expect(buildOpenCodeConfig('', DEFAULT_PUBLIC_MCP_URL, false)).toEqual({
      ok: true,
      content: expect.stringContaining(`"url": "${DEFAULT_PUBLIC_MCP_URL}"`),
    });
    expect(buildCursorConfig('', DEFAULT_PUBLIC_MCP_URL, false)).toEqual({
      ok: true,
      content: expect.stringContaining(`"url": "${DEFAULT_PUBLIC_MCP_URL}"`),
    });
  });

  it('merges JSON configs and preserves unrelated entries', () => {
    const openCode = buildOpenCodeConfig(
      `{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "mcp": {
    "github": {
      "type": "remote",
      "url": "https://example.test/mcp"
    },
    "speko": {
      "type": "remote",
      "url": "https://old.example/mcp"
    }
  }
}
`,
      DEFAULT_PUBLIC_MCP_URL,
      false,
    );

    expect(openCode.ok).toBe(true);
    expect(openCode.ok ? openCode.content : '').toContain('"model": "anthropic/claude-sonnet-4-5"');
    expect(openCode.ok ? openCode.content : '').toContain('"github"');
    expect(openCode.ok ? openCode.content : '').toContain(`"url": "${DEFAULT_PUBLIC_MCP_URL}"`);

    const cursor = buildCursorConfig(
      `{
  "mcpServers": {
    "github": {
      "url": "https://example.test/mcp"
    },
    "speko": {
      "url": "https://old.example/mcp"
    }
  }
}
`,
      DEFAULT_AUTH_MCP_URL,
      true,
    );

    expect(cursor.ok).toBe(true);
    expect(cursor.ok ? cursor.content : '').toContain('"github"');
    expect(cursor.ok ? cursor.content : '').toContain(
      `"Authorization": "Bearer $${'{env:SPEKO_API_KEY}'}`,
    );
  });

  it('replaces only the Codex speko block', () => {
    const result = buildCodexConfig(
      `model = "gpt-5"

[mcp_servers.github]
url = "https://example.test/mcp"

[mcp_servers.speko]
url = "https://old.example/mcp"

[tools]
enabled = true
`,
      DEFAULT_PUBLIC_MCP_URL,
      false,
    );

    expect(result).toEqual({
      ok: true,
      content: `model = "gpt-5"

[mcp_servers.github]
url = "https://example.test/mcp"

[tools]
enabled = true

[mcp_servers.speko]
url = "${DEFAULT_PUBLIC_MCP_URL}"
`,
    });
  });

  it('skips invalid configs with manual snippets', () => {
    const openCode = buildOpenCodeConfig('{ invalid', DEFAULT_PUBLIC_MCP_URL, false);
    expect(openCode.ok).toBe(false);
    expect(openCode.ok ? '' : openCode.manualSnippet).toContain(DEFAULT_PUBLIC_MCP_URL);

    const codex = buildCodexConfig('[broken', DEFAULT_PUBLIC_MCP_URL, false);
    expect(codex.ok).toBe(false);
    expect(codex.ok ? '' : codex.manualSnippet).toContain('[mcp_servers.speko]');
  });

  it('applies project file changes with backups and does not write on dry run', async () => {
    const dir = mkTempDir();
    const cwd = join(dir, 'project');
    const home = join(dir, 'home');
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    writeFileSync(
      join(cwd, '.cursor', 'mcp.json'),
      `{
  "mcpServers": {
    "old": {
      "url": "https://example.test"
    }
  }
}
`,
    );

    try {
      await runInitCommand(
        ['--dry-run', '--access', 'docs', '--tools', 'cursor', '--scope', 'project', '--yes'],
        {
          cwd,
          homeDir: home,
          env: {},
          stdout: fakeWriteStream(),
          stderr: fakeWriteStream(),
        },
      );
      expect(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8')).toContain(
        'https://example.test',
      );

      await runInitCommand(
        ['--access', 'docs', '--tools', 'cursor', '--scope', 'project', '--yes'],
        {
          cwd,
          homeDir: home,
          env: {},
          stdout: fakeWriteStream(),
          stderr: fakeWriteStream(),
          timestamp: () => '20260520T000000Z',
        },
      );

      const updated = readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8');
      expect(updated).toContain(DEFAULT_PUBLIC_MCP_URL);
      expect(updated).toContain('"old"');
      expect(existsSync(join(cwd, '.cursor', 'mcp.json.20260520T000000Z.bak'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds a manual Claude API-key step instead of writing a secret', () => {
    const options: ResolvedInitOptions = {
      access: 'full',
      auth: 'api-key',
      tools: ['claude'],
      scope: 'user',
      dryRun: false,
      yes: true,
    };

    expect(buildInitPlan(options, { homeDir: '/home/test', cwd: '/repo' })).toEqual([
      {
        kind: 'manual',
        tool: 'claude',
        label: 'Claude Code',
        manualSnippet: `claude mcp add --transport http --scope user speko ${DEFAULT_AUTH_MCP_URL} \\
  --header "Authorization: Bearer sk_live_xxx"`,
      },
    ]);
  });
});

function mkTempDir(): string {
  return join(tmpdir(), `spekoai-mcp-${Math.random().toString(16).slice(2)}`);
}

function fakeWriteStream(): NodeJS.WriteStream {
  return {
    isTTY: false,
    write: () => true,
  } as NodeJS.WriteStream;
}

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
  DEFAULT_SCOPE,
  DEFAULT_SELECTED_TOOLS,
  INIT_HELP_TEXT,
  parseInitArgs,
  type ResolvedInitOptions,
  runInitCommand,
} from '../src/index.js';

describe('spekoai-mcp init', () => {
  it('preselects only Claude Code in the interactive wizard', () => {
    expect(DEFAULT_SELECTED_TOOLS).toEqual(['claude']);
  });

  it('defaults the interactive scope prompt to the current project', () => {
    expect(DEFAULT_SCOPE).toBe('project');
  });

  it('describes the single hosted endpoint in help output', () => {
    expect(INIT_HELP_TEXT).toContain(DEFAULT_AUTH_MCP_URL);
    expect(INIT_HELP_TEXT).not.toContain('docs');
  });

  it('parses complete non-interactive init flags', () => {
    expect(
      completeInitArgs(
        parseInitArgs([
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
      auth: 'oauth',
      tools: ['claude', 'codex', 'opencode', 'cursor', 'other'],
      scope: 'user',
      dryRun: false,
      yes: true,
    });
  });

  it('rejects non-interactive init when required flags are missing', () => {
    expect(() => completeInitArgs(parseInitArgs(['--auth', 'oauth']))).toThrow(
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
      DEFAULT_AUTH_MCP_URL,
      false,
    );

    expect(openCode.ok).toBe(true);
    expect(openCode.ok ? openCode.content : '').toContain('"model": "anthropic/claude-sonnet-4-5"');
    expect(openCode.ok ? openCode.content : '').toContain('"github"');
    expect(openCode.ok ? openCode.content : '').toContain(`"url": "${DEFAULT_AUTH_MCP_URL}"`);

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
      DEFAULT_AUTH_MCP_URL,
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
url = "${DEFAULT_AUTH_MCP_URL}"
`,
    });
  });

  it('skips invalid configs with manual snippets', () => {
    const openCode = buildOpenCodeConfig('{ invalid', DEFAULT_AUTH_MCP_URL, false);
    expect(openCode.ok).toBe(false);
    expect(openCode.ok ? '' : openCode.manualSnippet).toContain(DEFAULT_AUTH_MCP_URL);

    const codex = buildCodexConfig('[broken', DEFAULT_AUTH_MCP_URL, false);
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
        ['--dry-run', '--auth', 'oauth', '--tools', 'cursor', '--scope', 'project', '--yes'],
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
        ['--auth', 'oauth', '--tools', 'cursor', '--scope', 'project', '--yes'],
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
      expect(updated).toContain(DEFAULT_AUTH_MCP_URL);
      expect(updated).toContain('"old"');
      expect(existsSync(join(cwd, '.cursor', 'mcp.json.20260520T000000Z.bak'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges OpenCode project config instead of replacing existing servers', async () => {
    const dir = mkTempDir();
    const cwd = join(dir, 'project');
    const home = join(dir, 'home');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(cwd, 'opencode.json'),
      `{
  "$schema": "https://opencode.ai/config.json",
  "theme": "system",
  "mcp": {
    "github": {
      "type": "remote",
      "url": "https://example.test/mcp",
      "enabled": true
    }
  }
}
`,
    );

    try {
      await runInitCommand(
        ['--auth', 'oauth', '--tools', 'opencode', '--scope', 'project', '--yes'],
        {
          cwd,
          homeDir: home,
          env: {},
          stdout: fakeWriteStream(),
          stderr: fakeWriteStream(),
          timestamp: () => '20260520T000000Z',
        },
      );

      const updated = JSON.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8')) as {
        theme?: string;
        mcp?: Record<string, { url?: string }>;
      };
      expect(updated.theme).toBe('system');
      expect(updated.mcp?.github?.url).toBe('https://example.test/mcp');
      expect(updated.mcp?.speko?.url).toBe(DEFAULT_AUTH_MCP_URL);
      expect(existsSync(join(cwd, 'opencode.json.20260520T000000Z.bak'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints OAuth follow-up commands after applying changes', async () => {
    const dir = mkTempDir();
    const cwd = join(dir, 'project');
    const home = join(dir, 'home');
    mkdirSync(cwd, { recursive: true });
    const stdout = capturingWriteStream();

    try {
      await runInitCommand(
        ['--auth', 'oauth', '--tools', 'opencode,codex', '--scope', 'project', '--yes'],
        {
          cwd,
          homeDir: home,
          env: {},
          stdout,
          stderr: fakeWriteStream(),
          timestamp: () => '20260520T000000Z',
        },
      );

      const output = stdout.output();
      const firstResult = output.indexOf('OK OpenCode config:');
      const nextSteps = output.indexOf('After configuring:');

      expect(firstResult).toBeGreaterThanOrEqual(0);
      expect(nextSteps).toBeGreaterThan(firstResult);
      expect(output.slice(0, firstResult)).not.toContain('After configuring:');
      expect(output).toContain('- Run: opencode mcp auth speko');
      expect(output).toContain('- Run: codex mcp login speko');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats already-configured command steps as successful', async () => {
    const dir = mkTempDir();
    const stdout = capturingWriteStream();
    const stderr = capturingWriteStream();

    try {
      await runInitCommand(
        ['--auth', 'oauth', '--tools', 'claude', '--scope', 'project', '--yes'],
        {
          cwd: join(dir, 'project'),
          homeDir: join(dir, 'home'),
          env: {},
          stdout,
          stderr,
          runCommand: () => ({
            ok: false,
            message: 'MCP server speko already exists in .mcp.json',
          }),
        },
      );

      expect(stdout.output()).toContain(
        'OK Claude Code: Already configured: MCP server speko already exists in .mcp.json',
      );
      expect(stdout.output()).toContain('After configuring:');
      expect(stdout.output()).toContain('- In Claude Code, run /mcp and complete sign-in.');
      expect(stdout.output()).not.toContain('Manual fallback:');
      expect(stderr.output()).not.toContain(
        'Some selected tools were not configured automatically',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('labels planned actions separately from commands and paths', async () => {
    const dir = mkTempDir();
    const stdout = capturingWriteStream();

    try {
      await runInitCommand(
        [
          '--dry-run',
          '--auth',
          'oauth',
          '--tools',
          'claude,opencode',
          '--scope',
          'project',
          '--yes',
        ],
        {
          cwd: join(dir, 'project'),
          homeDir: join(dir, 'home'),
          env: {},
          stdout,
          stderr: fakeWriteStream(),
        },
      );

      expect(stdout.output()).toContain('- Claude Code: run command: claude mcp add');
      expect(stdout.output()).toContain('- OpenCode config: update file:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds a manual Claude API-key step instead of writing a secret', () => {
    const options: ResolvedInitOptions = {
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

function fakeWriteStream(onWrite?: (chunk: string) => void): NodeJS.WriteStream {
  return {
    isTTY: false,
    write: (chunk: string | Uint8Array) => {
      onWrite?.(String(chunk));
      return true;
    },
  } as NodeJS.WriteStream;
}

function capturingWriteStream(): NodeJS.WriteStream & { output: () => string } {
  let output = '';
  return Object.assign(
    fakeWriteStream((chunk) => (output += chunk)),
    {
      output: () => output,
    },
  );
}

// ---------------------------------------------------------------------------
// Agent detection + multi-agent targets (`--tools all`, bridge configs,
// per-agent guidance) — everything here runs against fakes / temp dirs.
// ---------------------------------------------------------------------------
import {
  buildBridgeMcpServersConfig,
  buildVsCodeConfig,
  type DetectCtx,
  detectInstalledTools,
  GUIDANCE_BEGIN,
  GUIDANCE_CARD,
  GUIDANCE_END,
  upsertGuidanceBlock,
} from '../src/index.js';

function fakeDetectCtx(opts: {
  home?: string;
  platform?: NodeJS.Platform;
  paths?: string[];
  clis?: string[];
  env?: Record<string, string | undefined>;
}): DetectCtx {
  return {
    homeDir: opts.home ?? '/home/dev',
    platform: opts.platform ?? 'linux',
    env: opts.env ?? {},
    exists: (path) => (opts.paths ?? []).includes(path),
    hasCli: (cmd) => (opts.clis ?? []).includes(cmd),
  };
}

describe('agent detection', () => {
  it('detects agents from config dirs and CLI probes, in stable order', () => {
    const ctx = fakeDetectCtx({
      home: '/home/dev',
      platform: 'linux',
      paths: [
        '/home/dev/.cursor',
        '/home/dev/.codeium/windsurf',
        '/home/dev/.gemini',
        '/home/dev/.config/Claude/claude_desktop_config.json',
      ],
      clis: ['claude', 'code'],
    });
    expect(detectInstalledTools(ctx)).toEqual([
      'claude',
      'claude-desktop',
      'cursor',
      'windsurf',
      'vscode',
      'gemini',
    ]);
  });

  it('detects nothing on a clean machine and never auto-detects "other"', () => {
    expect(detectInstalledTools(fakeDetectCtx({}))).toEqual([]);
  });

  it('gates Cline on the extension having actually run', () => {
    const ctx = fakeDetectCtx({
      home: '/home/dev',
      platform: 'linux',
      paths: [
        '/home/dev/.config/Code/User',
        '/home/dev/.config/Code/User/globalStorage/saoudrizwan.claude-dev',
      ],
    });
    expect(detectInstalledTools(ctx)).toEqual(['vscode', 'cline']);
  });

  it('detects Zed via its macOS data dir or CLI, not just the settings file', () => {
    const viaDataDir = fakeDetectCtx({
      home: '/Users/dev',
      platform: 'darwin',
      paths: ['/Users/dev/Library/Application Support/Zed'],
    });
    expect(detectInstalledTools(viaDataDir)).toEqual(['zed']);

    const viaCli = fakeDetectCtx({ platform: 'linux', clis: ['zed'] });
    expect(detectInstalledTools(viaCli)).toEqual(['zed']);
  });

  it('resolves --tools all to the detected set non-interactively', () => {
    const parsed = parseInitArgs(['--auth', 'oauth', '--tools', 'all', '--scope', 'user', '--yes']);
    expect(parsed.toolsAll).toBe(true);
    expect(completeInitArgs(parsed, ['claude', 'cursor']).tools).toEqual(['claude', 'cursor']);
  });

  it('fails --tools all loudly when nothing is detected', () => {
    const parsed = parseInitArgs(['--auth', 'oauth', '--tools', 'all', '--scope', 'user', '--yes']);
    expect(() => completeInitArgs(parsed, [])).toThrow(/no supported coding agents/);
  });

  it('normalizes tool aliases', () => {
    const parsed = parseInitArgs([
      '--auth',
      'oauth',
      '--tools',
      'desktop,vs-code,gemini-cli,claude-code',
      '--scope',
      'user',
      '--yes',
    ]);
    expect(completeInitArgs(parsed).tools).toEqual([
      'claude-desktop',
      'vscode',
      'gemini',
      'claude',
    ]);
  });
});

describe('multi-agent target configs', () => {
  const baseOptions = (tools: ResolvedInitOptions['tools']): ResolvedInitOptions => ({
    auth: 'oauth',
    tools,
    scope: 'user',
    dryRun: false,
    yes: true,
  });
  const paths = { homeDir: '/home/dev', cwd: '/work', platform: 'linux' as const, env: {} };

  it('oauth bridge configs use the stdio bridge and carry no secrets', () => {
    const result = buildBridgeMcpServersConfig(undefined, false, {});
    if (!result.ok) throw new Error(result.reason);
    const parsed = JSON.parse(result.content) as {
      mcpServers: { speko: { command: string; args: string[]; env?: unknown } };
    };
    expect(parsed.mcpServers.speko.command).toBe('npx');
    expect(parsed.mcpServers.speko.args).toEqual(['-y', '@spekoai/mcp', 'bridge']);
    expect(parsed.mcpServers.speko.env).toBeUndefined();
  });

  it('api-key bridge configs interpolate SPEKO_API_KEY, with an explicit placeholder fallback', () => {
    const withKey = buildBridgeMcpServersConfig(undefined, true, { SPEKO_API_KEY: 'sk_live_real' });
    if (!withKey.ok) throw new Error(withKey.reason);
    expect(JSON.parse(withKey.content).mcpServers.speko.env).toEqual({
      SPEKO_API_KEY: 'sk_live_real',
    });

    const withoutKey = buildBridgeMcpServersConfig(undefined, true, {});
    if (!withoutKey.ok) throw new Error(withoutKey.reason);
    expect(JSON.parse(withoutKey.content).mcpServers.speko.env).toEqual({
      SPEKO_API_KEY: 'sk_live_xxx',
    });
  });

  it('VS Code config uses the servers root with an explicit http type', () => {
    const oauth = buildVsCodeConfig(undefined, DEFAULT_AUTH_MCP_URL, false);
    if (!oauth.ok) throw new Error(oauth.reason);
    expect(JSON.parse(oauth.content).servers.speko).toEqual({
      type: 'http',
      url: DEFAULT_AUTH_MCP_URL,
    });

    const apiKey = buildVsCodeConfig(undefined, DEFAULT_AUTH_MCP_URL, true);
    if (!apiKey.ok) throw new Error(apiKey.reason);
    expect(JSON.parse(apiKey.content).servers.speko.headers.Authorization).toBe(
      `Bearer \${env:SPEKO_API_KEY}`,
    );
  });

  it('plans Cline with its extra fields and per-agent guidance in each convention', () => {
    const steps = buildInitPlan(
      baseOptions(['codex', 'gemini', 'windsurf', 'vscode', 'cline']),
      paths,
    );
    const filePaths = steps.flatMap((step) => (step.kind === 'file' ? [step.path] : []));
    expect(filePaths).toContain('/home/dev/.codex/AGENTS.md');
    expect(filePaths).toContain('/home/dev/.gemini/GEMINI.md');
    expect(filePaths).toContain('/home/dev/.codeium/windsurf/memories/global_rules.md');
    expect(filePaths).toContain('/home/dev/.config/Code/User/prompts/speko-mcp.instructions.md');
    expect(filePaths).toContain('/home/dev/Documents/Cline/Rules/speko-mcp.md');

    const cline = steps.find((step) => step.kind === 'file' && step.label === 'Cline config');
    if (cline?.kind !== 'file') throw new Error('expected a Cline file step');
    const built = cline.build(undefined);
    if (!built.ok) throw new Error(built.reason);
    const entry = JSON.parse(built.content).mcpServers.speko;
    expect(entry.disabled).toBe(false);
    expect(entry.autoApprove).toEqual([]);
  });

  it('targets Claude Desktop at the per-platform config file', () => {
    const darwin = buildInitPlan(baseOptions(['claude-desktop']), { ...paths, platform: 'darwin' });
    const win = buildInitPlan(baseOptions(['claude-desktop']), {
      ...paths,
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' },
    });
    const darwinStep = darwin[0];
    const winStep = win[0];
    if (darwinStep?.kind !== 'file' || winStep?.kind !== 'file') {
      throw new Error('expected file steps');
    }
    expect(darwinStep.path).toBe(
      '/home/dev/Library/Application Support/Claude/claude_desktop_config.json',
    );
    expect(winStep.path).toContain('AppData');
  });

  it('keeps Zed as a printed snippet instead of rewriting user JSONC', () => {
    const steps = buildInitPlan(baseOptions(['zed']), paths);
    expect(steps).toHaveLength(1);
    const step = steps[0];
    if (step?.kind !== 'manual') throw new Error('expected a manual Zed step');
    expect(step.manualSnippet).toContain('context_servers');
    expect(step.manualSnippet).toContain('/home/dev/.config/zed/settings.json');
  });

  it('guidance upsert is idempotent and preserves user content byte-for-byte', () => {
    const userText = '# My own rules\n\nDo not touch this.\n';
    const once = upsertGuidanceBlock(userText);
    const twice = upsertGuidanceBlock(once);
    expect(twice).toBe(once);
    expect(once.startsWith(userText.replace(/\n*$/, ''))).toBe(true);
    expect(once).toContain(GUIDANCE_BEGIN);
    expect(once).toContain(GUIDANCE_CARD);
    expect(once).toContain(GUIDANCE_END);
    expect(
      once.match(new RegExp(GUIDANCE_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')),
    ).toHaveLength(1);
  });

  it('applies bridge config + guidance end-to-end with --tools all and injected detection', async () => {
    const dir = mkTempDir();
    const home = join(dir, 'home');
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'GEMINI.md'), '# my gemini rules\n');

    try {
      await runInitCommand(['--auth', 'oauth', '--tools', 'all', '--scope', 'user', '--yes'], {
        cwd: join(dir, 'project'),
        homeDir: home,
        env: {},
        stdout: fakeWriteStream(),
        stderr: fakeWriteStream(),
        detect: {
          homeDir: home,
          platform: 'linux',
          env: {},
          exists: (path) => existsSync(path),
          hasCli: () => false,
        },
      });

      const settings = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'));
      expect(settings.mcpServers.speko.args).toEqual(['-y', '@spekoai/mcp', 'bridge']);
      const rules = readFileSync(join(home, '.gemini', 'GEMINI.md'), 'utf8');
      expect(rules).toContain('# my gemini rules');
      expect(rules).toContain(GUIDANCE_BEGIN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCodexConfig,
  buildCursorConfig,
  buildHttpMcpServersConfig,
  buildInitPlan,
  buildOpenCodeConfig,
  buildVsCodeConfig,
  completeInitArgs,
  DEFAULT_AUTH_MCP_URL,
  httpServerEntry,
  INIT_HELP_TEXT,
  parseInitArgs,
  runInitCommand,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('init authentication arguments', () => {
  it('parses OAuth, tools, and scope', () => {
    expect(
      parseInitArgs([
        '--dry-run',
        '--auth',
        'oauth',
        '--tools',
        'cursor,codex',
        '--scope',
        'project',
        '--yes',
      ]),
    ).toEqual({
      dryRun: true,
      yes: true,
      help: false,
      auth: 'oauth',
      tools: ['cursor', 'codex'],
      scope: 'project',
    });
    expect(INIT_HELP_TEXT).toContain('--auth <oauth|api-key>');
  });

  it('rejects an unknown auth mode', () => {
    expect(() => parseInitArgs(['--auth', 'magic'])).toThrow(/Invalid --auth/);
  });

  it('completes non-interactive arguments', () => {
    expect(
      completeInitArgs(
        parseInitArgs(['--auth', 'api-key', '--tools', 'cursor', '--scope', 'project', '--yes']),
      ),
    ).toMatchObject({ auth: 'api-key', tools: ['cursor'], scope: 'project', yes: true });
  });
});

describe('direct HTTP config builders', () => {
  it('builds a standard direct HTTP server entry', () => {
    expect(httpServerEntry(DEFAULT_AUTH_MCP_URL, true)).toEqual({
      type: 'http',
      url: DEFAULT_AUTH_MCP_URL,
      headers: { Authorization: 'Bearer $' + '{env:SPEKO_API_KEY}' },
    });
    expect(httpServerEntry(DEFAULT_AUTH_MCP_URL, false)).toEqual({
      type: 'http',
      url: DEFAULT_AUTH_MCP_URL,
    });
  });

  it('writes direct HTTP mcpServers JSON without stdio commands', () => {
    const result = buildHttpMcpServersConfig(undefined, DEFAULT_AUTH_MCP_URL, false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.content);
    expect(parsed.mcpServers.speko.url).toBe(DEFAULT_AUTH_MCP_URL);
    expect(parsed.mcpServers.speko.command).toBeUndefined();
    expect(parsed.mcpServers.speko.headers).toBeUndefined();
    expect(result.content).not.toContain('mcp-remote');
    expect(result.content).not.toContain('bridge');
  });

  it('writes native Cursor, VS Code, OpenCode, and Codex configs', () => {
    const cursor = buildCursorConfig(undefined, DEFAULT_AUTH_MCP_URL, true);
    const vscode = buildVsCodeConfig(undefined, DEFAULT_AUTH_MCP_URL, true);
    const opencode = buildOpenCodeConfig(undefined, DEFAULT_AUTH_MCP_URL, true);
    const codex = buildCodexConfig(undefined, DEFAULT_AUTH_MCP_URL, true);
    expect(cursor.ok && cursor.content).toContain('SPEKO_API_KEY');
    expect(vscode.ok && vscode.content).toContain('SPEKO_API_KEY');
    expect(opencode.ok && opencode.content).toContain('"oauth": false');
    expect(codex.ok && codex.content).toContain('bearer_token_env_var = "SPEKO_API_KEY"');
  });

  it('plans only direct HTTP/manual entries', () => {
    const steps = buildInitPlan(
      {
        auth: 'oauth',
        tools: ['claude', 'claude-desktop', 'cursor'],
        scope: 'project',
        dryRun: true,
        yes: true,
      },
      { homeDir: '/home/test', cwd: '/project', platform: 'linux', env: {} },
    );
    expect(steps.every((step) => step.kind !== 'command')).toBe(true);
    expect(steps.map((step) => step.tool)).toEqual(['claude', 'claude-desktop', 'cursor']);
    expect(steps.map((step) => step.manualSnippet).join('\n')).not.toContain('bridge');
  });
});

describe('init execution', () => {
  it('writes a project Cursor config and preserves unrelated fields', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'speko-init-'));
    temporaryDirectories.push(directory);
    const stdout = { write: vi.fn(() => true), isTTY: false } as never;
    const stderr = { write: vi.fn(() => true) } as never;

    await runInitCommand(
      ['--auth', 'api-key', '--tools', 'cursor', '--scope', 'project', '--yes'],
      {
        cwd: directory,
        homeDir: directory,
        env: { SPEKO_API_KEY: 'sk_test' },
        stdout,
        stderr,
      },
    );

    const config = JSON.parse(readFileSync(join(directory, '.cursor', 'mcp.json'), 'utf8'));
    expect(config.mcpServers.speko.url).toBe(DEFAULT_AUTH_MCP_URL);
    expect(config.mcpServers.speko.headers.Authorization).toContain('SPEKO_API_KEY');
  });
});

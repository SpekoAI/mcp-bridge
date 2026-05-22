import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_HEADER_ENV,
  BRIDGE_HELP_TEXT,
  buildAuthHeaderArgs,
  buildProxyArgv,
  DEFAULT_AUTH_MCP_URL,
  HELP_TEXT,
  isCliEntrypoint,
  resolveCliConfig,
  run,
} from '../src/index.js';

describe('spekoai-mcp CLI helpers', () => {
  it('uses the authenticated hosted MCP endpoint by default for the bridge command', () => {
    expect(resolveCliConfig([], {})).toEqual({
      serverUrl: DEFAULT_AUTH_MCP_URL,
      passthroughArgs: [],
      help: false,
    });
  });

  it('uses environment endpoint overrides', () => {
    expect(
      resolveCliConfig([], {
        SPEKOAI_MCP_URL: 'https://mcp-staging.speko.dev/mcp',
      }).serverUrl,
    ).toBe('https://mcp-staging.speko.dev/mcp');
  });

  it('lets a positional URL override the default endpoint', () => {
    expect(resolveCliConfig(['https://example.test/mcp', '--transport', 'http-only'], {})).toEqual({
      serverUrl: 'https://example.test/mcp',
      passthroughArgs: ['--transport', 'http-only'],
      help: false,
    });
  });

  it('detects help without changing pass-through behavior', () => {
    expect(resolveCliConfig(['--help'], {}).help).toBe(true);
    expect(HELP_TEXT).toContain('Usage: spekoai-mcp');
    expect(HELP_TEXT).toContain('spekoai-mcp bridge');
    expect(HELP_TEXT).not.toContain('SPEKOAI_MCP_URL');
    expect(HELP_TEXT).not.toContain('mcp-staging');
    expect(BRIDGE_HELP_TEXT).not.toContain('SPEKOAI_MCP_URL');
    expect(BRIDGE_HELP_TEXT).not.toContain('mcp-staging');
  });

  it('prints top-level help when no command is provided', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(run([], {})).resolves.toBeUndefined();
      expect(write).toHaveBeenCalledWith(HELP_TEXT);
    } finally {
      write.mockRestore();
    }
  });

  it('prints bridge help under the bridge subcommand', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(run(['bridge', '--help'], {})).resolves.toBeUndefined();
      expect(write).toHaveBeenCalledWith(BRIDGE_HELP_TEXT);
    } finally {
      write.mockRestore();
    }
  });

  it('rejects bridge flags at the top level', async () => {
    await expect(run(['--debug'], {})).rejects.toThrow(/Unknown command/);
  });

  it('routes init before proxy argument resolution', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(
        run(
          ['init', '--dry-run', '--auth', 'oauth', '--tools', 'cursor', '--scope', 'project'],
          {},
        ),
      ).resolves.toBeUndefined();
    } finally {
      write.mockRestore();
    }
  });

  it('treats npm .bin symlinks as direct CLI execution', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spekoai-mcp-'));
    try {
      const target = join(dir, 'dist-index.js');
      const symlink = join(dir, 'spekoai-mcp');
      writeFileSync(target, '');
      symlinkSync(target, symlink);

      expect(isCliEntrypoint(symlink, pathToFileURL(target).href)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds a safe env-backed Authorization header when SPEKO_API_KEY is set', () => {
    expect(buildAuthHeaderArgs({ SPEKO_API_KEY: '  sk_test_123  ' })).toEqual({
      args: ['--header', `Authorization:\${${AUTH_HEADER_ENV}}`],
      envValue: 'Bearer sk_test_123',
    });
  });

  it('omits auth header args when no API key is set so OAuth can run', () => {
    expect(buildAuthHeaderArgs({})).toEqual({ args: [] });
  });

  it('builds the mcp-remote argv with auth args before pass-through flags', () => {
    expect(
      buildProxyArgv({
        nodePath: '/node',
        proxyPath: '/proxy.js',
        serverUrl: DEFAULT_AUTH_MCP_URL,
        authArgs: ['--header', `Authorization:\${${AUTH_HEADER_ENV}}`],
        passthroughArgs: ['--debug'],
      }),
    ).toEqual([
      '/node',
      '/proxy.js',
      DEFAULT_AUTH_MCP_URL,
      '--header',
      `Authorization:\${${AUTH_HEADER_ENV}}`,
      '--debug',
    ]);
  });
});

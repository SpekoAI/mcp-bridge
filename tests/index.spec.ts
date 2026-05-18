import { describe, expect, it } from 'vitest';
import {
  AUTH_HEADER_ENV,
  buildAuthHeaderArgs,
  buildProxyArgv,
  DEFAULT_AUTH_MCP_URL,
  DEFAULT_PUBLIC_MCP_URL,
  HELP_TEXT,
  resolveCliConfig,
} from '../src/index.js';

describe('spekoai-mcp CLI helpers', () => {
  it('uses the authenticated hosted MCP endpoint by default', () => {
    expect(resolveCliConfig([], {})).toEqual({
      serverUrl: DEFAULT_AUTH_MCP_URL,
      passthroughArgs: [],
      publicOnly: false,
      help: false,
    });
  });

  it('uses the public endpoint when --public is passed', () => {
    expect(resolveCliConfig(['--public', '--debug'], {})).toEqual({
      serverUrl: DEFAULT_PUBLIC_MCP_URL,
      passthroughArgs: ['--debug'],
      publicOnly: true,
      help: false,
    });
  });

  it('uses environment endpoint overrides for default modes', () => {
    expect(
      resolveCliConfig([], {
        SPEKOAI_MCP_AUTH_URL: 'https://mcp-staging.speko.dev/mcp-auth',
      }).serverUrl,
    ).toBe('https://mcp-staging.speko.dev/mcp-auth');
    expect(
      resolveCliConfig(['--public'], {
        SPEKOAI_MCP_URL: 'https://mcp-staging.speko.dev/mcp',
      }).serverUrl,
    ).toBe('https://mcp-staging.speko.dev/mcp');
  });

  it('lets a positional URL override the default endpoint', () => {
    expect(
      resolveCliConfig(['https://example.test/mcp-auth', '--transport', 'http-only'], {}),
    ).toEqual({
      serverUrl: 'https://example.test/mcp-auth',
      passthroughArgs: ['--transport', 'http-only'],
      publicOnly: false,
      help: false,
    });
  });

  it('detects help without changing pass-through behavior', () => {
    expect(resolveCliConfig(['--help'], {}).help).toBe(true);
    expect(HELP_TEXT).toContain('Usage: spekoai-mcp');
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

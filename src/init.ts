import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { confirm, intro, isCancel, log, multiselect, note, outro, select } from '@clack/prompts';
import { applyEdits, modify, type ParseError, parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { DEFAULT_AUTH_MCP_URL, DEFAULT_PUBLIC_MCP_URL, type Environment } from './constants.js';

export type InitAccess = 'full' | 'docs';
export type InitAuth = 'oauth' | 'api-key';
export type InitScope = 'user' | 'project';
export type InitTool = 'claude' | 'codex' | 'opencode' | 'cursor' | 'other';

type InitArgValue = string | boolean;

export type ParsedInitArgs = {
  access?: InitAccess;
  auth?: InitAuth;
  tools?: InitTool[];
  scope?: InitScope;
  dryRun: boolean;
  yes: boolean;
  help: boolean;
};

export type ResolvedInitOptions = {
  access: InitAccess;
  auth?: InitAuth;
  tools: InitTool[];
  scope: InitScope;
  dryRun: boolean;
  yes: boolean;
};

export type InitPaths = {
  homeDir: string;
  cwd: string;
};

export type FileUpdateResult =
  | { ok: true; content: string }
  | { ok: false; reason: string; manualSnippet: string };

type ToolSpec = {
  tool: InitTool;
  label: string;
};

export type PlannedInitStep =
  | {
      kind: 'command';
      tool: 'claude';
      label: string;
      command: string[];
      manualSnippet: string;
      postInstall?: string;
    }
  | {
      kind: 'file';
      tool: 'codex' | 'opencode' | 'cursor';
      label: string;
      path: string;
      build: (existing: string | undefined) => FileUpdateResult;
      manualSnippet: string;
      postInstall?: string;
    }
  | {
      kind: 'manual';
      tool: InitTool;
      label: string;
      manualSnippet: string;
      postInstall?: string;
    };

type AppliedStep = {
  label: string;
  ok: boolean;
  message: string;
  manualSnippet?: string;
};

type InitDependencies = {
  env?: Environment;
  homeDir?: string;
  cwd?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  timestamp?: () => string;
  runCommand?: (command: readonly string[]) => { ok: boolean; message: string };
};

const TOOL_SPECS: readonly ToolSpec[] = [
  { tool: 'claude', label: 'Claude Code' },
  { tool: 'codex', label: 'Codex' },
  { tool: 'opencode', label: 'OpenCode' },
  { tool: 'cursor', label: 'Cursor' },
  { tool: 'other', label: 'Other clients' },
];

export const DEFAULT_SELECTED_TOOLS: readonly InitTool[] = ['claude', 'opencode'];
export const DEFAULT_SCOPE: InitScope = 'project';

const TOOL_LABELS = new Map(TOOL_SPECS.map((spec) => [spec.tool, spec.label]));

export const INIT_HELP_TEXT = `Usage: spekoai-mcp init [options]

Configure Speko MCP in Claude Code, Codex, OpenCode, Cursor, or another MCP client.

Options:
  --access <full|docs>        full uses ${DEFAULT_AUTH_MCP_URL}; docs uses ${DEFAULT_PUBLIC_MCP_URL}
  --auth <oauth|api-key>      Authentication mode for full access.
  --tools <list>              Comma-separated tools: claude,codex,opencode,cursor,other
  --scope <user|project>      Install globally for the user or in the current project.
  --dry-run                   Print the planned changes without writing files or running commands.
  --yes                       Skip the final confirmation prompt.
  -h, --help                  Print this help text.

Examples:
  spekoai-mcp init
  spekoai-mcp init --dry-run --access docs --tools cursor --scope project --yes
  spekoai-mcp init --access full --auth oauth --tools claude,codex --scope user --yes
`;

export function parseInitArgs(argv: readonly string[]): ParsedInitArgs {
  const parsed: ParsedInitArgs = { dryRun: false, yes: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--yes':
      case '-y':
        parsed.yes = true;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      case '--access':
        parsed.access = parseAccess(readFlagValue(argv, index, arg));
        index += 1;
        break;
      case '--auth':
        parsed.auth = parseAuth(readFlagValue(argv, index, arg));
        index += 1;
        break;
      case '--tools':
        parsed.tools = parseTools(readFlagValue(argv, index, arg));
        index += 1;
        break;
      case '--scope':
        parsed.scope = parseScope(readFlagValue(argv, index, arg));
        index += 1;
        break;
      default:
        if (arg.startsWith('--access=')) {
          parsed.access = parseAccess(readInlineFlagValue(arg));
        } else if (arg.startsWith('--auth=')) {
          parsed.auth = parseAuth(readInlineFlagValue(arg));
        } else if (arg.startsWith('--tools=')) {
          parsed.tools = parseTools(readInlineFlagValue(arg));
        } else if (arg.startsWith('--scope=')) {
          parsed.scope = parseScope(readInlineFlagValue(arg));
        } else {
          throw new Error(`Unknown init option: ${arg}`);
        }
    }
  }

  return parsed;
}

export function completeInitArgs(parsed: ParsedInitArgs): ResolvedInitOptions {
  const missing: string[] = [];
  if (!parsed.access) missing.push('--access');
  if (parsed.access === 'full' && !parsed.auth) missing.push('--auth');
  if (!parsed.tools?.length) missing.push('--tools');
  if (!parsed.scope) missing.push('--scope');
  if (!parsed.dryRun && !parsed.yes) missing.push('--yes or --dry-run');

  if (missing.length > 0) {
    throw new Error(
      `spekoai-mcp init is running non-interactively. Provide ${missing.join(
        ', ',
      )} or run it in an interactive terminal.`,
    );
  }

  const access = parsed.access;
  const tools = parsed.tools;
  const scope = parsed.scope;
  if (!access || !tools?.length || !scope) {
    throw new Error('spekoai-mcp init options are incomplete.');
  }

  return {
    access,
    auth: access === 'full' ? parsed.auth : undefined,
    tools,
    scope,
    dryRun: parsed.dryRun,
    yes: parsed.yes,
  } satisfies ResolvedInitOptions;
}

export function endpointForAccess(access: InitAccess): string {
  return access === 'full' ? DEFAULT_AUTH_MCP_URL : DEFAULT_PUBLIC_MCP_URL;
}

export function isApiKeyAuth(options: Pick<ResolvedInitOptions, 'access' | 'auth'>): boolean {
  return options.access === 'full' && options.auth === 'api-key';
}

export function buildCursorConfig(
  existing: string | undefined,
  endpoint: string,
  apiKeyAuth: boolean,
): FileUpdateResult {
  const server = apiKeyAuth
    ? {
        url: endpoint,
        headers: {
          Authorization: `Bearer $${'{env:SPEKO_API_KEY}'}`,
        },
      }
    : { url: endpoint };

  return updateJsonc(
    existing,
    ['mcpServers', 'speko'],
    server,
    cursorSnippet(endpoint, apiKeyAuth),
  );
}

export function buildOpenCodeConfig(
  existing: string | undefined,
  endpoint: string,
  apiKeyAuth: boolean,
): FileUpdateResult {
  const server = apiKeyAuth
    ? {
        type: 'remote',
        url: endpoint,
        oauth: false,
        headers: {
          Authorization: 'Bearer {env:SPEKO_API_KEY}',
        },
        enabled: true,
      }
    : {
        type: 'remote',
        url: endpoint,
        enabled: true,
      };

  const withSchema = updateJsonc(
    existing,
    ['$schema'],
    'https://opencode.ai/config.json',
    openCodeSnippet(endpoint, apiKeyAuth),
  );
  if (!withSchema.ok) return withSchema;

  return updateJsonc(
    withSchema.content,
    ['mcp', 'speko'],
    server,
    openCodeSnippet(endpoint, apiKeyAuth),
  );
}

export function buildCodexConfig(
  existing: string | undefined,
  endpoint: string,
  apiKeyAuth: boolean,
): FileUpdateResult {
  const source = existing ?? '';
  try {
    parseToml(source || '');
  } catch (error) {
    return {
      ok: false,
      reason: `Could not parse existing TOML: ${error instanceof Error ? error.message : String(error)}`,
      manualSnippet: codexSnippet(endpoint, apiKeyAuth),
    };
  }

  const nextBlock = codexSnippet(endpoint, apiKeyAuth);
  const withoutExisting = source.replace(
    /(^|\r?\n)\[mcp_servers\.speko\]\r?\n(?:(?!\r?\n\[).)*(?:\r?\n)?/s,
    '$1',
  );
  const trimmed = withoutExisting.replace(/\s+$/, '');
  const content = `${trimmed ? `${trimmed}\n\n` : ''}${nextBlock}\n`;

  try {
    parseToml(content);
  } catch (error) {
    return {
      ok: false,
      reason: `Generated TOML failed validation: ${
        error instanceof Error ? error.message : String(error)
      }`,
      manualSnippet: nextBlock,
    };
  }

  return { ok: true, content };
}

export function buildInitPlan(options: ResolvedInitOptions, paths: InitPaths): PlannedInitStep[] {
  const endpoint = endpointForAccess(options.access);
  const apiKeyAuth = isApiKeyAuth(options);
  const steps: PlannedInitStep[] = [];

  for (const tool of options.tools) {
    if (tool === 'claude') {
      steps.push(buildClaudeStep(options, endpoint, apiKeyAuth));
    } else if (tool === 'codex') {
      steps.push({
        kind: 'file',
        tool,
        label: 'Codex config',
        path: join(paths.homeDir, '.codex', 'config.toml'),
        build: (existing) => buildCodexConfig(existing, endpoint, apiKeyAuth),
        manualSnippet: codexSnippet(endpoint, apiKeyAuth),
        postInstall:
          options.access === 'full' && !apiKeyAuth ? 'Run: codex mcp login speko' : undefined,
      });
    } else if (tool === 'opencode') {
      const configPath =
        options.scope === 'user'
          ? join(paths.homeDir, '.config', 'opencode', 'opencode.json')
          : join(paths.cwd, 'opencode.json');
      steps.push({
        kind: 'file',
        tool,
        label: 'OpenCode config',
        path: configPath,
        build: (existing) => buildOpenCodeConfig(existing, endpoint, apiKeyAuth),
        manualSnippet: openCodeSnippet(endpoint, apiKeyAuth),
        postInstall:
          options.access === 'full' && !apiKeyAuth ? 'Run: opencode mcp auth speko' : undefined,
      });
    } else if (tool === 'cursor') {
      const configPath =
        options.scope === 'user'
          ? join(paths.homeDir, '.cursor', 'mcp.json')
          : join(paths.cwd, '.cursor', 'mcp.json');
      steps.push({
        kind: 'file',
        tool,
        label: 'Cursor config',
        path: configPath,
        build: (existing) => buildCursorConfig(existing, endpoint, apiKeyAuth),
        manualSnippet: cursorSnippet(endpoint, apiKeyAuth),
      });
    } else {
      steps.push({
        kind: 'manual',
        tool,
        label: 'Other MCP clients',
        manualSnippet: otherClientSnippet(endpoint, options.access, apiKeyAuth),
      });
    }
  }

  return steps;
}

export function renderPlanSummary(
  options: ResolvedInitOptions,
  steps: readonly PlannedInitStep[],
): string {
  const endpoint = endpointForAccess(options.access);
  const lines = [
    `Access: ${options.access === 'full' ? 'Full access' : 'Docs and scaffolds only'}`,
    `Endpoint: ${endpoint}`,
    `Auth: ${options.access === 'full' ? (options.auth === 'api-key' ? 'SPEKO_API_KEY' : 'OAuth') : 'None'}`,
    `Scope: ${options.scope}`,
    '',
    'Planned changes:',
    ...steps.map((step) => {
      if (step.kind === 'command') {
        return `- ${step.label}: run ${formatCommand(step.command)}`;
      }
      if (step.kind === 'file') {
        return `- ${step.label}: update ${step.path}`;
      }
      return `- ${step.label}: print manual Streamable HTTP settings`;
    }),
  ];

  const postInstall = steps
    .map((step) => step.postInstall)
    .filter((value): value is string => Boolean(value));
  if (postInstall.length > 0) {
    lines.push('', 'After configuring:', ...postInstall.map((step) => `- ${step}`));
  }

  return lines.join('\n');
}

export async function runInitCommand(
  argv: readonly string[] = process.argv.slice(2),
  deps: InitDependencies = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const parsed = parseInitArgs(argv);

  if (parsed.help) {
    stdout.write(INIT_HELP_TEXT);
    return;
  }

  const interactive = Boolean((deps.stdin ?? process.stdin).isTTY && stdout.isTTY);
  const options = interactive ? await promptForMissingOptions(parsed) : completeInitArgs(parsed);
  const paths = {
    homeDir: deps.homeDir ?? env.HOME ?? homedir(),
    cwd: deps.cwd ?? process.cwd(),
  };
  const steps = buildInitPlan(options, paths);
  const summary = renderPlanSummary(options, steps);

  if (interactive) {
    note(summary, options.dryRun ? 'Dry run' : 'Ready to configure Speko MCP');
  } else {
    stdout.write(`${summary}\n`);
  }

  if (options.dryRun) {
    stdout.write(`${renderManualSnippets(steps)}\n`);
    printApiKeyReminder(options, env, stdout);
    return;
  }

  if (!options.yes) {
    const shouldApply = await confirm({ message: 'Apply these changes?' });
    if (isCancel(shouldApply) || !shouldApply) {
      cancelInit('No changes applied.');
      return;
    }
  }

  const applied = await applyInitPlan(steps, {
    timestamp: deps.timestamp ?? defaultTimestamp,
    runCommand: deps.runCommand ?? runExternalCommand,
  });

  const resultText = renderAppliedSteps(applied);
  if (interactive) {
    outro(resultText);
  } else {
    stdout.write(`${resultText}\n`);
  }
  stdout.write(`${renderManualSnippets(steps.filter((step) => step.kind === 'manual'))}\n`);
  stdout.write(`${renderFailedManualSnippets(applied)}\n`);
  printApiKeyReminder(options, env, stdout);

  const failures = applied.filter((step) => !step.ok);
  if (failures.length > 0) {
    stderr.write(
      `Some selected tools were not configured automatically. Use the printed manual snippets for those tools.\n`,
    );
  }
}

async function promptForMissingOptions(parsed: ParsedInitArgs): Promise<ResolvedInitOptions> {
  intro('Configure Speko MCP');

  const access =
    parsed.access ??
    (await promptValue<InitAccess>(
      select({
        message: 'Which Speko MCP endpoint do you want?',
        options: [
          {
            value: 'full',
            label: 'Full Speko account access',
            hint: 'private actions like balance, logs, builds, tests, deploys, plus docs',
          },
          {
            value: 'docs',
            label: 'Public docs and scaffolds only',
            hint: 'no sign-in; docs, package guidance, recommendations, and example scaffolds',
          },
        ],
      }),
    ));

  const auth =
    access === 'full'
      ? (parsed.auth ??
        (await promptValue<InitAuth>(
          select({
            message: 'How should full access authenticate?',
            options: [
              { value: 'oauth', label: 'OAuth', hint: 'recommended when your tool supports it' },
              { value: 'api-key', label: 'SPEKO_API_KEY', hint: 'uses an environment variable' },
            ],
          }),
        )))
      : undefined;

  const tools =
    parsed.tools ??
    (await promptValue<InitTool[]>(
      multiselect({
        message: 'Which coding tools should be configured?',
        required: true,
        initialValues: [...DEFAULT_SELECTED_TOOLS],
        options: TOOL_SPECS.map((spec) => ({ value: spec.tool, label: spec.label })),
      }),
    ));

  const scope =
    parsed.scope ??
    (await promptValue<InitScope>(
      select({
        message: 'Where should supported configs be written?',
        initialValue: DEFAULT_SCOPE,
        options: [
          { value: 'project', label: 'Current project config' },
          { value: 'user', label: 'Global/user config' },
        ],
      }),
    ));

  return {
    access,
    auth,
    tools,
    scope,
    dryRun: parsed.dryRun,
    yes: parsed.yes,
  };
}

async function promptValue<T>(value: Promise<T | symbol>): Promise<T> {
  const resolved = await value;
  if (isCancel(resolved)) {
    cancelInit('No changes applied.');
    throw new Error('Init cancelled.');
  }
  return resolved;
}

function cancelInit(message: string): void {
  log.warn(message);
  outro('Cancelled');
}

async function applyInitPlan(
  steps: readonly PlannedInitStep[],
  deps: Required<Pick<InitDependencies, 'timestamp' | 'runCommand'>>,
): Promise<AppliedStep[]> {
  const applied: AppliedStep[] = [];
  const timestamp = deps.timestamp();

  for (const step of steps) {
    if (step.kind === 'manual') {
      applied.push({ label: step.label, ok: true, message: 'Manual instructions printed.' });
      continue;
    }

    if (step.kind === 'command') {
      const result = deps.runCommand(step.command);
      applied.push({
        label: step.label,
        ok: result.ok,
        message: result.message,
        manualSnippet: result.ok ? undefined : step.manualSnippet,
      });
      continue;
    }

    const existing = existsSync(step.path) ? readFileSync(step.path, 'utf8') : undefined;
    const next = step.build(existing);
    if (!next.ok) {
      applied.push({
        label: step.label,
        ok: false,
        message: next.reason,
        manualSnippet: next.manualSnippet,
      });
      continue;
    }
    if (existing === next.content) {
      applied.push({ label: step.label, ok: true, message: `Already up to date: ${step.path}` });
      continue;
    }
    mkdirSync(dirname(step.path), { recursive: true });
    if (existing !== undefined) {
      const backupPath = `${step.path}.${timestamp}.bak`;
      await copyFile(step.path, backupPath);
    }
    writeFileSync(step.path, next.content);
    applied.push({ label: step.label, ok: true, message: `Updated ${step.path}` });
  }

  return applied;
}

function buildClaudeStep(
  options: ResolvedInitOptions,
  endpoint: string,
  apiKeyAuth: boolean,
): PlannedInitStep {
  const manualSnippet = claudeSnippet(endpoint, options.scope, apiKeyAuth);
  if (apiKeyAuth) {
    return {
      kind: 'manual',
      tool: 'claude',
      label: 'Claude Code',
      manualSnippet,
    };
  }

  return {
    kind: 'command',
    tool: 'claude',
    label: 'Claude Code',
    command: [
      'claude',
      'mcp',
      'add',
      '--transport',
      'http',
      '--scope',
      options.scope,
      'speko',
      endpoint,
    ],
    manualSnippet,
    postInstall:
      options.access === 'full' ? 'In Claude Code, run /mcp and complete sign-in.' : undefined,
  };
}

function updateJsonc(
  existing: string | undefined,
  path: readonly (string | number)[],
  value: unknown,
  manualSnippet: string,
): FileUpdateResult {
  const source = existing?.trim() ? existing : '{}\n';
  const errors: ParseError[] = [];
  const parsed = parseJsonc(source, errors, { allowTrailingComma: true, disallowComments: false });

  if (errors.length > 0) {
    return {
      ok: false,
      reason: `Could not parse existing JSON/JSONC config.`,
      manualSnippet,
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      reason: 'Existing JSON/JSONC config root is not an object.',
      manualSnippet,
    };
  }

  const edits = modify(source, [...path], value as InitArgValue, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol: '\n',
    },
  });

  return { ok: true, content: ensureTrailingNewline(applyEdits(source, edits)) };
}

function codexSnippet(endpoint: string, apiKeyAuth: boolean): string {
  return `[mcp_servers.speko]
url = "${endpoint}"${apiKeyAuth ? '\nbearer_token_env_var = "SPEKO_API_KEY"' : ''}`;
}

function openCodeSnippet(endpoint: string, apiKeyAuth: boolean): string {
  const server = apiKeyAuth
    ? `{
      "type": "remote",
      "url": "${endpoint}",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:SPEKO_API_KEY}"
      },
      "enabled": true
    }`
    : `{
      "type": "remote",
      "url": "${endpoint}",
      "enabled": true
    }`;

  return `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "speko": ${server}
  }
}`;
}

function cursorSnippet(endpoint: string, apiKeyAuth: boolean): string {
  const server = apiKeyAuth
    ? `{
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer $${'{env:SPEKO_API_KEY}'}"
      }
    }`
    : `{
      "url": "${endpoint}"
    }`;

  return `{
  "mcpServers": {
    "speko": ${server}
  }
}`;
}

function claudeSnippet(endpoint: string, scope: InitScope, apiKeyAuth: boolean): string {
  return apiKeyAuth
    ? `claude mcp add --transport http --scope ${scope} speko ${endpoint} \\
  --header "Authorization: Bearer sk_live_xxx"`
    : `claude mcp add --transport http --scope ${scope} speko ${endpoint}`;
}

function otherClientSnippet(endpoint: string, access: InitAccess, apiKeyAuth: boolean): string {
  const auth =
    access === 'docs'
      ? 'Authentication: None'
      : apiKeyAuth
        ? 'API key auth: Send Authorization: Bearer sk_live_xxx'
        : "OAuth: Use the client's OAuth flow";

  return `Name: speko
URL: ${endpoint}
${auth}`;
}

function renderManualSnippets(steps: readonly PlannedInitStep[]): string {
  const snippets = steps
    .filter((step) => step.kind === 'manual')
    .map((step) => `${step.label}:\n${step.manualSnippet}`);

  return snippets.length > 0 ? `\nManual steps:\n\n${snippets.join('\n\n')}\n` : '';
}

function renderAppliedSteps(steps: readonly AppliedStep[]): string {
  return steps
    .map((step) => `${step.ok ? 'OK' : 'SKIP'} ${step.label}: ${step.message}`)
    .join('\n');
}

function renderFailedManualSnippets(steps: readonly AppliedStep[]): string {
  const snippets = steps
    .filter((step) => !step.ok && step.manualSnippet)
    .map((step) => `${step.label}:\n${step.manualSnippet}`);

  return snippets.length > 0 ? `\nManual fallback:\n\n${snippets.join('\n\n')}\n` : '';
}

function printApiKeyReminder(
  options: ResolvedInitOptions,
  env: Environment,
  stdout: NodeJS.WriteStream,
): void {
  if (!isApiKeyAuth(options) || env.SPEKO_API_KEY?.trim()) {
    return;
  }
  stdout.write(
    `\nSPEKO_API_KEY is not set. Before using API-key auth, run:\n${apiKeyExportCommand(
      env.SHELL,
    )}\n`,
  );
}

function apiKeyExportCommand(shell: string | undefined): string {
  if (shell?.endsWith('/fish')) {
    return 'set -gx SPEKO_API_KEY sk_live_xxx';
  }
  if (process.platform === 'win32') {
    return '$env:SPEKO_API_KEY = "sk_live_xxx"';
  }
  return 'export SPEKO_API_KEY=sk_live_xxx';
}

function runExternalCommand(command: readonly string[]): { ok: boolean; message: string } {
  const result = spawnSync(command[0] ?? '', command.slice(1), {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.error) {
    return { ok: false, message: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      message: result.stderr.trim() || result.stdout.trim() || `Exited with ${result.status}`,
    };
  }
  return { ok: true, message: `Ran ${formatCommand(command)}` };
}

function formatCommand(command: readonly string[]): string {
  return command.map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value);
}

function defaultTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFlagValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function readInlineFlagValue(arg: string): string {
  const value = arg.slice(arg.indexOf('=') + 1);
  if (!value) {
    throw new Error(`Missing value for ${arg.slice(0, arg.indexOf('='))}`);
  }
  return value;
}

function parseAccess(value: string): InitAccess {
  if (value === 'full' || value === 'docs') return value;
  throw new Error(`Invalid --access value: ${value}`);
}

function parseAuth(value: string): InitAuth {
  if (value === 'oauth' || value === 'api-key') return value;
  throw new Error(`Invalid --auth value: ${value}`);
}

function parseScope(value: string): InitScope {
  if (value === 'user' || value === 'project') return value;
  throw new Error(`Invalid --scope value: ${value}`);
}

function parseTools(value: string): InitTool[] {
  const tools = value
    .split(',')
    .map((item) => normalizeTool(item.trim()))
    .filter((item): item is InitTool => Boolean(item));

  if (tools.length === 0) {
    throw new Error('At least one tool is required.');
  }

  return Array.from(new Set(tools));
}

function normalizeTool(value: string): InitTool | undefined {
  if (!value) return undefined;
  if (value === 'claude-code' || value === 'claude_code') return 'claude';
  if (TOOL_LABELS.has(value as InitTool)) return value as InitTool;
  throw new Error(`Invalid tool: ${value}`);
}

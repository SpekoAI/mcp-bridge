import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { confirm, intro, isCancel, log, multiselect, note, outro, select } from '@clack/prompts';
import { applyEdits, modify, type ParseError, parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { DEFAULT_AUTH_MCP_URL, type Environment } from './constants.js';
import {
  claudeDesktopConfigPath,
  clineSettingsPath,
  type DetectCtx,
  detectInstalledTools,
  realDetectCtx,
  vscodeUserDir,
  windsurfDir,
  zedSettingsPath,
} from './detect.js';
import {
  standaloneGuidanceContent,
  upsertGuidanceBlock,
  VSCODE_INSTRUCTIONS_FRONTMATTER,
} from './guidance.js';

export type InitAuth = 'oauth' | 'api-key';
export type InitScope = 'user' | 'project';
export type InitTool =
  | 'claude'
  | 'claude-desktop'
  | 'codex'
  | 'opencode'
  | 'cursor'
  | 'windsurf'
  | 'vscode'
  | 'gemini'
  | 'cline'
  | 'zed'
  | 'other';

type InitArgValue = string | boolean;

export type ParsedInitArgs = {
  auth?: InitAuth;
  tools?: InitTool[];
  /** `--tools all`: resolve to the detected agent set at run time. */
  toolsAll?: boolean;
  scope?: InitScope;
  dryRun: boolean;
  yes: boolean;
  help: boolean;
};

export type ResolvedInitOptions = {
  auth: InitAuth;
  tools: InitTool[];
  scope: InitScope;
  dryRun: boolean;
  yes: boolean;
};

export type InitPaths = {
  homeDir: string;
  cwd: string;
  /** Platform for per-vendor config paths (Claude Desktop, VS Code, Cline, Zed). */
  platform?: NodeJS.Platform;
  /** Env for per-vendor path overrides (APPDATA) and API-key interpolation. */
  env?: Environment;
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
      tool: Exclude<InitTool, 'other'>;
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
  postInstall?: string;
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
  /** Agent-detection probes — injectable so tests never touch the real machine. */
  detect?: DetectCtx;
};

const TOOL_SPECS: readonly ToolSpec[] = [
  { tool: 'claude', label: 'Claude Code' },
  { tool: 'claude-desktop', label: 'Claude Desktop' },
  { tool: 'codex', label: 'Codex' },
  { tool: 'opencode', label: 'OpenCode' },
  { tool: 'cursor', label: 'Cursor' },
  { tool: 'windsurf', label: 'Windsurf' },
  { tool: 'vscode', label: 'VS Code' },
  { tool: 'gemini', label: 'Gemini CLI' },
  { tool: 'cline', label: 'Cline' },
  { tool: 'zed', label: 'Zed' },
  { tool: 'other', label: 'Other clients' },
];

export const DEFAULT_SELECTED_TOOLS: readonly InitTool[] = ['claude'];
export const DEFAULT_SCOPE: InitScope = 'project';

const TOOL_LABELS = new Map(TOOL_SPECS.map((spec) => [spec.tool, spec.label]));

export const INIT_HELP_TEXT = `Usage: spekoai-mcp init [options]

Configure Speko MCP in your coding agents. Detects what is installed (Claude
Code/Desktop, Codex, OpenCode, Cursor, Windsurf, VS Code, Gemini CLI, Cline,
Zed) and writes each agent's config in its own convention.

Options:
  --auth <oauth|api-key>      Authentication mode for ${DEFAULT_AUTH_MCP_URL}.
  --tools <list|all>          "all" = every detected agent, or a comma list:
                              claude,claude-desktop,codex,opencode,cursor,windsurf,vscode,gemini,cline,zed,other
  --scope <user|project>      Install globally for the user or in the current project.
  --dry-run                   Print the planned changes without writing files or running commands.
  --yes                       Skip the final confirmation prompt.
  -h, --help                  Print this help text.

Examples:
  spekoai-mcp init
  spekoai-mcp init --auth oauth --tools all --scope user --yes
  spekoai-mcp init --dry-run --auth oauth --tools cursor,windsurf --scope project --yes
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
      case '--auth':
        parsed.auth = parseAuth(readFlagValue(argv, index, arg));
        index += 1;
        break;
      case '--tools':
        applyToolsFlag(parsed, readFlagValue(argv, index, arg));
        index += 1;
        break;
      case '--scope':
        parsed.scope = parseScope(readFlagValue(argv, index, arg));
        index += 1;
        break;
      default:
        if (arg.startsWith('--auth=')) {
          parsed.auth = parseAuth(readInlineFlagValue(arg));
        } else if (arg.startsWith('--tools=')) {
          applyToolsFlag(parsed, readInlineFlagValue(arg));
        } else if (arg.startsWith('--scope=')) {
          parsed.scope = parseScope(readInlineFlagValue(arg));
        } else {
          throw new Error(`Unknown init option: ${arg}`);
        }
    }
  }

  return parsed;
}

export function completeInitArgs(
  parsed: ParsedInitArgs,
  detected: readonly InitTool[] = [],
): ResolvedInitOptions {
  const missing: string[] = [];
  if (!parsed.auth) missing.push('--auth');
  if (!parsed.toolsAll && !parsed.tools?.length) missing.push('--tools');
  if (!parsed.scope) missing.push('--scope');
  if (!parsed.dryRun && !parsed.yes) missing.push('--yes or --dry-run');

  if (missing.length > 0) {
    throw new Error(
      `spekoai-mcp init is running non-interactively. Provide ${missing.join(
        ', ',
      )} or run it in an interactive terminal.`,
    );
  }

  const auth = parsed.auth;
  const tools = parsed.toolsAll ? [...detected] : parsed.tools;
  const scope = parsed.scope;
  if (parsed.toolsAll && (!tools || tools.length === 0)) {
    throw new Error(
      '--tools all found no supported coding agents on this machine. Name them explicitly, e.g. --tools claude,cursor.',
    );
  }
  if (!auth || !tools?.length || !scope) {
    throw new Error('spekoai-mcp init options are incomplete.');
  }

  return {
    auth,
    tools,
    scope,
    dryRun: parsed.dryRun,
    yes: parsed.yes,
  } satisfies ResolvedInitOptions;
}

export function isApiKeyAuth(options: Pick<ResolvedInitOptions, 'auth'>): boolean {
  return options.auth === 'api-key';
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

/**
 * The stdio-bridge server entry for agents that cannot talk to a remote HTTP
 * MCP directly (Claude Desktop, Windsurf, Gemini CLI, Cline, Zed). One source
 * of truth so no agent can be handed a different invocation than the others.
 *
 * Auth: with OAuth the bridge's mcp-remote proxy runs the browser sign-in on
 * first connect (no secret in the file). With API-key auth we interpolate the
 * key from SPEKO_API_KEY when it's set in the current environment (GUI apps
 * don't inherit shell exports, so an env-var reference would silently fail);
 * when unset, a placeholder + edit instruction is the honest fallback.
 */
export function bridgeServerEntry(
  apiKeyAuth: boolean,
  env: Environment = {},
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    command: 'npx',
    args: ['-y', '@spekoai/mcp', 'bridge'],
  };
  if (apiKeyAuth) {
    entry['env'] = { SPEKO_API_KEY: env.SPEKO_API_KEY?.trim() || 'sk_live_xxx' };
  }
  return entry;
}

/** True when an API-key config had to be written with the sk_live_xxx placeholder. */
function usedKeyPlaceholder(apiKeyAuth: boolean, env: Environment): boolean {
  return apiKeyAuth && !env.SPEKO_API_KEY?.trim();
}

/** Windsurf, Gemini CLI, Claude Desktop: standard `mcpServers` JSON with a stdio bridge entry. */
export function buildBridgeMcpServersConfig(
  existing: string | undefined,
  apiKeyAuth: boolean,
  env: Environment,
  extraFields: Record<string, unknown> = {},
): FileUpdateResult {
  const server = { ...bridgeServerEntry(apiKeyAuth, env), ...extraFields };
  return updateJsonc(
    existing,
    ['mcpServers', 'speko'],
    server,
    bridgeMcpServersSnippet(apiKeyAuth, env, extraFields),
  );
}

/**
 * VS Code (GitHub Copilot agent mode): native remote HTTP support via the
 * user-profile `mcp.json` — root key is `servers` (not `mcpServers`) and the
 * entry carries an explicit `"type": "http"`. OAuth is handled by VS Code
 * itself; API-key auth uses VS Code's `${env:VAR}` interpolation.
 */
export function buildVsCodeConfig(
  existing: string | undefined,
  endpoint: string,
  apiKeyAuth: boolean,
): FileUpdateResult {
  const server = apiKeyAuth
    ? {
        type: 'http',
        url: endpoint,
        headers: {
          Authorization: `Bearer $${'{env:SPEKO_API_KEY}'}`,
        },
      }
    : { type: 'http', url: endpoint };

  return updateJsonc(existing, ['servers', 'speko'], server, vscodeSnippet(endpoint, apiKeyAuth));
}

export function buildInitPlan(options: ResolvedInitOptions, paths: InitPaths): PlannedInitStep[] {
  const endpoint = DEFAULT_AUTH_MCP_URL;
  const apiKeyAuth = isApiKeyAuth(options);
  const env = paths.env ?? {};
  const platform = paths.platform ?? process.platform;
  const pathCtx = { homeDir: paths.homeDir, platform, env };
  const bridgePostInstall = apiKeyAuth
    ? usedKeyPlaceholder(apiKeyAuth, env)
      ? 'Replace sk_live_xxx in the written config with your real SPEKO_API_KEY.'
      : undefined
    : 'First connect runs a browser sign-in to Speko (mcp-remote OAuth).';
  const steps: PlannedInitStep[] = [];

  for (const tool of options.tools) {
    if (tool === 'claude') {
      steps.push(buildClaudeStep(options, endpoint, apiKeyAuth));
    } else if (tool === 'claude-desktop') {
      steps.push({
        kind: 'file',
        tool,
        label: 'Claude Desktop config',
        path: claudeDesktopConfigPath(pathCtx),
        build: (existing) => buildBridgeMcpServersConfig(existing, apiKeyAuth, env),
        manualSnippet: bridgeMcpServersSnippet(apiKeyAuth, env),
        postInstall:
          bridgePostInstall ?? 'Fully quit (Cmd/Ctrl+Q) and reopen Claude Desktop for it to load.',
      });
    } else if (tool === 'windsurf') {
      steps.push({
        kind: 'file',
        tool,
        label: 'Windsurf config',
        path: join(windsurfDir(pathCtx), 'mcp_config.json'),
        build: (existing) => buildBridgeMcpServersConfig(existing, apiKeyAuth, env),
        manualSnippet: bridgeMcpServersSnippet(apiKeyAuth, env),
        postInstall: bridgePostInstall,
      });
      steps.push(
        guidanceAppendStep(
          tool,
          'Windsurf usage guide',
          join(windsurfDir(pathCtx), 'memories', 'global_rules.md'),
        ),
      );
    } else if (tool === 'vscode') {
      steps.push({
        kind: 'file',
        tool,
        label: 'VS Code config',
        path: join(vscodeUserDir(pathCtx), 'mcp.json'),
        build: (existing) => buildVsCodeConfig(existing, endpoint, apiKeyAuth),
        manualSnippet: vscodeSnippet(endpoint, apiKeyAuth),
        postInstall: 'Reload the VS Code window to load it.',
      });
      steps.push(
        guidanceFileStep(
          tool,
          'VS Code usage guide',
          join(vscodeUserDir(pathCtx), 'prompts', 'speko-mcp.instructions.md'),
          VSCODE_INSTRUCTIONS_FRONTMATTER,
        ),
      );
    } else if (tool === 'gemini') {
      steps.push({
        kind: 'file',
        tool,
        label: 'Gemini CLI config',
        path: join(paths.homeDir, '.gemini', 'settings.json'),
        build: (existing) => buildBridgeMcpServersConfig(existing, apiKeyAuth, env),
        manualSnippet: bridgeMcpServersSnippet(apiKeyAuth, env),
        postInstall: bridgePostInstall,
      });
      steps.push(
        guidanceAppendStep(
          tool,
          'Gemini CLI usage guide',
          join(paths.homeDir, '.gemini', 'GEMINI.md'),
        ),
      );
    } else if (tool === 'cline') {
      steps.push({
        kind: 'file',
        tool,
        label: 'Cline config',
        path: clineSettingsPath(pathCtx),
        build: (existing) =>
          buildBridgeMcpServersConfig(existing, apiKeyAuth, env, {
            disabled: false,
            autoApprove: [],
          }),
        manualSnippet: bridgeMcpServersSnippet(apiKeyAuth, env, {
          disabled: false,
          autoApprove: [],
        }),
        postInstall: bridgePostInstall,
      });
      steps.push(
        guidanceFileStep(
          tool,
          'Cline usage guide',
          join(paths.homeDir, 'Documents', 'Cline', 'Rules', 'speko-mcp.md'),
        ),
      );
    } else if (tool === 'zed') {
      // Zed's settings.json is user-owned JSONC that commonly carries comments
      // and trailing structure — a merge gone wrong bricks the editor config,
      // so Zed stays a printed snippet (same call the calls wizard made).
      steps.push({
        kind: 'manual',
        tool,
        label: 'Zed',
        manualSnippet: zedSnippet(apiKeyAuth, env, zedSettingsPath(pathCtx)),
      });
    } else if (tool === 'codex') {
      steps.push({
        kind: 'file',
        tool,
        label: 'Codex config',
        path: join(paths.homeDir, '.codex', 'config.toml'),
        build: (existing) => buildCodexConfig(existing, endpoint, apiKeyAuth),
        manualSnippet: codexSnippet(endpoint, apiKeyAuth),
        postInstall: !apiKeyAuth ? 'Run: codex mcp login speko' : undefined,
      });
      steps.push(
        guidanceAppendStep(tool, 'Codex usage guide', join(paths.homeDir, '.codex', 'AGENTS.md')),
      );
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
        postInstall: !apiKeyAuth ? 'Run: opencode mcp auth speko' : undefined,
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
        manualSnippet: otherClientSnippet(endpoint, apiKeyAuth),
      });
    }
  }

  return steps;
}

export function renderPlanSummary(
  options: ResolvedInitOptions,
  steps: readonly PlannedInitStep[],
): string {
  const endpoint = DEFAULT_AUTH_MCP_URL;
  const lines = [
    `Endpoint: ${endpoint}`,
    `Auth: ${options.auth === 'api-key' ? 'SPEKO_API_KEY' : 'OAuth'}`,
    `Scope: ${options.scope}`,
    '',
    'Planned changes:',
    ...steps.map((step) => {
      if (step.kind === 'command') {
        return `- ${step.label}: run command: ${formatCommand(step.command)}`;
      }
      if (step.kind === 'file') {
        return `- ${step.label}: update file: ${step.path}`;
      }
      return `- ${step.label}: print manual Streamable HTTP settings`;
    }),
  ];

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

  const homeDir = deps.homeDir ?? env.HOME ?? homedir();
  const interactive = Boolean((deps.stdin ?? process.stdin).isTTY && stdout.isTTY);

  // Detect installed agents when the selection depends on it: the interactive
  // multiselect preselects the detected set, and non-interactive `--tools all`
  // resolves to exactly that set. Explicit `--tools a,b` runs skip the probes
  // entirely (they spawn real CLIs), keeping scripted runs fast and hermetic.
  const detectCtx = deps.detect ?? realDetectCtx(homeDir, env);
  const needsDetection = interactive || parsed.toolsAll === true;
  const detected = needsDetection ? detectInstalledTools(detectCtx) : [];

  const options = interactive
    ? await promptForMissingOptions(parsed, detected)
    : completeInitArgs(parsed, detected);
  const paths = {
    homeDir,
    cwd: deps.cwd ?? process.cwd(),
    platform: detectCtx.platform,
    env,
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
  const manualText = renderManualSnippets(steps.filter((step) => step.kind === 'manual'));
  const failedManualText = renderFailedManualSnippets(applied);
  const postInstallText = renderPostInstallSteps(applied);
  if (interactive) {
    const hasFailures = applied.some((step) => !step.ok);
    if (hasFailures) {
      log.warn(resultText);
    } else {
      log.success(resultText);
    }
    stdout.write(manualText);
    stdout.write(failedManualText);
    if (postInstallText) {
      log.step(postInstallText);
    }
    outro(hasFailures ? 'Finished with issues' : 'Done');
  } else {
    stdout.write(`${resultText}\n`);
    stdout.write(manualText);
    stdout.write(failedManualText);
    if (postInstallText) {
      stdout.write(`\n${postInstallText}\n`);
    }
  }
  printApiKeyReminder(options, env, stdout);

  const failures = applied.filter((step) => !step.ok);
  if (failures.length > 0) {
    stderr.write(
      `Some selected tools were not configured automatically. Use the printed manual snippets for those tools.\n`,
    );
  }
}

async function promptForMissingOptions(
  parsed: ParsedInitArgs,
  detected: readonly InitTool[] = [],
): Promise<ResolvedInitOptions> {
  intro('Configure Speko MCP');
  if (detected.length > 0) {
    log.info(`Detected: ${detected.map((tool) => TOOL_LABELS.get(tool) ?? tool).join(', ')}`);
  }

  const auth =
    parsed.auth ??
    (await promptValue<InitAuth>(
      select({
        message: 'How should Speko MCP authenticate?',
        options: [
          { value: 'oauth', label: 'OAuth', hint: 'recommended when your tool supports it' },
          { value: 'api-key', label: 'SPEKO_API_KEY', hint: 'uses an environment variable' },
        ],
      }),
    ));

  const detectedSet = new Set(detected);
  // `--tools all` resolves to the detected set; with nothing detected it falls
  // through to the multiselect instead of silently configuring nothing.
  const toolsFromArgs = parsed.toolsAll
    ? detected.length > 0
      ? [...detected]
      : undefined
    : parsed.tools;
  const tools =
    toolsFromArgs ??
    (await promptValue<InitTool[]>(
      multiselect({
        message: 'Which coding tools should be configured?',
        required: true,
        // Preselect what's installed; a machine with nothing detected falls
        // back to the historical Claude Code default.
        initialValues: detected.length > 0 ? [...detected] : [...DEFAULT_SELECTED_TOOLS],
        options: TOOL_SPECS.map((spec) => ({
          value: spec.tool,
          label: spec.label,
          ...(detectedSet.has(spec.tool) ? { hint: 'detected' } : {}),
        })),
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
      applied.push({
        label: step.label,
        ok: true,
        message: 'Manual instructions printed.',
        postInstall: step.postInstall,
      });
      continue;
    }

    if (step.kind === 'command') {
      const result = deps.runCommand(step.command);
      const alreadyConfigured = !result.ok && isAlreadyConfiguredMessage(result.message);
      const ok = result.ok || alreadyConfigured;
      applied.push({
        label: step.label,
        ok,
        message: alreadyConfigured ? `Already configured: ${result.message}` : result.message,
        manualSnippet: ok ? undefined : step.manualSnippet,
        postInstall: ok ? step.postInstall : undefined,
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
      applied.push({
        label: step.label,
        ok: true,
        message: `Already up to date: ${step.path}`,
        postInstall: step.postInstall,
      });
      continue;
    }
    mkdirSync(dirname(step.path), { recursive: true });
    if (existing !== undefined) {
      const backupPath = `${step.path}.${timestamp}.bak`;
      await copyFile(step.path, backupPath);
    }
    writeFileSync(step.path, next.content);
    applied.push({
      label: step.label,
      ok: true,
      message: `Updated ${step.path}`,
      postInstall: step.postInstall,
    });
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
    postInstall: 'In Claude Code, run /mcp and complete sign-in.',
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

function otherClientSnippet(endpoint: string, apiKeyAuth: boolean): string {
  const auth = apiKeyAuth
    ? 'API key auth: Send Authorization: Bearer sk_live_xxx'
    : "OAuth: Use the client's OAuth flow";

  return `Name: speko
URL: ${endpoint}
${auth}`;
}

/** Marker-append guidance into a rules file the USER owns (Codex AGENTS.md, GEMINI.md, global_rules.md). */
function guidanceAppendStep(
  tool: Exclude<InitTool, 'other'>,
  label: string,
  path: string,
): PlannedInitStep {
  return {
    kind: 'file',
    tool,
    label,
    path,
    build: (existing) => ({ ok: true, content: upsertGuidanceBlock(existing ?? '') }),
    manualSnippet: upsertGuidanceBlock(''),
  };
}

/** Standalone guidance file WE own (Cline rules dir, VS Code instructions dir) — plain overwrite. */
function guidanceFileStep(
  tool: Exclude<InitTool, 'other'>,
  label: string,
  path: string,
  frontmatter?: string,
): PlannedInitStep {
  return {
    kind: 'file',
    tool,
    label,
    path,
    build: () => ({ ok: true, content: standaloneGuidanceContent(frontmatter) }),
    manualSnippet: standaloneGuidanceContent(frontmatter),
  };
}

function bridgeMcpServersSnippet(
  apiKeyAuth: boolean,
  env: Environment,
  extraFields: Record<string, unknown> = {},
): string {
  const server = { ...bridgeServerEntry(apiKeyAuth, env), ...extraFields };
  return JSON.stringify({ mcpServers: { speko: server } }, null, 2);
}

function vscodeSnippet(endpoint: string, apiKeyAuth: boolean): string {
  const server = apiKeyAuth
    ? `{
      "type": "http",
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer $${'{env:SPEKO_API_KEY}'}"
      }
    }`
    : `{
      "type": "http",
      "url": "${endpoint}"
    }`;

  return `{
  "servers": {
    "speko": ${server}
  }
}`;
}

function zedSnippet(apiKeyAuth: boolean, env: Environment, settingsPath: string): string {
  const entry = bridgeServerEntry(apiKeyAuth, env) as {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  const contextServer = {
    context_servers: {
      speko: {
        command: {
          path: entry.command,
          args: entry.args,
          ...(entry.env ? { env: entry.env } : {}),
        },
      },
    },
  };
  return `Add to ${settingsPath}:\n${JSON.stringify(contextServer, null, 2)}`;
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

function renderPostInstallSteps(steps: readonly AppliedStep[]): string {
  const postInstall = Array.from(
    new Set(
      steps
        .filter((step) => step.ok)
        .map((step) => step.postInstall)
        .filter((value): value is string => Boolean(value)),
    ),
  );

  return postInstall.length > 0
    ? `After configuring:\n${postInstall.map((step) => `- ${step}`).join('\n')}`
    : '';
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
    const message = result.stderr.trim() || result.stdout.trim() || `Exited with ${result.status}`;
    if (isAlreadyConfiguredMessage(message)) {
      return { ok: true, message: `Already configured: ${message}` };
    }
    return {
      ok: false,
      message,
    };
  }
  return { ok: true, message: `Ran ${formatCommand(command)}` };
}

function isAlreadyConfiguredMessage(message: string): boolean {
  return /\balready (?:configured|exists|up to date)\b/i.test(message);
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

function parseAuth(value: string): InitAuth {
  if (value === 'oauth' || value === 'api-key') return value;
  throw new Error(`Invalid --auth value: ${value}`);
}

function parseScope(value: string): InitScope {
  if (value === 'user' || value === 'project') return value;
  throw new Error(`Invalid --scope value: ${value}`);
}

/** `--tools all` toggles run-time detection; anything else is a forced comma list. */
function applyToolsFlag(parsed: ParsedInitArgs, value: string): void {
  if (value.trim().toLowerCase() === 'all') {
    parsed.toolsAll = true;
    return;
  }
  parsed.tools = parseTools(value);
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

const TOOL_ALIASES: Record<string, InitTool> = {
  'claude-code': 'claude',
  claude_code: 'claude',
  desktop: 'claude-desktop',
  claude_desktop: 'claude-desktop',
  'vs-code': 'vscode',
  vs_code: 'vscode',
  code: 'vscode',
  'gemini-cli': 'gemini',
  gemini_cli: 'gemini',
};

function normalizeTool(value: string): InitTool | undefined {
  if (!value) return undefined;
  const lowered = value.toLowerCase();
  const alias = TOOL_ALIASES[lowered];
  if (alias) return alias;
  if (TOOL_LABELS.has(lowered as InitTool)) return lowered as InitTool;
  throw new Error(`Invalid tool: ${value}`);
}

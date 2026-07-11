/**
 * Cross-agent usage guidance ("the skill, everywhere"): agents that read a
 * global rules/instructions file get a compact card describing what the Speko
 * MCP is for, in THAT agent's own convention — Codex ~/.codex/AGENTS.md,
 * Gemini ~/.gemini/GEMINI.md, Windsurf global_rules.md (marker-delimited
 * appends into files the USER owns), Cline rules dir + VS Code instructions
 * dir (standalone files WE own).
 *
 * Append discipline (same bar as init.ts's config writers): idempotent —
 * re-runs REPLACE the block between markers, never duplicate it — and user
 * content outside the markers is preserved byte-for-byte. Backups + dry-run
 * come for free because guidance rides the same planned-file-step engine.
 */

export const GUIDANCE_BEGIN = '<!-- BEGIN speko mcp guidance (managed by `spekoai-mcp init`) -->';
export const GUIDANCE_END = '<!-- END speko mcp guidance -->';

/**
 * Kept deliberately short: this lands in users' GLOBAL context files, so every
 * line costs them tokens in every session. Names only the stable tool families
 * (they exist on the hosted server today) and the one rule that matters:
 * actions touch the user's real Speko organization.
 */
export const GUIDANCE_CARD = `# Speko MCP — voice-AI platform tools

The \`speko\` MCP server connects this agent to the Speko platform (voice-AI
gateway: STT, LLM and TTS through one API, routed to the best provider).

- Look things up first: \`search_docs\` answers Speko API and platform questions
  from the official docs — prefer it over guessing endpoints or parameters.
- Build and ship voice agents: create/update/deploy agents, agent tools, evals.
- Phone and sessions: buy phone numbers, start phone or browser voice sessions.
- Ground agents in knowledge bases: create knowledge bases and documents.
- These tools act on the user's REAL Speko organization (agents, numbers,
  credits) — create, deploy and delete deliberately, never for exploration.

Docs: https://docs.speko.dev`;

/** Pure: insert or replace the marker-delimited block in an existing file body. */
export function upsertGuidanceBlock(raw: string, card: string = GUIDANCE_CARD): string {
  const block = `${GUIDANCE_BEGIN}\n${card}\n${GUIDANCE_END}`;
  const begin = raw.indexOf(GUIDANCE_BEGIN);
  const end = raw.indexOf(GUIDANCE_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    return raw.slice(0, begin) + block + raw.slice(end + GUIDANCE_END.length);
  }
  if (!raw.trim()) return `${block}\n`;
  // trimEnd(), not a /\n*$/ regex: the file body is library input and that
  // regex backtracks polynomially on long trailing-newline runs (CodeQL
  // js/polynomial-redos). Linear, and trailing whitespace at EOF is noise.
  return `${raw.trimEnd()}\n\n${block}\n`;
}

/** Standalone guidance file body (Cline rules dir, VS Code instructions dir). */
export function standaloneGuidanceContent(frontmatter?: string): string {
  return frontmatter ? `${frontmatter}\n${GUIDANCE_CARD}\n` : `${GUIDANCE_CARD}\n`;
}

/** VS Code Copilot user-level instructions frontmatter: applies the card to every request. */
export const VSCODE_INSTRUCTIONS_FRONTMATTER = `---
applyTo: '**'
description: 'Speko MCP — voice-AI platform tools available to this agent'
---`;

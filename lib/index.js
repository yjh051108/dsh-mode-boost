/**
 * dsh-mode-boost: measured-boost reasoning-mode router, host-plane bundle
 * plugin (official DSH plugin form: package.json + lib/, installed via
 * `dsh plugin add` / dev_install_package, restart-persistent via bundles).
 *
 * Attaches to ANY session composition (official Standard preset included —
 * no preset fork needed). On the first assembly it replaces only the persona
 * section and narrows the first-turn tool surface; after the first durable
 * tool/call the full catalog is exposed. Every real user message in a weak
 * (internal-routing) session gets one near-field guidance message
 * (cache-neutral fixed text, boost-style reclassification rounds 3+,
 * depth-adaptive per task complexity).
 *
 * Coexistence: if the session already carries a router-owned persona section
 * (e.g. the router-standard preset row is mounted), this plugin no-ops for
 * that session — no double injection, migration-ready.
 *
 * Zero external imports (inline schema compiler, node:fs for the activity
 * log only). All texts come from ./core.js — the same module the probe
 * batteries import, so measured == shipped.
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  applyPersona, bandFor, coreFor, parseMode, personaFor, sessionMode, testinessFor, clamp01,
  isComplexTask, isChatTask, guideFor, extractText,
} from './core.js?v=2' // v=2: cache-busting query — the ESM cache keys by URL

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mode-boost'

/** Prompt assembly, the tools registry, and the LLM route must exist. */
export const inject = ['systemPrompt', 'tools', 'llm']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/** Minimal spec → JSON Schema compiler (subset of defineTool's work). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (Array.isArray(meta.enum)) prop.enum = meta.enum
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** Append one line to the activity log (best-effort, never throws). */
function log(entry) {
  try {
    appendFileSync(join(DSH_HOME, 'mode-boost-activity.jsonl'), `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`, 'utf8')
  } catch { /* observability is best-effort */ }
}

export function apply(ctx, config) {
  const overrides = new Map() // session id -> explicit mode (number 0..1 or 'weak')
  const agents = new Map() // session id -> Agent (live handle, in-process only)
  const guided = new Map() // session id -> last user-message id we guided
  const inactive = new Set() // sessions where another router is mounted
  const chat = new Set() // sessions that stand down (conversational first message)
  const guideOnly = new Set() // sessions that keep the preset persona/surface
  let toolsRegistered = false

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const session = agent.session
    agents.set(session.id, agent)

    // Coexistence guard: the router-standard preset row registers
    // dev_mode_status/dev_mode_set under those exact names; OUR tools use
    // dev_mode_* names, so the catalog signal is unambiguous — no caching
    // needed, no self-pollution possible.
    const catalog = new Set(assembled.tools.map((tool) => tool.name))
    if (catalog.has('dev_router_status') || (assembled.sections || []).some((s) => s.name === 'router-persona')) {
      inactive.add(session.id)
      log({ event: 'assemble', session: session.id, action: 'inactive', reason: 'other-router-present' })
      return assembled
    }
    inactive.delete(session.id)

    const firstMsg = session.events.find((e) => e.type === 'user/message')
    const firstText = extractText(firstMsg?.data)

    // Conversational session (greeting / no task): stand down entirely.
    if (isChatTask(firstText)) {
      chat.add(session.id)
      log({ event: 'assemble', session: session.id, action: 'chat-standdown', text: firstText.slice(0, 40) })
      return assembled
    }
    chat.delete(session.id)

    // Specialized surfaces keep their own persona and tool surface; only the
    // near-field guidance is added:
    //  - minimal: persona IS the exact RL prompt (complete:true); replacing it
    //    destroys the training condition; its surface (bash + str_replace_editor)
    //    has none of the core names the first-turn filter expects.
    //  - cordis/创造模式: the persona carries trust-critical instructions
    //    (composition planes, never edit shipped presets, load the skill);
    //    replacing it broke real sessions (2026-08-15 export).
    const personaSection = (assembled.sections || []).find((s) => s.name === 'persona' || /persona/i.test(s.name))
    const personaText = personaSection?.text ?? ''
    const minimalLike = !catalog.has('read') || !catalog.has('write')
    const cordisLike = /cordis|harness|host composition/i.test(personaText)
    const guideOnlyMode = minimalLike || cordisLike

    if (!toolsRegistered) {
      registerTools()
      toolsRegistered = true
    }

    const mode = overrides.get(session.id) ?? sessionMode(session)
    const modelId = agent.options?.model
    if (guideOnlyMode) {
      guideOnly.add(session.id)
      log({ event: 'assemble', session: session.id, action: 'guide-only', mode: String(mode), model: modelId, reason: minimalLike ? 'minimal-surface' : 'specialized-persona' })
      return assembled // persona + tool surface untouched
    }
    guideOnly.delete(session.id)

    const persona = personaFor(mode, modelId)

    // The persona stays constant for the whole session (mode is fixed); only
    // the tool surface changes once, after the first durable tool/call.
    const sections = applyPersona(assembled.sections, persona)

    if (session.events.some((event) => event.type === 'tool/call')) {
      log({ event: 'assemble', session: session.id, action: 'promoted', mode: String(mode), model: modelId })
      return { ...assembled, sections, contexts: [] } // promoted: full catalog
    }

    const core = new Set(coreFor(mode))
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const shell = available.has('pwsh') ? 'pwsh' : available.has('bash') ? 'bash' : null
    if (shell === null) {
      throw new Error(`${name}: no platform shell in catalog`)
    }
    core.add(shell)

    log({ event: 'assemble', session: session.id, action: 'first-turn', mode: String(mode), model: modelId, core: [...core] })
    return {
      ...assembled,
      sections,
      contexts: [],
      tools: assembled.tools.filter((tool) => core.has(tool.name)),
    }
  })

  // ── near-field routing guidance (weak mode; boost-style + depth-adaptive) ──
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    if (inactive.has(session.id)) return // another router owns this session
    if (chat.has(session.id)) return // conversational session — stand down
    const data = event.data ?? {}
    if (data.source?.kind !== 'user') return // only real user messages
    const agent = ctx.get('agent')
    const target = agent !== undefined && agent.session === session ? agent : [...agents.values()].find((a) => a.session === session)
    if (target === undefined || target.inbox === undefined) return
    const mode = overrides.get(session.id) ?? sessionMode(session)
    if (bandFor(mode) !== 'weak') return // strong modes need no guidance
    if (guided.get(session.id) === event.id) return // dedupe: already guided
    const text = extractText(data)
    if (!text.trim()) return
    const round = (session.events || []).filter((e) => e.type === 'user/message').length
    const modelId = target.options?.model
    const guide = guideFor(round, text, modelId)
    try {
      target.inbox.append('next-step', {
        id: `mode-boost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        source: { kind: 'plugin', plugin: 'mode-boost' },
        content: [{ type: 'text', text: guide }],
      })
      guided.set(session.id, event.id)
      log({ event: 'guide', session: session.id, round, complex: isComplexTask(text), model: modelId })
    } catch { /* duplicate/ordering races: skip */ }
  })

  // ── router visibility & tuning (agent self-optimization) ────────────────
  const registerTool = (tool) => {
    try {
      ctx.effect(() => ctx.tools.register({
        ...tool,
        parameters: toJsonSchema(tool.parameters),
      }))
      return true
    } catch { return false } // already registered by another router — fine
  }

  const modeSpec = {
    mode: {
      type: 'string',
      required: true,
      description: 'band name (spec / weak / mixed / react), a 0-100 number, a 0.0-1.0 number, or auto to clear the override',
    },
  }

  function fmtMode(mode) {
    return typeof mode === 'string' ? mode : mode.toFixed(2)
  }

  // Lazy registration: called once, from the first ACTIVE assembly (after the
  // coexistence check) — so the catalog signal stays unambiguous.
  function registerTools() {
    registerTool({
      name: 'dev_mode_status',
      description: 'Show this session\'s reasoning-mode routing: mode, band, persona, first-turn core tools, test-suppression, and whether an override is active.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute() {
        const session = currentSession()
        if (session === undefined) return 'no agent session'
        const mode = overrides.get(session.id) ?? sessionMode(session)
        const modelId = currentAgent()?.options?.model
        return [
          `mode=${fmtMode(mode)} (band=${bandFor(mode)})`,
          `persona=${personaFor(mode, modelId).replace(/\n/g, ' / ')}`,
          `core=[${coreFor(mode).join(', ')}]`,
          `testiness=${testinessFor(mode)}`,
          `override=${overrides.has(session.id) ? 'yes' : 'no'}`,
        ].join('\n')
      },
    })

    registerTool({
      name: 'dev_mode_set',
      description: 'Set this session\'s reasoning mode: spec (plan-first) / weak (internal routing, model decides per task) / mixed (transition, trap) / react (doer). Accepts band names, 0-100, or 0.0-1.0; use auto to return to task classification. The next request applies it.',
      parameters: modeSpec,
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute(args) {
        const parsed = parseMode(args.mode)
        if (parsed === null) return `invalid mode "${args.mode}": use spec/weak/mixed/react, 0-100, 0.0-1.0, or auto`
        const session = currentSession()
        if (session === undefined) return 'no agent session'
        if (parsed === 'auto') overrides.delete(session.id)
        else overrides.set(session.id, parsed === 'weak' ? 'weak' : clamp01(parsed))
        const current = overrides.get(session.id) ?? sessionMode(session)
        return `mode=${fmtMode(current)} (band=${bandFor(current)}) — next request applies`
      },
    })

    // ── mode-isolated subagent: run a task in a DIFFERENT reasoning mode, in a
    //    fresh isolated context (own system prompt) — the only reliable way to
    //    change modes mid-session. ──
    registerTool({
      name: 'dev_mode_subagent',
      description: 'Run one task in a DIFFERENT reasoning mode than this session, in a fresh isolated context (own system prompt). The current session trajectory is untouched. Mode: spec (plan-first) / weak (internal routing) / react (doer) / balanced. Returns the subagent\'s answer text.',
      parameters: {
        mode: { type: 'string', required: true, description: 'spec / weak / react / balanced (or 0-100)' },
        task: { type: 'string', required: true, description: 'the task to hand to the mode-isolated subagent' },
        maxTokens: { type: 'number', description: 'output cap (default 1024)' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const parsed = parseMode(args.mode)
        if (parsed === null || parsed === 'auto') return `invalid mode "${args.mode}"`
        const session = currentSession()
        const agent = session === undefined ? undefined : [...agents.values()].find((a) => a.session === session)
        if (agent === undefined || agent.options === undefined) return 'no agent route available'
        const { provider, model } = agent.options
        if (!provider || !model) return 'agent route missing provider/model'

        const persona = personaFor(parsed, model)
        const maxTokens = Number(args.maxTokens || 1024)
        let text = ''
        let reasoningChars = 0
        try {
          const stream = ctx.llm.stream({
            provider,
            model,
            system: persona,
            messages: [{ role: 'user', content: [{ type: 'text', text: String(args.task) }] }],
            maxTokens,
          })
          for await (const chunk of stream) {
            if (chunk.type === 'text-delta') text += chunk.text
            else if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length
          }
        } catch (error) {
          return `subagent error: ${error && error.message ? error.message : String(error)}`
        }
        const head = text.slice(0, 3000)
        return `[mode-subagent ${bandFor(parsed)} | reasoning ${reasoningChars} chars]\n${head}${text.length > 3000 ? '\n…(truncated)' : ''}`
      },
    })
  }

  function currentSession() {
    const agent = ctx.get('agent')
    if (agent !== undefined && agent.session !== undefined) return agent.session
    const last = [...agents.values()].at(-1)
    return last?.session
  }

  function currentAgent() {
    const session = currentSession()
    return session === undefined ? undefined : [...agents.values()].find((a) => a.session === session)
  }

  log({ event: 'apply', plugin: name })
}


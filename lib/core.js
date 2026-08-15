/**
 * mode-boost core: reasoning-mode routing logic (zero dependencies).
 *
 * Port of dsh-router-standard's router-core with the MEASURED boosts applied
 * (all numbers from official-API probes, deepseek-v4-flash,
 * reasoning_effort=max, 2026-08-15; see README for the full table):
 *
 * 1. deep-persona — weak/Flash persona gains "Think deeply first, then
 *    produce." (P20 deep-persona @1536: route 94% / converge 100% vs
 *    shipped deep-guide 100% / 88%; persona-static keeps prefix-cache hits).
 * 2. boost guidance — rounds 3+ use the "NEW task, classify fresh" text
 *    (P19 @1024: route 88% vs BASE 69%; P21 related chains @1024: 69% vs
 *    baseline 56% — today's ordering, opposite of the published P21).
 * 3. depth-adaptive dispatch — simple tasks get the fast-convergence guide,
 *    complex tasks the directed deep guide (P30 @1536: complex 7.5 steps +
 *    deeper chars; simple 1.0 steps, near-zero reasoning waste).
 *    The decision-closure suffix is applied ONLY for non-Flash models
 *    (measured neutral on Flash today: c-closed ≈ b-directed).
 *
 * The texts below are the single source of truth: the probe batteries
 * (probe/run-mode-boost-eval.mjs) import them from here so what is measured
 * is exactly what the plugin injects.
 */

export const MODE_SPEC = 0
export const MODE_MIXED = 0.3
export const MODE_REACT = 1
export const MODE_WEAK = 'weak'

const SPEC_PERSONA = 'You are a helpful software engineer assistant.'

const MIXED_PERSONA =
  'You are a helpful software engineer assistant.\n'
  + 'Work directly: prefer writing or editing code over describing plans. '
  + 'Verify your changes by reading and running them.'

const REACT_PERSONA =
  'You are a hands-on software engineer who delivers working output fast.\n'
  + 'Work directly: write or edit code, then verify it by reading and running. '
  + 'Keep the loop tight — produce, verify, fix — and do not build test '
  + 'harnesses, scaffolding, or ceremony the user did not ask for. '
  + 'Finish with a usable deliverable and a short summary.'

/** Weak (internal-routing) personas — model-specific optimum.
 *  pro:   spec sentence + classify instruction (w6c; P24)
 *  flash: neutral + classify + recall/anti-runaway anchors (w7; P11/P23)
 *         + deep-first sentence (P20 deep-persona: converge 100%) — the
 *         measured boost over the shipped w7.
 */
const WEAK_PRO =
  'You are a helpful software engineer assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.'

const WEAK_FLASH =
  'You are a helpful assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.\n'
  + 'Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.\n'
  + 'Think deeply first, then produce.'

// ── guidance texts (near-field, appended to real user messages) ────────────

/** Round 1-2 baseline: classify + adopt style. */
export const GUIDE_BASE =
  '\n\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first.'

/** Rounds 3+: anti-dilution reclassification (P19 boost / P21 b-boost). */
export const GUIDE_BOOST =
  '\n\nRouter: this is a NEW task, different from the previous ones. Classify it fresh (build or fix) and adopt the matching style — build: direct production; fix: inspect-first. Do not follow the previous task\'s style.'

/** Fast-convergence tail for simple tasks (P30: 1 step, zero waste). */
export const GUIDE_COMMIT = ' Think deeply first, then commit and act.'

/** Directed deep tail for complex tasks (P30: depth without rumination). */
export const GUIDE_DEEP = ' Think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. Produce when your information is complete.'

/** Decision-closure tail — non-Flash models only (P30: +12% depth on Pro;
 *  measured neutral on Flash today: c-closed ≈ b-directed). */
export const GUIDE_CLOSURE = ' End each reasoning block with a decision or an information need.'

/** Complexity heuristic: long or architecturally-worded tasks are COMPLEX. */
const COMPLEX_RE = /(重构|架构|全面|详细|设计|系统|优化|分析|survey|overview|architecture|refactor|comprehensive|detailed|design|system|optimize|analyze)/i

export function isComplexTask(text) {
  return typeof text === 'string' && (text.length > 120 || COMPLEX_RE.test(text))
}

/**
 * Conversational first-message detection: greetings / bare acknowledgements /
 * short messages with no task keywords. On such sessions the router stands
 * down entirely (original preset persona and tool surface untouched, no
 * guidance) — the deep engineering persona on a chat session produces long
 * reasoning chains with nothing to route (measured on 创造模式, 2026-08-15:
 * 338 reasoning chunks on a greeting + analysis question).
 */
const CHAT_RE = /^(你好|您好|hello|hi|hey|嗨|哈喽|在吗|谢谢|感谢|thanks|thank you|早上好|下午好|晚上好|嗯|好|ok|okay|yes|no|嗯嗯|好的)[!。.!？?~～]*$/i

export function isChatTask(text) {
  if (typeof text !== 'string') return true
  const t = text.trim()
  if (t.length === 0) return true
  if (CHAT_RE.test(t)) return true
  if (t.length > 24) return false
  return !t.match(REACT_RE) && !t.match(SPEC_RE) // short + no task keywords → chat
}

/** True when the routed model id is a Flash-family model. */
export function isFlashModel(modelId) {
  return typeof modelId === 'string' && /flash/i.test(modelId)
}

/** Quantize a mode to one of the four measured behavior bands. */
export function bandOf(mode) {
  if (mode === 'weak') return 'weak'
  const m = clamp01(mode)
  if (m < 0.2) return 'spec' // measured stable spec region (0..0.15)
  if (m < 0.5) return 'transition' // measured unstable band — avoid
  return 'react' // measured stable react region (0.5..1 behave alike)
}

/** Persona for a mode; weak picks the model-specific internal-routing text. */
export function personaFor(mode, modelId) {
  switch (bandOf(mode)) {
    case 'spec': return SPEC_PERSONA
    case 'transition': return MIXED_PERSONA
    case 'weak': return isFlashModel(modelId) ? WEAK_FLASH : WEAK_PRO
    default: return REACT_PERSONA
  }
}

/**
 * Per-message near-field guidance (the plugin's exact dispatch):
 *   round 1-2 → GUIDE_BASE; rounds 3+ → GUIDE_BOOST (anti-dilution);
 *   simple task → +GUIDE_COMMIT (fast convergence);
 *   complex task → +GUIDE_DEEP (+GUIDE_CLOSURE for non-Flash models).
 */
export function guideFor(round, text, modelId) {
  const base = round >= 3 ? GUIDE_BOOST : GUIDE_BASE
  if (!isComplexTask(text)) return base + GUIDE_COMMIT
  const deep = base + GUIDE_DEEP
  return isFlashModel(modelId) ? deep : deep + GUIDE_CLOSURE
}

/** First-turn core tools (shell added dynamically by the plugin). */
export function coreFor(mode) {
  switch (bandOf(mode)) {
    case 'spec': return ['read', 'edit', 'glob', 'grep'] // read-first
    case 'transition': return ['read', 'edit', 'write', 'glob', 'grep'] // union
    default: return ['read', 'write', 'edit'] // write-first
  }
}

/** Human-readable band name for a mode value. */
export function bandFor(mode) {
  const b = bandOf(mode)
  return b === 'transition' ? 'mixed' : b
}

/** Test-suppression strength for a mode (informational). */
export function testinessFor(mode) {
  switch (bandOf(mode)) {
    case 'react': return 'suppressed'
    case 'spec': return 'normal'
    default: return 'light'
  }
}

const REACT_RE = /(开发|创建|写一个|写|生成|从零|做|做一个|做个|游戏|网页|网站|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|write a|write an|build a|make a|new project)/gi
const SPEC_RE = /(修复|修一下|调试|重构|维护|排查|报错|出错|崩溃|优化|审查|review|fix|debug|refactor|maintain|repair|broken|break|为什么|异常|故障|迁移|升级|兼容)/gi

function countHits(regex, text) {
  return [...text.matchAll(regex)].length
}

/**
 * Classify a task text into a mode. Clear keyword evidence picks a stable
 * band (1 react / 0 spec); AMBIGUOUS or unmatched text returns 'weak' —
 * the internal-routing mode, where the model decides per task.
 */
export function classifyTask(text) {
  const react = countHits(REACT_RE, text)
  const spec = countHits(SPEC_RE, text)
  if (react > spec) return 1
  if (spec > react) return 0
  return 'weak'
}

/** Per-session mode derived from durable events (resume-safe). */
export function sessionMode(session) {
  const events = session.events
  const userMsg = events.find((e) => e.type === 'user/message')
  return classifyTask(extractText(userMsg?.data))
}

export function extractText(data) {
  if (!data) return ''
  const payload = data && typeof data.message === 'object' && data.message !== null ? data.message : data
  const content = Array.isArray(payload.content) ? payload.content : []
  return content.map((c) => (typeof c === 'string' ? c : (c.text ?? ''))).join(' ')
}

export function clamp01(v) {
  return Math.min(1, Math.max(0, Number(v) || 0))
}

/**
 * Replace only the persona section of an assembled section list, keeping
 * everything else — the plan-mode section above all, which is toggled per
 * plan state and carries the plan-boundary instructions.
 */
export function applyPersona(sections, personaText) {
  const rest = (sections || []).filter(
    (section) => section.name !== 'persona' && !/persona/i.test(section.name),
  )
  return [...rest, { name: 'router-persona', text: personaText, order: 0 }]
}

/** Parse a user/agent-supplied mode token: number 0-100, 0.0-1.0, or a band name. */
export function parseMode(token) {
  if (token === undefined || token === null) return null
  const t = String(token).trim().toLowerCase()
  if (t === 'auto') return 'auto'
  if (t === 'weak' || t === 'router') return 'weak'
  if (t === 'spec' || t === 'spec-lean') return 0
  if (t === 'balanced' || t === 'mixed') return 0.3 // transition-band center
  if (t === 'react' || t === 'react-lean') return 1
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  if (t.includes('.')) return clamp01(n)
  return clamp01(n / 100)
}

import { mkdtempSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

// The plugin captures DSH_HOME at module load, so it must be set before the
// dynamic import below. Each run gets its own scratch home.
const root = mkdtempSync(join(tmpdir(), 'mode-boost-it-'))
process.env.DSH_HOME = root
after(async () => { await rm(root, { recursive: true, force: true }) })

const { apply } = await import(`../lib/index.js?v=${Date.now()}`)

const user = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const toolMessage = (id, text) => ({ id, role: 'user', source: { kind: 'tool', name: 'pwsh' }, content: [{ type: 'text', text }] })
const event = (type, data) => ({ type, data })
// Weak-classifying, non-chat text: longer than 24 chars with no build/fix keywords.
const WEAK_TASK = '请介绍一下你平时处理一般问题时的大致思路，两三句话即可。'

function session(events = []) {
  return { id: `s-${Math.random().toString(36).slice(2, 8)}`, events: [...events] }
}

const fullAssembly = {
  sections: [{ name: 'persona', text: 'You are a helpful assistant.', order: 0 }],
  contexts: [],
  tools: ['read', 'write', 'edit', 'glob', 'grep', 'pwsh'].map((name) => ({ name })),
  variables: {},
}

function fakeCtx() {
  const listeners = new Map()
  return {
    _listeners: listeners,
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
      return () => {}
    },
    get: () => undefined,
    effect: (fn) => fn(),
    tools: { register: () => {} },
    llm: { stream: async () => {} },
  }
}

async function runAssemble(ctx, assembly, context) {
  let current = assembly
  for (const handler of ctx._listeners.get('system-prompt/assemble') ?? []) {
    current = await handler(current, context, async () => current)
  }
  return current
}

async function runPreStep(ctx, payload) {
  let decision = { kind: 'enter', messages: [...payload.messages] }
  for (const handler of ctx._listeners.get('agent/pre-step') ?? []) {
    decision = await handler(payload, async () => decision)
  }
  return decision
}

const signal = { throwIfAborted() {} }

async function applyPlugin() {
  const ctx = fakeCtx()
  apply(ctx, {})
  return ctx
}

describe('assemble dispatch (first message)', () => {
  it('stands down without classifying when the host lacks AssembleContext.messages', async () => {
    const ctx = await applyPlugin()
    const s = session()
    const context = { agent: { session: s, options: { model: 'deepseek-v4-flash' } } }
    const out = await runAssemble(ctx, fullAssembly, context)
    assert.equal(out, fullAssembly)
    const log = await readFile(join(root, 'mode-boost-activity.jsonl'), 'utf8')
    assert.match(log, /"action":"host-incompatible"/)
  })

  it('records unclassified-no-user when claimed is present but empty', async () => {
    const ctx = await applyPlugin()
    const s = session()
    const context = { agent: { session: s, options: { model: 'deepseek-v4-flash' } }, messages: [] }
    const out = await runAssemble(ctx, fullAssembly, context)
    assert.equal(out, fullAssembly)
    const log = await readFile(join(root, 'mode-boost-activity.jsonl'), 'utf8')
    assert.match(log, /"action":"unclassified-no-user"/)
  })

  it('applies first-turn persona + tool narrowing from the claimed first message (weak)', async () => {
    const ctx = await applyPlugin()
    const s = session()
    const context = { agent: { session: s, options: { model: 'deepseek-v4-flash' } }, messages: [user('u1', WEAK_TASK)] }
    const out = await runAssemble(ctx, fullAssembly, context)
    const names = out.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, ['edit', 'pwsh', 'read', 'write'])
    assert.ok(out.sections.some((section) => section.name === 'router-persona' && /Think deeply first/.test(section.text)))
    const log = await readFile(join(root, 'mode-boost-activity.jsonl'), 'utf8')
    assert.match(log, /"action":"first-turn","mode":"weak"/)
  })

  it('applies the react persona for build-keyword first messages', async () => {
    const ctx = await applyPlugin()
    const s = session()
    const context = { agent: { session: s, options: { model: 'deepseek-v4-flash' } }, messages: [user('u1', '写一个网页游戏')] }
    const out = await runAssemble(ctx, fullAssembly, context)
    const persona = out.sections.find((section) => section.name === 'router-persona')
    assert.match(persona.text, /hands-on software engineer/)
    const log = await readFile(join(root, 'mode-boost-activity.jsonl'), 'utf8')
    assert.match(log, /"action":"first-turn","mode":"1"/)
  })

  it('stands down on real greetings and logs the real text', async () => {
    const ctx = await applyPlugin()
    const s = session()
    const context = { agent: { session: s, options: { model: 'deepseek-v4-flash' } }, messages: [user('u1', '你好')] }
    const out = await runAssemble(ctx, fullAssembly, context)
    assert.equal(out, fullAssembly)
    const log = await readFile(join(root, 'mode-boost-activity.jsonl'), 'utf8')
    assert.match(log, /"action":"chat-standdown","text":"你好"/)
  })

  it('re-uses the durable first message once it is logged (subsequent assemblies)', async () => {
    const ctx = await applyPlugin()
    const s = session([event('user/message', user('u1', '写一个脚本'))])
    const context = { agent: { session: s, options: { model: 'deepseek-v4-flash' } }, messages: [] }
    const out = await runAssemble(ctx, fullAssembly, context)
    assert.deepEqual(out.tools.map((tool) => tool.name).sort(), ['edit', 'pwsh', 'read', 'write'])
  })
})

describe('pre-step guide injection', () => {
  it('appends exactly one guide for one real user message (weak, round 1)', async () => {
    const ctx = await applyPlugin()
    const s = session()
    const payload = { agent: { session: s, options: { model: 'deepseek-v4-flash' } }, messages: [user('u1', WEAK_TASK)], turn: 1, step: 1, signal }
    const decision = await runPreStep(ctx, payload)
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 2)
    const guide = decision.messages[1]
    assert.equal(guide.source.kind, 'plugin')
    assert.equal(guide.source.plugin, 'mode-boost')
    assert.match(guide.content[0].text, /Router: classify/)
    const log = await readFile(join(root, 'mode-boost-activity.jsonl'), 'utf8')
    assert.match(log, /"event":"guide","session":"[^"]+","round":1/)
  })

  it('appends one guide per real user message in a multi-message batch, rounds ascending', async () => {
    const ctx = await applyPlugin()
    const s = session()
    const payload = { agent: { session: s, options: { model: 'deepseek-v4-flash' } }, messages: [user('u1', '任务甲'), user('u2', '任务乙')], turn: 1, step: 1, signal }
    const decision = await runPreStep(ctx, payload)
    assert.equal(decision.messages.length, 4)
    assert.equal(decision.messages[2].source.plugin, 'mode-boost')
    assert.equal(decision.messages[3].source.plugin, 'mode-boost')
  })

  it('uses boost reclassification text from round 3 (logged rounds as base)', async () => {
    const ctx = await applyPlugin()
    const s = session([
      event('user/message', user('u1', '第一问')),
      event('user/message', user('u2', '第二问')),
    ])
    const payload = { agent: { session: s, options: { model: 'deepseek-v4-flash' } }, messages: [user('u3', '第三问')], turn: 3, step: 1, signal }
    const decision = await runPreStep(ctx, payload)
    assert.match(decision.messages[1].content[0].text, /NEW task/)
  })

  it('does not guide strong (react) sessions', async () => {
    const ctx = await applyPlugin()
    const s = session()
    const payload = { agent: { session: s, options: { model: 'deepseek-v4-flash' } }, messages: [user('u1', '写一个网页游戏')], turn: 1, step: 1, signal }
    const decision = await runPreStep(ctx, payload)
    assert.equal(decision.messages.length, 1)
  })

  it('does not guide tool-only sub-steps', async () => {
    const ctx = await applyPlugin()
    const s = session([event('user/message', user('u1', WEAK_TASK))])
    const payload = { agent: { session: s, options: { model: 'deepseek-v4-flash' } }, messages: [toolMessage('t1', '{"ok":true}')], turn: 1, step: 2, signal }
    const decision = await runPreStep(ctx, payload)
    assert.equal(decision.messages.length, 1)
  })

  it('does not guide chat sessions (stand down)', async () => {
    const ctx = await applyPlugin()
    const s = session()
    // First assembly classifies the greeting as chat and stands down.
    await runAssemble(ctx, fullAssembly, { agent: { session: s, options: { model: 'deepseek-v4-flash' } }, messages: [user('u1', '你好')] })
    const payload = { agent: { session: s, options: { model: 'deepseek-v4-flash' } }, messages: [user('u2', '在吗')], turn: 2, step: 1, signal }
    const decision = await runPreStep(ctx, payload)
    assert.equal(decision.messages.length, 1)
  })

  it('preserves a reject decision verbatim', async () => {
    const ctx = await applyPlugin()
    const s = session()
    const payload = { agent: { session: s, options: { model: 'deepseek-v4-flash' } }, messages: [user('u1', WEAK_TASK)], turn: 1, step: 1, signal }
    // A downstream listener vetoes the step after our listener appended guides.
    const handlers = ctx._listeners.get('agent/pre-step')
    const [pluginHandler] = handlers
    ctx._listeners.set('agent/pre-step', [async (p, next) => {
      const decision = await pluginHandler(p, next)
      return { kind: 'reject' }
    }])
    const decision = await runPreStep(ctx, payload)
    assert.deepEqual(decision, { kind: 'reject' })
  })
})

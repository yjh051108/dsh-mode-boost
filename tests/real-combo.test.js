import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Real-assembly smoke: the plugin loaded into a genuine Cordis context with
// the official LLM/session/system-prompt/tools/agent/agent-loop plugins, so
// guide injection is verified through the real claim → assemble → pre-step →
// user/message → model-request path. The DSH_HOME captured by the plugin must
// be set before its module loads.
const root = mkdtempSync(join(tmpdir(), 'mode-boost-combo-'))
process.env.DSH_HOME = root
after(async () => { await rm(root, { recursive: true, force: true }) })

const H = 'D:/deepseek-harness'
const imp = (path) => import(pathToFileURL(path).href)
const { Context } = await imp(`${H}/vendor/cordis/lib/index.js`)
const { default: LlmRuntime, CallId, LlmAdapter, LlmError, createUserMessage } = await imp(`${H}/packages/llm/llm/lib/index.js`)
const { default: SessionStore, SessionId } = await imp(`${H}/packages/core/session/lib/index.js`)
const { default: SystemPrompt } = await imp(`${H}/packages/core/system-prompt/lib/index.js`)
const { default: ToolRuntime, defineContentToolFixture } = await imp(`${H}/packages/core/tools/lib/index.js`)
const { default: AgentRegistry } = await imp(`${H}/packages/core/agent/lib/index.js`)
const { default: AgentLoop } = await imp(`${H}/packages/core/agent-loop/lib/index.js`)
const { default: JsonlSessionPersistence } = await imp(`${H}/packages/session/session-persistence-jsonl/lib/index.js`)
const { apply: applyBoost } = await import(`${pathToFileURL(join(process.cwd(), 'lib/index.js')).href}?v=${Date.now()}`)

/** Scripted adapter mirroring the repo's test fixture (text responses only). */
class MockAdapter extends LlmAdapter {
  requests = []
  constructor(script) { super(); this.script = script }
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(options) {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (!chunks) throw new Error('MockAdapter: script exhausted')
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function harness(adapter, options = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {
    persona: options.cordisPersona
      ? 'Cordis composition: trust instructions for host plane plugins.'
      : 'You are a helpful software engineer assistant.',
  })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  if (options.persistence) await ctx.plugin(JsonlSessionPersistence, { root: options.persistence })
  if (!options.minimal) {
    // Standard surface: read/write/edit + a shell name must be present, or the
    // plugin treats the session as minimal (guide-only) and skips persona swap.
    for (const name of ['read', 'write', 'edit', 'pwsh']) {
      ctx.tools.register(defineContentToolFixture({ name, description: name, parameters: {} }))
    }
  }
  await ctx.plugin({ name: applyBoost.name, inject: applyBoost.inject, apply: applyBoost })
  return ctx
}

function waitForIdle(ctx, agent) {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

function send(agent, text) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

const textOf = (message) => (message.content ?? [])
  .map((block) => (block.type === 'text' ? block.text ?? '' : '')).join('')

function userMessages(agent) {
  return agent.session.events.filter((e) => e.type === 'user/message').map((e) => e.data)
}

const WEAK_TASK = '请介绍一下你平时处理一般问题时的大致思路，两三句话即可。'

describe('real-assembly mode-boost', () => {
  it('first turn swaps the persona and injects exactly one guide into log and request', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('combo-first'), { provider: 'mock', model: 'deepseek-v4-flash' })

    send(agent, WEAK_TASK)
    await waitForIdle(ctx, agent)

    // Persona replaced on the FIRST request (weak flash persona).
    assert.match(adapter.requests[0].system, /Think deeply first/)
    // First-turn tool surface narrowed to the weak core + shell.
    const toolNames = (adapter.requests[0].tools ?? []).map((tool) => tool.name).sort()
    assert.deepEqual(toolNames, ['edit', 'pwsh', 'read', 'write'])
    // Guide reached the model request.
    const requestTexts = (adapter.requests[0].messages ?? []).map(textOf).join('\n')
    assert.match(requestTexts, /Router: classify/)
    // Log: exactly the real message plus exactly one guide.
    const logged = userMessages(agent)
    assert.equal(logged.length, 2)
    assert.equal(textOf(logged[0]), WEAK_TASK)
    assert.equal(logged[1].source.kind, 'plugin')
    assert.equal(logged[1].source.plugin, 'mode-boost')
    await ctx.fiber.dispose()
  })

  it('a downstream reject drops the claim and the guide; retry injects exactly one', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('combo-reject'), { provider: 'mock', model: 'mock' })
    const rejectStep = ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))

    send(agent, WEAK_TASK)
    await waitForIdle(ctx, agent)

    // Rejected turn: no model request, nothing logged.
    assert.equal(adapter.requests.length, 0)
    assert.equal(userMessages(agent).length, 0)
    rejectStep()

    send(agent, WEAK_TASK)
    await waitForIdle(ctx, agent)

    const logged = userMessages(agent)
    assert.equal(logged.length, 2) // real message + one guide
    assert.equal(logged[1].source.plugin, 'mode-boost')
    await ctx.fiber.dispose()
  })

  it('a request retry on the same step does not duplicate the guide', async () => {
    const failOnce = () => { throw new LlmError('busy', 'RATE_LIMIT') }
    const adapter = new MockAdapter([failOnce, textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('combo-retry'), { provider: 'mock', model: 'deepseek-v4-flash' })
    ctx.on('agent/request-error', async () => ({ kind: 'retry' }))

    send(agent, WEAK_TASK)
    await waitForIdle(ctx, agent)

    // Same step retried after the adapter failure; the assembly is reused, so
    // the guide is injected exactly once.
    assert.equal(adapter.requests.length, 2)
    const logged = userMessages(agent)
    assert.equal(logged.length, 2) // real message + one guide
    assert.equal(logged[1].source.plugin, 'mode-boost')
    await ctx.fiber.dispose()
  })

  it('minimal surface keeps the preset persona and still injects guides', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter, { minimal: true })
    const agent = ctx.agentLoop.create(SessionId('combo-minimal'), { provider: 'mock', model: 'deepseek-v4-flash' })

    send(agent, WEAK_TASK)
    await waitForIdle(ctx, agent)

    assert.doesNotMatch(adapter.requests[0].system, /Think deeply first/)
    const logged = userMessages(agent)
    assert.equal(logged.length, 2) // real message + one guide
    assert.equal(logged[1].source.plugin, 'mode-boost')
    await ctx.fiber.dispose()
  })

  it('a cordis-like persona stays untouched and still gets guides', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter, { cordisPersona: true })
    const agent = ctx.agentLoop.create(SessionId('combo-cordis'), { provider: 'mock', model: 'deepseek-v4-flash' })

    send(agent, WEAK_TASK)
    await waitForIdle(ctx, agent)

    assert.doesNotMatch(adapter.requests[0].system, /Think deeply first/)
    const logged = userMessages(agent)
    assert.equal(logged.length, 2) // real message + one guide
    assert.equal(logged[1].source.plugin, 'mode-boost')
    await ctx.fiber.dispose()
  })

  it('resume of a persisted pending first message classifies through the plugin', async () => {
    const persistRoot = mkdtempSync(join(tmpdir(), 'mb-resume-'))
    try {
      // Lifecycle 1: the durable log holds only the balanced turn seed plus a
      // pending inbox splice — zero user/message before the crash.
      const ctx1 = await harness(new MockAdapter([]), { persistence: persistRoot })
      const sessionId = SessionId('pending-first-combo')
      const s1 = ctx1.sessions.create(sessionId, {
        seed: [
          { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
          { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
        ],
      })
      s1.append('agent/inbox/spliced', {
        target: 'next-turn',
        start: 0,
        inserted: [createUserMessage({ content: [{ type: 'text', text: WEAK_TASK }], source: { kind: 'user' } })],
      })
      await ctx1.sessions.flush(s1)
      await ctx1.fiber.dispose()

      // Lifecycle 2: resume with the plugin loaded; the pending message must
      // be classified on the first turn (weak persona + one guide).
      const adapter2 = new MockAdapter([textResponse('ok'), textResponse('ok')])
      const ctx2 = await harness(adapter2, { persistence: persistRoot })
      const a2 = (await ctx2.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: 'mock', model: 'deepseek-v4-flash' },
      })).agent
      a2.followup(createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }))
      await waitForIdle(ctx2, a2)

      assert.match(adapter2.requests[0].system, /Think deeply first/)
      const logged = userMessages(a2)
      assert.equal(logged.filter((m) => m.source.kind === 'plugin' && m.source.plugin === 'mode-boost').length, 2)
      assert.equal(logged[0].source.kind, 'user')
      assert.equal(textOf(logged[0]), WEAK_TASK)
      await ctx2.fiber.dispose()
    } finally {
      await rm(persistRoot, { recursive: true, force: true })
    }
  })

  it('a downstream empty enter stays empty: no log, no request, no guide', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('combo-empty-enter'), { provider: 'mock', model: 'deepseek-v4-flash' })
    // A legal downstream "no step" decision (kept by agent-instructions): the
    // plugin must not resurrect it into a guide-only model request.
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      return { kind: 'enter', messages: [] }
    })

    send(agent, WEAK_TASK)
    await waitForIdle(ctx, agent)

    assert.equal(adapter.requests.length, 0)
    assert.equal(userMessages(agent).length, 0)
    await ctx.fiber.dispose()
  })

  it('chat sessions stand down: original persona, no guide', async () => {
    const adapter = new MockAdapter([textResponse('hi')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('combo-chat'), { provider: 'mock', model: 'mock' })

    send(agent, '你好')
    await waitForIdle(ctx, agent)

    assert.doesNotMatch(adapter.requests[0].system, /Think deeply first/)
    const logged = userMessages(agent)
    assert.equal(logged.length, 1) // greeting only, no guide
    await ctx.fiber.dispose()
  })
})

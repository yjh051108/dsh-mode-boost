import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Loader-entry smoke: the plugin is packed with `npm pack`, installed into a
// scratch node_modules tree, and the whole composition is started through
// `dsh-app-boot`'s real Loader from a test cordis.yml — exercising the
// publish artifact (files whitelist, cordis.patch.yml), bare-module
// resolution, and the real plugin-load path end to end.
const root = mkdtempSync(join(tmpdir(), 'mode-boost-loader-'))
process.env.DSH_HOME = join(root, 'dsh-home')
after(async () => { await rm(root, { recursive: true, force: true }) })

const H = 'D:/deepseek-harness'
const SRC = fileURLToPath(new URL('..', import.meta.url))
const imp = (path) => import(pathToFileURL(path).href)

const { boot } = await imp(`${H}/packages/boot/app-boot/lib/index.js`)
const { SessionId } = await imp(`${H}/packages/core/session/lib/index.js`)
const { LlmAdapter, createUserMessage } = await imp(`${H}/packages/llm/llm/lib/index.js`)
const { defineContentToolFixture } = await imp(`${H}/packages/core/tools/lib/index.js`)

class MockAdapter extends LlmAdapter {
  requests = []
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
  async *stream(options) {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const WEAK_TASK = '请介绍一下你平时处理一般问题时的大致思路，两三句话即可。'

describe('Loader composition from the packed artifact', () => {
  it('boots the plugin through the Loader and guides the first turn', async () => {
    const combo = mkdtempSync(join(root, 'combo-'))
    try {
      // Pack the plugin into the scratch tree and install the tarball there.
      execSync(`npm pack --silent --pack-destination "${combo}"`, { cwd: SRC, stdio: 'pipe' })
      const tgz = readdirSync(combo).find((f) => f.endsWith('.tgz'))
      assert.ok(tgz, 'npm pack produced a tarball')
      const pkgRoot = join(combo, 'node_modules', '@dsh-external')
      mkdirSync(pkgRoot, { recursive: true })
      execSync(`tar -xzf "${join(combo, tgz)}" -C "${pkgRoot}"`)
      // npm tarballs unpack to `package/`; the bare name must be the package name.
      renameSync(join(pkgRoot, 'package'), join(pkgRoot, 'dsh-mode-boost'))
      const packed = join(pkgRoot, 'dsh-mode-boost')
      assert.ok(existsSync(join(packed, 'cordis.patch.yml')), 'pack includes cordis.patch.yml')

      // Junction the official packages so bare resolution finds them.
      const official = [
        ['dsh-llm', 'packages/llm/llm'],
        ['dsh-session', 'packages/core/session'],
        ['dsh-system-prompt', 'packages/core/system-prompt'],
        ['dsh-tools', 'packages/core/tools'],
        ['dsh-agent', 'packages/core/agent'],
        ['dsh-agent-loop', 'packages/core/agent-loop'],
      ]
      mkdirSync(join(combo, 'node_modules', '@deepseek-ai'), { recursive: true })
      for (const [name, rel] of official) {
        symlinkSync(join(H, rel), join(combo, 'node_modules', '@deepseek-ai', name), 'junction')
      }

      const cfgPath = join(combo, 'cordis.yml')
      writeFileSync(cfgPath, [
        '- id: llm',
        '  name: "@deepseek-ai/dsh-llm"',
        '- id: session',
        '  name: "@deepseek-ai/dsh-session"',
        '- id: system-prompt',
        '  name: "@deepseek-ai/dsh-system-prompt"',
        '  config:',
        '    persona: "You are a helpful software engineer assistant."',
        '- id: tools',
        '  name: "@deepseek-ai/dsh-tools"',
        '- id: agent',
        '  name: "@deepseek-ai/dsh-agent"',
        '- id: agent-loop',
        '  name: "@deepseek-ai/dsh-agent-loop"',
        '  config:',
        '    agents: []',
        '- id: mode-boost',
        '  name: "@dsh-external/dsh-mode-boost"',
        '  config: {}',
      ].join('\n'))

      const ctx = await boot('loader-test', cfgPath, undefined, undefined, pathToFileURL(`${combo}/`).href)
      try {
        const adapter = new MockAdapter()
        ctx.llm.registerAdapter(['mock'], adapter)
        // Standard surface (as the real preset provides): read/write/edit plus a
        // shell name, so the plugin takes the full path (persona swap + first
        // turn narrowing) rather than guide-only.
        for (const name of ['read', 'write', 'edit', 'pwsh']) {
          ctx.tools.register(defineContentToolFixture({ name, description: name, parameters: {} }))
        }
        const agent = ctx.agentLoop.create(SessionId('loader1'), { provider: 'mock', model: 'deepseek-v4-flash' })
        agent.followup(createUserMessage({ content: [{ type: 'text', text: WEAK_TASK }], source: { kind: 'user' } }))
        await new Promise((resolve) => {
          const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
            if (subject === agent && status === 'idle') { dispose(); resolve() }
          })
        })

        assert.equal(adapter.requests.length, 1)
        assert.match(adapter.requests[0].system, /Think deeply first/)
        const toolNames = (adapter.requests[0].tools ?? []).map((tool) => tool.name).sort()
        assert.deepEqual(toolNames, ['edit', 'pwsh', 'read', 'write'])
        const logged = agent.session.events.filter((e) => e.type === 'user/message')
        assert.equal(logged.length, 2) // real message + one guide
        assert.equal(logged[1].data.source.kind, 'plugin')
        assert.equal(logged[1].data.source.plugin, 'mode-boost')
      } finally {
        await ctx.fiber.dispose()
      }
    } finally {
      await rm(combo, { recursive: true, force: true })
    }
  })
})

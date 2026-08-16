import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyTask, extractText, firstUserMessage, isChatTask, loggedUserRounds, modeFor, sessionMode,
} from '../lib/core.js'

const user = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const injected = (id, text) => ({ id, role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text }] })
const event = (type, data) => ({ type, data })

describe('firstUserMessage', () => {
  it('reports missing when neither the log nor the claimed batch has a real user message', () => {
    assert.deepEqual(firstUserMessage({ events: [] }, []), { kind: 'missing' })
    assert.deepEqual(firstUserMessage({ events: [] }, [injected('i1', 'AGENTS.md')]), { kind: 'missing' })
  })

  it('prefers the durable log over the claimed batch', () => {
    const events = [event('user/message', user('u1', 'first logged'))]
    const first = firstUserMessage({ events }, [user('u2', 'first claimed')])
    assert.equal(first.kind, 'present')
    assert.equal(first.messageId, 'u1')
    assert.equal(first.text, 'first logged')
  })

  it('falls back to the claimed batch before the message is logged (first assembly)', () => {
    const first = firstUserMessage({ events: [] }, [user('u2', 'first claimed')])
    assert.equal(first.kind, 'present')
    assert.equal(first.messageId, 'u2')
    assert.equal(first.text, 'first claimed')
  })

  it('ignores non-user sources in both the log and the claimed batch', () => {
    const events = [event('user/message', injected('i1', 'instructions'))]
    const first = firstUserMessage({ events }, [user('u1', 'real question')])
    assert.equal(first.kind, 'present')
    assert.equal(first.messageId, 'u1')
  })

  it('keeps a genuinely empty present message distinct from missing', () => {
    const first = firstUserMessage({ events: [] }, [user('u0', '')])
    assert.equal(first.kind, 'present')
    assert.equal(first.text, '')
    assert.equal(isChatTask(first.text), true) // present empty still stands down
  })
})

describe('modeFor / sessionMode', () => {
  it('classifies from the first real user message', () => {
    assert.equal(modeFor({ events: [] }, [user('u1', '写一个工具')]), 1)
    assert.equal(modeFor({ events: [] }, [user('u1', '修复这个报错')]), 0)
    assert.equal(modeFor({ events: [] }, [user('u1', '介绍一下思路')]), 'weak')
  })

  it('returns weak when no first message exists yet', () => {
    assert.equal(modeFor({ events: [] }, []), 'weak')
    assert.equal(modeFor({ events: [] }), 'weak')
  })

  it('sessionMode only counts real user messages (no instructions/catalog pollution)', () => {
    const events = [
      event('user/message', injected('i1', 'AGENTS.md instructions')),
      event('user/message', user('u1', '写一个脚本')),
    ]
    assert.equal(sessionMode({ events }), 1)
  })
})

describe('loggedUserRounds', () => {
  it('counts only real user messages already logged', () => {
    const events = [
      event('user/message', user('u1', 'one')),
      event('user/message', injected('i1', 'instructions')),
      event('user/message', user('u2', 'two')),
    ]
    assert.equal(loggedUserRounds({ events }), 2)
  })
})

describe('extractText', () => {
  it('extracts text blocks from a message payload or a bare payload', () => {
    assert.equal(extractText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a b')
    assert.equal(extractText({ message: { content: [{ type: 'text', text: 'nested' }] } }), 'nested')
    assert.equal(extractText(undefined), '')
  })
})

describe('classifyTask', () => {
  it('keeps the measured keyword routing intact', () => {
    assert.equal(classifyTask('写一个网页游戏'), 1)
    assert.equal(classifyTask('修复登录崩溃'), 0)
    assert.equal(classifyTask('随便聊聊'), 'weak')
  })
})

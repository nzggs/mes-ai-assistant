import { describe, it, expect, vi } from 'vitest'
import { reportError, subscribeErrors } from './errorReporter'

describe('errorReporter', () => {
  it('reportError 触发所有订阅者并携带 msg', () => {
    const listener = vi.fn()
    const unsub = subscribeErrors(listener)
    reportError('出错了')
    expect(listener).toHaveBeenCalledTimes(1)
    const payload = listener.mock.calls[0][0]
    expect(payload.msg).toBe('出错了')
    expect(typeof payload.id).toBe('number')
    expect(typeof payload.time).toBe('number')
    unsub()
  })

  it('unsubscribe 后不再收到通知', () => {
    const listener = vi.fn()
    const unsub = subscribeErrors(listener)
    unsub()
    reportError('x')
    expect(listener).not.toHaveBeenCalled()
  })

  it('多次 reportError 都会被分发', () => {
    const listener = vi.fn()
    const unsub = subscribeErrors(listener)
    reportError('a')
    reportError('b')
    expect(listener).toHaveBeenCalledTimes(2)
    unsub()
  })

  it('空消息回退为「未知错误」', () => {
    const listener = vi.fn()
    const unsub = subscribeErrors(listener)
    reportError('')
    expect(listener.mock.calls[0][0].msg).toBe('未知错误')
    unsub()
  })

  it('超长消息被截断到 500 字符', () => {
    const listener = vi.fn()
    const unsub = subscribeErrors(listener)
    reportError('x'.repeat(1000))
    expect(listener.mock.calls[0][0].msg.length).toBe(500)
    unsub()
  })

  it('订阅者抛异常不影响其他订阅者', () => {
    const bad = vi.fn(() => { throw new Error('boom') })
    const good = vi.fn()
    const u1 = subscribeErrors(bad)
    const u2 = subscribeErrors(good)
    expect(() => reportError('ok')).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
    u1(); u2()
  })
})

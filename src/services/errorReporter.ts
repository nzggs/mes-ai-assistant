// 全局错误上报：把原本被 console.error/warn 静默吞掉的业务报错，统一推到前端弹窗报警。
// 用法：import { reportError } from './errorReporter'; reportError('文档解析失败：xxx')

export interface ReportedError {
  id: number
  msg: string
  time: number
}

type Listener = (err: ReportedError) => void

const listeners = new Set<Listener>()
let seq = 0

/** 上报一条错误，触发所有订阅者（ErrorToasts 会弹窗显示） */
export function reportError(msg: string): void {
  const trimmed = (msg || '未知错误').toString().slice(0, 500)
  const err: ReportedError = { id: ++seq, msg: trimmed, time: Date.now() }
  listeners.forEach(l => {
    try { l(err) } catch { /* 忽略订阅者异常 */ }
  })
}

/** 订阅错误事件，返回取消订阅函数 */
export function subscribeErrors(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

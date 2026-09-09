import { useEffect, useState } from 'react'
import { subscribeErrors, type ReportedError } from '../services/errorReporter'

const AUTO_DISMISS_MS = 8000

/**
 * 全局错误报警弹窗：订阅 errorReporter，把所有上报的错误以红色卡片堆叠展示在右上角，
 * 每条可手动关闭或 8 秒后自动消失。用于把原本被静默吞掉的报错（AI 解析失败、日志写入失败、接口异常等）呈现给用户。
 */
export default function ErrorToasts() {
  const [errors, setErrors] = useState<ReportedError[]>([])

  useEffect(() => {
    const unsub = subscribeErrors(err => {
      setErrors(prev => [err, ...prev].slice(0, 5)) // 最多同时显示 5 条
      // 自动消失
      setTimeout(() => {
        setErrors(prev => prev.filter(e => e.id !== err.id))
      }, AUTO_DISMISS_MS)
    })
    return unsub
  }, [])

  if (errors.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 w-[340px] max-w-[90vw]">
      {errors.map(e => (
        <div
          key={e.id}
          className="rounded-xl bg-red-600 text-white shadow-2xl px-4 py-3 animate-slide-up border border-red-700"
        >
          <div className="flex items-start gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <div className="flex-1 text-sm leading-snug whitespace-pre-wrap break-words">{e.msg}</div>
            <button
              onClick={() => setErrors(prev => prev.filter(x => x.id !== e.id))}
              className="shrink-0 p-0.5 rounded hover:bg-red-500 transition-colors"
              aria-label="关闭"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

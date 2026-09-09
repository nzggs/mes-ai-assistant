// 测试环境初始化。注意：server 端测试在 node 环境运行（无 window），
// 因此所有依赖 DOM 的兜底仅在 jsdom 环境（typeof window !== 'undefined'）下执行。
import 'fake-indexeddb/auto'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

if (typeof window !== 'undefined') {
  // jsdom 环境才需要 jest-dom 匹配器与 DOM 兜底
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  await import('@testing-library/jest-dom')

  // jsdom 不实现 matchMedia，组件中会用到，统一兜底。
  if (!window.matchMedia) {
    // @ts-expect-error 测试兜底
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })
  }

  // jsdom 不实现 scrollTo / scrollIntoView / ResizeObserver，组件可能调用。
  if (!window.scrollTo) window.scrollTo = () => {}
  // @ts-expect-error 测试兜底
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
  if (!('ResizeObserver' in globalThis)) {
    // @ts-expect-error 测试兜底
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }

  if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:mock'
  if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {}

  if (typeof globalThis.structuredClone !== 'function') {
    // @ts-expect-error 测试兜底
    globalThis.structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v))
  }
}

// 每个测试后清理 DOM 与 fetch mock，避免用例间串扰。
afterEach(() => {
  if (typeof window !== 'undefined') cleanup()
  vi.restoreAllMocks()
})

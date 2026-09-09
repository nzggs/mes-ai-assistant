import { describe, it, expect } from 'vitest'
import { APP_VERSION } from './version'

describe('version', () => {
  it('导出应用版本号字符串', () => {
    expect(typeof APP_VERSION).toBe('string')
    expect(APP_VERSION.length).toBeGreaterThan(0)
  })
})

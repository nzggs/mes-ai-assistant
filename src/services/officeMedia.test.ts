import { describe, it, expect } from 'vitest'
import { colWidthToPx } from './officeMedia'

describe('officeMedia', () => {
  describe('colWidthToPx', () => {
    it('正常宽度换算', () => {
      expect(colWidthToPx(10)).toBe(75) // 10*7+5
      expect(colWidthToPx(8.5)).toBe(Math.round(8.5 * 7 + 5))
    })
    it('0 或负值回退 64', () => {
      expect(colWidthToPx(0)).toBe(64)
      expect(colWidthToPx(-3)).toBe(64)
    })
    it('NaN/undefined 回退 64', () => {
      expect(colWidthToPx(NaN)).toBe(64)
      expect(colWidthToPx(undefined as unknown as number)).toBe(64)
    })
  })
})

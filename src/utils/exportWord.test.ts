import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { markdownToHtml, sanitizeFilename, exportMarkdownAsWord } from './exportWord'

describe('exportWord', () => {
  describe('markdownToHtml', () => {
    it('处理标题', () => {
      expect(markdownToHtml('# 标题一')).toContain('<h1>标题一</h1>')
      expect(markdownToHtml('### 标题三')).toContain('<h3>标题三</h3>')
    })
    it('处理无序与有序列表', () => {
      const html = markdownToHtml('- a\n- b')
      expect(html).toContain('<ul')
      expect(html).toContain('<li>a</li>')
      const html2 = markdownToHtml('1. x\n2. y')
      expect(html2).toContain('<ol')
      expect(html2).toContain('<li>x</li>')
    })
    it('处理代码块', () => {
      const html = markdownToHtml('```\nconst a = 1;\n```')
      expect(html).toContain('<pre')
      expect(html).toContain('const a = 1;')
    })
    it('处理内联强调与行内代码', () => {
      const html = markdownToHtml('这是 **粗体** 和 `code`')
      expect(html).toContain('<strong>粗体</strong>')
      expect(html).toContain('<code>code</code>')
    })
    it('空输入返回空串', () => {
      expect(markdownToHtml('')).toBe('')
    })
    it('转义 HTML 特殊字符防止 XSS', () => {
      const html = markdownToHtml('<script>alert(1)</script>')
      expect(html).not.toContain('<script>alert(1)</script>')
      expect(html).toContain('&lt;script&gt;')
    })
  })

  describe('sanitizeFilename', () => {
    it('移除 Windows 非法字符', () => {
      expect(sanitizeFilename('a/b:c*?')).toBe('abc')
    })
    it('压缩连续空白并 trim', () => {
      expect(sanitizeFilename('  a   b  ')).toBe('a b')
    })
    it('截断到 maxLen', () => {
      expect(sanitizeFilename('一二三四五六七八九十', 5)).toBe('一二三四五')
    })
    it('空结果回退默认名', () => {
      const r = sanitizeFilename('///', 30)
      expect(r).toMatch(/^AI回答_/)
    })
  })

  describe('exportMarkdownAsWord', () => {
    let createObjectURL: any
    let revokeObjectURL: any
    let clickSpy: any
    beforeEach(() => {
      createObjectURL = vi.fn(() => 'blob:mock')
      revokeObjectURL = vi.fn()
      // @ts-ignore
      globalThis.URL.createObjectURL = createObjectURL
      // @ts-ignore
      globalThis.URL.revokeObjectURL = revokeObjectURL
      clickSpy = vi.fn()
      // 让 document.createElement('a') 返回带 click 的锚点
      const orig = document.createElement.bind(document)
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        const el = orig(tag)
        if (tag === 'a') (el as any).click = clickSpy
        return el
      })
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })
    it('空内容直接返回不触发下载', async () => {
      await exportMarkdownAsWord('   ', '报表')
      expect(createObjectURL).not.toHaveBeenCalled()
    })
    it('正常内容触发下载', async () => {
      await exportMarkdownAsWord('# 报表\n内容', '月度报表')
      expect(createObjectURL).toHaveBeenCalled()
      expect(clickSpy).toHaveBeenCalled()
    })
  })
})

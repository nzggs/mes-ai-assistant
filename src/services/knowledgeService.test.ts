import { describe, it, expect } from 'vitest'
import {
  buildKnowledgeContext,
  extractSheetName,
  computeContentHash,
  detectSummaryIntent,
  detectMentionedSheet,
  getCachedSummary,
  FULL_DOC_SUMMARY_KEY,
  splitReduceBatches,
  estimateReduceBatchCount,
} from './knowledgeService'

function mkDoc(over: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    name: '不良分析报告.xlsx',
    type: 'excel',
    status: 'approved',
    summary: '这是一份不良分析报告',
    keywords: ['不良', '分析'],
    content: [
      { title: '不良分析报告 - 2026履历', paragraphs: ['行1：某设备出现异常'] },
      { title: '不良分析报告 - 统计', paragraphs: ['共 10 条不良记录'] },
    ],
    textContent: '不良分析报告\n2026履历\n行1：某设备出现异常\n统计\n共 10 条不良记录',
    chunks: 1,
    pages: 2,
    tableSummaries: {},
    summaryChunks: [],
    uploadDate: '2026-08-01T00:00:00Z',
    approvedDate: '2026-08-02T00:00:00Z',
    ...over,
  } as any
}

describe('knowledgeService 纯函数', () => {
  describe('FULL_DOC_SUMMARY_KEY', () => {
    it('整文档缓存键为 __doc__', () => {
      expect(FULL_DOC_SUMMARY_KEY).toBe('__doc__')
    })
  })

  describe('extractSheetName', () => {
    it('提取 "文件名 - 表名" 中的表名', () => {
      expect(extractSheetName('不良分析报告 - 2026履历')).toBe('2026履历')
    })
    it('无分隔符时返回原样', () => {
      expect(extractSheetName('统计')).toBe('统计')
    })
    it('取最后一个分隔符之后的部分', () => {
      expect(extractSheetName('A - B - C')).toBe('C')
    })
  })

  describe('computeContentHash', () => {
    it('对相同内容返回相同哈希', () => {
      const d = mkDoc()
      expect(computeContentHash(d)).toBe(computeContentHash(d))
    })
    it('内容变更后哈希变化', () => {
      const d1 = mkDoc()
      const d2 = mkDoc({ content: [{ title: 'x', paragraphs: ['changed'] }] })
      expect(computeContentHash(d1)).not.toBe(computeContentHash(d2))
    })
    it('无 content 时回退 textContent', () => {
      const d = mkDoc({ content: [] })
      expect(computeContentHash(d)).toContain(':')
    })
    it('格式为 h<36进制>:<长度>', () => {
      expect(computeContentHash(mkDoc())).toMatch(/^h[0-9a-z]+:\d+$/)
    })
  })

  describe('detectSummaryIntent', () => {
    it('含意图词 + 提到文档名 → 整篇', () => {
      const r = detectSummaryIntent('总结一下不良分析报告', mkDoc())
      expect(r).toEqual({ full: true })
    })
    it('含意图词 + 提到标签页 → 定位标签页', () => {
      const r = detectSummaryIntent('总结2026年履历', mkDoc())
      expect(r?.full).toBe(false)
      expect(r?.sheetName).toBe('2026履历')
    })
    it('仅提到标签页名（无意图词）也触发', () => {
      const r = detectSummaryIntent('统计有哪些内容', mkDoc())
      expect(r?.full).toBe(false)
      expect(r?.sheetName).toBe('统计')
    })
    it('无关问题返回 null', () => {
      expect(detectSummaryIntent('今天天气怎么样', mkDoc())).toBeNull()
    })
  })

  describe('detectMentionedSheet', () => {
    it('命中标签页', () => {
      expect(detectMentionedSheet('看看2026履历', mkDoc())).toBe('2026履历')
    })
    it('未命中返回 null', () => {
      expect(detectMentionedSheet('没有相关内容', mkDoc())).toBeNull()
    })
  })

  describe('getCachedSummary', () => {
    it('命中有效缓存', () => {
      const d = mkDoc()
      const hash = computeContentHash(d)
      d.tableSummaries = { '__doc__': { text: '整篇总结', updatedAt: 1, contentHash: hash } }
      expect(getCachedSummary(d, '__doc__')).toBe('整篇总结')
    })
    it('缓存内容哈希不匹配（内容已变）返回 null', () => {
      const d = mkDoc()
      d.tableSummaries = { '__doc__': { text: '旧总结', updatedAt: 1, contentHash: 'stale-hash' } }
      expect(getCachedSummary(d, '__doc__')).toBeNull()
    })
    it('无缓存返回 null', () => {
      expect(getCachedSummary(mkDoc(), '__doc__')).toBeNull()
    })
    it('缓存文本为空返回 null', () => {
      const d = mkDoc()
      d.tableSummaries = { '__doc__': { text: '', updatedAt: 1, contentHash: computeContentHash(d) } }
      expect(getCachedSummary(d, '__doc__')).toBeNull()
    })
  })

  describe('splitReduceBatches / estimateReduceBatchCount（REDUCE 多级树形合并）', () => {
    it('239 段小结按每批 6 段分批 → 40 批，且输入字符量自适应', () => {
      // 模拟 SAP HANA 手册 239 段小结：每段约 800 字符
      const partials = Array.from({ length: 239 }, (_, i) => `第${i + 1}段小结内容`.repeat(80))
      const batches = splitReduceBatches(partials, 6, 12000)
      // 每批 ≤6 条（除最后一组），全部覆盖
      expect(batches.length).toBe(40)
      expect(batches.every(b => b.length <= 6)).toBe(true)
      expect(batches.flat().length).toBe(239)
      // 预估批次数：第一级 40 批 → 第二级 40/6≈7 批 → 第三级 7/6≈2 批 → 第四级 1 批 = 50
      expect(estimateReduceBatchCount(partials, 6, 12000)).toBe(50)
    })
    it('超大单条按字符量超限时仍能正确分批（自适应缩小批次）', () => {
      // 若某些小结异常长（如 9000 字符），单批累计超限即收束
      const partials = [
        '长'.repeat(9000),
        '长'.repeat(9000),
        '短'.repeat(100),
      ]
      const batches = splitReduceBatches(partials, 6, 12000)
      // A(9000) 后 B 加入会使 18000>12000 → A 先收束；B(9000)+C(100)=9100<12000 → B,C 同批
      expect(batches.length).toBe(2)
      expect(batches[0].length).toBe(1) // [A]
      expect(batches[1].length).toBe(2) // [B, C]
      expect(batches.flat().length).toBe(3)
    })
    it('单批字符量接近上限时自动收束当前批', () => {
      const partials = Array.from({ length: 4 }, () => '中'.repeat(6000)) // 每条约 6000 字符
      const batches = splitReduceBatches(partials, 6, 12000)
      // 每批最多约 2 条（12000/6000），因此 4 条 → 2 批
      expect(batches.length).toBe(2)
      expect(batches[0].length).toBe(2)
      expect(batches[1].length).toBe(2)
    })
  })

  describe('buildKnowledgeContext', () => {
    it('空文档列表返回空字符串', () => {
      expect(buildKnowledgeContext([])).toBe('')
    })
    it('无 approved 文档返回空字符串', () => {
      expect(buildKnowledgeContext([mkDoc({ status: 'pending' }), mkDoc({ status: 'rejected' })])).toBe('')
    })
    it('approved 但无内容/正文的文档不纳入', () => {
      expect(buildKnowledgeContext([mkDoc({ content: [], textContent: '' })])).toBe('')
    })
    it('无查询时注入文档前 6000 字符', () => {
      const ctx = buildKnowledgeContext([mkDoc()])
      expect(ctx).toContain('文档：不良分析报告')
      expect(ctx).toContain('已入库')
    })
    it('查询未命中任何文档时给出未命中提示', () => {
      const ctx = buildKnowledgeContext([mkDoc()], '完全无关的问题xyz')
      expect(ctx).toContain('未找到相关内容')
    })
    it('查询命中文档时注入相关段落并标注来源', () => {
      const ctx = buildKnowledgeContext([mkDoc()], '设备出现异常')
      expect(ctx).toContain('不良分析报告')
    })
    it('只注入 approved 文档，忽略 pending', () => {
      const ctx = buildKnowledgeContext([mkDoc({ id: 'p', name: '待审核.docx', status: 'pending' })], '')
      expect(ctx).toBe('')
    })

    describe('探索模式（两步提问法·第一步）', () => {
      it('explore 模式仅注入目录与检索引导，不注入命中正文', () => {
        const ctx = buildKnowledgeContext([mkDoc()], 'SAVEPOINT 相关', 60000, 'explore')
        expect(ctx).toContain('检索引导模式')
        expect(ctx).toContain('不良分析报告') // 目录含文档名
        expect(ctx).toContain('指定一篇') // 引导用户定位具体文档
        expect(ctx).not.toContain('与问题相关的内容（命中检索）') // 不进入第二步命中扩展
      })
      it('explore 模式用全部预算注入目录，文档名全部可见', () => {
        const docs = [
          mkDoc({ id: 'a', name: '文档A.xlsx' }),
          mkDoc({ id: 'b', name: '文档B.xlsx' }),
          mkDoc({ id: 'c', name: '文档C.xlsx' }),
        ]
        const ctx = buildKnowledgeContext(docs, '不良', 60000, 'explore')
        expect(ctx).toContain('文档A')
        expect(ctx).toContain('文档B')
        expect(ctx).toContain('文档C')
      })
    })

    describe('命中总结缓存后仍补充正文切片检索', () => {
      it('查询命中的具体关键词在正文但不在（不完整）缓存总结中时，仍能注入正文切片', () => {
        // 构造：整篇缓存总结只归纳了 DROP，但正文里确有 ALTER SYSTEM SAVEPOINT 章节
        const filler = '背景填充内容'.repeat(200) // 使 fullText 超过 2000，触发项⑦关键词检索
        const d = mkDoc({
          name: '不良分析报告.xlsx',
          content: [
            { title: '不良分析报告 - 背景', paragraphs: [filler] },
            { title: '不良分析报告 - DROP章节', paragraphs: ['DROP TABLE 示例说明'] },
            { title: '不良分析报告 - SAVEPOINT章节', paragraphs: ['ALTER SYSTEM SAVEPOINT 命令的详细说明与用法'] },
          ],
        })
        const hash = computeContentHash(d)
        // 不完整的缓存：只提到 DROP，没有 SAVEPOINT
        d.tableSummaries = { '__doc__': { text: '整篇总结：仅包含 DROP TABLE 示例说明', updatedAt: 1, contentHash: hash } }
        // 带总结意图词 + 点名文档名 → 触发项⑤（注入不完整缓存），同时项⑦应补充正文切片
        const ctx = buildKnowledgeContext([d], '总结一下不良分析报告中关于ALTER SYSTEM SAVEPOINT的内容')
        expect(ctx).toContain('SAVEPOINT') // 正文切片被补充注入
        expect(ctx).toContain('DROP TABLE') // 缓存总结仍被注入
      })

      it('缓存总结非常长（超过旧 perDocBudget）时，正文切片仍不被挤掉', () => {
        // 回归场景：SAP HANA 手册整篇总结 2.4 万字符远超旧 perDocBudget(4000)，
        // 若总结计入 docUsed，正文切片循环会直接 break → 正文查不到。修复后总结用独立预算。
        const d = mkDoc({
          name: 'SAP HANA数据库SQL参考手册(中文版).pdf',
          content: [],
          textContent: '--- 第1页 ---\nSAP HANA 数据库 SQL 参考手册\n' + '背景章节内容。'.repeat(300) +
            '\n--- 第172页 ---\nALTER SYSTEM SAVEPOINT 语法说明\nALTER SYSTEM START PERFTRACE 语法说明',
        })
        const hash = computeContentHash(d)
        // 超长的完整总结缓存（不含 PERFTRACE 细节），模拟旧版多级合并产物
        const longSummary = ('整篇总结内容段落，涵盖数据类型与 SQL 函数，但不含系统管理命令细节。'.repeat(700))
        expect(longSummary.length).toBeGreaterThan(20000) // 确为超长总结
        d.tableSummaries = { '__doc__': { text: longSummary, updatedAt: 1, contentHash: hash } }
        // 带总结意图 + 点名文档名 + 具体命令 → 项⑤注入长总结，项⑦必须仍注入 PERFTRACE 正文
        const ctx = buildKnowledgeContext([d], '总结一下SAP HANA数据库SQL参考手册中关于ALTER SYSTEM START PERFTRACE的内容')
        expect(ctx).toContain('PERFTRACE') // 正文切片未因长总结而被挤掉
        expect(ctx).toContain('ALTER SYSTEM SAVEPOINT') // 正文 SAVEPOINT 语法页也在
      })
    })
  })
})

/**
 * Office 文档内嵌图片提取（仅用于「阅读原文 / 文件预览」UI 渲染）
 *
 * 设计原则：
 * - 完全独立于知识库的文本解析（knowledgeService.extractXlsxText / extractPptxText），
 *   不影响 doc.content、归纳（saveTableSummary）与检索（buildKnowledgeContext）。
 * - 直接解包原文件（xlsx/pptx 均为 ZIP + XML），把内嵌图片按 工作表 / 幻灯片 关联后返回，
 *   由预览弹窗以「正常方式」叠加渲染。
 */

import JSZip from 'jszip'

// ---- 最小 DOM 辅助（与 knowledgeService 内联实现保持一致）----
function byLocal(el: Element | Document, local: string): Element[] {
  const out: Element[] = []
  const all = el.getElementsByTagName('*')
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === local) out.push(all[i])
  }
  return out
}
function findZipEntry(zip: JSZip, name: string): JSZip.JSZipObject | null {
  const n = name.toLowerCase()
  for (const k of Object.keys(zip.files)) {
    if (k.toLowerCase() === n) return zip.files[k]
  }
  return null
}
async function readXml(zip: JSZip, file: JSZip.JSZipObject): Promise<Document> {
  const txt = await file.async('string')
  return new DOMParser().parseFromString(txt, 'text/xml')
}
async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

// 仅提取图片类型的 media（排除 PPT 中 media 目录可能混入的音频/视频）
const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|svg|tiff?|webp)$/i

// Excel：列宽近似换算（Excel 列宽单位 → 像素）
export function colWidthToPx(width: number): number {
  // 标准近似：width 字符数 * 7 + 5；负值/0 回退 64
  if (!width || width <= 0) return 64
  return Math.round(width * 7 + 5)
}

export interface ExcelImageAnchor {
  dataUrl: string
  leftPx: number   // 相对工作表左上角的绝对 X（像素）
  topPx: number    // 相对工作表左上角的绝对 Y（像素）
  widthPx: number
  heightPx: number
}
export interface ExcelSheetImages {
  sheetName: string
  images: ExcelImageAnchor[]   // 有锚点（drawing）的图片，绝对定位叠加
  looseImages: string[]        // 无锚点（worksheet rels 直接引用 media）的图片 dataURL，底部画廊展示
}

/**
 * 提取 xlsx 每个工作表的图片锚点信息。
 * 通过 xl/worksheets/_rels/sheetN.xml.rels → ../drawings/drawingN.xml → drawingN.xml.rels → ../media/imageY.ext
 * 映射 工作表 → 图片，并读取 drawings 中的锚点（from col/row + ext 尺寸）。
 */
export async function extractExcelImages(blob: Blob): Promise<ExcelSheetImages[]> {
  const zip = await JSZip.loadAsync(blob)
  const result: ExcelSheetImages[] = []

  // 1. 工作表顺序（workbook.xml）
  const workbookFile = findZipEntry(zip, 'xl/workbook.xml')
  const sheetNames: string[] = []
  if (workbookFile) {
    const wbDoc = await readXml(zip, workbookFile)
    for (const s of byLocal(wbDoc, 'sheet')) {
      sheetNames.push(s.getAttribute('name') || `Sheet${sheetNames.length + 1}`)
    }
  }

  // 2. 媒体缓存（按需读取，避免一次解出所有图片）
  const mediaCache = new Map<string, string>() // 相对路径(小写) → dataUrl

  // 3. 逐个工作表解析其 drawings
  for (let si = 0; si < sheetNames.length; si++) {
    const sheetNum = si + 1
    const sheetRelsFile = findZipEntry(zip, `xl/worksheets/_rels/sheet${sheetNum}.xml.rels`)
    const images: ExcelImageAnchor[] = []
    const looseImages: string[] = []
    if (sheetRelsFile) {
      const relsDoc = await readXml(zip, sheetRelsFile)
      // 找到该 sheet 引用的 drawing 文件；同时收集 rel 直接引用 media 的图片（无 drawing 锚点）
      let drawingPath: string | null = null
      const directMedia: string[] = []
      for (const rel of byLocal(relsDoc, 'Relationship')) {
        const t = rel.getAttribute('Target') || ''
        if (/drawing\d+\.xml$/i.test(t)) {
          drawingPath = t.startsWith('/') ? t.replace(/^\//, '') : `xl/${t.replace(/^\.\.\//, '')}`
          drawingPath = drawingPath.replace(/^\/?xl\//, 'xl/')
        } else if (/media\//i.test(t) && IMAGE_EXT.test(t)) {
          const m = t.startsWith('/') ? t.replace(/^\//, '') : `xl/${t.replace(/^\.\.\//, '')}`
          directMedia.push(m.replace(/^\/?xl\//, 'xl/'))
        }
      }
      // 处理无锚点图片（worksheet rels 直接引用 media，无 drawing）
      for (const mp of directMedia) {
        let dataUrl = mediaCache.get(mp.toLowerCase())
        if (!dataUrl) {
          const mf = findZipEntry(zip, mp)
          if (mf) {
            dataUrl = await blobToDataUrl(await mf.async('blob'))
            mediaCache.set(mp.toLowerCase(), dataUrl)
          }
        }
        if (dataUrl) looseImages.push(dataUrl)
      }
      if (drawingPath) {
        const drawingFile = findZipEntry(zip, drawingPath)
        if (drawingFile) {
          const drawingDoc = await readXml(zip, drawingFile)
          // drawing 的 rels：rId → media（路径在 _rels 子目录，如 xl/drawings/_rels/drawing1.xml.rels）
          const drawingRelsFile = findZipEntry(zip, drawingPath.replace(/(\/drawing\d+)\.xml$/i, '/_rels$1.xml.rels'))
          const ridToMedia: Record<string, string> = {}
          if (drawingRelsFile) {
            const dRels = await readXml(zip, drawingRelsFile)
            for (const rel of byLocal(dRels, 'Relationship')) {
              const t = rel.getAttribute('Target') || ''
              const id = rel.getAttribute('Id') || ''
              if (/media\//i.test(t) && IMAGE_EXT.test(t)) {
                const mediaRel = t.startsWith('/') ? t.replace(/^\//, '') : `xl/${t.replace(/^\.\.\//, '')}`
                ridToMedia[id] = mediaRel.replace(/^\/?xl\//, 'xl/')
              }
            }
          }
          // 读取该 sheet 的列宽/行高用于像素换算
          const sheetFile = findZipEntry(zip, `xl/worksheets/sheet${sheetNum}.xml`)
          let colW: Map<number, number> = new Map()
          let rowH: Map<number, number> = new Map()
          let defaultColW = 64
          if (sheetFile) {
            const sDoc = await readXml(zip, sheetFile)
            for (const cols of byLocal(sDoc, 'cols')) {
              for (const c of byLocal(cols, 'col')) {
                const min = parseInt(c.getAttribute('min') || '1', 10)
                const max = parseInt(c.getAttribute('max') || String(min), 10)
                const w = parseFloat(c.getAttribute('width') || '0')
                for (let n = min; n <= max; n++) colW.set(n, colWidthToPx(w))
              }
            }
            for (const r of byLocal(sDoc, 'row')) {
              const rn = parseInt(r.getAttribute('r') || '0', 10)
              const ht = parseFloat(r.getAttribute('ht') || '0')
              if (rn && ht) rowH.set(rn, ht)
            }
            const dsp = byLocal(sDoc, 'sheetViews')
            if (dsp.length) {
              const dc = byLocal(dsp[0], 'pane')
              if (dc.length) {
                const sw = parseFloat(dc[0].getAttribute('xSplit') || '0')
                if (sw) defaultColW = colWidthToPx(sw)
              }
            }
          }
          const cumX = (col: number) => {
            let x = 0
            for (let c = 0; c < col; c++) x += colW.get(c + 1) ?? 64
            return x
          }
          const cumY = (row: number) => {
            let y = 0
            for (let r = 0; r < row; r++) y += rowH.get(r + 1) ?? 20
            return y
          }

          // 遍历锚点（oneCellAnchor / twoCellAnchor）
          const anchors = [
            ...byLocal(drawingDoc, 'oneCellAnchor'),
            ...byLocal(drawingDoc, 'twoCellAnchor'),
          ]
          for (const anchor of anchors) {
            const from = byLocal(anchor, 'from')[0]
            const pic = byLocal(anchor, 'pic')[0]
            if (!from || !pic) continue
            const col = parseInt(byLocal(from, 'col')[0]?.textContent || '0', 10)
            const row = parseInt(byLocal(from, 'row')[0]?.textContent || '0', 10)
            const colOff = parseInt(byLocal(from, 'colOff')[0]?.textContent || '0', 10)
            const rowOff = parseInt(byLocal(from, 'rowOff')[0]?.textContent || '0', 10)
            const blip = byLocal(pic, 'blip')[0]
            const rid = blip?.getAttribute('r:embed') || blip?.getAttribute('embed') || ''
            const ext = byLocal(anchor, 'ext')[0]
            const cx = ext ? parseInt(ext.getAttribute('cx') || '0', 10) : 0
            const cy = ext ? parseInt(ext.getAttribute('cy') || '0', 10) : 0
            const mediaPath = ridToMedia[rid]
            if (!mediaPath) continue
            let dataUrl = mediaCache.get(mediaPath.toLowerCase())
            if (!dataUrl) {
              const mf = findZipEntry(zip, mediaPath)
              if (!mf) continue
              const mb = await mf.async('blob')
              dataUrl = await blobToDataUrl(mb)
              mediaCache.set(mediaPath.toLowerCase(), dataUrl)
            }
            images.push({
              dataUrl,
              leftPx: cumX(col) + Math.round(colOff / 9525),
              topPx: cumY(row) + Math.round(rowOff / 9525),
              widthPx: Math.round(cx / 9525) || 120,
              heightPx: Math.round(cy / 9525) || 90,
            })
          }
        }
      }
    }
    result.push({ sheetName: sheetNames[si], images, looseImages })
  }
  return result
}


/**
 * 服务端 PDF 文本提取（node 端 pdfjs）。
 *
 * 背景：部分 PDF 在「浏览器端 pdfjs」取不出文字层（worker / CMap / eval 受限），导致
 * 文本提取返回空 → 知识库无内容可切片、预览显示「文档解析失败」、整篇总结瞬间空。
 * 实测 node 端 legacy pdfjs 能稳定解出此类 PDF 的中文（如「五期乙MES系统技术要求」75 页）。
 * 因此在服务端提供提取能力，前端对「后端托管的 PDF」统一改走服务端提取。
 */
import fs from 'fs'
import path from 'path'

let _pdfjsPromise = null
function loadPdfjs() {
  if (!_pdfjsPromise) {
    // pdfjs-dist 的 legacy 构建为 ESM，CJS 中通过动态 import 加载（Node 22 支持）
    _pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
  }
  return _pdfjsPromise
}

/**
 * 从 PDF 二进制缓冲区提取文本。
 * @returns {Promise<string>} 与前端 extractPdfText 相同格式：`--- 第X页 ---\n<页文本>\n\n`
 */
async function extractPdfTextFromBuffer(buf) {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false, // 规避部分环境下 eval 被禁导致字体解码失败
  }).promise

  // 优先使用 PDF 自身定义的页码标签（封面/目录可能导致物理页码与打印页码不一致）
  const pageLabels = doc.pageLabels || null

  let fullText = ''
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const textContent = await page.getTextContent()
    const pageText = textContent.items.map((it) => it.str).join(' ')
    const label = pageLabels && pageLabels[i - 1] ? pageLabels[i - 1] : String(i)
    fullText += `--- 第${label}页 ---\n${pageText}\n\n`
  }
  return fullText
}

/** 从磁盘 PDF 文件提取文本 */
async function extractPdfTextFromFile(filePath) {
  const buf = fs.readFileSync(filePath)
  return extractPdfTextFromBuffer(buf)
}

export { extractPdfTextFromFile, extractPdfTextFromBuffer }

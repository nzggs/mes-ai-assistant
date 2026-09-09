/**
 * 将 Markdown 回答导出为 Word(.doc) 文件并下载到本地
 * 采用 Word 可识别的 HTML 包装方式（无需额外依赖）
 */

/** HTML 转义，防止注入 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 行内格式：粗体/斜体/行内代码/链接 */
function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
}

/** 渲染 markdown 表格行 -> HTML */
function renderTableRow(line: string): string {
  const cells = line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim())
  return `<tr>${cells.map(c => `<td>${renderInline(c)}</td>`).join('')}</tr>`
}

/** 判断一行是否为 markdown 分隔行（表格对齐行，如 |---|:---:|） */
function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-')
}

/**
 * 将 markdown 文本转换为可在 Word 中显示的 HTML
 * 支持：标题、列表（有序/无序）、表格、代码块、引用、粗体/斜体/行内代码/链接、分隔线
 */
export function markdownToHtml(md: string): string {
  const lines = md.split(/\r?\n/)
  const html: string[] = []
  let i = 0
  let inCodeBlock = false
  let codeBuf: string[] = []
  let listType: 'ul' | 'ol' | null = null

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`)
      listType = null
    }
  }

  const flushCode = () => {
    if (codeBuf.length > 0) {
      html.push(`<pre style="background:#f5f5f5;padding:8px;border-radius:4px;font-family:Consolas,monospace;font-size:12px;">${escapeHtml(codeBuf.join('\n'))}</pre>`)
      codeBuf = []
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    // 代码块
    if (/^\s*```/.test(line)) {
      if (inCodeBlock) {
        flushCode()
        inCodeBlock = false
      } else {
        closeList()
        flushCode()
        inCodeBlock = true
      }
      i++
      continue
    }
    if (inCodeBlock) {
      codeBuf.push(line)
      i++
      continue
    }

    const trimmed = line.trim()

    // 空行
    if (!trimmed) {
      closeList()
      i++
      continue
    }

    // 标题
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      closeList()
      const level = heading[1].length
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      i++
      continue
    }

    // 分隔线
    if (/^\s*(---|\*\*\*|___)\s*$/.test(trimmed)) {
      closeList()
      html.push('<hr style="border:none;border-top:1px solid #ccc;margin:8px 0;" />')
      i++
      continue
    }

    // 引用
    if (/^>\s?/.test(trimmed)) {
      closeList()
      const quoteText = trimmed.replace(/^>\s?/, '')
      html.push(`<blockquote style="border-left:3px solid #ccc;margin:4px 0;padding-left:8px;color:#666;">${renderInline(quoteText)}</blockquote>`)
      i++
      continue
    }

    // 表格：连续行中以 | 开头 或 当前行为分隔行后接表头
    if (trimmed.startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      closeList()
      html.push('<table style="border-collapse:collapse;margin:8px 0;" border="1" cellpadding="6" cellspacing="0">')
      // 表头行
      html.push(`<thead><tr style="background:#f0f0f0;">${trimmed
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map(c => `<th style="border:1px solid #ccc;padding:6px;">${renderInline(c.trim())}</th>`)
        .join('')}</tr></thead>`)
      i += 2 // 跳过对齐行
      html.push('<tbody>')
      // 数据行
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        html.push(renderTableRow(lines[i]))
        i++
      }
      html.push('</tbody></table>')
      continue
    }

    // 列表
    const ul = trimmed.match(/^\s*[-*+]\s+(.*)$/)
    const ol = trimmed.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ul || ol) {
      const type = ol ? 'ol' : 'ul'
      if (listType !== type) {
        closeList()
        html.push(`<${type} style="padding-left:24px;margin:4px 0;">`)
        listType = type
      }
      html.push(`<li>${renderInline((ul || ol)![1])}</li>`)
      i++
      continue
    }

    // 普通段落
    closeList()
    html.push(`<p>${renderInline(trimmed)}</p>`)
    i++
  }

  closeList()
  flushCode()
  return html.join('\n')
}

/**
 * 清理并截断文件名：移除 Windows 非法字符、压缩空白，限制长度
 * @param name 原始文件名（如问题概述）
 * @param maxLen 最大字符数（默认 30 个汉字）
 */
export function sanitizeFilename(name: string, maxLen = 30): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '') // Windows 非法字符
    .replace(/\s+/g, ' ')         // 压缩连续空白
    .trim()
  const sliced = cleaned.slice(0, maxLen)
  return sliced || `AI回答_${Date.now()}`
}

/**
 * 导出 Markdown 文本为 .doc 文件并触发下载
 * @param mdText Markdown 文本
 * @param filename 文件名（不含扩展名）
 */
export async function exportMarkdownAsWord(mdText: string, filename: string): Promise<void> {
  if (!mdText || !mdText.trim()) return

  const bodyHtml = markdownToHtml(mdText)
  const html = `\ufeff<html xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:w="urn:schemas-microsoft-com:office:word"
xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(filename)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
<style>
  body { font-family: "微软雅黑", "Microsoft YaHei", sans-serif; font-size: 12pt; line-height: 1.6; color: #333; }
  h1,h2,h3,h4,h5,h6 { color: #1a1a1a; }
  code { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; font-family: Consolas, monospace; }
  a { color: #1a73e8; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`

  const blob = new Blob([html], { type: 'application/msword' })
  const fileName = `${sanitizeFilename(filename, 30)}.doc`

  // 回退方案：<a download>（部分环境忽略 download 属性，文件名会变成 Blob URL 的 UUID）
  const downloadViaAnchor = () => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // 优先使用 File System Access API：可直接指定建议文件名，
  // 不受部分环境忽略 <a download> 导致下载名变成 Blob URL UUID 的影响
  const picker = (window as any).showSaveFilePicker
  if (typeof picker !== 'function') {
    // 环境不支持该 API：只能回退到 <a download>
    downloadViaAnchor()
    return
  }

  try {
    const handle = await picker.call(window, {
      suggestedName: fileName,
      types: [{ description: 'Word 文档', accept: { 'application/msword': ['.doc'] } }],
    })
    const writable = await handle.createWritable()
    await writable.write(blob)
    await writable.close()
  } catch {
    // 用户主动取消保存对话框（或保存失败）：直接结束，
    // 不再回退弹出第二个下载窗口
  }
}

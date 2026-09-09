import { useState, useEffect, useRef, useCallback } from 'react'

interface PdfViewerProps {
  url: string
  searchTerm: string
  onPageChange: (page: number, total: number, labels?: string[] | null) => void
  onSearchResults: (pages: number[], total: number) => void
  registerJumpToPage: (fn: (page: number) => void) => void
}

export function PdfViewer({ url, searchTerm, onPageChange, onSearchResults, registerJumpToPage }: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [pdfDoc, setPdfDoc] = useState<any>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pageTexts, setPageTexts] = useState<string[]>([])
  const renderTaskRef = useRef<any>(null)

  // Load PDF document
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    // Dynamic import to avoid bundling pdfjs-dist in main chunk
    import('pdfjs-dist').then(async (pdfjsLib) => {
      // Configure worker
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

      // Resolve relative URL to absolute
      const absoluteUrl = new URL(url, window.location.origin).href

      try {
        const doc = await pdfjsLib.getDocument({
          url: absoluteUrl,
          cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/cmaps/',
          cMapPacked: true,
        }).promise

        if (cancelled) return
        setPdfDoc(doc)
        setTotalPages(doc.numPages)
        setCurrentPage(1)
        const labels: string[] | null = (doc as any).pageLabels || null
        onPageChange(1, doc.numPages, labels)

        // Extract text from all pages for search
        const texts: string[] = []
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i)
          const textContent = await page.getTextContent()
          texts.push(textContent.items.map((item: any) => item.str).join(' '))
        }
        if (!cancelled) {
          setPageTexts(texts)
          setLoading(false)
        }
      } catch (err: any) {
        if (!cancelled) {
          console.error('PDF load error:', err)
          const errMsg = err?.message || String(err)
          setError(`PDF 文件加载失败: ${errMsg}`)
          setLoading(false)
        }
      }
    }).catch((err) => {
      if (!cancelled) {
        console.error('Failed to load pdfjs-dist:', err)
        setError('PDF 渲染模块加载失败')
        setLoading(false)
      }
    })

    return () => {
      cancelled = true
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel() } catch {}
      }
    }
  }, [url])

  // Render current page
  const renderPage = useCallback(async (pageNum: number) => {
    if (!pdfDoc || !canvasRef.current) return

    if (renderTaskRef.current) {
      try { renderTaskRef.current.cancel() } catch {}
    }

    const page = await pdfDoc.getPage(pageNum)
    const canvas = canvasRef.current
    const context = canvas.getContext('2d')
    if (!context) return

    const containerWidth = canvas.parentElement?.clientWidth || 800
    const viewport = page.getViewport({ scale: 1 })
    const scale = Math.min(containerWidth / viewport.width, 1.5)
    const scaledViewport = page.getViewport({ scale })

    canvas.width = scaledViewport.width
    canvas.height = scaledViewport.height
    canvas.style.width = '100%'
    canvas.style.height = 'auto'

    const renderContext = {
      canvasContext: context,
      viewport: scaledViewport,
    }

    renderTaskRef.current = page.render(renderContext)
    try {
      await renderTaskRef.current.promise
    } catch (err: any) {
      if (err?.name !== 'RenderingCancelledException') {
        console.error('Render error:', err)
      }
    }
  }, [pdfDoc])

  useEffect(() => {
    if (pdfDoc && !loading) {
      renderPage(currentPage)
      onPageChange(currentPage, totalPages)
    }
  }, [currentPage, pdfDoc, loading, renderPage, totalPages, onPageChange])

  useEffect(() => {
    if (!searchTerm.trim() || pageTexts.length === 0) {
      onSearchResults([], totalPages)
      return
    }
    const lowerTerm = searchTerm.toLowerCase()
    const results: number[] = []
    pageTexts.forEach((text, idx) => {
      if (text.toLowerCase().includes(lowerTerm)) {
        results.push(idx + 1)
      }
    })
    onSearchResults(results, totalPages)
  }, [searchTerm, pageTexts, totalPages, onSearchResults])

  useEffect(() => {
    registerJumpToPage((page: number) => {
      setCurrentPage(page)
    })
  }, [registerJumpToPage])

  useEffect(() => {
    const handleResize = () => {
      if (pdfDoc && !loading) {
        renderPage(currentPage)
      }
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [currentPage, pdfDoc, loading, renderPage])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-3 border-mes-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-mes-textTertiary">正在加载 PDF 文件...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center gap-2">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-red-400">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <p className="text-sm text-red-500">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-center">
      <canvas ref={canvasRef} className="shadow-lg rounded-lg bg-white max-w-full" />
    </div>
  )
}

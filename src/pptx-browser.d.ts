// pptx-browser 无自带类型定义，此处声明其核心 API（仅预览所需）
declare module 'pptx-browser' {
  export class PptxRenderer {
    constructor()
    load(
      source: File | Blob | ArrayBuffer | Uint8Array,
      onProgress?: (progress: number, message: string) => void
    ): Promise<void>
    slideCount: number
    renderSlide(index: number, canvas: HTMLCanvasElement, width?: number): Promise<void>
    renderAllSlides(width?: number): Promise<HTMLCanvasElement[]>
    destroy(): void
  }
}

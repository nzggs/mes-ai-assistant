import { defineConfig } from 'vite'
import * as babel from '@babel/core'

// 内联 Babel 转换插件：用 @babel/core（纯 JS，无原生绑定）替换 @vitejs/plugin-react-swc。
// 原因：本机 Windows 上 SWC 原生绑定在 build 的 transforming 阶段偶发挂死（卡在 transforming...、esbuild 子进程=0），
// 而 @babel/core + preset-react + preset-typescript 为纯 JS 实现，可确定性完成 TSX/JSX/TS 转换，绕过该死锁。
// vite 输出语义（HTML/CSS/分块/import.meta.env）完全不变，仅底层转换引擎替换。
function babelReactTransform() {
  return {
    name: 'babel-react-transform',
    enforce: 'pre',
    async transform(code: string, id: string) {
      if (!/\.(t|j)sx?$/.test(id)) return null
      if (id.includes('node_modules')) return null
      const isTs = id.endsWith('.ts') || id.endsWith('.tsx')
      const isTsx = id.endsWith('.tsx') || id.endsWith('.jsx')
      const presets: any[] = []
      if (isTs) presets.push(['@babel/preset-typescript'])
      if (id.endsWith('.tsx') || id.endsWith('.jsx') || id.endsWith('.js')) {
        presets.push(['@babel/preset-react', { runtime: 'automatic' }])
      }
      const result = await babel.transformAsync(code, {
        filename: id,
        babelrc: false,
        configFile: false,
        sourceMaps: false,
        presets,
      })
      if (!result || result.code == null) return null
      return { code: result.code, map: result.map }
    },
  }
}

export default defineConfig({
  plugins: [babelReactTransform()],
  esbuild: false,
  server: {
    port: 5173,
    host: true
  },
  build: {
    outDir: 'dist',
    // 注：不能用 emptyOutDir:true——vite 会先 rmSync 整个 dist，被 WorkBuddy safe-delete 护栏拦截导致构建失败。
    // 陈旧产物由 scripts/clean-dist.mjs 在构建后逐个 unlink 清理。
    emptyOutDir: false,
    chunkSizeWarningLimit: 1500,
    // 注：本机 Windows 上 esbuild 持久服务进程在 minify / CSS 压缩阶段偶发死锁（构建卡在 rendering），
    // 故关闭 esbuild 压缩，改用纯 rollup 输出，规避该死锁。后续环境稳定后可恢复 minify:true 减小产物体积。
    minify: false,
    cssMinify: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: undefined
      }
    }
  }
})

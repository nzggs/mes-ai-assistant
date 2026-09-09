// 编程式 vite 构建（CLI 路径偶发卡死 transforming，改用 API 直接构建，见记忆十七）
// 用法：ESBUILD_WORKER_THREADS=0 node build.cjs
const path = require('path')

async function main() {
  const { build } = require('vite')
  console.log('[build] start', new Date().toISOString())
  const start = Date.now()
  await build({
    configFile: path.resolve(__dirname, 'vite.config.ts'),
    logLevel: 'info',
  })
  console.log('[build] done in', ((Date.now() - start) / 1000).toFixed(1) + 's')
}

main().catch((err) => {
  console.error('[build] FAILED:', err)
  process.exit(1)
})

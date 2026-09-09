import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react-swc'

// 测试专用配置，与 vite.config.ts(构建) 分离，互不影响。
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // 默认 jsdom（组件/服务）；服务端与服务端 e2e 测试文件顶部用
    // `// @vitest-environment node` 切换到 node 环境。
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'src/**/*.test.{ts,tsx}',
      'server/**/*.test.{js,ts}',
      'shared/**/*.test.{js,ts}',
    ],
    exclude: ['node_modules/**', 'dist/**', '.temp/**', 'tmp/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      reportsDirectory: './coverage',
      include: [
        'src/**/*.{ts,tsx}',
        'server/**/*.{js,ts}',
        'shared/**/*.{js,ts}',
      ],
      exclude: [
        '**/*.d.ts',
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/pptx-browser.d.ts',
        'src/types/index.ts',
        '**/*.test.{ts,tsx,js}',
        'node_modules/**',
        'dist/**',
      ],
    },
  },
})

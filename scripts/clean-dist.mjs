// 清理 dist/assets 中的陈旧构建产物（仅删除 mtime 早于基准时间的文件）
// 用法：node scripts/clean-dist.mjs --before <unix秒> （在 vite build 之前记录时间戳）
// 原理：本次构建重写的所有 chunk（含动态 import 的 pdf/docx 等）mtime 都会更新；
//       未被本次构建产出的旧文件 mtime 保持旧值，可安全删除。
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(__dirname, '..', 'dist')

const argIdx = process.argv.indexOf('--before')
const before = argIdx >= 0 ? Number(process.argv[argIdx + 1]) : 0
if (!before) {
  console.error('用法: node scripts/clean-dist.mjs --before <unix秒>')
  process.exit(1)
}

const assetsDir = path.join(DIST, 'assets')
if (!fs.existsSync(assetsDir)) {
  console.log('clean-dist: assets 目录不存在，跳过')
  process.exit(0)
}

let removed = 0
let kept = 0
for (const f of fs.readdirSync(assetsDir)) {
  const full = path.join(assetsDir, f)
  let stat
  try { stat = fs.statSync(full) } catch { continue }
  if (stat.isFile() && stat.mtimeMs < before * 1000) {
    try {
      fs.unlinkSync(full)
      removed++
    } catch (e) {
      console.error(`clean-dist: 删除 ${f} 失败: ${e.message}`)
    }
  } else {
    kept++
  }
}
console.log(`clean-dist: 清理 ${removed} 个陈旧产物，保留 ${kept} 个`)

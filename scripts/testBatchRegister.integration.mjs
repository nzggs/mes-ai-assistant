// 批量注册端到端集成测试：真实 xlsx 解析 + 真实 registerUser(localStorage 持久化)
// 用 esbuild 转译 services，并定义 import.meta.env 以适配 Node 运行。
import { build } from 'esbuild'
import * as XLSX from 'xlsx'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// ---- localStorage 最小 polyfill ----
const store = new Map()
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
}

const out = mkdtempSync(join(tmpdir(), 'br-int-'))
const entry = join(out, 'entry.mjs')
// 入口：透出被测函数（使用绝对路径，避免临时目录相对解析失败）
const src = join(process.cwd(), 'src/services')
writeFileSync(entry, `
export { validateBatchRow } from ${JSON.stringify(join(src, 'userValidation.ts'))}
export { registerUser, getRegisteredUsers, DEPARTMENTS } from ${JSON.stringify(join(src, 'userService.ts'))}
`)
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: join(out, 'bundle.mjs'),
  define: { 'import.meta.env': '{}' },
  logLevel: 'silent',
  absWorkingDir: process.cwd(),
})
const mod = await import(pathToFileURL(join(out, 'bundle.mjs')).href)
const { validateBatchRow, registerUser, getRegisteredUsers, DEPARTMENTS } = mod

let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL: ' + m) } }

// 预置一个已存在用户，验证重复拦截
registerUser({ username: 'seeduser', password: 'Seed1234', department: '技术部', role: 'user', mustChangePassword: true })

// 构造真实 xlsx：表头 + 混合数据行
const aoa = [
  ['用户名', '显示名称', '部门', '用户组', '密码'],
  ['zhangsan', '张三', '技术部', '用户', 'Abc12345'],   // 合法
  ['lisi', '李四', '质量部', '管理员', 'Xyz67890'],     // 合法(管理员)
  ['wangwu', '王五', '火星部', '用户', 'Pass1234'],     // 部门不存在
  ['zhaoliu', '赵六', '技术部', '超管', 'Pass1234'],     // 用户组不存在
  ['', '无名', '技术部', '用户', 'Pass1234'],           // 用户名为空
  ['bad name', '空格', '技术部', '用户', 'Pass1234'],    // 用户名含空格
  ['qianqi', '钱七', '技术部', '用户', '123'],          // 密码过短
  ['zhangsan', '张三重复', '技术部', '用户', 'Abc12345'],// 文件内重复
  ['seeduser', '已存在', '技术部', '用户', 'Seed1234'], // 与已存在用户重复
  ['', '', '', '', ''],                                  // 整行空(应跳过)
]
const ws = XLSX.utils.aoa_to_sheet(aoa)
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, ws, '批量注册模板')
const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })

// 模拟 handleBatchFile 的解析与落库循环
const wb2 = XLSX.read(buf, { type: 'array', cellDates: true })
const sh = wb2.Sheets[wb2.SheetNames[0]]
const rows = XLSX.utils.sheet_to_json(sh, { header: 1 })
const existingLower = new Set(Object.keys(getRegisteredUsers()).map(k => k.toLowerCase()))
const batchLower = new Set()
let success = 0
const failures = []
for (let i = 1; i < rows.length; i++) {
  const r = rows[i]
  const cells = (r || []).map(c => c == null ? '' : (typeof c === 'string' ? c : String(c)).trim())
  if (cells.every(c => c === '')) continue
  const v = validateBatchRow({ username: cells[0], displayName: cells[1], department: cells[2], roleRaw: cells[3], password: cells[4] ?? '' }, DEPARTMENTS, existingLower, batchLower)
  if (!v.ok) { failures.push(v.error); continue }
  const res = registerUser({ username: v.username, password: cells[4] ?? '', displayName: v.displayName, department: v.department, role: v.role, mustChangePassword: true })
  if (res.success) { success++; batchLower.add(v.username.toLowerCase()) } else failures.push(res.error)
}

const users = getRegisteredUsers()
console.log('=== 端到端集成测试 ===')
console.log('成功注册:', success, ' 失败行:', failures.length)
failures.forEach(f => console.log('  - 失败:', f))

ok(success === 2, '仅 2 个合法行落库(zhangsan, lisi)')
ok(users['zhangsan'] && users['zhangsan'].role === 'user', 'zhangsan 为用户')
ok(users['lisi'] && users['lisi'].role === 'admin', 'lisi 为管理员')
ok(!users['wangwu'], '部门不存在的 wangwu 未落库')
ok(!users['zhaoliu'], '用户组不存在的 zhaoliu 未落库')
ok(!users['bad name'], '含空格用户名的 bad name 未落库')
ok(!users['qianqi'], '密码过短的 qianqi 未落库')
ok(!users['seeduser2'] && users['seeduser'], '与已存在重复的 seeduser 未重复创建(预置仍在)')
ok(failures.length === 7, `失败行数应为 7(部门/角色/空用户名/空格用户名/短密码/文件内重复/已存在重复)，实际 ${failures.length}`)

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)

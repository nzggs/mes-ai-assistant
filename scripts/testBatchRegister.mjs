// 批量注册校验逻辑整体测试：用 esbuild 转译 userValidation.ts 后在 Node 跑断言
import { build } from 'esbuild'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEPARTMENTS = ['IT部', '技术部', '生产部', '质量部', '设备部']

const out = mkdtempSync(join(tmpdir(), 'uv-'))
const entry = join(out, 'userValidation.mjs')
await build({
  entryPoints: ['src/services/userValidation.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: entry,
  logLevel: 'silent',
})
const { validateBatchRow, isReservedUsername, USERNAME_RE, validatePassword } =
  await import(pathToFileURL(entry).href)

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++ } else { fail++; console.log('  ✗ FAIL: ' + msg) } }

// 辅助：构造一行
const row = (username, department = '技术部', roleRaw = '用户', password = 'Abc12345', displayName = '测试') =>
  ({ username, displayName, department, roleRaw, password })
const emptySets = () => ({ existingLower: new Set(), batchLower: new Set() })

console.log('=== A. 用户名校验 ===')
ok(!USERNAME_RE.test(''), '空用户名不通过')
ok(USERNAME_RE.test('zhangsan'), 'zhangsan 通过')
ok(USERNAME_RE.test('张三'), '中文用户名通过')
ok(!USERNAME_RE.test('a'), '单字符用户名不通过(长度<2)')
ok(!USERNAME_RE.test('x'.repeat(21)), '21 位用户名不通过(长度>20)')
ok(!USERNAME_RE.test('bad name'), '含空格用户名不通过')
ok(!USERNAME_RE.test('张三!'), '含特殊符号!不通过')
ok(isReservedUsername('__proto__'), '__proto__ 判为保留字')
ok(isReservedUsername('constructor'), 'constructor 判为保留字')
ok(!isReservedUsername('zhangsan'), '普通用户名非保留字')

console.log('=== B. 密码校验 ===')
ok(validatePassword('Abc12345') === null, 'Abc12345 通过')
ok(validatePassword('12345') !== null, '5 位不通过')
ok(validatePassword('a'.repeat(21)) !== null, '21 位不通过')
ok(validatePassword('abcdefgh') !== null, '纯字母不通过(需含数字)')
ok(validatePassword('12345678') !== null, '纯数字不通过(需含字母)')
ok(validatePassword('Abc 123') !== null, '含空格不通过')
ok(validatePassword('Abc123') === null, '6 位且含字母+数字通过')

console.log('=== C. validateBatchRow 整行 ===')
// 合法行
{
  const r = validateBatchRow(row('lisi', '质量部', '管理员', 'Xyz67890', '李四'), DEPARTMENTS, ...Object.values(emptySets()))
  ok(r.ok && r.role === 'admin', '合法管理员行通过且 role=admin')
}
{
  const r = validateBatchRow(row('wangwu'), DEPARTMENTS, ...Object.values(emptySets()))
  ok(r.ok && r.role === 'user', '合法用户行通过且 role=user')
}
// 用户名相关失败
ok(!validateBatchRow(row(''), DEPARTMENTS, ...Object.values(emptySets())).ok, '空用户名失败')
ok(!validateBatchRow(row('__proto__'), DEPARTMENTS, ...Object.values(emptySets())).ok, '保留字用户名失败')
ok(!validateBatchRow(row('a'), DEPARTMENTS, ...Object.values(emptySets())).ok, '过短用户名失败')
// 部门相关失败
ok(!validateBatchRow(row('u1', '技术部X'), DEPARTMENTS, ...Object.values(emptySets())).ok, '不存在的部门失败')
ok(!validateBatchRow(row('u2', ''), DEPARTMENTS, ...Object.values(emptySets())).ok, '空部门失败')
// 用户组相关失败
ok(!validateBatchRow(row('u3', '技术部', '超管'), DEPARTMENTS, ...Object.values(emptySets())).ok, '非法用户组失败')
ok(!validateBatchRow(row('u4', '技术部', ''), DEPARTMENTS, ...Object.values(emptySets())).ok, '空用户组失败')
// 密码相关失败
ok(!validateBatchRow(row('u5', '技术部', '用户', '123'), DEPARTMENTS, ...Object.values(emptySets())).ok, '短密码失败')
ok(!validateBatchRow(row('u6', '技术部', '用户', 'abcdefgh'), DEPARTMENTS, ...Object.values(emptySets())).ok, '纯字母密码失败')
ok(!validateBatchRow(row('u7', '技术部', '用户', ''), DEPARTMENTS, ...Object.values(emptySets())).ok, '空密码失败')

console.log('=== D. 重复检测（已存在 / 文件内）===')
{
  const existing = new Set(['zhangsan'])
  const r = validateBatchRow(row('ZhangSan'), DEPARTMENTS, existing, new Set())
  ok(!r.ok && r.error === '用户名已存在', '大小写重复(已存在)被拦截')
}
{
  const batch = new Set(['lisi'])
  const r1 = validateBatchRow(row('lisi'), DEPARTMENTS, new Set(), batch)
  ok(!r1.ok && r1.error === '用户名已存在', '文件内重复被拦截')
}
{
  // 首行成功后，第二行同用户名应被文件内重复拦截（模拟 handleBatchFile 流程）
  const batch = new Set()
  const first = validateBatchRow(row('wangwu'), DEPARTMENTS, new Set(), batch)
  ok(first.ok, '首行 wangwu 校验通过')
  if (first.ok) batch.add('wangwu')
  const second = validateBatchRow(row('wangwu'), DEPARTMENTS, new Set(), batch)
  ok(!second.ok, '同文件第二行 wangwu 被文件内重复拦截')
}

console.log('=== E. 显示名称过长 ===')
ok(!validateBatchRow(row('u8', '技术部', '用户', 'Abc12345', 'x'.repeat(31)), DEPARTMENTS, ...Object.values(emptySets())).ok, '超长显示名失败')

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)

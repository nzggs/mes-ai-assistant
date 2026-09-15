/**
 * 规格表达式解析与求值（纯函数，零依赖，**不使用 eval / new Function**）
 * ============================================================================
 * 「APC 和 RTO」的参数规格（当前设定值 / RTO 理想操作点 / 规格下限 LSL /
 * 规格上限 USL / 可调下限 / 可调上限）除了写死数字，还允许写成**取数结果的列名表达式**，
 * 例如 `USL_COL - 1`、`(LSL_COL + USL_COL) / 2`。
 * 现场型号多、交错生产，规格随单据行变化，逐型号手工维护数字不现实，
 * 直接把规格放到 SQL 结果列里随行取回、用表达式微调，才是可维护的形态。
 *
 * 安全边界（这是本模块存在的意义）：
 *   - 自己写递归下降解析器，**只认识** 数字 / 列名 / `+ - * /` / 括号 / 一元正负；
 *   - 函数调用、属性访问、逗号、字符串、赋值、下标一律拒绝；
 *   - 因此表达式永远不可能变成可执行代码，最多是「四则运算 + 取列值」。
 *
 * 上限（防止用超长表达式退化服务端）：
 *   - 源码 ≤ 400 字符；引用的列名 ≤ 32 个；每个列名 ≤ 64 字符；AST 嵌套 ≤ 32 层。
 */

export const SPEC_EXPR_MAX_LEN = 400
export const SPEC_EXPR_MAX_IDENTS = 32
export const SPEC_EXPR_MAX_IDENT_LEN = 64
export const SPEC_EXPR_MAX_DEPTH = 32

/** 数字字面量：1 / 1.5 / .5 / 1e-3 / -2.5（符号由一元运算符处理） */
const NUM_RE = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/
/** 列名：字母或下划线开头；HANA 列名常见形态（大写字母 + 数字 + 下划线）都在此范围内 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/
/** 纯数字字符串（用于「能静态判定大小关系」的场合） */
const PLAIN_NUM_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * 是否为「纯数字」——数字本身，或只由数字构成的字符串。
 * 用于决定 lsl < usl / min < max 能不能在保存时就静态校验：
 * 一旦任一侧是列名表达式，就只能等运行期取到数据行后再判定。
 */
export function isPlainNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (!s || !PLAIN_NUM_RE.test(s)) return false
  return Number.isFinite(Number(s))
}

/** 纯数字 → number；否则返回 null（调用方据此走表达式分支） */
export function toPlainNumber(v) {
  return isPlainNumber(v) ? Number(v) : null
}

// ===== 词法 =====

const OPERATORS = new Set(['(', ')', '+', '-', '*', '/'])

function tokenize(src) {
  const tokens = []
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    if (OPERATORS.has(ch)) {
      tokens.push({ type: ch, pos: i })
      i++
      continue
    }
    if (ch === '.' || (ch >= '0' && ch <= '9')) {
      if (ch === '.' && !(src[i + 1] >= '0' && src[i + 1] <= '9')) {
        return { ok: false, error: `第 ${i + 1} 位出现「.」：不支持属性访问，小数需写成 0.5 或 .5` }
      }
      const m = NUM_RE.exec(src.slice(i))
      if (!m) return { ok: false, error: `第 ${i + 1} 位处的数字写法无效` }
      tokens.push({ type: 'num', value: Number(m[0]), text: m[0], pos: i })
      i += m[0].length
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = IDENT_RE.exec(src.slice(i))
      tokens.push({ type: 'ident', name: m[0], pos: i })
      i += m[0].length
      continue
    }
    if (ch === ',') return { ok: false, error: '不支持逗号（本表达式只做四则运算，无函数调用与多参数）' }
    if (ch === ';') return { ok: false, error: '不支持分号' }
    if (ch === "'" || ch === '"' || ch === '`') return { ok: false, error: '不支持字符串字面量' }
    if (ch === '=') return { ok: false, error: '不支持赋值' }
    if (ch === '[' || ch === ']' || ch === '{' || ch === '}') {
      return { ok: false, error: `不支持的字符「${ch}」` }
    }
    if (ch === '^' || ch === '%' || ch === '!' || ch === '&' || ch === '|' || ch === '<' || ch === '>' || ch === '?') {
      return { ok: false, error: `不支持的运算符「${ch}」（仅支持 + - * / 与括号）` }
    }
    return { ok: false, error: `不支持的字符「${ch}」（第 ${i + 1} 位）` }
  }
  return { ok: true, tokens }
}

// ===== 语法（递归下降 + 优先级）=====

function parseTokens(tokens) {
  let p = 0
  const peek = () => tokens[p]

  function unexpected(what) {
    const t = peek()
    if (!t) return new Error(`表达式不完整：${what}`)
    return new Error(`第 ${t.pos + 1} 位出现意外的「${t.type === 'num' ? t.text : t.type === 'ident' ? t.name : t.type}」：${what}`)
  }

  // 加减（最低优先级）
  function parseAdditive() {
    let left = parseMultiplicative()
    while (peek() && (peek().type === '+' || peek().type === '-')) {
      const op = tokens[p++].type
      const right = parseMultiplicative()
      left = { type: 'binary', op, left, right }
    }
    return left
  }

  // 乘除
  function parseMultiplicative() {
    let left = parseUnary()
    while (peek() && (peek().type === '*' || peek().type === '/')) {
      const op = tokens[p++].type
      const right = parseUnary()
      left = { type: 'binary', op, left, right }
    }
    return left
  }

  // 一元正负（可叠加：--1、-(-x)）
  function parseUnary() {
    const t = peek()
    if (t && (t.type === '+' || t.type === '-')) {
      p++
      return { type: 'unary', op: t.type, arg: parseUnary() }
    }
    return parsePrimary()
  }

  function parsePrimary() {
    const t = peek()
    if (!t) throw new Error('表达式不完整（缺少操作数）')
    if (t.type === 'num') {
      p++
      return { type: 'num', value: t.value }
    }
    if (t.type === 'ident') {
      p++
      const nx = peek()
      // 提前识别常见误用，报出比「表达式不完整」更有用的原因
      if (nx && nx.type === '(') throw new Error(`不支持函数调用「${t.name}(...)」，本表达式只做四则运算`)
      if (nx && nx.type === '.') throw new Error(`不支持属性访问「${t.name}.」`)
      return { type: 'id', name: t.name }
    }
    if (t.type === '(') {
      p++
      const inner = parseAdditive()
      const closing = peek()
      if (!closing || closing.type !== ')') throw new Error('括号未闭合')
      p++
      return inner
    }
    throw unexpected('此处需要一个数字、列名或左括号')
  }

  const ast = parseAdditive()
  if (p !== tokens.length) {
    const t = tokens[p]
    throw new Error(
      `第 ${t.pos + 1} 位出现多余内容「${t.type === 'num' ? t.text : t.type === 'ident' ? t.name : t.type}」：` +
      '运算符之间缺少连接（或误用了不被支持的写法）'
    )
  }
  return ast
}

/** 表达式引用的全部列名（去重，按出现顺序，大小写保留原样） */
export function exprIdentifiers(ast) {
  const out = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'id') {
      if (!out.includes(node.name)) out.push(node.name)
      return
    }
    if (node.type === 'unary') walk(node.arg)
    else if (node.type === 'binary') {
      walk(node.left)
      walk(node.right)
    }
  }
  walk(ast)
  return out
}

/** AST 实际嵌套深度（用于拦截 1+1+1+... 这类不加深括号但树很深的长链） */
export function exprDepth(ast) {
  if (!ast || typeof ast !== 'object') return 0
  if (ast.type === 'num' || ast.type === 'id') return 1
  if (ast.type === 'unary') return 1 + exprDepth(ast.arg)
  if (ast.type === 'binary') return 1 + Math.max(exprDepth(ast.left), exprDepth(ast.right))
  return 1
}

// ===== 对外：解析 =====

/**
 * 解析规格表达式。
 * @param {string} src
 * @returns {{ok:true, ast:object, idents:string[]} | {ok:false, error:string}}
 */
export function parseExpr(src) {
  const text = String(src == null ? '' : src).trim()
  if (!text) return { ok: false, error: '表达式为空' }
  if (text.length > SPEC_EXPR_MAX_LEN) {
    return { ok: false, error: `表达式过长（${text.length} 字符，最多 ${SPEC_EXPR_MAX_LEN} 字符）` }
  }
  const tk = tokenize(text)
  if (!tk.ok) return { ok: false, error: tk.error }
  if (tk.tokens.length === 0) return { ok: false, error: '表达式为空' }

  let ast
  try {
    ast = parseTokens(tk.tokens)
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }

  const idents = exprIdentifiers(ast)
  if (idents.length > SPEC_EXPR_MAX_IDENTS) {
    return { ok: false, error: `引用的列名过多（${idents.length} 个，最多 ${SPEC_EXPR_MAX_IDENTS} 个）` }
  }
  for (const id of idents) {
    if (id.length > SPEC_EXPR_MAX_IDENT_LEN) {
      return { ok: false, error: `列名过长（${id.length} 字符，最多 ${SPEC_EXPR_MAX_IDENT_LEN} 字符）：${id}` }
    }
  }
  if (exprDepth(ast) > SPEC_EXPR_MAX_DEPTH) {
    return { ok: false, error: `表达式嵌套过深（最多 ${SPEC_EXPR_MAX_DEPTH} 层）` }
  }
  return { ok: true, ast, idents }
}

// ===== 对外：求值 =====

function evalNode(node, resolve) {
  switch (node.type) {
    case 'num':
      return node.value
    case 'id': {
      const raw = resolve ? resolve(node.name) : undefined
      if (raw === null || raw === undefined || raw === '') {
        throw new Error(`列「${node.name}」在该数据行中没有值`)
      }
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n)) throw new Error(`列「${node.name}」的值不是有效数字（${String(raw)}）`)
      return n
    }
    case 'unary': {
      const a = evalNode(node.arg, resolve)
      return node.op === '-' ? -a : a
    }
    case 'binary': {
      const l = evalNode(node.left, resolve)
      const r = evalNode(node.right, resolve)
      if (node.op === '+') return l + r
      if (node.op === '-') return l - r
      if (node.op === '*') return l * r
      if (node.op === '/') {
        if (r === 0) throw new Error('出现了除以 0')
        return l / r
      }
      throw new Error(`不支持的运算符「${node.op}」`)
    }
    default:
      throw new Error('表达式节点未知')
  }
}

/**
 * 求值。
 * @param {object} ast parseExpr 得到的 AST
 * @param {(name:string)=>number|string|null|undefined} resolve 列名 → 原始值（大小写不敏感由调用方保证）
 * @returns {{ok:true, value:number} | {ok:false, error:string}}
 */
export function evalExpr(ast, resolve) {
  if (!ast || typeof ast !== 'object') return { ok: false, error: '表达式为空' }
  try {
    const value = evalNode(ast, resolve)
    if (!Number.isFinite(value)) {
      return { ok: false, error: '表达式结果不是有限数值（可能出现了除以 0 或数值溢出）' }
    }
    return { ok: true, value }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

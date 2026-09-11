/**
 * SQL 只读护栏（纯函数，零外部依赖）
 * ============================================================================
 * 「APC 和 RTO」功能允许管理员在页面上手工配置取数 SQL，因此这一层是唯一的
 * 安全底线，任何来源（目录文件、页面保存、试运行草稿）的 SQL 都必须先过这里：
 *
 *  1) 只允许单条 SELECT / WITH；DDL / DML（insert/update/delete/merge/truncate/
 *     drop/alter/create/grant/call/...）以及 SELECT INTO、FOR UPDATE 一律拒绝。
 *  2) 校验前先剥离注释、并把字符串字面量与带引号标识符替换为等长空格，
 *     避免用注释或字面量夹带危险关键字（既不误报也不漏报）。
 *  3) 多语句（分号）直接拒绝。
 *  4) 执行前追加行数上限，任何一次读取都不可能超过上限行。
 *
 * 本模块只做「文本判定」，不碰连接、不做 IO，便于单测与复用。
 */

// ===== 词法扫描：剥离注释 / 屏蔽字面量 =====

/**
 * 单次扫描：剥离注释；maskLiterals=true 时把字符串字面量与带引号标识符的内容
 * 替换为等长空格（长度保持不变）。带引号标识符一定不是关键字，字符串内容也不该
 * 触发关键字拦截，故做屏蔽后再做关键字校验，避免误报与漏报。
 */
function scanSql(sql, maskLiterals) {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    const next = i + 1 < n ? sql[i + 1] : ''

    // 行注释 --
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++
      out += ' '
      continue
    }
    // 块注释 /* */
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && i + 1 < n && sql[i + 1] === '/')) i++
      i += 2
      out += ' '
      continue
    }
    // 字符串字面量 '...'（'' 为转义）
    if (ch === "'") {
      let lit = ch
      i++
      while (i < n) {
        lit += sql[i]
        if (sql[i] === "'") {
          if (i + 1 < n && sql[i + 1] === "'") {
            lit += sql[i + 1]
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      out += maskLiterals ? ' '.repeat(lit.length) : lit
      continue
    }
    // 带引号标识符 "..."（"" 为转义）
    if (ch === '"') {
      let lit = ch
      i++
      while (i < n) {
        lit += sql[i]
        if (sql[i] === '"') {
          if (i + 1 < n && sql[i + 1] === '"') {
            lit += sql[i + 1]
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      out += maskLiterals ? ' '.repeat(lit.length) : lit
      continue
    }
    out += ch
    i++
  }
  return out
}

/** 去掉注释（保留字符串/标识符原样），用于最终执行 */
export function stripSqlComments(sql) {
  return scanSql(String(sql == null ? '' : sql), false)
}

/** 去注释 + 屏蔽字面量，用于安全校验 */
export function maskSql(sql) {
  return scanSql(String(sql == null ? '' : sql), true)
}

// ===== 只读校验 =====

/**
 * 只读禁止词。都是「整词」匹配：\b 与下划线同属单词字符边界，
 * 因此 LEGAL_UPDATE_TIME 这类列名不会被 LAST_UPDATE 误伤。
 */
const FORBIDDEN_KEYWORDS = [
  'insert', 'update', 'delete', 'upsert', 'replace', 'merge',
  'truncate', 'drop', 'alter', 'create', 'rename',
  'grant', 'revoke', 'call', 'do', 'exec', 'execute',
  'commit', 'rollback', 'savepoint', 'begin', 'lock', 'unlock',
  'import', 'export', 'load', 'unload', 'into', 'procedure', 'function',
]

function badSql(message) {
  const err = new Error(message)
  err.code = 'EHDBREADONLY'
  err.status = 400
  return err
}

/**
 * 校验 SQL 只能是单条只读查询。通过则返回可直接执行的清洗后 SQL。
 * @throws {Error} code=EHDBREADONLY status=400
 */
export function assertReadOnlySql(sql) {
  const cleaned = stripSqlComments(sql).trim().replace(/;+\s*$/, '')
  if (!cleaned) throw badSql('SQL 为空，已拒绝执行')

  const masked = maskSql(cleaned)

  // 多语句：清洗后的文本里仍出现分号即为拼接多条语句
  if (masked.includes(';')) throw badSql('只允许单条 SQL 语句，检测到分号，已拒绝执行')

  // 必须以 SELECT / WITH 开头
  if (!/^(select|with)\b/i.test(masked)) {
    throw badSql('只读数据源仅允许 SELECT / WITH 查询，已拒绝执行')
  }

  // 危险关键字整词拦截
  const flat = masked.replace(/\s+/g, ' ')
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(flat)) {
      throw badSql(`只读数据源检测到禁止的 SQL 关键字「${kw.toUpperCase()}」，已拒绝执行`)
    }
  }

  return cleaned
}

/**
 * 给查询追加行数上限。已存在 LIMIT / SELECT TOP 时按需收紧或保持原样，
 * 保证任何情况下单次读取都不超过 maxRows 行。
 */
export function applyRowLimit(sql, maxRows, useLimit = true) {
  const trimmed = stripSqlComments(sql).trim().replace(/;+\s*$/, '')
  if (!useLimit) return trimmed
  if (!Number.isFinite(maxRows) || maxRows <= 0) return trimmed

  const limitMatch = /(^|\s)limit\s+(\d+)\s*$/i.exec(trimmed)
  if (limitMatch) {
    const current = Number(limitMatch[2])
    if (current <= maxRows) return trimmed
    return `${trimmed.slice(0, limitMatch.index)} LIMIT ${maxRows}`
  }
  // 已有 TOP n 子句：不重复注入（HANA 中 TOP 与 LIMIT 混用会报错）
  if (/^\s*select\s+top\s+\d+/i.test(trimmed)) return trimmed

  return `${trimmed} LIMIT ${maxRows}`
}

// ===== SQL 模板（占位符替换）=====

/** 模板占位符：{{name}} */
const PLACEHOLDER_RE = /\{\{\s*(\w+)\s*\}\}/g

/** 提取模板中出现的全部占位符名（去重） */
export function extractTemplateVars(sql) {
  const names = []
  const text = String(sql == null ? '' : sql)
  let m
  PLACEHOLDER_RE.lastIndex = 0
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
    if (!names.includes(m[1])) names.push(m[1])
  }
  return names
}

/**
 * 渲染 SQL 模板。strict=true（默认）时遇到未提供的占位符直接报错，
 * 避免把 {{xxx}} 原样送进数据库造成语法错误难以定位。
 */
export function renderSqlTemplate(tpl, vars = {}, { strict = true } = {}) {
  return String(tpl == null ? '' : tpl).replace(PLACEHOLDER_RE, (_m, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key])
    if (strict) throw badSql(`取数 SQL 模板存在未提供的占位符：{{${key}}}`)
    return ''
  })
}

/** 标识符（表名/列名/模式名）：只允许常规字符，用于安全地拼进 SQL */
export const IDENT_RE = /^[A-Za-z0-9_$#]{1,128}$/

/** 校验并返回安全标识符（带引号） */
export function assertIdent(name, label = '标识符') {
  const s = String(name == null ? '' : name).trim()
  if (!IDENT_RE.test(s)) {
    throw badSql(`${label}非法（仅允许字母/数字/下划线/$/#，最长 128 字符）：${s || '(空)'}`)
  }
  return s
}

/** 给标识符加双引号（用于拼进 SQL） */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

/**
 * MES 数据直查（问答两轮）的文本解析工具 —— 纯函数，便于单测
 * ============================================================================
 * 第一轮模型在回答里输出一个 ```mes-sql 代码块，这里负责：
 *  - extractMesSql：取出代码块里的 SQL
 *  - trimAfterMesSqlBlock：截掉代码块之后的输出（模型常在那后面复述/编造结果）
 *  - extractMesSource：从代码块之外的正文里取出「来源：xxx」标注
 * 第二轮由 App.tsx 提交 POST /api/mes/query 执行，并把真实结果回灌给模型。
 */

/**
 * 从模型回答中提取 mes-sql 推荐查询（只取第一个代码块）。
 *
 * 模型有时会在代码块里先写一行说明（如「来源：Z_LOGIC_xxx.xml」）再写 SQL。
 * 那一行不是 SQL 语法，原样送进只读护栏会以「只读数据源仅允许 SELECT / WITH
 * 查询，已拒绝执行」被拒（现场实测出现过这种 400）。这里从第一行以
 * SELECT / WITH 开头的语句起截取，丢弃前面的说明行；来源另由
 * extractMesSource 从代码块之外的正文提取。
 */
export function extractMesSql(text: string): string | null {
  const m = /```mes-sql\s*([\s\S]*?)```/.exec(text)
  if (!m) return null
  const body = m[1].trim()
  if (!body) return null
  const lines = body.split('\n')
  const start = lines.findIndex(line => /^\s*(select|with)\b/i.test(line))
  // start > 0：前面是说明行，从 SQL 起始行截取
  // start === 0 或根本没找到（start === -1）：原样返回，交给护栏给出明确报错
  const sql = (start > 0 ? lines.slice(start).join('\n') : body).trim()
  return sql || null
}

/** 截掉 mes-sql 代码块之后的所有输出。
 * 第一轮模型在给出 SQL 后若继续输出"结果表格 / 数值 / 结论"，必然不是真实查询结果
 * （真实结果要等第二轮系统回传），多为对历史成功回答的复述或编造——曾导致
 * 「查询失败却在报错前列出查询结果」的误导。展示与回灌历史时一律只保留到代码块结束。 */
export function trimAfterMesSqlBlock(text: string): string {
  const start = text.indexOf('```mes-sql')
  if (start === -1) return text
  const end = text.indexOf('```', start + 10)
  if (end === -1) return text.slice(0, start)
  return text.slice(0, end + 3)
}

/** 从 mes-sql 代码块之前的文本里提取「来源：xxx」标注（SQL 取自哪篇文档/哪个脚本） */
export function extractMesSource(text: string): string | null {
  const m = text.match(/来源\s*[：:]\s*([^\n`]{1,120})/)
  return m ? m[1].trim() : null
}

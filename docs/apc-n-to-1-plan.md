# APC / RTO：由「1 对 1」改造为「多对 1」调优 —— 实施方案

> 基线：`8aea7c2`（回退后状态）。本文只做设计，不含任何代码改动。
> 目标读者：现场工艺 + 项目开发。确认后按 §11 分阶段实施。

---

## 1. 需求与确认结论

把现有「1 个参数 → 1 个结果」的自调优，改为「N 个参数 → 1 个结果」的多变量调优。

已确认的四项设计结论（D1–D4）：

| 编号 | 结论 |
| --- | --- |
| D1 | 一个监测项 = **1 条 SQL + 1 个输出结果(CV) + N 个参与参数(MV)**，CV 与 MV 取自同一行的不同列 |
| D2 | kᵢ 由**确定性回归**从历史数据算出，AI 只负责把结果翻译成人话；不把拟合交给大模型 |
| D3 | 保留 1:1 兼容：N=1 时新公式**严格退化**为旧公式，老项目不改也能跑 |
| D4 | 第一期做「结构 + 取数 + 求解 + 界面」；第二期做 kᵢ 自动标定（回归 + AI 解读） |

补充需求（用户原话要点）：

- kᵢ 用历史数据 + SQL 查询算出推荐值，**也允许手动输入覆盖**；**不做成列名表达式**（与型号无关）。
- 输出结果是**变量**：电芯重量 / 容量 / 内阻等各自单独设置，SQL 查出「变量名 + 值」。
- 参与参数是多列，与输出结果**同一行**；各自量程与单位在界面手动配置。
- **SQL 模板隶属于参数配置**：一个项目可有多个监测项，每项一套自己的 SQL 模板。
- **删除窄表（long）模式，只用宽表（wide）**。

---

## 2. 现状核对（不可绕过的事实）

### 2.1 数据模型

```
projects[id] = { id, name, description, dbSlot,
                 queries: { mode, history, columns{code,ts,value} },
                 params:  [ 参数 × 16 字段 ],
                 createdAt, updatedAt }
```

- `projects` 是 **对象 map**（`apcConfig.js:390-400`），不是数组。
- `normalizeProject`（`apcConfig.js:425-462`）只认 `name / description / dbSlot / queries / params`。

### 2.2 三个必须提前处理的坑

| # | 位置 | 问题 | 后果 |
| --- | --- | --- | --- |
| **P1** | `apcCatalog.js:124-143` `normalizeQueries` | 白名单**只返回** `{mode, history, columns}` | 往里加的新字段会被**静默丢弃**——存不进也读不出，且不报错 |
| **P2** | `apcCatalog.js:243-269` `validateCatalog` | 返回值里**没有 `schema`** | `buildTemplateVars`（`apcService.js:190`）里 `catalog.schema` 恒为 `''`，`{{schema}}` **永远展开成空**（既有缺陷，顺手修） |
| **P3** | `apcService.js:872` `optimizeParam` | `error = optimalTarget - stats.mean`，而 `mean` 是**被调参数自己**的测量值 | 旧模型本质是**自调优**（CV ≡ MV），不是真的 1 对 1 两列 |

**P3 是本次改造的核心动机**：旧模型里没有独立的 CV，`processGain` 描述的是「这个参数的测量值随其设定值怎么变」。
它恰好就是新模型里 kᵢ 的前身 → 这是 D3 「N=1 严格退化」成立的依据。

### 2.3 求解链路（旧）

```
error = optimalTarget − mean
wanted = setpoint + error / processGain        // ← 除，apcService.js:873
裁剪到 [min, max]  →  ±maxStepPct 限幅  →  量化
死区：status==='normal' 且 |error| ≤ 规格带宽 × deadbandPct%
预测：predictedMean = mean + ΔMV × gain          // ← 乘，apcService.js:894
```

除 / 乘在数学上自洽（`mean + (error/g)×g = optimalTarget`），新模型沿用同一套符号约定。

### 2.4 取数链路（旧）

`fetchProcessSeries`（`apcService.js:585-682`）按 `params[].dbSlot` 分组、每组一条 SQL；
`normalizeWideSeries`（`:564-578`）一行一个时间戳，每个参数取 `p.column` 一列。

**确认：全链路零跨参数计算**——没有任何一处同时用到两个参数的值。多对 1 是新增能力，不替换旧逻辑。

---

## 3. 新数据模型

```jsonc
projects[id] = {
  id, name, description, dbSlot,
  createdAt, updatedAt,
  items: [
    {
      id: "it_xxx",
      name: "电芯重量",
      description: "",

      // ① 本监测项专属取数（宽表；mode 不再出现在界面上）
      query: {
        history: "SELECT ... {{minutes}} ...",
        columns: { ts: "TS" }
      },

      // ② 输出结果（CV），唯一
      output: {
        code: "CELL_WEIGHT",
        name: "电芯重量",
        unit: "g",
        decimals: 3,
        column: "CELL_WEIGHT",          // SQL 结果列名
        objective: "quality",
        spec: {
          lsl: 12.0, usl: 13.0,          // number | 列名表达式（复用 specExpr）
          target: 12.5                   // RTO 理想操作点；缺省 = (lsl+usl)/2
        }
      },

      // ③ 参与调优的参数（MV），N ≥ 1
      params: [
        {
          code: "SLURRY_SOLID",
          name: "浆料固含量",
          unit: "%",
          decimals: 3,
          column: "SLURRY_SOLID",
          min: 60, max: 80,              // 量程：手动配置，用于归一化 sᵢ
          maxStepPct: 3,                 // 单次调整限幅
          weight: 1,                     // wᵢ 调整阻力（默认 1，越大越少动）
          enabled: true,                 // 本期是否参与
          k: {                           // ∂CV/∂MVᵢ
            mode: "manual",              // manual | calibrated
            value: 0.02,                 // 生效值
            calibrated: null             // { value, r2, n, at, method, warnings[] }
          }
        }
      ],

      // ④ 调优策略
      tuning: {
        deadbandPct: 10,                 // 死区（占规格带宽 %），不可删
        maxRounds: 2,                    // 触限后再分配轮数
        residualTolerancePct: 5          // 残差大于此比例则报「无法完全消除」
      }
    }
  ],

  // 兼容字段（老项目读取用，见 §4）
  queries: null, params: [], legacyMigrated: true
}
```

不变的部分：`databases / meta / limits` 三个全局段原样保留；`meta.station` 仍是全局装置名。

---

## 4. 迁移策略（关键：无损、不炸）

> 教训：上次 JOIN 回退之所以让线上 APC 全部 500，就是因为**数据卷里已有新格式，而旧校验器读不了**。这次迁移必须反向也安全。

### 4.1 读取时惰性合成（不写盘）

`getProject(id)` 增加一层：若 `project.items` 缺失或为空，则**在内存里**合成：

```
老 params[i]  →  items[i] = {
  name: params[i].name,
  query: project.queries,
  output: {
    code: params[i].code, name, unit, decimals,
    column: params[i].column,
    objective: params[i].objective,
    spec: { lsl, usl, target: optimalTarget }
  },
  params: [ { ...params[i], weight: 1, enabled: true,
              k: { mode:'manual', value: params[i].processGain } } ],
  tuning: { deadbandPct: params[i].deadbandPct }
}
```

**为什么这样迁移是严格等价的**：新模型 N=1 时 `ΔMV = ΔCV / k`，代入 `k = processGain`、`ΔCV = target − mean`，即 `ΔMV = (optimalTarget − mean) / processGain`，与 `apcService.js:873` 逐字相同。

- 读：老项目自动变成 N 个「自调优」监测项，行为与今天一致（D3）。
- 写：只有用户**主动保存**某个项目时，才把合成结果落盘（`legacyMigrated: true`），此时 `queries/params` 置空。
- 不做批量迁移脚本，不做全量重写——避免一次性改动数据卷。

### 4.2 窄表模式

`QUERY_MODES` 收缩为 `['wide']`，界面不再提供选项。但 `normalizeQueries` 遇到历史 `mode: 'long'` 时**不抛错**，保留并标记 `deprecated: true`，走旧 `normalizeSeries` 分支；界面在这些项目上显示「该监测项使用旧版窄表模式，建议重建」。

> 理由同上：直接报错 = 数据卷里只要有老 long 项目，整个 APC 接口 500。**先冻结，再引导重建**。

---

## 5. 取数改造

### 5.1 一条 SQL 拿到 CV + 全部 MV

宽表天然满足「同一行」要求。`buildTemplateVars` 要支持：

- `{{columns}}` 自动展开 **CV 列 + 全部 MV 列 + ts 列 + 规格表达式引用列**（现有并入逻辑 `apcService.js:205-217` 直接复用并扩展）。
- 删除 `{{codeFilter}}` 的 long 分支（保留变量本身以免老模板报错，但其为空）。
- 修 P2：`validateCatalog` 返回值补上 `schema`，让 `{{schema}}` 真正生效。

### 5.2 新取数函数

```js
// 返回 { series: { output: [{t,v,rawRow}], params: { code: [{t,v,rawRow}] } }, meta }
fetchItemSeries({ project, item, minutes, maxRows })
```

- 按 `item.query` 渲染 SQL，一次查询取回该行所有列。
- `rawRow` 仍用 `attachRow`（`apcService.js:536-544`，`enumerable: false`）挂载 → 保证原始行**不会**随 JSON 泄漏到前端。
- 未就绪（无项目 / 该项无 SQL / 槽位未配连接）→ 返回空 + `reason`，**绝不伪造数据**（沿用现有铁律）。

### 5.3 就绪判定下移

`getSourceReadiness`（`apcService.js:133-145`）现在只看 `project.queries.history`，改为：
**项目存在 + 该项目至少一个监测项 + 该监测项有 SQL + 槽位已配连接**，并新增 `itemId` 返回值。

---

## 6. N 对 1 求解

### 6.1 目标

给定 CV 偏差 `ΔCV = CV_target − CV_mean`，求各 MV 的调整量 `ΔMVᵢ`：

```
min  Σ wᵢ (ΔMVᵢ / sᵢ)²           ← 归一化后的「最小调整」
s.t. Σ kᵢ · ΔMVᵢ = ΔCV           ← 必须把偏差补回来
```

- `sᵢ = maxᵢ − minᵢ`（量程）→ 让「1 g」和「1 %」可比。
- `wᵢ` 权重 → 表达「这个参数不想多动」（如能耗敏感、执行机构磨损）。

拉格朗日闭式解：

```
ΔMVᵢ = (kᵢ · sᵢ² / wᵢ) · ΔCV / Σⱼ (kⱼ² · sⱼ² / wⱼ)
```

**N = 1 退化验证**：`ΔMV = (k s²/w)·ΔCV / (k² s²/w) = ΔCV / k` ✓ 与旧公式一致。

**直观解释**：谁的单位调整对 CV 影响大（k 大）、量程宽（s 大）、越不想动（w 大），谁就少动——具体由 `kᵢsᵢ²/wᵢ` 这个「杠杆份额」决定。

### 6.2 约束链（顺序不可变）

```
① 死区      |ΔCV| ≤ 规格带宽 × deadbandPct%  且 状态正常        → hold，不做任何调整
② 加权求解  闭式解 → ΔMVᵢ
③ 量程裁剪  clamp(ΔMVᵢ, minᵢ − curᵢ, maxᵢ − curᵢ)
④ 单次限幅  |ΔMVᵢ| ≤ |curᵢ| × maxStepPct%
⑤ 量化      按 decimals 取整（四舍五入到最小调节步长）
⑥ 再分配    被裁掉的部分 ΔCV_rem = ΔCV − ΣkᵢΔMVᵢ，
            在**未触限**参数上按同公式二次求解；最多 maxRounds 轮
⑦ 残差      仍有余量 → 记录 residual，risk 提示「受约束限制无法完全消除偏差」
```

边界处理：

- `kᵢ = 0` / 缺失 → 该参数**排除**出求解集（不影响 CV，调它没意义）。
- 全部参数 `kᵢ = 0` → `status: 'unknown'`，`hold: true`，明确说明「无有效影响系数」。
- 分母 `Σ(kⱼ²sⱼ²/wⱼ) = 0` → 同上，**绝不返回 NaN 或无穷**。
- 某参数 `enabled: false` → 不参与，其量程仍显示但不给建议。

### 6.3 输出契约

```jsonc
recommendation: {
  cv: { current, target, delta, unit, spec:{lsl,usl} },
  moves: [
    { code, name, unit,
      current, suggested, delta, deltaPct,
      clampedBy: null | "min" | "max" | "step",
      share: 0.42,                     // 承担的偏差份额 kᵢΔMVᵢ/ΔCV
      k: 0.02, kMode: "manual" }
  ],
  predictedCV: 12.48,                  // CV_mean + ΣkᵢΔMVᵢ
  predictedOutOfSpecPct: 1.2,
  residual: 0.03, residualPct: 24,     // 未能消除的部分
  confidence: 72, urgency: "medium",
  hold: false, rounds: 1,
  reason: "…中文逐条理由…",
  risk: "…"
}
```

---

## 7. kᵢ 的来源

### 7.1 第一期：手动

界面每个参数一个输入框（`k.mode = 'manual'`）。新建监测项时预填提示：
「可先用单变量试验估计：k ≈ ΔCV / ΔMV」。

### 7.2 第二期：自动标定（`server/regress.js`）

数据源：本监测项的历史行（`rawRow` 里已有 CV 列 + 各 MV 列，**无需新查询**）。

流程：

```
① 取窗口内全部行，剔除任一列为空/非数值的行
② 标准化（z-score）→ 多元最小二乘（OLS，正规方程 + 高斯消元，零依赖）
③ 共线性诊断：VIF > 10 的参数标记「高度共线，k 不可信」
④ 显著性：t 统计量 / R² / 调整 R²
⑤ 样本量门槛：n ≥ 10×参数个数 且 n ≥ 30，否则拒绝标定
⑥ 输出 kᵢ = ∂CV/∂MVᵢ（原始尺度，非标准化系数）
⑦ AI 解读（可选）：把 R²、VIF、k 值、单位喂给模型，产出人话结论与建议
```

- 纯函数、零 IO、零依赖，放 `server/regress.js`，配套 `regress.test.js`。
- **AI 只解读，不改数值**（D2）。
- 界面：点「标定」→ 弹窗展示 `k旧 / k新 / R² / VIF / n` → 用户点「采用」才写入 `k.value`，并把结果留档到 `k.calibrated`。**绝不自动覆盖。**

---

## 8. API 契约

### 8.1 运行接口（读）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/apc/status` | 增加 `items[]` 概要 |
| GET | `/api/apc/overview?project=&item=&minutes=` | **单监测项**结构：1 个 CV 卡 + N 个 MV 行 |
| GET | `/api/apc/optimize?project=&item=&minutes=` | 返回 §6.3 的 `recommendation` |
| GET | `/api/apc/history?project=&item=&code=&minutes=` | 曲线；`code` 可为 CV 或任一 MV |

> ⚠️ 现有 `/api/apc/overview` 是**单项目**结构（不是 `projects` 数组），改造时不要顺手改成数组——前端 `ApcRto.tsx` 依赖当前形状。

### 8.2 配置接口（写，`requireAdmin`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/apc/projects/:id` | 返回含 `items` 的完整项目（惰性合成后的） |
| POST | `/api/apc/projects/:id/items` | 新建监测项 |
| PUT | `/api/apc/projects/:id/items/:itemId` | 更新监测项（支持分段保存：`query` / `output` / `params` / `tuning`） |
| DELETE | `/api/apc/projects/:id/items/:itemId` | 删除监测项 |
| POST | `/api/apc/projects/:id/items/preview-query` | 按**该项**试算 SQL（复用 `previewQuery`，`apcService.js:237-304`） |
| POST | `/api/apc/projects/:id/items/:itemId/calibrate` | 标定 kᵢ（**第一期返回 501 占位**） |

限流沿用 `apcProbeRateLimit`；`preview-query` 必须显式传 `slot`，不猜。

### 8.3 待补的既有问题

- `validateCatalog` 补 `schema`（P2）。
- `normalizeQueries` / `normalizeProject` 白名单同步扩展 `items`，**每一项子字段都要显式列出**，否则又是 P1 式静默丢弃。

---

## 9. 前端重构

### 9.1 配置面板 `ApcConfigPanel.tsx`（现 1171 行，3 个 tab）

```
现在：项目设置 | SQL 模板 | 参数配置
改成：项目设置 | 监测项
```

「监测项」tab 采用**左列表 + 右详情**：

```
┌ 监测项 ─────────┬ 详情 ────────────────────────────────┐
│ + 新建          │ ① 基本信息  名称 / 描述              │
│ ● 电芯重量      │ ② 取数 SQL  模板 + 时间戳列 + 试算   │
│ ○ 电芯内阻      │ ③ 输出结果  变量名/列/单位/规格/目标 │
│                 │ ④ 参与参数  N 行：列/量程/单位/      │
│                 │             k/权重/限幅/启用/标定    │
│                 │ ⑤ 调优策略  死区/轮数/残差容忍       │
└─────────────────┴──────────────────────────────────────┘
```

- 删除 tab 内的窄表/宽表单选（`qDraft` 默认值 `'long'` 见 `ApcConfigPanel.tsx:91` → 改为 `'wide'`）。
- 脏区统计（`sDirty/qDirty/pDirty`，`:158-161`）改为按**当前选中监测项**统计，保存按钮显示「监测项：电芯重量 有未保存改动」。
- 复用内部组件 `SectionCard / FieldShell / inputCls`（`:643-690`，目前未导出——若拆分文件需先导出）。

### 9.2 运行页 `ApcRto.tsx`（现 1135 行）

- 顶部增加**监测项选择器**（沿用 `activeProjectId` 的脏 id 自愈模式：选中 id 不在列表则回落第一项并清 `localStorage`）。
- 主体从「N 个参数卡」变为：**1 个 CV 卡**（当前/目标/规格带/预测） + **1 张调整建议表**（N 行 MV，含 `suggested` 与 `clampedBy` 标记）。
- `ApcTrendChart.tsx` 的渐变 id `apcAreaFill` 目前**硬编码**——同页出现多张图会互相覆盖，必须参数化。

---

## 10. 兼容性与风险

| 风险 | 应对 |
| --- | --- |
| 数据卷里有老项目，新校验器读不了 → 全接口 500 | §4 惰性合成 + long 冻结；**部署前先在远程备份 `apc.config.json`** |
| `normalizeQueries` 白名单静默丢字段 | 新增字段逐个显式列入返回值，测试断言 `items` 往返不丢 |
| 旧 `processGain` 与新 `k` 语义不一致 | N=1 等价性作为**硬验收项**（见 §12） |
| 多参数共线 → k 不稳定 → 建议乱跳 | 手动模式给提示；自动标定加 VIF 门槛；置信度纳入 VIF 惩罚 |
| 建议超出现场可执行范围 | 约束链 ③④ 保证不越界；`clampedBy` 逐条说明 |
| 配置无审计日志 | 保持现状（追责靠 `updatedAt` + 文件 mtime），如需审计另开任务 |

---

## 11. 分阶段实施

### 第一期：结构 + 取数 + 求解 + 界面（可独立交付）

1. `apcCatalog.js`：`QUERY_MODES = ['wide']`；`normalizeItem` / `normalizeItems`；`normalizeQueries` 返回体扩展；修 `schema`（P2）。
2. `apcConfig.js`：`normalizeProject` 支持 `items`；`getProject` 惰性合成迁移；`items` CRUD。
3. `apcService.js`：`fetchItemSeries`；求解器 `optimizeItem`（§6）；`getSourceReadiness` 下移；`getOverview/getOptimization/getHistory` 改按 item。
4. `index.js`：§8.2 的 6 个接口 + 运行接口加 `item` 参数。
5. 前端：`ApcConfigPanel.tsx` 重构为「项目 + 监测项」；`ApcRto.tsx` 改为 CV 卡 + 建议表；`ApcTrendChart` 参数化 id；`src/types/index.ts` + `src/services/apcApi.ts` 同步。
6. 测试：`server/apcMulti.test.js`（求解器）、`server/apcConfig.migrate.test.js`（迁移等价）、更新 `apc.test.js`；前端 `ApcConfigPanel.test.tsx`。

### 第二期：kᵢ 自动标定

7. `server/regress.js` + `regress.test.js`（OLS / VIF / 显著性 / 样本门槛）。
8. `/calibrate` 接口落地 + AI 解读层（复用现有 LLM 通道）。
9. 标定弹窗 UI。

---

## 12. 验收清单

**算法**

- [ ] N=1 时，新建议与旧 `optimizeParam` 输出**逐字段一致**（用同一份历史数据对拍）。
- [ ] 两个参数、k 一正一负 → 建议方向相反且都朝消除 `ΔCV` 的方向。
- [ ] 某参数触量程上限 → `clampedBy: "max"`，剩余偏差由另一个参数承担（再分配生效）。
- [ ] 全部参数触限 → `residual` 正确，`risk` 提示「无法完全消除」。
- [ ] `k` 全为 0 → `status: 'unknown'` + `hold: true`，**无 NaN 输出**。
- [ ] 死区内 → `hold: true`，`moves[].delta` 全为 0。

**迁移**

- [ ] 老项目（含 long 模式）读取不报错，行为与改造前一致。
- [ ] 保存后 `items` 落盘、`queries/params` 清空，再次读取正常。
- [ ] 数据卷配置损坏 / 缺字段时降级为空态，**不 500**。

**安全**

- [ ] `preview-query` / 新接口均过只读护栏与占位符白名单。
- [ ] `rawRow` 不出现在任何接口响应里（`enumerable: false` 仍生效）。
- [ ] 未就绪时返回空 + `reason`，**不返回任何伪造数据**。

**测试基线**

- [ ] vitest 失败仍为 2 个文件（`server.e2e.test.js`、`llmApi.test.ts`），不新增失败。

---

## 13. 需要你拍板的一个点

**窄表模式的处置**：本文采用「界面删除 + 后端冻结兼容」（§4.2），代价是后端仍留一段 long 死代码。

- **方案 A（推荐）**：先冻结，等现场所有项目都迁到宽表后再物理删除。
- **方案 B**：本次直接物理删除。若数据卷里还有 long 项目，**部署后会 500**，需要人工先改配置。

如果选 B，我会在实施前先写一个只读的体检接口，列出哪些项目还在用 long。

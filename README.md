# MES AI 智能助手（mes-ai-assistant）

面向制造工厂的**局域网私有化 AI 问答系统**。

把 MES 业务知识库——现场文档（Word / Excel / PPT / PDF）与从数据库导出的**页面 / 逻辑 / 流程代码（XML）**——统一入库，
由 AI 检索后回答异常分析、参数调优、代码定位与功能开发类问题；同时提供 MES 生产数据查询、用户与权限管理。

支持**本地大模型（Ollama，数据不出内网）**与多家云端国产模型一键切换。

---

## 目录

- [核心特性](#核心特性)
- [技术栈](#技术栈)
- [系统架构](#系统架构)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [目录结构](#目录结构)
- [知识库与检索设计](#知识库与检索设计)
- [模型供应商](#模型供应商)
- [开发与测试](#开发与测试)
- [部署与运维](#部署与运维)
- [安全说明](#安全说明)

---

## 核心特性

| 模块 | 能力 |
|---|---|
| **智能问答** | SSE 流式输出、深度思考过程展示、Markdown 渲染、多轮上下文 |
| **知识库问答** | 上传文档 → 解析入库 → 审核 → 检索引用，回答**逐条标注来源（文档名 + 页码）** |
| **多格式解析** | Word（docx）、Excel（xlsx）、PPT（pptx）、PDF（pdfjs-dist，支持扫描页）、**XML 数据导出** |
| **XML 代码库导入** | 一条 `<DATA_RECORD>` = 一个对象页，标题为「对象编号 · 描述」；分块流式解析，单文件 24MB+ 无压力 |
| **超大文档按需加载** | 超阈值文档列表接口**不下发正文**，打开详情/阅读器时按需拉取分页，避免首屏拉数十 MB |
| **服务端页级倒排索引** | 零依赖自建索引，英文标识符（含子词 / camelCase 拆分）+ 中文 bigram；实测 4700 页对象名精确召回 12/12，查询 < 10ms |
| **全文总结（map-reduce）** | 按页切片并发归纳并缓存；仅**已入库**文档可总结，XML 数据导出按设计**禁止**总结 |
| **MES 数据查询** | 生产数据（OEE、良率、设备状态、产出等）以表格 / 卡片展示，只读 |
| **异常分析与参数调优** | 根因分析决策树（带置信度）、工艺参数建议表（当前值 / 建议值 / 理由）；图示化知识树与知识图谱 |
| **用户与权限** | 超级管理员预设、注册 / 注销 / 重置密码、首登强制改密；按部门区分文档处理权限 |
| **在线预览** | Office 文档浏览器内渲染（docx-preview / SheetJS），PDF 内嵌阅读器 |

---

## 技术栈

- **前端**：React 18 + TypeScript + Vite 5 + Tailwind CSS 3
- **后端**：Node.js + Express（ESM），单进程托管前端静态产物与 API
- **存储**：JSON 分片落盘（`/data`，Docker 卷），浏览器侧 IndexedDB 作本地缓存与补传
- **文档解析**：pdfjs-dist、docx-preview、xlsx（SheetJS）、pptx-browser、自研 XML 流式解析器
- **检索**：纯前端 bigram 检索 **+** 服务端页级倒排索引（零第三方依赖）
- **测试**：Vitest + jsdom + Testing Library + supertest + fake-indexeddb
- **部署**：Docker / Docker Compose（host 网络），一条命令启动

---

## 系统架构

```
┌──────────────────────────── 浏览器（局域网任意设备） ────────────────────────────┐
│  React SPA（Vite 构建产物，由后端托管）                                          │
│   ├── 聊天 / 知识库 / 用户管理 / MES 数据面板                                     │
│   ├── IndexedDB 本地缓存（断网可用、离线上传后自动补传）                            │
│   └── 前端 bigram 检索（小文档本地兜底）                                          │
└───────────────────────────────────┬─────────────────────────────────────────────┘
                                    │ HTTP / SSE（同源，默认 3001）
┌───────────────────────────────────▼─────────────────────────────────────────────┐
│  Express 服务端（Docker 容器，host 网络）                                         │
│   ├── 静态托管 dist/          ├── /api/docs        文档 CRUD（分片存储）           │
│   ├── /api/chat（SSE 代理）   ├── /api/docs/:id/pages|titles  按需取页              │
│   ├── /api/search（倒排索引）  ├── /api/summary/*    总结任务（断点续跑）            │
│   └── /api/users/*            └── server/searchIndex.js  页级倒排索引（内存常驻）   │
│                                                                                  │
│   数据卷 mes-data → /data（文档分片、原文件、用户、总结、任务状态）                  │
└───────────────┬──────────────────────────────────┬───────────────────────────────┘
                │ OpenAI 兼容协议                    │ OpenAI 兼容协议
        ┌───────▼────────┐                 ┌───────▼─────────────────────────────┐
        │ 宿主机 Ollama   │                 │ 云端模型（DeepSeek / 通义 / GLM /    │
        │ 127.0.0.1:11434 │                 │ Kimi / 豆包 / 混元 / MiniMax）        │
        │ 数据不出内网     │                 │ 需在页面配置 API Key                  │
        └────────────────┘                 └─────────────────────────────────────┘
```

**关键设计**

- **同源部署**：后端同时托管前端产物与 API，局域网设备只需访问 `http://<宿主机IP>:3001`，无需额外配置。
- **host 网络**：目标机 docker bridge 不可用，改用 `network_mode: host` 后，容器内 `127.0.0.1:11434` 即宿主机 Ollama，且 3001 直接监听宿主机，无需端口映射。
- **数据不入仓库**：知识库业务数据（上传文档、原文件、索引、用户）全部落在数据卷 `/data`，与代码分离。

---

## 快速开始

### 前置条件

- Linux 宿主机（已在 Ubuntu 20.04 验证），已安装 Docker 与 Docker Compose
- 宿主机已安装 [Ollama](https://ollama.com/) 并拉取模型（使用本地模型时）：

  ```bash
  ollama pull deepseek-r1:1.5b
  ```

### 一键启动

```bash
git clone <仓库地址>
cd mes-ai-assistant            # ⚠ 目录名必须是 mes-ai-assistant（compose 项目名由目录名决定）
docker compose up -d --build   # 或执行 ./deploy.sh 一键自检部署
```

构建完成后访问 **`http://<宿主机IP>:3001`**。

> 首次构建需联网执行 `npm ci` 与前端打包，耗时较长；后续仅改代码时重复执行该命令即可。

### 默认账号（首次登录用）

| 项目 | 值 |
|---|---|
| 用户名 | `SITE_ADMIN` |
| 密码 | `Admin@2026#Site` |
| 角色 | 系统管理员（超级管理员 · IT 部） |

打开 `http://<宿主机IP>:3001` 后用上面的账号密码登录即可进入系统，再在「用户管理」中为其他人开账号。

- 初始密码可用构建期变量 `VITE_INITIAL_ADMIN_PASSWORD` 覆盖（见 `src/services/userService.ts` 的 `SUPER_ADMIN`）。
- 该账号**首次登录会强制要求修改密码**；上线后请立即重置，并删除或停用不再需要的初始账号。
- IT 部管理员可处理全部文档（含审核）；其他部门账号用于上传与查阅。

> ⚠️ 安全提示：为便于内部交接与首次部署，默认口令已写在上方。**本仓库为公开仓库**，
> 且该默认口令同样存在于源码中，请勿在生产环境长期沿用；部署完成后请第一时间修改。

---

## 配置说明

配置文件是**项目根目录的 `.env`**（唯一来源），Vite 构建与 docker compose 都会读取它，因此 clone 后无需额外配置。

| 变量 | 作用 | 说明 |
|---|---|---|
| `ADMIN_TOKEN` | 服务端管理令牌 | 写操作（上传 / 删除文档、用户管理）必须携带 `X-Admin-Token` |
| `VITE_ADMIN_TOKEN` | 前端构建期令牌 | **必须与 `ADMIN_TOKEN` 同值**，否则局域网设备管理操作 403 |
| `OLLAMA_BASE` | 宿主机 Ollama 地址 | host 网络下用 `http://127.0.0.1:11434`（推荐）；bridge 网络须改为宿主机非回环 IP |
| `OLLAMA_MODEL` | 默认本地模型 | 需与宿主机已拉取模型一致 |
| `VITE_BACKEND_URL` | 后端地址 | 留空 = 前端与 API 同源（推荐） |

**可选调优变量**（服务端读取，用于超大文档与索引）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `SLIM_PAGE_THRESHOLD` | `200` | 文档页数超过此值时，列表接口剥离正文 |
| `SLIM_TEXT_THRESHOLD` | `800000` | 字符数超过此值时同样剥离正文 |
| `SEARCH_INDEX` | 启用 | 置 `0` 可关闭服务端倒排索引 |
| `MES_IDX_MAX_DF` | 内置 | 单 term 倒排表长度上限（高频词裁枝阈值） |
| `MES_DATA_DIR` | `/data` | 知识库数据落点 |

> 更换 `ADMIN_TOKEN` 的推荐做法：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`，
> 同时更新 `.env` 中的 `ADMIN_TOKEN` 与 `VITE_ADMIN_TOKEN`，再 `docker compose up -d --build`（前端需重新烧入令牌）。

---

## 目录结构

```
mes-ai-assistant/
├── src/
│   ├── components/          # 界面组件（聊天、知识库、用户管理、MES 数据面板等，含单测）
│   ├── services/
│   │   ├── llmApi.ts        # 模型调用（SSE 流式，多供应商适配）
│   │   ├── knowledgeService.ts  # 文档解析、检索、知识上下文组装、总结（map-reduce）
│   │   ├── xmlParser.ts     # XML 数据导出流式解析（分块、跨块记录还原）
│   │   ├── searchApi.ts     # 服务端倒排索引检索客户端
│   │   ├── docStore.ts      # 文档持久化（后端 + IndexedDB）、按需取页
│   │   └── userService.ts   # 用户与权限
│   ├── data/                # 内置示例数据
│   └── types/               # TypeScript 类型定义
├── server/
│   ├── index.js             # Express 入口：静态托管 + API（文档 / 检索 / 总结 / 用户）
│   ├── storage.js           # JSON 分片存储层（含内存缓存）
│   ├── searchIndex.js       # 页级倒排索引（零依赖）
│   ├── summaryTask.js       # 总结任务调度（并发控制、断点续跑）
│   ├── pdfExtract.js        # PDF 文本提取
│   └── systemPrompt.js      # 系统提示词（引用 shared/）
├── shared/
│   ├── providers.js         # 模型供应商单一数据源（前后端共用）
│   └── systemPrompt.js      # 系统提示词单一数据源
├── public/pdfjs/            # pdfjs 运行时资源（cmaps、worker）
├── scripts/                 # 构建清理与测试脚本
├── Dockerfile / docker-compose.yml / deploy.sh
├── DEPLOY.md                # 部署与运维手册（架构、配置、备份、排错、回滚）
└── README.md
```

---

## 知识库与检索设计

这是本项目与"直接调 API 的聊天机器人"最大的差异点，简要说明几条关键机制：

**1. 文档生命周期**：上传 → 解析 → `pending`（待审核）→ `approved`（已入库）/ `rejected`。
**只有 `approved` 文档参与检索与总结**（前后端双重校验）；删除文档时用墓碑整体替换分片，其总结内容随之清除。

**2. XML 数据导出（代码库）**
- 导入格式为 `.xml`（避免与 Markdown 记忆文件语义混淆），**不做 AI 预处理直接入库**。
- 一条 `<DATA_RECORD>` = 一个 DocPage，页标题为「对象编号 · 描述」；对象编号由根元素推断表名（如 `SELECT_FROM_Z_LOGIC_*` → `LOGIC`）。
- 解析器分块流式（默认 4MB/块），可处理 24MB+ 单文件。
- XML 只存结构化 `content`，不重复存扁平 `textContent`（体积减半）。
- **按设计禁止 AI 总结**：检索精度由服务端倒排索引直接保证；而 map-reduce 对上万条记录需上万次模型调用，必然撞上总结时限被中断，既得不到完整结果又白耗算力。前端、后端接口、历史任务恢复三处均拦截。

**3. 超大文档按需加载**
- 超过 `SLIM_PAGE_THRESHOLD` / `SLIM_TEXT_THRESHOLD` 的文档，`/api/docs` 剥离正文，返回 `contentOmitted: true` + `pageCount`（字符数用采样外推，不遍历全量）。
- 取页走 `GET /api/docs/:id/pages?from&to|indices`（单次 ≤ 500 页）；前端打开详情 / 阅读器时自动补全，总结前自愈取回全文。

**4. 服务端页级倒排索引**（`server/searchIndex.js`，零依赖）
- 索引单元 = DocPage，仅索引 `approved` 文档，内存常驻不落盘（重启后台重建）。
- 分词：英文标识符按 `_ . - $` 拆子词 + camelCase 再拆，中文按 bigram。
- 高频模板词（`select` / `where` 等）整词丢弃；长随机串（UUID 类）按规则过滤。
- 接口：`GET /api/search`、`GET /api/search/status`；文档写入 / 删除时增量联动。
- 索引未就绪时，前端自动退回本地检索。

**5. 检索模式判定**：点名文档 / 标签页 → 详解（下发正文切片）；明确询问"知识库里有哪些文档" → 探索（只列目录）；
**其余一律详解**——避免"开发 XX 功能"这类问题只回一串文档名而拿不到正文。

**6. 对象目录 + SQL 页优先**（`GET /api/objects`）
XML 超大文档被剥正文后，「文档目录」里一个对象名都列不出来，模型只能从命中正文里猜表名，
实测会把文档名 `Z_WIDGET_202609101235.xml` 当成数据库表，编出 `FROM Z_WIDGET ... LIKE '%作业指导书%'` 这种不存在的 SQL。
因此：
- 检索时额外取一份**对象目录**（只含对象编号 / 描述 / 类型 / 所属文档，不含正文，很廉价）注入上下文，
  让模型先看清库里真实存在哪些对象（例如 `query.ce.sop.list · 查询作业指导书列表（query.sql）`）。
- 命中页按类别标注：`sql` / `script` / `widget`（界面 JSON）/ `flow`（流程 JSON）。
  问 SQL 类问题时给 `query.sql` 页**提权并优先注入**，同时把界面/流程大 JSON 按上限裁剪（写 SQL 时它们是纯噪声）；
  问界面类问题时保持完整结构体，不做裁剪。

**7. 按模型分档的检索预算**（`shared/modelProfile.js`）
注入规模与模型能力匹配，不再"一个公式套所有模型"：云端模型按各家 `contextWindow` 的 80%（封顶 160000 字符）吃饱召回；
本地模型按**参数量分档**（≤2B / 2~4.5B / 4.5~14B / >14B）逐档收紧窗口、topK 与单页字符数——
小模型灌太多只会稀释注意力，而且会直接撞上 Ollama 的上下文上限（见 `DEPLOY.md`「本地模型上下文」）。

**8. 上下文预算按实际用量分配**
历史实现固定「目录 35% / 正文 65%」；XML 文档的目录几乎是空的，那 35% 被白白浪费，正文反而被压到 65% 以内，
关键 SQL 页因此挤不进上下文。现在正文预算 = 总预算 − 目录**实际**用量（至少保留一半给正文），
并对跨文档注入加**保底配额**，避免单篇的大 JSON 把其他文档整篇挤出上下文。

---

## 模型供应商

在页面「模型设置」中选择供应商并填写 API Key（本地模型无需 Key）。所有供应商统一走 **OpenAI 兼容协议**。

| 供应商 | 默认模型 | 上下文 |
|---|---|---|
| **本地 DeepSeek（Ollama）** | `deepseek-r1:1.5b` | 见下方说明（宿主机 `OLLAMA_CONTEXT_LENGTH`） |
| DeepSeek | `deepseek-chat` / `deepseek-reasoner` | 64K |
| 通义千问 | `qwen-plus` 等 7 个 | 128K |
| 智谱 GLM | `glm-4-plus` 等 7 个 | 128K |
| Kimi（月之暗面） | `moonshot-v1-128k` | 8K / 32K / 128K（按模型） |
| 豆包（字节） | `doubao-pro-32k` | 32K / 128K（按模型） |
| 腾讯混元 | `hy3`（256K） | 256K |
| MiniMax | `MiniMax-Text-01` | 200K |

供应商配置的**单一数据源**是 `shared/providers.js`（含单模型的 `contextWindow` 覆盖），
注入预算的档位表在 `shared/modelProfile.js`，两者共同决定"这个模型该给多少上下文"。

> **本地模型的坑**：Ollama 的 OpenAI 兼容端点**不接受 `num_ctx`**，而缺省上下文只有 4096 token，
> 超过就直接返回 `HTTP 400 exceed_context_size_error`（模型根本不执行，页面表现为"LLM 无响应"）。
> 部署时必须设置 `OLLAMA_CONTEXT_LENGTH`（本项目按 8192 配置，与 `shared/modelProfile.js` 的
> `OLLAMA_SAFE_CTX_TOKENS` 保持一致）。详见 `DEPLOY.md`。

---

## 开发与测试

```bash
npm install
npm run dev        # 本地开发（Vite dev server）
npm run build      # 构建前端产物到 dist/
npm run preview    # 预览构建产物
```

运行测试（Windows 下 `npx vitest` 可能卡死，推荐直接调用入口）：

```bash
NODE_OPTIONS= node node_modules/vitest/vitest.mjs run              # 全量测试
NODE_OPTIONS= node node_modules/vitest/vitest.mjs run --coverage   # 覆盖率
NODE_OPTIONS= node node_modules/typescript/bin/tsc --noEmit        # 类型检查
```

测试覆盖：前端组件与服务（Testing Library + jsdom）、服务端存储 / 索引 / 总结准入守卫（supertest E2E）。

---

## 部署与运维

完整手册见 **[DEPLOY.md](./DEPLOY.md)**，涵盖：

- 架构与前置条件、`.env` 配置详解
- 部署步骤与验证清单
- 数据备份（数据卷 `mes-data`）
- 日常运维命令（重启、日志、时区、构建缓存）
- **排错**：网络模式选择、令牌不一致 403、索引未就绪、文档"正在解析中"、总结超时等
- 版本回滚

**常用命令**

```bash
docker compose ps                            # 查看容器状态
docker compose logs -f --tail 100            # 查看日志
docker compose up -d --build                 # 重新构建并启动
docker compose up -d                         # 仅重启（改 environment / 时区等无需 --build）
```

> 仅文档变更（如本 README、DEPLOY.md）**不需要重新构建**，服务器上 `git pull` 即可。

---

## 安全说明

- **数据不出内网**：默认使用宿主机 Ollama 本地模型，知识库内容与提问均不离开局域网。
- **管理令牌**：写操作需携带 `X-Admin-Token`；`ADMIN_TOKEN` 与 `VITE_ADMIN_TOKEN` 必须同值。
  注意 `VITE_` 前缀变量会**编入前端包**，局域网内打开页面者可从源码看到——仅适合可信内网作基础防护。
- **密码存储**：用户密码以 SHA-256 哈希存储，不落明文；首次登录强制改密。
- **默认账号**：首次部署的内置账号与口令见上方[默认账号](#默认账号首次登录用)；因本仓库为公开仓库，
  请在部署完成后立即修改该口令，避免他人凭默认口令登录。
- **提示词注入防护**：知识库文档内容仅作检索数据，文档内嵌的任何指令、角色设定一律不生效。
- **数据与代码分离**：所有业务数据（上传文档、原文件、索引、用户）存于数据卷 `/data`，**不入 Git 仓库**。
- **只读**：AI 对 MES 系统只能查询，不能修改生产参数或执行控制操作。

---

## 关于

**mes-ai-assistant** 是一套可完全私有化部署的制造现场 AI 助手，目标是把"散落在文档与数据库导出物里的工厂知识"变成可被 AI 直接检索、引用与实施的知识资产。

设计上坚持三条原则：

1. **数据主权**：默认本地模型 + 内网部署，业务数据存于独立数据卷、不进仓库，内容不出内网。
2. **可溯源**：AI 的每条结论都必须标注来源文档与页码，未注入文档时明确声明"未参考任何文档"，不编造出处。
3. **面向落地**：不止于"检索到相关文档"，对开发类需求要给出可实施的对象、字段、步骤与代码；对超大代码库用倒排索引保证精确召回，而不是靠堆总结。

---

## 许可

本项目为**内部使用**项目（`package.json` 中 `private: true`），未开源授权。

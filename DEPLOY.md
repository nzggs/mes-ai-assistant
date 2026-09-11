# 部署与运维手册（Linux + Docker）

本手册是 mes-ai-assistant 的**唯一部署方式说明**：在 Linux 宿主机上用 Docker 运行，
宿主机提供 Ollama 本地模型。Windows 仅作为访问端（浏览器），不参与构建与部署。

- 仓库：https://github.com/nzggs/mes-ai-assistant
- 线上环境：Ubuntu 20.04（172.28.1.15），容器 `mes-ai-assistant`，访问 `http://<宿主机IP>:3001`

---

## 一、架构

```
浏览器（任意设备）
      │  HTTP 3001
      ▼
Linux 宿主机
      │  host 网络（无端口映射，容器直接监听宿主机 3001）
      ▼
 容器 mes-ai-assistant  ──►  宿主机 Ollama (127.0.0.1:11434)
   Express 托管前端 dist + /api        deepseek-r1:1.5b
```

**要点**

- 后端 Express 单进程同时托管前端静态包与 `/api`，端口 3001。
- 问答链路：`浏览器 → 后端容器 → 宿主机 Ollama`。上游地址由服务端环境变量
  `OLLAMA_API_URL` 决定（`server/index.js` 读 `PROVIDERS[providerId].apiUrl`），
  **不接受前端传入** —— 所以页面右上角显示的地址只是展示，访问端无需安装 Ollama。
- **为什么用 host 网络**：目标机的 docker bridge 网络不可用（DNS `EAI_AGAIN`、外网
  `EHOSTUNREACH`、连宿主机端口超时）。host 网络下构建期能联网（npm ci），运行期
  `127.0.0.1:11434` 就是宿主机 Ollama，3001 直接监听宿主机、无需端口映射。
  若换到 bridge 正常的机器，可去掉 `network_mode: host` 与 `build.network: host`，
  恢复 `ports` 映射，并把 `.env` 的 `OLLAMA_BASE` 改为宿主机非回环 IP。

---

## 二、前置条件（宿主机）

| 项目 | 要求 | 检查命令 |
|---|---|---|
| Docker + Compose | Docker 20+ / Compose v2 | `docker compose version` |
| Ollama | 已启动，监听 11434 | `curl -s -m 5 http://127.0.0.1:11434/api/tags` |
| 本地模型 | `deepseek-r1:1.5b` | `ollama list \| grep deepseek` |
| 端口 | 3001 未被占用 | `sudo ss -lntp \| grep 3001` |

缺模型时拉取（约 1.1GB）：

```bash
ollama pull deepseek-r1:1.5b
```

> host 网络下**不需要**修改 `OLLAMA_HOST`，也不需要开防火墙放行 11434。
> （仅 bridge 网络才需要 `OLLAMA_HOST=0.0.0.0`，并放行容器网段。）

---

## 三、部署

### 3.1 全新部署

```bash
cd ~
git clone https://github.com/nzggs/mes-ai-assistant.git mes-ai-assistant
cd mes-ai-assistant
docker compose up -d --build
```

> **目录名必须是 `mes-ai-assistant`**：compose 项目名由目录名决定，数据卷名随之变化。
> 改名会导致新建空卷、知识库数据"消失"（旧卷仍在，`docker volume ls` 可找回）。

首次构建需 `npm ci`（前后端两份依赖），约 3–8 分钟。

### 3.2 一键脚本（可选）

```bash
chmod +x deploy.sh && ./deploy.sh
```

脚本依次做：环境检查 → 探测 Ollama → 检查/拉取模型 → 构建并启动 → 健康检查 → 打印访问地址。

### 3.3 配置说明

`.env` 是**唯一配置文件**，docker compose 默认自动加载，无需 `--env-file`：

| 变量 | 作用 |
|---|---|
| `VITE_ADMIN_TOKEN` | 构建期烧入前端包的管理令牌 |
| `ADMIN_TOKEN` | 服务端管理写操作鉴权（上传/删除/用户管理） |
| `OLLAMA_BASE` | 宿主机 Ollama 地址，默认 `http://127.0.0.1:11434` |
| `VITE_BACKEND_URL` | 留空＝前端与 API 同源（后端托管 dist） |
| `SEARCH_INDEX` | 设 `0` 可关闭服务端倒排索引（默认开启） |
| `SLIM_PAGE_THRESHOLD` | 文档超过该页数时，列表接口不下发正文（默认 200） |
| `SLIM_TEXT_THRESHOLD` | 文档正文超过该字符数时不下发（默认 800000） |
| `MES_IDX_MAX_DF` | 单个词出现在超过该页数即视为停用词丢弃（默认 1500） |
| `MES_IDX_MAX_POSTINGS` | 倒排表总条目上限，内存兜底（默认 3000000） |
| `APC_ENABLED` | 设 `0` 可整体关闭「APC和RTO」功能（默认开启） |
| `HANA_HOST` / `HANA_PORT` | HANA 地址与 SQL 端口（端口默认 30015） |
| `HANA_USER` / `HANA_PASSWORD` | HANA 登录账号（**只读账号**，仅授予 SELECT） |
| `HANA_DATABASE` | MDC 多租户场景下的租户库名（可选） |
| `HANA_USE_TLS` / `HANA_VALIDATE_CERT` | 是否启用 TLS / 是否校验服务端证书 |
| `HANA_MAX_ROWS` | 单次读取行数上限，硬保护（默认 2000） |
| `HANA_STATEMENT_TIMEOUT_MS` | 语句超时，超时即断连释放会话（默认 15000） |
| `HANA_USE_LIMIT` | 是否自动为查询追加 `LIMIT`（默认开启；老版本 HANA 不支持时设 `0`） |
| `APC_CACHE_TTL_MS` | 后端结果缓存时长，避免前端轮询打库（默认 5000） |
| `APC_RATE_LIMIT` | APC 数据接口每分钟每 IP 请求上限（默认 60） |
| `APC_PROBE_RATE_LIMIT` | APC 配置类接口（测试连接 / 试运行 / 读写配置）每分钟每 IP 上限（默认 20） |
| `APC_CATALOG_FILE` | 指定参数目录文件；**设置后页面上的目录类保存不再生效**（默认 `server/apc.catalog.json`） |
| `APC_CONFIG_FILE` | 覆盖运行期配置文件路径（默认 `<数据目录>/apc.config.json`，主要用于测试） |

> 两个令牌必须**同一值**，否则管理操作 403。仓库里的令牌经确认可公开，
> 如需更换见第六节。

> **超大文档（XML 数据导出等）**：正文体量大（常达数十 MB / 数千条记录）时，
> 文档列表接口不再下发 `content`（响应里带 `contentOmitted: true` 与 `pageCount`），
> 前端需要时通过 `GET /api/docs/:id/pages` 按需取页；问答检索改由服务端倒排索引
> `GET /api/search` 承担。这两条正是为了消除「换一台浏览器打开就要先拉几十 MB 正文」的问题。
> 索引只在**已入库（approved）**文档上构建，重启后后台异步重建（秒级），构建期间
> 前端自动退回本地检索，功能不降级。

### 3.4 APC / RTO 只读数据源

左侧边栏「APC和RTO」页面会即时读取只读数据库（HANA）中记录的过程数据列值，并给出过程参数
设定值的优化建议。数据源、取数 SQL 与参数目录**都可以在页面上手工配置**，保存即生效、
无需重启服务；完全未配置时后端回退到**内置仿真数据源**（页面会明确标注），仅用于功能验证。

#### ① 页面配置（推荐）

在「APC和RTO」页面右上角点 **数据源配置**，有三个窗口：

| 窗口 | 能配什么 |
|---|---|
| **数据库登录** | 地址、端口、租户库名、用户名、密码、Schema、TLS/证书、读取行数上限、连接与语句超时、是否自动追加 LIMIT；带**测试连接**（用页面草稿真连一次，不落盘） |
| **SQL 查询语句** | 取数模式（窄表/宽表）、SQL 模板、字段映射（编码列/时间列/数值列）；带**试运行**（真执行一次只读查询，返回列名与前 N 行，可点选列名自动指派映射） |
| **参数配置** | 逐个过程参数的设定值、RTO 理想操作点、规格上下限、可调范围、单次限幅、工艺死区、过程增益，以及装置名/采样间隔/默认窗口；支持增删、JSON 批量导入导出 |

配置保存在**数据卷** `mes-ai-assistant_mes-data` 的 `/data/apc.config.json`，
重建容器不丢，且**不在 git 里**。

> ⚠ **不要把生产库密码写进 `.env`**：本仓库把 `.env` 纳入了 git 跟踪且仓库是公开的，
> 写进去等于公开凭据。用页面「数据库登录」保存即可，密码只落在数据卷里，
> 接口只回传「是否已设置密码」，永不回显密码原文。
> （若确实要用环境变量传凭据，请先把 `.env` 加入 `.gitignore` 并 `git rm --cached .env`。）

配置类接口全部需要管理员令牌（`ADMIN_TOKEN`）：从非本机访问时，页面会提示粘贴令牌，
令牌与知识库管理/用户管理共用。

#### ② 环境变量配置（适合统一管控的场景）

在项目根目录 `.env` 中补齐（`docker compose up -d` 生效，无需重建镜像）：

```bash
HANA_HOST=10.0.0.21
HANA_PORT=30015
HANA_USER=READONLY_APC        # 必须是只读账号
HANA_PASSWORD=********
# 可选
HANA_DATABASE=HDB             # MDC 多租户租户库名
HANA_SCHEMA=MES               # 供 SQL 模板里的 {{schema}} 使用
HANA_USE_TLS=true
HANA_VALIDATE_CERT=true
HANA_MAX_ROWS=2000
HANA_STATEMENT_TIMEOUT_MS=15000
```

取值优先级：**页面保存值 > 环境变量 > 内置默认**。页面上每一项都标了来源，
点「恢复为环境变量/默认值」即可回退。

#### ③ 取数模式与 SQL 模板

**窄表（long）**——一行一个参数值，最常见：

```sql
SELECT "PARAM_CODE", "TS", "VALUE" FROM "MES_PROCESS_HIST"
WHERE "TS" >= ADD_SECONDS(CURRENT_TIMESTAMP, -60 * {{minutes}}){{codeFilter}}
ORDER BY "TS" ASC LIMIT {{limit}}
```

**宽表（wide）**——一行一个时间戳，各参数各占一列（列名在「参数配置」里逐个填写）：

```sql
SELECT "TS", {{columns}} FROM "MES_PROCESS_HIST"
WHERE "TS" >= ADD_SECONDS(CURRENT_TIMESTAMP, -60 * {{minutes}}) LIMIT {{limit}}
```

模板占位符共 5 个，都是服务端生成、不可注入任意文本：

| 占位符 | 说明 |
|---|---|
| `{{minutes}}` | 统计窗口分钟数（整数） |
| `{{limit}}` | 行数上限（整数） |
| `{{codeFilter}}` | 窄表：由白名单参数编码生成的 `AND "CODE" IN (...)` |
| `{{columns}}` | 宽表：各参数数据列名列表（已校验+加引号） |
| `{{schema}}` | 模式名（在「数据库登录」里配置） |

宽表模式下若某个参数没填数据列名，保存会被直接拒绝，取数时也会立即报错——
不会拿参数编码去猜列名（那会悄悄取错数据）。

#### ④ 安全边界（重要）

1. **只读**：无论 SQL 来自目录文件、页面保存还是试运行草稿，执行前一律强制校验
   「单条 SELECT / WITH」；DDL/DML（insert/update/delete/merge/truncate/drop/alter/
   create/grant/call…）、多语句拼接、`SELECT INTO`、`FOR UPDATE` 全部拒绝；
   校验前先剥离注释、屏蔽字符串与带引号标识符，无法靠注释或字面量绕过。
2. **不接受可执行裸 SQL**：接口没有「传一段 SQL 就跑」的入口。页面保存的是**模板**，
   运行时只代入服务端生成的整数、白名单编码与已校验列名；
   唯一的自由 SQL 入口是管理员的**试运行**，同样要过上面同一层护栏。
3. **限量**：自动追加 `LIMIT`（默认 2000 行），并在客户端再硬截断一次。
4. **限时**：连接超时 8s、语句超时 15s，超时立即销毁连接释放服务端会话。
5. **限流 + 缓存**：数据接口每 IP 60 次/分钟、结果缓存 5s；配置类接口每 IP 20 次/分钟，
   前端轮询不会打到数据库。
6. **凭据不出服务端**：密码只落在数据卷配置文件，接口只回 `passwordSet` 布尔值。
7. **建议不下发**：页面展示的设定值建议**不会**自动写入 DCS/PLC，需工艺工程师确认后手动执行。

> 生产环境请务必为 HANA 单独建一个**只读账号**（仅 `SELECT` 权限，且只授权所需表/视图），
> 不要复用管理员账号——应用层的只读护栏是第二道防线，数据库授权才是第一道。

---

## 四、验证

```bash
# 页面与容器
curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:3001/
docker compose ps

# 端到端对话（本地模型也要带 X-Api-Key，占位值即可）
curl -s -m 180 -X POST http://127.0.0.1:3001/api/chat \
  -H 'Content-Type: application/json' \
  -H 'X-Api-Key: ollama-local' \
  -d '{"messages":[{"role":"user","content":"只回答一个数字：1+1等于几"}],"providerId":"ollama","modelId":"deepseek-r1:1.5b"}' \
  | head -c 400

# 服务端检索索引状态（ready=true 表示倒排索引已就绪）
curl -s http://127.0.0.1:3001/api/search/status

# 服务端检索（示例：按对象名/业务词检索，返回 Top-K 命中页）
curl -s 'http://127.0.0.1:3001/api/search?q=查询库存列表&topK=5' | head -c 600

# APC/RTO 功能与数据源状态（mode=hana 表示已接真实 HANA，simulated 表示仿真源）
curl -s http://127.0.0.1:3001/api/apc/status

# 过程参数实时值概览（近 1 小时窗口）
curl -s 'http://127.0.0.1:3001/api/apc/overview?minutes=60' | head -c 400

# 设定值优化建议
curl -s 'http://127.0.0.1:3001/api/apc/optimize?minutes=60' | head -c 600

# HANA 连通性探测（管理员接口，需带令牌）
curl -s http://127.0.0.1:3001/api/apc/ping -H "X-Admin-Token: $ADMIN_TOKEN"
```

浏览器打开 `http://<宿主机IP>:3001`，右上角「API 配置」应显示：本地 DeepSeek / DeepSeek-R1 1.5B。

---

## 五、数据与备份

### 5.1 数据在哪

容器内 `/data`，落在 Docker 卷 `mes-ai-assistant_mes-data`，**重建容器不丢数据**。

```
/data
├─ docs/
│  ├─ index.json          # 轻量索引（元数据：id/名称/状态/更新时间/正文长度）
│  └─ <docId>             # 每篇文档一个分片 JSON（正文、切片、总结都嵌在这里）
├─ files/
│  ├─ <docId>             # 上传的原始文件二进制
│  └─ <docId>.ext         # 扩展名（pdf/docx/…）
├─ tasks/                 # 总结任务的临时状态（终态超 24h 自动清理）
├─ doc-logs.json          # 操作日志（最多 4000 条）
├─ users.json             # 用户表（跨设备共享）
└─ apc.config.json        # APC/RTO 数据源配置（连接参数、取数 SQL、参数目录；含密码，勿外传）
```

删除文档是软删除（`index.json` 打 `deleted` 墓碑），原始 `files/` 一并清除。

> `apc.config.json` 里可能含数据库密码，备份文件请按敏感数据管理。
> 删除该文件等价于「全部恢复为环境变量/默认值」，服务会自动回退到种子目录与仿真数据源。

### 5.2 备份

```bash
# 查卷的实际路径
docker volume inspect mes-ai-assistant_mes-data

# 打包备份（服务运行中也可执行）
sudo tar czf mes-data-$(date +%Y%m%d).tar.gz \
  -C $(docker volume inspect -f '{{.Mountpoint}}' mes-ai-assistant_mes-data) .
```

### 5.3 恢复 / 迁移

```bash
docker compose down                    # 停容器（数据保留在卷里）
sudo tar xzf mes-data-20260909.tar.gz -C <卷路径>
docker compose up -d
```

---

## 六、日常运维

```bash
docker compose logs -f          # 看日志
docker compose restart          # 重启
docker compose ps               # 状态
docker compose down             # 停止并移除容器（数据保留）
docker compose up -d --build    # 改代码后重建
```

### 升级

```bash
cd ~/mes-ai-assistant
git pull origin master          # 建议先备份目录或记住当前 commit
docker compose up -d --build
```

### 更换管理员令牌

`ADMIN_TOKEN` 与 `VITE_ADMIN_TOKEN` 必须一致：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

改 `.env` 中两处为同一值，然后 `docker compose up -d --build`（令牌是构建期烧入前端的，必须重建）。

### 更换本地模型

改 `shared/providers.js` 中 ollama 段的 `defaultModel`（并确认宿主机已 `ollama pull` 该模型），
重新构建即可。仅临时切换模型 ID 时，可在页面「API 配置」里直接填本地已有的模型名。

> 换了参数量差别很大的模型（如 1.5B → 7B）时，注入预算会自动跟着档位走，无需改代码；
> 档位表见下节「模型分级预算」。

### 本地模型上下文（务必配置，否则知识库问答直接失败）

Ollama 的 OpenAI 兼容端点（`/v1/chat/completions`）**不接受 `num_ctx`**，请求一旦超过服务端
上下文上限就直接返回 `HTTP 400 exceed_context_size_error` —— 模型根本不会执行，页面表现为
「LLM 无响应」。而 Ollama 缺省上下文只有 **4096 token**，装不下知识库检索出来的正文。

实测：5877 token 的请求 → `request (5877 tokens) exceeds the available context size (4096 tokens)`。
所以部署时必须把宿主机 Ollama 的上下文调大：

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/ctx.conf >/dev/null <<'EOF'
[Service]
Environment="OLLAMA_CONTEXT_LENGTH=8192"
EOF
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

并确认 `shared/modelProfile.js` 里的 `OLLAMA_SAFE_CTX_TOKENS` 与上面取值一致（默认 8192）。
两者不一致的后果：宿主机更小 → 请求 400 失败；宿主机更大 → 只是没吃满，不会出错。

### 模型分级预算（云端按云端配置 / 本地按参数量分档）

知识库注入规模按模型能力分档，唯一配置点在 `shared/modelProfile.js`：

| 模型 | 档位 | 注入上限（字符） | topK | 单页字符 |
|---|---|---|---|---|
| 云端（GLM / DeepSeek / Kimi / 混元…） | cloud | 各家 `contextWindow` × 80%，封顶 160000 | 30 | 9000 |
| 本地 ≤2B（如 deepseek-r1:1.5b） | tiny | 6000 | 8 | 2500 |
| 本地 2B~4.5B（如 qwen2.5:3b） | small | 12000 | 12 | 4000 |
| 本地 4.5B~14B（如 7B / 8B） | medium | min(26000, Ollama 上限) | 20 | 6000 |
| 本地 >14B（如 32B） | large | min(52000, Ollama 上限) | 30 | 8000 |

小模型必须"少而准"：把 2 万字符灌给 1.5B 只会稀释注意力（关键 SQL 页被界面 JSON 淹没），
还会直接撞上 Ollama 的上下文上限。云端大模型则相反，窗口越大越应吃满召回。
同提供商内的短窗口模型也已单独标注（如 Kimi 8K / 128K、豆包 32K / 128K）。

---

## 七、排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 构建卡在 `npm ci` | 网络慢/被限流、或 bridge 无外网 | 重试；确认 `build.network: host`；或换源 `npm config set registry https://registry.npmmirror.com` |
| 构建报 `env file .env.docker not found` | 用了旧版 compose 配置 | 当前版本已无 `env_file`，`git pull` 更新 |
| 容器反复重启 | 3001 被占（host 网络直占宿主机端口） | `sudo ss -lntp \| grep 3001` 停掉占用进程 |
| 页面能开，本地模型报连接失败 | 宿主机 Ollama 没起，或模型未拉取 | 见第二节；`ollama list` |
| 上传/删除文档 403 | 前后端令牌不一致或未重建 | 确认 `.env` 两处一致后 `docker compose up -d --build` |
| 数据"丢失" | 目录改名导致新建卷 | `docker volume ls` 找回旧卷，或改回目录名 |
| 换机器后连不上 Ollama | 用了 bridge 网络 | 改 `.env` 的 `OLLAMA_BASE` 为宿主机非回环 IP |
| 日志 / 文件时间比北京时间早 8 小时 | 容器默认 UTC | compose 已设 `TZ: Asia/Shanghai`；`docker exec <容器> date` 应显示 CST |
| 总结报「文档不存在」 | 该文档只存在于浏览器 IndexedDB，未同步到后端 | 新版本总结前会自动补传；仍失败就重新上传该文档 |
| 超大 XML 文档「搜不到内容」 | 服务端索引尚未构建完成（刚重启），或该文档未入库（非 approved） | `curl /api/search/status` 看 `ready`；未入库文档本就不参与问答，先点「确认入库」 |
| 容器内存占用偏高（数百 MB） | 索引与已入库文档正文常驻内存（数万条记录的量级） | 正常；如需收紧可调小 `MES_IDX_MAX_POSTINGS`，或 `SEARCH_INDEX=0` 关闭索引（会退回前端全量检索） |
| 大文档打开详情较慢 | 正文按需加载（首次打开需从服务端取回） | 预期行为；未下发的正文只在打开文档时才拉取，避免每次打开页面都拉几十 MB |
| 本地模型问答「LLM 无响应」、日志见 `exceed_context_size_error` | Ollama 上下文仍是缺省 4096，装不下注入的知识库正文 | 见第六节「本地模型上下文」：设 `OLLAMA_CONTEXT_LENGTH` 后重启 ollama |
| 问 SQL 却答成别的表/编造表名 | 模型拿文档名当表名；对象目录未注入或 SQL 页被界面 JSON 挤掉 | 已修：会注入「对象目录」+ 给 `query.sql` 页提权 + 按类型裁剪大 JSON。若仍错，确认 `/api/objects?q=…` 有返回（`ready=true`） |
| `/api/objects` 返回空 | 索引未就绪，或查询词与对象名/描述完全不匹配 | `curl /api/search/status` 看 `ready`；换更贴近对象名的关键词重试 |

---

## 八、回滚

```bash
git tag                          # 归档标签，如 archive-2026-09-09
git log --oneline -5

# 临时查看某个版本
git checkout archive-2026-09-09
# 硬回滚（丢弃之后所有改动，谨慎）
git reset --hard archive-2026-09-09
# 只撤销单个文件
git checkout archive-2026-09-09 -- src/components/ApiKeyModal.tsx
```

回滚后需重新构建：`docker compose up -d --build`。

**知识库数据不入库**，源码回滚不影响已上传文档（数据在卷里）；
如需整体灾备，从完整快照包恢复（见 5.2 备份产物）。

---

## 九、文件清单

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 多阶段构建：builder 出 `dist/` → runtime 由 Express 托管前端与 API |
| `docker-compose.yml` | 单服务 `app`，host 网络，卷 `mes-data` 持久化 `/data` |
| `.env` | 唯一配置（前后端令牌、Ollama 地址） |
| `deploy.sh` | 一键部署 + 自检脚本 |
| `shared/providers.js` | 模型提供商单一数据源（前端与后端共用） |
| `server/searchIndex.js` | 零依赖页级倒排索引（英文标识符+子词 / CJK bigram），超大文档的问答检索通道 |

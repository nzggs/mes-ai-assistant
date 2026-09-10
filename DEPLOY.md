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

> 两个令牌必须**同一值**，否则管理操作 403。仓库里的令牌经确认可公开，
> 如需更换见第六节。

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
└─ users.json             # 用户表（跨设备共享）
```

删除文档是软删除（`index.json` 打 `deleted` 墓碑），原始 `files/` 一并清除。

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

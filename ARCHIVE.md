# 项目归档与恢复说明

归档时间：2026-09-09
基线标签：`archive-2026-09-09`

---

## 一、当前状态快照

| 项目 | 说明 |
|---|---|
| 架构 | 前端 React + Vite（TS），后端 Express(ESM)，单进程同时托管前端静态资源与 `/api` |
| 端口 | 3001（容器与本机一致） |
| 容器化 | 多阶段 Dockerfile，compose 使用 **host 网络** |
| 本地模型 | `deepseek-r1:1.5b`（Ollama，宿主机提供） |
| 已部署环境 | Ubuntu 172.28.1.15（容器名 `mes-ai-assistant`） |
| 数据持久化 | Docker 卷 `mes-data` → 容器内 `/data` |

---

## 二、clone 后直接运行（Docker）

```bash
git clone <仓库地址>
cd mes-ai-assistant

# 宿主机需已安装 Ollama 并拉取模型
ollama pull deepseek-r1:1.5b

# 一条命令启动（.env 会被 docker compose 自动加载）
docker compose up -d --build
```

访问 `http://<宿主机IP>:3001`。

### 为什么不需要额外配置

`.env` 是**唯一配置文件**，同时被两处读取：

- **Vite 构建**：读 `VITE_` 前缀变量（`VITE_ADMIN_TOKEN`）
- **docker compose**：默认自动加载本文件，读 `ADMIN_TOKEN` / `OLLAMA_BASE`

两者取自同一令牌值，因此不会出现「前端烧入的令牌与后端不一致导致 403」的问题。

> 容器内不需要 `.env`：`.dockerignore` 已排除所有 env 文件，
> 构建期令牌通过 `build.args` 注入（见 `docker-compose.yml` 与 `Dockerfile` 的 `ARG VITE_ADMIN_TOKEN`）。

### 换机器时注意

`OLLAMA_BASE` 默认是 `http://127.0.0.1:11434`。compose 用的是 **host 网络**，
所以 `127.0.0.1` 就是宿主机本身 —— 只要宿主机跑了 Ollama 就能直连，无需改配置、无需开防火墙。

若改成 bridge 网络，则必须把 `OLLAMA_BASE` 改成宿主机的非回环 IP，否则容器会连到它自己。

---

## 三、本机运行（非 Docker）

```bash
npm ci                 # 安装前端依赖
cd server && npm ci    # 安装后端依赖
node build.cjs         # 构建前端到 dist/
node server/index.js   # 启动（3001）
```

Windows 可直接双击 `start-lan.bat`（监听 `0.0.0.0`，供局域网访问）。

---

## 四、如何回滚

### 回滚到本次归档点

```bash
git tag                          # 查看标签
git checkout archive-2026-09-09  # 临时查看该版本
# 或硬回滚（会丢弃之后所有改动，谨慎）
git reset --hard archive-2026-09-09
```

### 只撤销某个文件的改动

```bash
git checkout archive-2026-09-09 -- src/components/ApiKeyModal.tsx
```

### 改崩了但没提交

```bash
git status        # 看改了什么
git checkout -- . # 丢弃所有未提交改动
```

### 恢复知识库数据

知识库数据（`server/data/`，含上传文档与索引）**不入 git**，请从完整快照包恢复：

```
archive/mes-ai-assistant-full-20260909.tar.gz
```

解压后把 `server/data/` 覆盖回去即可。

---

## 五、归档文件清单

源码以 GitHub 仓库为准（https://github.com/nzggs/mes-ai-assistant），不再单独留存源码包。

| 文件 | 内容 | 用途 |
|---|---|---|
| `archive/mes-ai-assistant-full-20260909.tar.gz` | 源码 + `dist/` + `server/data/`（55M，位于项目外 `archive/`） | 本机完整灾备，**含知识库数据**（数据不入库，这是唯一的整包快照） |

---

## 六、安全说明

- 管理令牌 `ADMIN_TOKEN` / `VITE_ADMIN_TOKEN` 已随 `.env` 入仓库（经确认可公开）。
  如需更换：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`，
  **两处必须同时改成同一个值**，否则局域网设备上传/删除文档会 403。
- 知识库业务数据（`server/data/`）不入库。
- 上传文档、用户账号等运行期数据均落在 `server/data/` 或 Docker 卷 `mes-data` 中。

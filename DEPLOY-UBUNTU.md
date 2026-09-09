# 部署到 Ubuntu 虚拟机（172.28.1.15）

> 适用：Windows 本机（172.28.1.14）无法装 Docker，改用已装好 Docker + Ollama 的 Ubuntu 虚拟机（172.28.1.15）。

## 架构

```
Windows 浏览器 (172.28.1.14)
        │  HTTP 3001
        ▼
Ubuntu 宿主机 (172.28.1.15:3001)
        │  host 网络（无端口映射，容器直接监听宿主机 3001）
        ▼
  容器 mes-ai-assistant  ──►  宿主机 Ollama (127.0.0.1:11434)
        (Express 托管前端 + /api)      deepseek-r1:1.5b
```

> **为什么用 host 网络**：目标机 Ubuntu 20.04 的 docker bridge 网络不可用（DNS `EAI_AGAIN`、
> 外网 `EHOSTUNREACH`、连宿主机端口超时）。改 host 后构建期能联网、运行期 `127.0.0.1:11434`
> 就是宿主机 Ollama，且 3001 无需端口映射。若换到 bridge 正常的机器，可去掉 `network_mode`
> 并恢复 `ports` 映射。

**关键点**：问答链路是 `浏览器 → 后端容器 → 宿主机 Ollama`。后端取上游地址用的是服务端的
`PROVIDERS.ollama.apiUrl`（`server/index.js:453,476`），由环境变量 `OLLAMA_API_URL` 决定，
**不接受前端传入的地址**。所以：

- 页面右上角显示的 `127.0.0.1:11434` 只是展示信息，不参与实际调用；
- Windows 端**不需要**开 Ollama，也不需要装模型。

---

## 第 1 步：确认 Ollama 服务与模型就绪

在 **host 网络**下，容器与宿主机共享网络栈，容器内的 `127.0.0.1:11434` 就是宿主机 Ollama，
**不需要改 `OLLAMA_HOST`、也不需要开防火墙**。只需确认两件事：

```bash
# 1) Ollama 在跑（能返回模型 JSON 即正常）
curl -s -m 5 http://127.0.0.1:11434/api/tags | head -c 200

# 2) 模型已拉取（应看到 deepseek-r1:1.5b）
ollama list | grep deepseek
```

没有就拉（约 1.1GB）：

```bash
ollama pull deepseek-r1:1.5b
```

<details>
<summary>仅当改用 bridge 网络时才需要（当前配置可跳过）</summary>

Ollama 默认只监听 `127.0.0.1`，bridge 网络下容器访问不到，需改为监听非回环地址：

```bash
sudo systemctl edit ollama
```

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart ollama
sudo ufw allow from 172.17.0.0/16 to any port 11434   # 容器网段访问 Ollama
sudo ufw allow 3001/tcp                                # 页面访问
```

同时把 `.env` 的 `OLLAMA_BASE` 从 `127.0.0.1` 改成宿主机的非回环 IP，否则容器会连到自己。

</details>

---
## 第 2 步：获取代码（git clone）

```bash
cd ~
git clone https://github.com/nzggs/mes-ai-assistant.git mes-ai-assistant
cd mes-ai-assistant
ls -l     # 应能看到 Dockerfile / docker-compose.yml / .env / deploy.sh
```

> 目录名必须是 `mes-ai-assistant`：compose 项目名由目录名决定，改了会新建数据卷。
> 已有目录时用 `git pull origin master` 更新即可（旧目录先备份）。

---

## 第 3 步：构建并启动

### 方式 A：一键脚本（推荐）

```bash
chmod +x deploy.sh
./deploy.sh
```

脚本会自动做：环境检查 → 探测 Ollama 连通性 → 检查/拉取模型 → 构建并启动 → 健康检查 → 打印访问地址。

### 方式 B：手动执行

```bash
docker compose up -d --build
```

> `.env` 是唯一配置文件，docker compose **默认自动加载**它，无需 `--env-file`。
> 它同时提供构建期的 `VITE_ADMIN_TOKEN` 和运行时的 `ADMIN_TOKEN`，两者取自同一值，
> 只改一处会导致局域网设备上传/删除文档 403。

首次构建需要 `npm ci`（前后端两份依赖），约 3–8 分钟，取决于网络。

---
## 第 4 步：验证

```bash
# 健康检查
curl -s http://127.0.0.1:3001/api/health

# 容器状态
docker compose ps

# 端到端对话（后端 → Ollama → deepseek-r1:1.5b）
curl -s -m 180 -X POST http://127.0.0.1:3001/api/chat \
  -H 'Content-Type: application/json' \
  -H 'X-Api-Key: ollama-local' \
  -d '{"messages":[{"role":"user","content":"只回答一个数字：1+1等于几"}],"providerId":"ollama","modelId":"deepseek-r1:1.5b"}' \
  | head -c 800
```

> 本地模型也要带 `X-Api-Key` 头（占位值 `ollama-local` 即可），否则后端返回"未提供 API Key"。

能流式返回内容即全链路打通。

---

## 第 5 步：从 Windows 访问

浏览器打开：**http://172.28.1.15:3001**

页面右上角「API 配置」应显示：本地 DeepSeek / DeepSeek-R1 1.5B。

---

## 常用运维命令

```bash
docker compose logs -f app     # 看日志
docker compose restart         # 重启
docker compose down            # 停止并移除容器
docker compose up -d --build   # 改代码后重新构建
docker compose ps              # 状态
```

数据落在卷 `mes-data`（容器内 `/data`），重建容器不丢文档。

```bash
docker volume inspect mes-ai-assistant_mes-data   # 查看实际存储路径
```

---

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 构建卡在 `npm ci` | 网络慢/被限流 | 重跑；或换 npm 源 `npm config set registry https://registry.npmmirror.com` |
| 页面能开，本地模型报"连接失败" | Ollama 只听 127.0.0.1 | 回到第 1 步 |
| 上传/删除文档 403 | token 不一致 | 确认用了 `--env-file .env`；两者都取自同文件的 `ADMIN_TOKEN` |
| 容器反复重启 | 3001 端口被占（host 网络直占宿主机端口） | `sudo ss -lntp \| grep 3001` 查占用进程并停掉 |
| `host.docker.internal` 解析失败 | 已废弃的回退方案 | 当前用 host 网络 + `OLLAMA_BASE=http://127.0.0.1:11434`，不会遇到 |
| 想换 Ollama 地址 | 虚拟机 IP 变了 | 改 `.env` 的 `OLLAMA_BASE`，然后 `docker compose up -d`（无需重建镜像） |

---

## 附：关键配置一览

| 文件 | 作用 |
|---|---|
| `.env` | `ADMIN_TOKEN`（管理与前端共用）、`OLLAMA_BASE`（宿主机 Ollama 地址） |
| `docker-compose.yml` | 单服务 `app`，**host 网络**（无端口映射），挂卷 `mes-data` |
| `Dockerfile` | 多阶段：builder 出 `dist/` → runtime 由 Express 托管前端与 API |
| `deploy.sh` | 一键部署 + 自检脚本 |

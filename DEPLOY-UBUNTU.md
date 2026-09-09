# 部署到 Ubuntu 虚拟机（172.28.1.15）

> 适用：Windows 本机（172.28.1.14）无法装 Docker，改用已装好 Docker + Ollama 的 Ubuntu 虚拟机（172.28.1.15）。

## 架构

```
Windows 浏览器 (172.28.1.14)
        │  HTTP 3001
        ▼
Ubuntu 宿主机 (172.28.1.15:3001)
        │  端口映射
        ▼
  容器 mes-ai-assistant  ──►  宿主机 Ollama (172.28.1.15:11434)
        (Express 托管前端 + /api)      deepseek-r1:1.5b
```

**关键点**：问答链路是 `浏览器 → 后端容器 → 宿主机 Ollama`。后端取上游地址用的是服务端的
`PROVIDERS.ollama.apiUrl`（`server/index.js:453,476`），由环境变量 `OLLAMA_API_URL` 决定，
**不接受前端传入的地址**。所以：

- 页面右上角显示的 `127.0.0.1:11434` 只是展示信息，不参与实际调用；
- Windows 端**不需要**开 Ollama，也不需要装模型。

---

## 第 1 步：Ubuntu 上确认 Ollama 可被容器访问（最容易踩的坑）

Ollama 默认只监听 `127.0.0.1`，容器访问不到。**必须改成监听非回环地址。**

```bash
# 看当前监听地址
ss -lntp | grep 11434
```

- 如果看到 `127.0.0.1:11434` 或 `127.0.0.1%lo` → **必须改**
- 如果看到 `0.0.0.0:11434` 或 `*:11434` → 已 OK，跳到第 2 步

### 修改方法

```bash
sudo systemctl edit ollama
```

在打开的编辑器里写入（注意 `[Service]` 必须保留）：

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
```

保存退出后：

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

### 验证（必须能通过非回环 IP 访问）

```bash
curl -s --max-time 5 http://172.28.1.15:11434/api/tags | head -c 200
```

能返回 JSON 模型列表才算通过。若返回 `Connection refused`，说明没改成功。

### 防火墙（仅在开启 ufw 时需要）

```bash
sudo ufw allow from 172.17.0.0/16 to any port 11434   # 容器网段访问 Ollama
sudo ufw allow 3001/tcp                                 # 页面访问
sudo ufw reload
```

---

## 第 2 步：Ubuntu 上确认模型已就绪

```bash
ollama list | grep deepseek
# 或
curl -s http://172.28.1.15:11434/api/tags | grep -o 'deepseek-r1:1.5b'
```

没有就拉（约 1.1GB）：

```bash
ollama pull deepseek-r1:1.5b
```

---

## 第 3 步：Windows 上传代码到 Ubuntu

在本机 **Git Bash / CMD** 里执行（`scp` 已确认可用，22 端口可达）：

```bash
scp "C:/Users/Administrator/WorkBuddy/AI智能助手/mes-ai-deploy.tar.gz" <用户名>@172.28.1.15:~/
```

把 `<用户名>` 换成 Ubuntu 的登录用户名，回车后输密码。

> 包只有 1.5MB，已排除 `node_modules`、`dist`、`dist.bak_*` 备份、本地知识库数据 `server/data`。

---

## 第 4 步：Ubuntu 上解压并部署

```bash
mkdir -p ~/mes-ai-assistant
tar xzf ~/mes-ai-deploy.tar.gz -C ~/mes-ai-assistant
cd ~/mes-ai-assistant
ls -l            # 应能看到 Dockerfile / docker-compose.yml / .env.docker / deploy.sh
```

### 方式 A：一键脚本（推荐）

```bash
chmod +x deploy.sh
./deploy.sh
```

脚本会自动做：环境检查 → 探测 Ollama 连通性 → 检查/拉取模型 → 构建并启动 → 健康检查 → 打印访问地址。

如果脚本报 Ollama 不可达，说明第 1 步没生效，按提示处理即可。

### 方式 B：手动执行

```bash
docker compose --env-file .env.docker up -d --build
```

> `--env-file .env.docker` **不能省**：构建期要把 `VITE_ADMIN_TOKEN` 烧进前端包，
> 运行时后端用同一个 `ADMIN_TOKEN`。省了会导致上传/删除文档 403。

首次构建需要 `npm ci`（前后端两份依赖），约 3–8 分钟，取决于网络。

---

## 第 5 步：验证

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

## 第 6 步：从 Windows 访问

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
| 上传/删除文档 403 | token 不一致 | 确认用了 `--env-file .env.docker`；两者都取自同文件的 `ADMIN_TOKEN` |
| 容器反复重启 | 端口占用 | `sudo ss -lntp \| grep 3001` 查占用；改 `docker-compose.yml` 的 `ports` |
| `host.docker.internal` 解析失败 | 用了回退方案 | `.env.docker` 里 `OLLAMA_BASE` 已填 `http://172.28.1.15:11434`，一般遇不到 |
| 想换 Ollama 地址 | 虚拟机 IP 变了 | 改 `.env.docker` 的 `OLLAMA_BASE`，然后 `docker compose up -d`（无需重建镜像） |

---

## 附：关键配置一览

| 文件 | 作用 |
|---|---|
| `.env.docker` | `ADMIN_TOKEN`（管理与前端共用）、`OLLAMA_BASE`（宿主机 Ollama 地址） |
| `docker-compose.yml` | 单服务 `app`，映射 3001，挂卷 `mes-data` |
| `Dockerfile` | 多阶段：builder 出 `dist/` → runtime 由 Express 托管前端与 API |
| `deploy.sh` | 一键部署 + 自检脚本 |

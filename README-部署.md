# README - 局域网部署（MES AI 智能助手）

本说明适用于把后端服务（`server/`，端口 3001）开放给**局域网内多台设备**访问，以及将来部署到一台固定的局域网服务器。

完成后，局域网内任意设备浏览器打开 `http://<服务器IP>:3001` 即可使用，无需在每台设备上手动配置任何令牌。

---

## 一、架构与鉴权说明

- 后端 Express 同时托管前端静态包（`dist/`）和 API，默认端口 `3001`。
- 前端由后端同源托管：设备访问 `http://<IP>:3001` 时，API 请求自动指向同一地址，无需额外跨域配置（CORS 已放行所有来源）。
- **管理写操作**（上传文档、删除文档、用户管理）由 `ADMIN_TOKEN` 保护：
  - 未设 `ADMIN_TOKEN`：仅本机（127.0.0.1）可写，局域网设备无法写。
  - 设了 `ADMIN_TOKEN`：所有写操作（含本机）必须携带匹配的管理员令牌。
- 前端在**构建期**把令牌烧入包（`VITE_ADMIN_TOKEN`），运行时自动带上，因此页面用户无感知。

> ⚠️ 安全提示：`VITE_` 前缀变量会编进前端 JS，局域网内任何打开页面者都能在源码中看到该令牌。它仅适合**可信内网**做基础防护，不能防范有意的局域网内攻击者。如需更强管控，请联系开发改为"页面输入令牌"方案（不烧入包）。

---

## 二、部署步骤（一键）

把整个 `mes-ai-assistant/` 目录拷到目标机器，双击运行根目录的部署脚本即可：

```
deploy-lan.bat
```

脚本会自动依次完成：
1. 放行 Windows 防火墙 3001 入站（规则名 `MES-AI-Assistant-3001`，已存在则忽略）。
2. 用 `VITE_ADMIN_TOKEN` 构建前端（令牌烧入 `dist/`）。
3. 启动后端，监听 `0.0.0.0:3001`。

日常重启（不重新构建）用：

```
start-lan.bat
```

---

## 三、手动分步配置（便于理解与排错）

### 1. 后端配置 `server/.env`

```bash
PORT=3001
HOST=0.0.0.0                                   # 0.0.0.0 = 对局域网开放；127.0.0.1 = 仅本机
ADMIN_TOKEN=<一段足够长的随机串>               # 建议：openssl rand -hex 32
ALLOWED_ORIGINS=                               # 一般留空（CORS 已放行所有来源）
```

> 重要坑：`node server/index.js` 从项目根目录启动，`.env` 加载逻辑已改为**显式读取 `server/.env`**（`server/index.js` 中 `dotenv.config({ path: ...server/.env })`）。不要把 `HOST`/`ADMIN_TOKEN` 只写在项目根目录的 `.env`，否则不会生效。

### 2. 前端构建期令牌（项目根目录 `.env`）

```bash
VITE_ADMIN_TOKEN=<与上面 ADMIN_TOKEN 完全相同的值>
```

构建命令（本机已验证可用的变通参数，避免 esbuild worker 在受限环境报错）：

```bash
NODE_OPTIONS= ESBUILD_WORKER_THREADS=0 TEMP="$PWD/.buildtmp" TMP="$PWD/.buildtmp" node build.cjs
```

或直接 `npm run build`（若环境无上述限制）。

构建后确认令牌已编入：

```bash
grep -c "<你的ADMIN_TOKEN值>" dist/assets/index-*.js   # 应输出 1
```

### 3. 放行防火墙（Windows）

```bash
netsh advfirewall firewall add rule name="MES-AI-Assistant-3001" dir=in action=allow protocol=TCP localport=3001
```

### 4. 启动

```bash
HOST=0.0.0.0 ADMIN_TOKEN=<值> node server/index.js
# 或依赖 server/.env，直接：
node server/index.js
```

---

## 四、验证清单

服务启动后日志应显示：

```
Port:      3001 (监听 0.0.0.0，已对局域网开放)
管理操作：已启用 ADMIN_TOKEN
```

用 curl 自测鉴权（用 `X-Forwarded-For` 模拟局域网 IP）：

```bash
# 本机（loopback）无令牌：设了 ADMIN_TOKEN 后为 403（正常，页面会自动带令牌）
curl -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/api/users

# 模拟局域网 IP + 正确令牌：期望 200
curl -o /dev/null -w "%{http_code}\n" -H "X-Forwarded-For: 10.0.0.5" -H "X-Admin-Token: <ADMIN_TOKEN>" http://127.0.0.0.1:3001/api/users

# 模拟局域网 IP + 无/错令牌：期望 403
curl -o /dev/null -w "%{http_code}\n" -H "X-Forwarded-For: 10.0.0.5" http://127.0.0.1:3001/api/users
```

健康检查：

```bash
curl -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/api/health   # 期望 200
```

其他设备访问 `http://<服务器IP>:3001` 应能看到登录页并能正常上传/管理文档。

---

## 五、排错

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 本机 `127.0.0.1:3001` 能开，局域网设备连不上 | 防火墙未放行 / 服务只监听 127.0.0.1 | 检查 `netsh advfirewall firewall show rule name="MES-AI-Assistant-3001"`；确认启动日志显示 `监听 0.0.0.0` |
| 启动日志显示 `监听 127.0.0.1，仅本机可访问` | `HOST` 未生效（写在根目录 `.env` 而非 `server/.env`） | 把 `HOST=0.0.0.0` 写到 `server/.env`，重启 |
| 局域网设备能打开页面，但上传/删除/用户管理报 403 | 前端包里的令牌与服务端 `ADMIN_TOKEN` 不一致，或前端未烧入令牌 | 确认根 `.env` 的 `VITE_ADMIN_TOKEN` == `server/.env` 的 `ADMIN_TOKEN`；重新构建；`grep` 确认令牌在 `dist/` |
| 启动日志 `管理操作：仅本机(loopback)可写` | `ADMIN_TOKEN` 未生效 | 同 HOST，确认写在 `server/.env` 且已重启 |
| 构建报 esbuild / worker 相关错误 | 受限环境 | 用带 `ESBUILD_WORKER_THREADS=0 TEMP/TMP` 变通参数的命令（见第三节） |
| 设备输入 IP 打不开，但 ping 得通 | 端口未放行 / 服务未起 | 确认 `netstat -ano \| grep :3001` 有监听；防火墙规则存在 |
| IP 会变导致设备访问失效 | 服务器 DHCP 分配动态 IP | 在路由器给服务器绑定固定 IP，或设备用主机名（需 DNS/hosts 可达） |

---

## 六、更换管理员令牌

1. 生成新值：`openssl rand -hex 32`
2. 同步修改三处（**值必须完全一致**）：
   - `server/.env` → `ADMIN_TOKEN=`
   - 项目根目录 `.env` → `VITE_ADMIN_TOKEN=`
   - `deploy-lan.bat` 中两处（`VITE_ADMIN_TOKEN=` 与 `ADMIN_TOKEN=`）
3. 重新部署：运行 `deploy-lan.bat`（会重新构建烧入新令牌并重启）。

---

## 七、文件清单

- `server/.env`：后端运行配置（HOST / ADMIN_TOKEN / PORT）
- 项目根 `.env`：前端构建期变量（VITE_ADMIN_TOKEN）；容器部署时同时提供 `ADMIN_TOKEN` 与 `OLLAMA_BASE`
- `deploy-lan.bat`：一键部署（防火墙 + 构建 + 启动）
- `start-lan.bat`：日常启动（不重建）
- `dist/`：构建后的前端包（含烧入的令牌）

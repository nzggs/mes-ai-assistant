# MES AI 智能助手 — 数据存储与运维部署说明

本文档说明：上传的文档与切片存在哪里、如何把系统打包成"安装包"做后续升级、以及日常运维怎么做。
配套脚本：`make-release.bat`（开发机打包）、`update-lan.bat`（服务器就地升级）、`deploy-lan.bat` / `start-lan.bat`（部署/启动）。

---

## 一、数据存放在哪里

### 1.1 数据根目录

默认在 **`server/data/`**（相对于项目根目录）。整套应用是有状态服务，**所有用户上传的文档、切片、总结、用户、日志都在这个目录里**。

如需把数据放到独立的盘（如 D 盘数据盘），启动前设置环境变量：

```bat
set MES_DATA_DIR=D:\mes-data
```

服务启动时会用该目录重建 `docs/`、`files/` 等子目录。**迁移数据盘 = 拷贝整个旧 `server/data` 到新位置 + 设 `MES_DATA_DIR` 指向它**。

### 1.2 目录结构

```
server/data/
├─ docs/
│  ├─ index.json          # 轻量索引（每篇的元数据：id/名称/状态/更新时间/是否删除/正文长度）
│  ├─ <docId>             # 每篇文档一个分片文件（JSON），含完整记录（见下）
│  └─ …                   # 其他文档分片
├─ files/
│  ├─ <docId>             # 上传的原始文件二进制（PDF/Word/Excel/PPT…）
│  └─ <docId>.ext         # 对应的扩展名（如 "pdf"、"docx"）
├─ tasks/
│  └─ sum-<taskId>.json   # 总结任务的临时运行状态（定期清理，非长期数据）
├─ doc-logs.json          # 操作日志（上传/删除/审核/总结），最多保留 4000 条
├─ users.json             # 用户表（跨浏览器/设备共享）
└─ docs.json.migrated     # 旧版整文件格式的备份（首次迁移后留下，可删）
```

### 1.3 上传一篇文档，数据怎么落盘

1. 原始文件 → 写进 `files/<docId>`（二进制）+ `files/<docId>.ext`（扩展名）。
2. 服务端解析正文与分段切片，连同元信息写成 `docs/<docId>` 这个**分片 JSON**（不再用单一大文件，避免整库重写）。
3. 所有分片写完后，重建 `docs/index.json`（只含元数据，不含正文，很小）。
4. 删除文档时：实际是给分片打 `deleted` 墓碑（软删除），`index.json` 同步标记；原始 `files/` 一并删除。

### 1.4 "切片"存在哪里

文档的切片/分块结果（整篇总结 `summaryChunks`、字典/表格类总结 `tableSummaries`、正文 `textContent`/`content`、`chunks` 数量等）**都嵌在 `docs/<docId>` 这个分片文件里**，没有单独的切片文件。`tasks/` 只是总结任务的临时进度，会被定时清理（终态超过 24 小时的自动删除）。

> 结论：**备份 `server/data` 这一个目录 = 备份了全部业务数据**。

---

## 二、备份与迁移

### 2.1 备份（推荐每天）

直接整目录拷贝即可（服务运行时也能拷，文件是小 JSON/二进制，原子写已做保护）：

```bat
xcopy /E /I /Y server\data  D:\backup\mes-ai-data-%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%\
```

或更简单：停服后把 `server/data` 整个压缩。

### 2.2 迁移 / 换数据盘

1. 停服（见四.1）。
2. 把旧 `server/data` 整体复制到新位置（如 `D:\mes-data`）。
3. 启动前设 `MES_DATA_DIR=D:\mes-data`（可写进 `server/.env` 之外的一个启动脚本，或 `start-lan.bat`）。
4. 启动，验证 `/api/health` 与知识库列表正常。

### 2.3 恢复

停服 → 用备份覆盖 `server/data` → 启动即可。

---

## 三、安装包更新（后续升级方法）

升级思路：**业务数据（`server/data`）与程序代码分离**。升级只替换程序（前端 `dist/`、后端 `server/`、`shared/`、配置脚本），数据目录原样保留。

### 3.1 开发机：打包"安装包"

运行 `make-release.bat`，它会：

- 用当前 `VITE_ADMIN_TOKEN`（根目录 `.env`）构建前端，把管理员令牌烧入 `dist/`；
- 把 `dist/`、`server/`、`shared/`、`package.json`、`package-lock.json`、`build.cjs`、`vite.config.ts`、`.env`（根，含 VITE_ADMIN_TOKEN）、`*.bat` 脚本打成一个 zip：`mes-ai-release-<日期>.zip`。

> 打包内容**不含** `server/data`（用户数据）和 `node_modules`（服务器侧按需安装，见下）。

### 3.2 服务器：用安装包就地升级

1. 把 `mes-ai-release-<日期>.zip` 传到服务器，解压到一个**临时目录**（如 `C:\temp\mes-ai-release`）。
2. 进入该临时目录，运行：

   ```bat
   update-lan.bat  "C:\path\to\当前安装目录"
   ```

   （若省略路径，默认把当前安装目录当作脚本所在目录自身，即"在已安装目录里就地跑更新包"——此时请先把新包内容解压覆盖到安装目录，再运行 `update-lan.bat`。）

`update-lan.bat` 会自动完成：

- 停止 3001 端口上的旧服务；
- 备份旧 `server/data` 到 `..\mes-ai-data-backup-<时间戳>`；
- 同步新包的程序文件到安装目录，**但保留** `server/data/`（用户数据）和 `server/.env`（本机令牌/端口配置）；
- 若新包带 `node_modules` 则一并覆盖，否则在服务器执行 `npm install`（需 Node 环境）；
- 重新放行防火墙 3001；
- 重新启动服务。

> 升级过程数据不丢、配置不丢。若升级失败，可用备份的 `server/data` 回退。

### 3.3 更换管理员令牌（升级或定期轮换）

`ADMIN_TOKEN`（服务端）与 `VITE_ADMIN_TOKEN`（前端，烧进 `dist`）**必须一致**：

1. 开发机：`openssl rand -hex 32` 生成新令牌；
2. 改根目录 `.env` 的 `VITE_ADMIN_TOKEN` 和 `server/.env` 的 `ADMIN_TOKEN` 为同一值；
3. 重新跑 `make-release.bat` 打包（前端需重新构建以烧入新令牌）；
4. 服务器用新包 `update-lan.bat` 升级。

---

## 四、日常运维

### 4.1 启动 / 停止

- 首次部署或换令牌后：`deploy-lan.bat`（会构建前端 + 启动，监听 `0.0.0.0:3001`）。
- 日常仅重启：`start-lan.bat`。
- 停止：结束占用 3001 端口的 `node` 进程（任务管理器或 `netstat -ano | findstr :3001` 后 `taskkill /PID <id> /F`）。

### 4.2 健康检查

```bat
curl http://127.0.0.1:3001/api/health      # 返回 200 即正常
curl http://127.0.0.1:3001/                 # 首页 200 即前端可访问
```

局域网其他设备访问：`http://<服务器局域网IP>:3001`。

### 4.3 日志

- 后端运行日志：`server-run.log`（启动 `deploy-lan.bat`/`start-lan.bat` 时重定向到此处）。
- 应用层操作日志：`server/data/doc-logs.json`（上传/删除/审核/总结记录，页面内也有展示）。

### 4.4 端口与防火墙

- 端口：`PORT`（默认 3001），监听地址 `HOST=0.0.0.0`（局域网可见）。
- 防火墙：部署脚本已加永久入站规则 `MES-AI-Assistant-3001`（TCP 3001，域/专用/公用均启用）。若重装系统需重新放行（见 `README-部署.md`）。

### 4.5 容量与清理

- 数据全在 `server/data`，按文档量增长。`files/` 占原始文件体积，`docs/` 占解析后的正文+切片（文本，通常远小于原文件）。
- `tasks/` 会自动清理，无需手动管。
- 如需释放空间：删除已审核文档（走应用内"删除"，会软删并清 `files/`）；`docs.json.migrated` 确认迁移成功后可直接删。

### 4.6 常见问题

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 其他设备连不上 | 防火墙未放行 / 服务未监听 0.0.0.0 | 查 `netstat -ano \| findstr :3001` 是否 `0.0.0.0:3001`；重跑 `deploy-lan.bat` |
| 上传/配置 Key 全部 403 | 设了 `ADMIN_TOKEN` 但前端令牌不对/未烧入 | 确认 `VITE_ADMIN_TOKEN` 与 `ADMIN_TOKEN` 一致且前端已重新构建 |
| 首页白屏 | `dist/` 未构建或被清 | 跑 `deploy-lan.bat` 重新构建 |
| 数据丢失错觉 | 其实是软删除 | 查 `docs/index.json` 的 `deleted` 标记；恢复需从备份覆盖 `server/data` |
| 服务起不来 | 端口被占 / Node 缺失 | 释放 3001；确认 `node -v` |

---

## 五、文件清单（与数据/部署相关）

| 文件 / 目录 | 作用 |
|---|---|
| `server/data/` | **全部业务数据**（文档、切片、原始文件、用户、日志） |
| `server/.env` | 服务端运行配置：`HOST`、`PORT`、`ADMIN_TOKEN` |
| `.env`（根） | 前端构建期变量：`VITE_ADMIN_TOKEN` |
| `dist/` | 构建后的前端静态包（含烧入的令牌） |
| `server/` | 后端源码与依赖入口（`server/index.js`） |
| `shared/providers.js` | 模型提供商单一数据源（前端+后端共用） |
| `deploy-lan.bat` | 一次性部署：构建 + 启动 + 防火墙 |
| `start-lan.bat` | 日常启动（不重建） |
| `make-release.bat` | 开发机：打包发布包（安装包） |
| `update-lan.bat` | 服务器：用安装包就地升级（保留数据与配置） |
| `README-部署.md` | 局域网部署与排错 |
| `README-数据存储与运维.md` | 本文档 |

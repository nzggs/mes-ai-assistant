#!/usr/bin/env bash
# ============================================================
#  mes-ai-assistant 一键部署脚本（宿主机 Ollama 模式）
#  用法：chmod +x deploy.sh && ./deploy.sh
#  可选：OLLAMA_HOST_IP=172.17.0.1 ./deploy.sh   （自定义宿主机 Ollama 地址）
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

# 宿主机 Ollama 地址：优先取环境变量，其次读 .env，最后用默认值
DEFAULT_IP="127.0.0.1"
HOST_IP="${OLLAMA_HOST_IP:-}"
if [ -z "$HOST_IP" ]; then
  HOST_IP="$(grep -E '^OLLAMA_BASE=http://' .env 2>/dev/null \
             | head -1 | sed -E 's#^OLLAMA_BASE=http://([^:/]+).*#\1#')"
fi
HOST_IP="${HOST_IP:-$DEFAULT_IP}"

MODEL="deepseek-r1:1.5b"

say() { printf '\n==> %s\n' "$*"; }

# ---------- 1. 环境检查 ----------
say "[1/5] 环境检查"
command -v docker >/dev/null 2>&1 || { echo "  未找到 docker，请先安装"; exit 1; }
echo "  docker        : $(docker --version | head -1)"
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
  echo "  compose       : $(docker compose version | head -1)"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
  echo "  compose       : $(docker-compose --version | head -1) (v1)"
else
  echo "  未找到 docker compose，请先安装插件"; exit 1
fi

# ---------- 2. 宿主机 Ollama 可达性 ----------
say "[2/5] 检查宿主机 Ollama ($HOST_IP:11434)"
if curl -fsS --max-time 5 "http://$HOST_IP:11434/api/tags" >/dev/null 2>&1; then
  echo "  Ollama 可达"
else
  echo "  无法访问 http://$HOST_IP:11434/api/tags"
  echo ""
  echo "  请先确认 Ollama 服务已启动："
  echo "    sudo systemctl start ollama && sudo systemctl enable ollama"
  echo "    curl http://$HOST_IP:11434/api/tags"
  echo ""
  echo "  注：compose 已配 network_mode: host，容器与宿主机共用网络栈，"
  echo "      Ollama 监听 127.0.0.1 即可，无需改成 0.0.0.0。"
  echo "      若你改用了 bridge 网络，则仍需 OLLAMA_HOST=0.0.0.0 并放行防火墙："
  echo "  若已开启 ufw，还需放行容器网段："
  echo "    sudo ufw allow from 172.17.0.0/16 to any port 11434"
  echo ""
  echo "  确认地址可用后重跑本脚本；如宿主机 IP 不是 $HOST_IP，用："
  echo "    OLLAMA_HOST_IP=<实际IP> ./deploy.sh"
  exit 1
fi

# ---------- 3. 模型检查 ----------
say "[3/5] 检查本地模型 $MODEL"
if curl -fsS --max-time 5 "http://$HOST_IP:11434/api/tags" 2>/dev/null | grep -q "$MODEL"; then
  echo "  模型已就绪"
else
  echo "  模型缺失，开始拉取（约 1.1GB）..."
  ollama pull "$MODEL"
fi

# ---------- 4. 构建并启动 ----------
say "[4/5] 构建镜像并启动容器"
# 不写 --env-file：docker compose 会自动加载同目录 .env
$COMPOSE up -d --build

# ---------- 5. 健康检查 ----------
say "[5/5] 等待服务就绪"
OK=0
for i in $(seq 1 40); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3001/api/health || true)"
  if [ "$code" = "200" ]; then OK=1; break; fi
  sleep 2
done

echo ""
if [ "$OK" = "1" ]; then
  echo "  服务已就绪"
else
  echo "  健康检查未通过，查看日志：docker compose logs --tail=50 app"
fi

$COMPOSE ps

# 打印访问地址
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "============================================================"
echo " 本机访问   : http://127.0.0.1:3001"
[ -n "${LAN_IP:-}" ] && echo " 局域网访问 : http://$LAN_IP:3001"
echo " 查看日志   : docker compose logs -f app"
echo " 停止服务   : docker compose down"
echo "============================================================"

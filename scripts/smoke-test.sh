#!/usr/bin/env bash
# smoke-test.sh — cloudflare-memory 接口冒烟测试
# 用法: bash scripts/smoke-test.sh [BASE_URL] [TOKEN] [ADMIN_TOKEN]
# 环境变量（优先级低于命令行参数）:
#   BASE_URL     默认 http://localhost:8787
#   TOKEN        普通用户 JWT（必需）
#   ADMIN_TOKEN  管理员 JWT（可选，缺省则跳过 admin 接口）

set -euo pipefail

# ── 参数解析 ──────────────────────────────────────────────────────────────────
BASE_URL="${1:-${BASE_URL:-http://localhost:8787}}"
TOKEN="${2:-${TOKEN:-}}"
ADMIN_TOKEN="${3:-${ADMIN_TOKEN:-}}"

# ── 颜色 ──────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ── 计数器 ────────────────────────────────────────────────────────────────────
PASS=0
FAIL=0
SKIP=0
WARN=0

# ── 前置检查 ──────────────────────────────────────────────────────────────────
if [ -z "$TOKEN" ]; then
  echo -e "${RED}错误: TOKEN 未设置。请通过第2个参数或环境变量 TOKEN 传入普通用户 JWT。${NC}"
  echo "示例: TOKEN=<your_jwt> bash scripts/smoke-test.sh"
  echo "生成 JWT: node scripts/jwt-gen.js <user-id>"
  exit 1
fi

# ── 辅助函数 ──────────────────────────────────────────────────────────────────

# run_test <名称> <期望HTTP状态码> <响应体必须包含的字符串> [curl 参数...]
run_test() {
  local name="$1"
  local expected_status="$2"
  local expected_body="$3"
  shift 3

  local response http_code body
  response=$(curl -s -w "\n__HTTP_CODE__:%{http_code}" "$@") || true
  http_code=$(echo "$response" | grep '__HTTP_CODE__:' | sed 's/__HTTP_CODE__://')
  body=$(echo "$response" | sed '/^__HTTP_CODE__:/d')

  if [ "$http_code" != "$expected_status" ]; then
    echo -e "${RED}[FAIL]${NC} $name"
    echo "       期望状态码: $expected_status，实际: $http_code"
    echo "       响应体: $body"
    FAIL=$((FAIL + 1))
    return
  fi

  if [ -n "$expected_body" ] && ! echo "$body" | grep -q "$expected_body"; then
    echo -e "${RED}[FAIL]${NC} $name"
    echo "       响应体中未找到: $expected_body"
    echo "       实际响应体: $body"
    FAIL=$((FAIL + 1))
    return
  fi

  echo -e "${GREEN}[PASS]${NC} $name"
  PASS=$((PASS + 1))
}

# run_warn_test: 允许多个状态码，未命中时记为 WARN 而非 FAIL
# run_warn_test <名称> <允许的状态码列表(逗号分隔)> <响应体必须包含的字符串> [curl 参数...]
run_warn_test() {
  local name="$1"
  local allowed_statuses="$2"
  local expected_body="$3"
  shift 3

  local response http_code body
  response=$(curl -s -w "\n__HTTP_CODE__:%{http_code}" "$@") || true
  http_code=$(echo "$response" | grep '__HTTP_CODE__:' | sed 's/__HTTP_CODE__://')
  body=$(echo "$response" | sed '/^__HTTP_CODE__:/d')

  if echo "$allowed_statuses" | tr ',' '\n' | grep -qx "$http_code"; then
    if [ -n "$expected_body" ] && ! echo "$body" | grep -q "$expected_body"; then
      echo -e "${YELLOW}[WARN]${NC} $name (HTTP $http_code，响应体未含期望字段: $expected_body)"
      WARN=$((WARN + 1))
    else
      echo -e "${GREEN}[PASS]${NC} $name"
      PASS=$((PASS + 1))
    fi
  else
    echo -e "${YELLOW}[WARN]${NC} $name (HTTP $http_code，可能依赖 AI/Vector 配置)"
    echo "       响应体: $body"
    WARN=$((WARN + 1))
  fi
}

# run_skip <名称> <原因>
run_skip() {
  local name="$1"
  local reason="$2"
  echo -e "${BLUE}[SKIP]${NC} $name ($reason)"
  SKIP=$((SKIP + 1))
}

# 从创建响应中提取 memory id（兼容有无 jq）
extract_id() {
  local body="$1"
  if command -v jq &>/dev/null; then
    echo "$body" | jq -r '.data.id // empty'
  else
    echo "$body" | grep -o '"id":"[^"]*"' | head -1 | sed 's/"id":"//;s/"//'
  fi
}

# ── 开始测试 ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  cloudflare-memory 冒烟测试${NC}"
echo -e "${BLUE}  BASE_URL: $BASE_URL${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# ── 基础 ──────────────────────────────────────────────────────────────────────
echo "--- 基础 ---"

run_test "GET /health" "200" "OK" \
  "$BASE_URL/health"

run_test "GET /api/memories 无 Token → 401" "401" "" \
  "$BASE_URL/api/memories"

# ── 记忆 CRUD ─────────────────────────────────────────────────────────────────
echo ""
echo "--- 记忆 CRUD ---"

# 创建短期记忆，捕获 id 供后续用例复用
CREATE_RESPONSE=$(curl -s \
  -X POST "$BASE_URL/api/memories" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"smoke test memory","tags":["smoke","test"]}')

if echo "$CREATE_RESPONSE" | grep -q '"success":true'; then
  echo -e "${GREEN}[PASS]${NC} POST /api/memories"
  PASS=$((PASS + 1))
else
  echo -e "${RED}[FAIL]${NC} POST /api/memories"
  echo "       响应: $CREATE_RESPONSE"
  FAIL=$((FAIL + 1))
fi

MEMORY_ID=$(extract_id "$CREATE_RESPONSE")
if [ -z "$MEMORY_ID" ]; then
  echo -e "${YELLOW}[WARN]${NC} 无法提取 memory id，后续依赖此 id 的用例将 SKIP"
fi

# 校验输入：空 text 应返回 400
run_test "POST /api/memories 空 text → 400" "400" "" \
  -X POST "$BASE_URL/api/memories" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":""}'

# 列出短期记忆
run_test "GET /api/memories?kind=short" "200" '"success":true' \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/memories?kind=short&limit=10"

# ── 统计 ──────────────────────────────────────────────────────────────────────
echo ""
echo "--- 统计 ---"

run_test "GET /api/stats" "200" '"success":true' \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/stats"

# ── 搜索（依赖 AI/Vector，501 记为 WARN）────────────────────────────────────
echo ""
echo "--- 搜索（依赖 AI/Vector，501 记为 WARN）---"

run_warn_test "POST /api/memories/search" "200,501" '"success"' \
  -X POST "$BASE_URL/api/memories/search" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"smoke test","topK":3}'

# ── Promote / Long-term ───────────────────────────────────────────────────────
echo ""
echo "--- Promote ---"

if [ -n "$MEMORY_ID" ]; then
  run_test "POST /api/memories/:id/promote" "200" '"success":true' \
    -X POST "$BASE_URL/api/memories/$MEMORY_ID/promote" \
    -H "Authorization: Bearer $TOKEN"

  run_test "GET /api/memories?kind=long (promoted 后应可见)" "200" '"success":true' \
    -H "Authorization: Bearer $TOKEN" \
    "$BASE_URL/api/memories?kind=long&limit=10"
else
  run_skip "POST /api/memories/:id/promote" "MEMORY_ID 未获取到"
  run_skip "GET /api/memories?kind=long (promoted 后应可见)" "MEMORY_ID 未获取到"
fi

# ── 删除 ──────────────────────────────────────────────────────────────────────
echo ""
echo "--- 删除 ---"

if [ -n "$MEMORY_ID" ]; then
  run_test "DELETE /api/memories/:id" "200" '"success":true' \
    -X DELETE "$BASE_URL/api/memories/$MEMORY_ID" \
    -H "Authorization: Bearer $TOKEN"
else
  run_skip "DELETE /api/memories/:id" "MEMORY_ID 未获取到"
fi

# ── Admin ─────────────────────────────────────────────────────────────────────
echo ""
echo "--- Admin ---"

# 普通 token 访问 admin 接口应返回 403（无论是否有 ADMIN_TOKEN 都验证此项）
run_test "POST /api/admin/reindex 普通 token → 403" "403" "" \
  -X POST "$BASE_URL/api/admin/reindex" \
  -H "Authorization: Bearer $TOKEN"

if [ -n "$ADMIN_TOKEN" ]; then
  run_test "POST /api/admin/reindex (admin token)" "200" '"success":true' \
    -X POST "$BASE_URL/api/admin/reindex" \
    -H "Authorization: Bearer $ADMIN_TOKEN"
else
  run_skip "POST /api/admin/reindex (admin token)" "ADMIN_TOKEN 未设置"
fi

# ── 汇总 ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "  结果汇总"
echo -e "  ${GREEN}PASS: $PASS${NC}  ${RED}FAIL: $FAIL${NC}  ${YELLOW}WARN: $WARN${NC}  ${BLUE}SKIP: $SKIP${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0

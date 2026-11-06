#!/usr/bin/env bash
# 一键回归：编译 src -> tests/.build，抽取前端算法，跑四套测试（交叉 / 契约 / 页面 / 文档）
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/tests/.build"
cd "$ROOT"
rm -rf "$OUT"
mkdir -p "$OUT"
npx tsc src/index.ts --outDir "$OUT" --target es2020 --module esnext --moduleResolution node --skipLibCheck || true   # Cloudflare 环境类型（KVNamespace / ExecutionContext）缺失是预期的，仍会产出 JS
sed -i "s|from \x27\./\([a-z]*\)\x27|from \x27./\1.js\x27|g" "$OUT"/*.js
cp tests/*.mjs "$OUT"/
REPO_ROOT="$ROOT" BUILD_DIR="$OUT" python3 tests/extract_front.py
node "$OUT/test_cross.mjs"
node "$OUT/test_stats.mjs"
node "$OUT/test_page_smoke.mjs"
node "$OUT/check_docs.mjs"

#!/bin/bash
# 看门狗：持续运行链家抓取，进程退出后自动重启，直到全部完成
TARGET=2896
DATA_FILE="data/raw/lianjia_ref_price_commute_targets.json"

get_count() {
  python3 -c "
import json
try:
    with open('$DATA_FILE', encoding='utf-8') as f:
        d = json.load(f)
    print(len(d.get('ref_prices', [])))
except:
    print(0)
" 2>/dev/null
}

echo "[watchdog] 目标: $TARGET 条"
count=$(get_count)
echo "[watchdog] 当前: $count 条"

while true; do
  count=$(get_count)
  echo "[watchdog] 当前: $count / $TARGET"

  if [ "$count" -ge "$TARGET" ]; then
    echo "[watchdog] 完成！共 $count 条"
    break
  fi

  echo "[watchdog] 启动抓取进程..."
  node scripts/fetch_lianjia_ref_price.mjs --input commute_targets --limit 0 --resume
  EXIT_CODE=$?

  count=$(get_count)
  echo "[watchdog] 进程退出(code=$EXIT_CODE)，已抓 $count 条"

  if [ "$count" -ge "$TARGET" ]; then
    echo "[watchdog] 完成！"
    break
  fi

  echo "[watchdog] 5秒后重启..."
  sleep 5
done

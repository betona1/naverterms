#!/usr/bin/env bash
# 상품등록정보검토 수집 배치 — 메모리 상한 래퍼.
#
# 왜: _diag_dispatch.py 가 로그인마다 python3 + Xvfb + Chrome(uc) 워커를 띄우는데,
#     워커당 ~4GB 라 CONC 가 크면 32GB 서버가 OOM 으로 하드 프리즈/재부팅됨 (2026-07-02 2회 다운).
# 대책: (1) 동시 워커수 DIAG_CONC(기본 2, 순차=1) 로 제한
#       (2) systemd --user scope 로 전체 프로세스 트리를 MemoryMax 로 캡 →
#           초과 시 서버 전체가 아니라 이 스코프만 cgroup-OOM 으로 정리됨.
#
# 사용:
#   ./run_diagnosis.sh                 # 전체 디스패치, 동시 2
#   ./run_diagnosis.sh redispatch      # 미수집분만 재수집, 동시 2
#   DIAG_CONC=1 ./run_diagnosis.sh     # 순차(1개씩)
#   DIAG_CONC=3 MEM_MAX=20G ./run_diagnosis.sh
set -euo pipefail

MODE="${1:-dispatch}"
case "$MODE" in
  dispatch)   SCRIPT=_diag_dispatch.py ;;
  redispatch) SCRIPT=_diag_redispatch.py ;;
  *) echo "usage: $0 [dispatch|redispatch]" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIAG_CONC="${DIAG_CONC:-2}"     # 동시 워커수 (순차=1)
MEM_HIGH="${MEM_HIGH:-14G}"     # 이 선부터 reclaim 압박 (소프트)
MEM_MAX="${MEM_MAX:-16G}"       # 하드 상한 — 초과 시 스코프 내부만 OOM
MEM_SWAP="${MEM_SWAP:-2G}"      # 스코프가 쓸 수 있는 스왑 상한

echo "[run_diagnosis] mode=$MODE CONC=$DIAG_CONC MemoryHigh=$MEM_HIGH MemoryMax=$MEM_MAX SwapMax=$MEM_SWAP"

exec systemd-run --user --scope --collect \
  --unit "naverterms-diag-$MODE" \
  -p MemoryHigh="$MEM_HIGH" \
  -p MemoryMax="$MEM_MAX" \
  -p MemorySwapMax="$MEM_SWAP" \
  env DIAG_CONC="$DIAG_CONC" python3 "$HERE/$SCRIPT"

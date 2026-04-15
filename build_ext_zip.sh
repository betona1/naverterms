#!/usr/bin/env bash
# build_ext_zip.sh — chrome-extension/ 를 zip으로 묶어서 frontend public/에 배포
#
# 사용법:
#   ./build_ext_zip.sh
#
# 결과:
#   /home/joacham/projects/ai100/viewer/gmarket_cpc/frontend/public/naver-extension-v<version>.zip
#   /home/joacham/projects/ai100/viewer/gmarket_cpc/frontend/public/naver-extension-latest.zip (심볼릭 링크)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$SCRIPT_DIR/chrome-extension"
PUBLIC_DIR="/home/joacham/projects/ai100/viewer/gmarket_cpc/frontend/public"

if [ ! -f "$EXT_DIR/manifest.json" ]; then
    echo "[X] manifest.json 없음: $EXT_DIR" >&2
    exit 1
fi
if [ ! -d "$PUBLIC_DIR" ]; then
    echo "[X] frontend public 디렉토리 없음: $PUBLIC_DIR" >&2
    exit 1
fi

# manifest.json의 version 추출
VERSION=$(python3 -c "import json; print(json.load(open('$EXT_DIR/manifest.json'))['version'])")
if [ -z "$VERSION" ]; then
    echo "[X] manifest.json에서 version을 읽을 수 없음" >&2
    exit 1
fi

ZIP_NAME="naver-extension-v${VERSION}.zip"
ZIP_PATH="$PUBLIC_DIR/$ZIP_NAME"
LATEST="$PUBLIC_DIR/naver-extension-latest.zip"

# 기존 zip 삭제
rm -f "$ZIP_PATH" "$LATEST"

# zip 생성 (chrome-extension 폴더 안쪽 내용만, 폴더명 자체는 포함 안 함)
# → 사용자가 압축해제하면 naver-extension-v2.0.0/ 폴더가 생기도록 폴더명 포함으로 변경
TMP_DIR=$(mktemp -d)
STAGE="$TMP_DIR/naver-extension-v${VERSION}"
cp -a "$EXT_DIR" "$STAGE"

# 불필요 파일 제거
find "$STAGE" -name '.DS_Store' -delete 2>/dev/null || true
find "$STAGE" -name '*.swp' -delete 2>/dev/null || true

(cd "$TMP_DIR" && zip -rq "$ZIP_PATH" "naver-extension-v${VERSION}")
rm -rf "$TMP_DIR"

# latest 링크
ln -sf "$ZIP_NAME" "$LATEST"

SIZE=$(du -h "$ZIP_PATH" | cut -f1)
echo "[OK] $ZIP_PATH ($SIZE)"
echo "[OK] $LATEST -> $ZIP_NAME"

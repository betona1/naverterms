#!/usr/bin/env bash
# build_ext_zip.sh — chrome-extension/ 를 zip으로 묶어서 frontend public/에 배포
#
# 사용법:
#   ./build_ext_zip.sh
#
# 결과:
#   frontend/public/downloads/naver-term-analyzer-v<version>.zip

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$SCRIPT_DIR/chrome-extension"
PUBLIC_DIR="$SCRIPT_DIR/frontend/public/downloads"

if [ ! -f "$EXT_DIR/manifest.json" ]; then
    echo "[X] manifest.json 없음: $EXT_DIR" >&2
    exit 1
fi
mkdir -p "$PUBLIC_DIR"

# manifest.json의 version 추출
VERSION=$(python3 -c "import json; print(json.load(open('$EXT_DIR/manifest.json'))['version'])")
if [ -z "$VERSION" ]; then
    echo "[X] manifest.json에서 version을 읽을 수 없음" >&2
    exit 1
fi

ZIP_NAME="naver-term-analyzer-v${VERSION}.zip"
ZIP_PATH="$PUBLIC_DIR/$ZIP_NAME"

# 기존 zip 삭제
rm -f "$ZIP_PATH"

# zip 생성
TMP_DIR=$(mktemp -d)
STAGE="$TMP_DIR/naver-term-analyzer-v${VERSION}"
cp -a "$EXT_DIR" "$STAGE"

# 불필요 파일 제거
find "$STAGE" -name '.DS_Store' -delete 2>/dev/null || true
find "$STAGE" -name '*.swp' -delete 2>/dev/null || true

(cd "$TMP_DIR" && zip -rq "$ZIP_PATH" "naver-term-analyzer-v${VERSION}")
rm -rf "$TMP_DIR"

SIZE=$(du -h "$ZIP_PATH" | cut -f1)
echo "[OK] $ZIP_PATH ($SIZE)"

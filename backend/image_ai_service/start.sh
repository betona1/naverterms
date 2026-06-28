#!/usr/bin/env bash
# Image AI FastAPI 서비스 실행 (port 8902).
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "❌ venv 없음. 먼저 ./setup.sh 실행"
  exit 1
fi

# 프로젝트 루트 .env 로드 (GEMINI_API_KEY 등)
ROOT_ENV=../../.env
if [ -f "$ROOT_ENV" ]; then
  set -a; . "$ROOT_ENV"; set +a
fi

. .venv/bin/activate
exec uvicorn main:app --host 0.0.0.0 --port 8902 --workers 1

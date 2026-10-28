#!/bin/bash
# macOS / Linux: 더블클릭(맥) 또는 터미널에서 ./start.command
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js가 필요해요. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요."
  (command -v open >/dev/null && open https://nodejs.org) || true
  read -r -p "엔터를 누르면 닫혀요" _
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "처음 실행이라 필요한 파일을 설치하고 있어요..."
  npm install --no-audit --no-fund || echo "설치에 실패했어요. AI 브리핑만 빼고는 그대로 동작해요."
fi
node server.js --open "$@"

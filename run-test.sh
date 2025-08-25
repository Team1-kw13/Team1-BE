#!/bin/bash

echo "=== WebSocket preprompt 테스트 스크립트 ==="
echo


# 간단한 연결 테스트 먼저 실행
echo "3. 간단한 연결 테스트..."
echo "-----------------------------------"
node test-simple.js

echo
echo "4. 상세한 preprompt 테스트..."
echo "-----------------------------------"
node test-preprompt.js

echo
echo "테스트 완료!"
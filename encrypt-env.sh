#!/bin/bash

if [ -z "$1" ]; then
  echo "사용법: ./encrypt-env.sh <암호>"
  exit 1
fi

openssl aes-256-cbc -e -in .env -out env.enc -pbkdf2 -k "$1"
echo "🔐 .env → env.enc 암호화 완료"

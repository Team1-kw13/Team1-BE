# PM2 자동 재시작 가이드

기존 npm scripts를 PM2 기반으로 변경했습니다.

## 🚀 설치 및 시작

### 1. PM2 설치 (전역)
```bash
npm install -g pm2
```

### 2. 서버 시작

```bash
npm start    # PM2로 운영 모드 실행 (자동 재시작)
npm run dev  # PM2로 개발 모드 실행 (watch + 자동 재시작)
```

## 🔧 관리 명령어

```bash
npm run status   # 상태 확인
npm run logs     # 로그 보기
npm run restart  # 재시작
npm run stop     # 정지
npm run delete   # 완전 삭제
```

## 📊 모니터링

### 실시간 모니터링
```bash
pm2 monit
```

### 로그 확인
```bash
# 실시간 로그
npm run logs

# 에러 로그만
pm2 logs sonju-api --err

# 파일로 저장된 로그  
tail -f logs/error.log
tail -f logs/out.log
```

## ⚙️ PM2 설정 (ecosystem.simple.config.js)

- **자동 재시작**: 크래시 시 3초 후 자동 재시작
- **메모리 제한**: 1GB 초과 시 재시작
- **최대 재시작**: 시간당 5회 제한
- **최소 실행 시간**: 10초
- **로그 관리**: `logs/` 디렉토리에 자동 저장

## 🔄 시스템 재부팅 시 자동 시작

```bash
# PM2 startup 설정
pm2 startup
pm2 save
```

## 🐳 Docker

기존 Dockerfile도 PM2 기반으로 변경됨:
```bash
docker build -t sonju-api .
docker run -p 3000:3000 --env-file .env sonju-api
```

## 🚨 트러블슈팅

### PM2 프로세스 정리
```bash
pm2 kill       # 모든 PM2 프로세스 종료
pm2 resurrect  # 저장된 프로세스 복구
```

---

**이제 기본적으로 PM2를 사용**하므로 크래시 시 자동으로 재시작됩니다!
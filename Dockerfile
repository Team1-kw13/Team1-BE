# 베이스 이미지
FROM node:18-alpine

# 작업 디렉토리 설정
WORKDIR /app

# 의존성 복사 및 설치
COPY package*.json ./
RUN npm install

# 앱 소스 복사
COPY . .

# 서버 포트 열기 (예: 3000)
EXPOSE 3000

# 앱 실행
CMD ["npm", "run", "dev"]

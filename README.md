# Sonju

노원구 민원 상담 AI 서비스의 백엔드 서버

## 📋 프로젝트 개요

노원구 주민들을 위한 AI 기반 민원 상담 서비스입니다. OpenAI Realtime API를 활용하여 음성 및 텍스트 기반의 실시간 대화형 상담을 제공합니다.

## 🚀 주요 기능

- **실시간 AI 대화**: OpenAI Realtime API를 통한 음성/텍스트 상담
- **민원 정보 검색**: RAG(Retrieval-Augmented Generation) 기반 동사무소, 행정 정보 검색
- **제안 질문**: 대화 맥락 기반 후속 질문 자동 생성
- **상담 요약**: 상담 내용 자동 요약 및 보고서 생성
- **WebSocket 통신**: 실시간 양방향 통신
- **위치 기반 서비스**: 사용자 위치 기반 주변 행정기관 정보 제공

## 🛠 기술 스택

- **Runtime**: Node.js
- **Framework**: Express.js
- **AI/ML**: OpenAI GPT-4o, Realtime API, Vector Store
- **실시간 통신**: WebSocket (ws)
- **문서 처리**: Puppeteer (HTML to Image)
- **프로세스 관리**: PM2
- **컨테이너**: Docker

## 📁 프로젝트 구조

```
Team1-BE/
├── config/           # 설정 파일
│   ├── cors.js      # CORS 설정
│   └── openai.js    # OpenAI 클라이언트 설정
├── service/         # 비즈니스 로직
│   ├── audioService.js      # 오디오 처리
│   ├── llmService.js        # LLM 통신 및 세션 관리
│   ├── ragService.js        # RAG 검색 서비스
│   ├── suggestionService.js # 제안 질문 생성
│   └── summaryService.js    # 상담 요약 생성
├── socket/          # WebSocket 통신
│   └── socket.js
├── index.js         # 메인 서버 파일
├── Dockerfile       # Docker 설정
└── docker-compose.yml
```

## ⚙️ 환경 설정

### 필요한 환경 변수

```bash
# OpenAI API
OPENAI_API_KEY=your_openai_api_key

# Vector Store IDs
VECTOR_STORE_DISTRICT_OFFICE=vs_xxx
VECTOR_STORE_FAQ=vs_xxx
```

### Docker로 실행

```bash
# 컨테이너 빌드 및 실행
docker-compose up -d

# 로그 확인
docker-compose logs -f
```

### 로컬 개발 환경

```bash
# 의존성 설치
npm install

# 개발 서버 실행 (with PM2 watch)
npm run dev

# 프로덕션 서버 실행
npm start
```

## 🌐 API 엔드포인트

### WebSocket

- `wss://sonju.duckdns.org/` - 실시간 음성/텍스트 상담

## 🔧 주요 서비스 설명

### LLMService

- OpenAI Realtime API와의 WebSocket 연결 관리
- 세션 기반 대화 상태 관리
- 함수 호출(Function Calling) 처리
- 동사무소 정보 자동 추출 및 전송

### RAGService

- OpenAI Vector Store를 이용한 의미 기반 검색
- 동사무소, FAQ 데이터 검색
- 위치 기반 검색 결과 우선순위 조정

### SuggestionService

- 대화 맥락을 분석하여 관련 질문 제안
- 노인 사용자를 고려한 자연스러운 질문 생성

### SummaryService

- 상담 내용을 구조화된 보고서로 요약
- HTML/이미지 형태의 보고서 생성
- Puppeteer를 이용한 이미지 변환

## 🧪 테스트 데이터

서비스의 음성 인식 및 대화 품질 검증을 위해 [AIHub 노인층 대상 음성 발화 데이터](https://www.aihub.or.kr/aihubdata/data/view.do?pageIndex=2&currMenu=&topMenu=&srchOptnCnd=OPTNCND001&searchKeyword=%EB%85%B8%EC%9D%B8&srchDetailCnd=DETAILCND001&srchOrder=ORDER001&srchPagePer=20&aihubDataSe=data&dataSetSn=107)를 활용하여 테스트를 진행했습니다.

- **데이터 출처**: AI Hub - 노인층 대상 음성 발화 데이터
- **테스트 목적**: 노인 사용자의 실제 발화 패턴 검증
- **검증 항목**: 음성 인식 정확도, 대화 이해도, 응답 적절성
- **WER**: 1.2%

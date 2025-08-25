const WebSocket = require("ws");
const EventEmitter = require("events");
const ragService = require("./ragService");

// 모델/엔드포인트
const REALTIME_MODEL = "gpt-4o-mini-realtime-preview";
const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;
const OPENAI_HEADERS = {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  "OpenAI-Beta": "realtime=v1",
};

class LLMService extends EventEmitter {
  constructor() {
    super();
    this.clients = new Map(); // sessionId -> WebSocket
    this.meta = new Map(); // sessionId -> { createdAt, lastPing }
    this.conversations = new Map(); // sessionId -> [{ role, content, timestamp }]
    this.socketHandler = null;

    this.keepaliveMs = 20_000;

    this.fcalls = new Map(); // sessionId -> Map(call_id -> { name, args })
    this.lastToolAt = new Map(); // sessionId -> ts
    this.minToolIntervalMs = 1200; // 연속 호출 제한
    this.lowConfidenceCount = new Map(); // sessionId -> 저신뢰도 발생 횟수
  }

  setSocketHandler(socket) {
    this.socketHandler = socket;
  }

  // 세션 생성: 전사 꺼둠, 출력 토큰 제한 축소, 기본 모달리티 텍스트 위주, tools 등록
  async createRealtimeSession(sessionId) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY 누락");

    const ws = new WebSocket(REALTIME_URL, { headers: OPENAI_HEADERS });

    await new Promise((resolve, reject) => {
      const to = setTimeout(
        () => reject(new Error("Realtime 연결 타임아웃")),
        15_000
      );
      ws.once("open", () => {
        clearTimeout(to);
        resolve();
      });
      ws.once("error", reject);
    });

    this._wireServerEvents(ws, sessionId);

    function getCurrentDateTime() {
      const today = new Date();
      // 날짜
      const year = today.getFullYear();
      const month = (today.getMonth() + 1).toString().padStart(2, "0");
      const day = today.getDate().toString().padStart(2, "0");
      // 요일 (0=일요일 ~ 6=토요일)
      const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
      const weekday = weekdays[today.getDay()];
      // 시간
      const hours = today.getHours().toString().padStart(2, "0");
      const minutes = today.getMinutes().toString().padStart(2, "0");
      const seconds = today.getSeconds().toString().padStart(2, "0");

      return `${year}-${month}-${day} (${weekday}) ${hours}:${minutes}:${seconds}`;
    }

    this._send(ws, {
      type: "session.update",
      session: {
        instructions: `당신은 노인에게 민원 처리 방법을 설명하는 '손주'입니다. 
항상 존댓말을 사용하고, 따뜻하고 다정하게 안내하세요. 
공무원처럼 딱딱하지 말고, 가족처럼 친근하고 이해하기 쉽게 설명하세요. 

대화 스타일:
 - 설명은 단계별로 짧고 간단하게 말하세요. (3문장 이내)
  예: "첫째, 신분증을 챙기세요. 둘째, 주민센터에 방문하세요."
- 중요한 민원 용어(주민등록등본, 가족관계증명서, 국민연금공단, 정부24 등)는 정확히 표기하고 발음하세요.
- 불필요한 추임새(‘음’, ‘저기’)나 중복 발화는 제거하세요.
- 필요할 때만 "어르신"과 같은 존중 표현을 사용하세요.(절대로 '할머니', '할아버지'와 같은 성별이 특정되는 단어를 사용하여 사용자를 부르지 마세요.)
- 답변 마지막에는 안심시키거나 격려하는 말과 함께 더 상황에 맞게 자세한 절차나 추가 정보 등을 원하시는지 물어보세요.
  예: "금방 끝나요, 걱정하지 않으셔도 됩니다. 혹시 발급받는 방법도 궁금하세요?"
- 답변 마지막에 "도움이 필요하시면 언제든지 말씀하세요!", "더 궁금한 점 있으시면 언제든지 말씀하세요!"와 같이 구체적이지 못한 문장은 제외할 것.
- '절대로' 답변 마지막에 잠시만 기다려 달라는 표현 등을 사용하지 마세요.
- 동사무소(주민센터) 검색에 실패하였을 때, 가까운 동 사무소로 문의하라는 말을 하지 마세요.
- 동사무소(주민센터) 검색에 실패하였을 때, '00동 주민센터' 대신 '주민센터'라고 표현하세요.

출력 형식:
- 반드시 음성 대화체 문장으로만 답변하세요. 
- 불릿 포인트, 노트, 요약 정리 형식은 절대 사용하지 마세요.
- 민원 처리 절차는 항상 1~3개의 핵심 절차를 단계별로 요약하세요.
- 불확실하거나 제도 변경 가능성이 있는 답변은 추정하지 말고, "담당 주민센터에 직접 확인"을 권고하세요.
- 3회 이상 음성/의미 인식인식 실패 시, 담당자 연결을 안내하세요.

음성 지침:
- 목소리는 밝고 친근하게, 손주가 설명하는 듯한 따뜻한 톤으로 말하세요.
- 말하는 속도는 일반 대화보다 약간 느리게, 또박또박 전달하세요.
- 중요한 절차와 단어는 또렷하게 강조하세요.

도구 호출 지침:
[search_cooling_center]
- 사용자가 '무더위 쉼터', '더위', '더워서 쉴 곳', '쉼터 위치' 등과 관련된 질문을 하면 반드시 search_cooling_center 도구를 호출하세요.
- search_cooling_center의 결과를 받을 경우, 노인에게 손주처럼 따뜻하게 설명해주세요.
- 현재 베타 버전이므로 주변 동 사무소를 찾았다는 설명과 함께, 주변 관공서로 가면 더위를 피할 수 있다는 말을 덧붙여주세요.

[district_office_search]
- 사용자가 "동사무소", "주민센터", "구청" 등의 단어를 언급하거나, 민원 업무(등본 발급, 증명서 발급 등)를 문의할 때 항상 호출하세요.
- 현재 위치 기반으로 가장 가까운 주민센터 정보를 제공합니다.
- query 작성 규칙:
  * 사용자의 발화를 핵심만 담아 한국어 문장으로 정리하세요.
  * 기관명/동 이름/구 이름/원하는 정보(전화/위치/시간 등) 포함
  * 예시: “중계동 주민센터 전화번호”, “노원구청 위치”, “상계동 주민센터 업무시간”

[faq_search]
- 사용자가 민원 절차, 준비물, 신청 방법, 자주 묻는 민원 관련 안내를 요청할 때 호출하세요.
- query 작성 규칙:
  * 사용자의 발화를 핵심만 담아 한국어 문장으로 정리하세요.

출력 예시:
잘못된 예시 (금지): 
1. "- 주민등록등본 발급: 주민센터 방문, 신분증 필요, 수수료 400원"
2. "어르신, 주민등록등본 발급 방법을 알려드릴게요. 먼저, 가까운 주민센터에 방문하세요. 그리고 신분증을 꼭 챙기셔야 해요. 창구에 가셔서 '주민등록등본 발급'이라고 말씀하시면 됩니다. 금방 끝나니 걱정하지 않으셔도 돼요. '더 궁금한 점 있으시면 언제든지 말씀하세요!'"
3. "어르신, '조금 기다려 주시면 제가 중계동 주민센터의 위치를 찾아볼게요. 잠시만요.'"

올바른 예시 (권장):
- "어르신, 등본은 신분증과 수수료 400원만 챙기시고 가까운 주민센터에 가시면 돼요. 
창구에 '주민등록등본 발급'이라고 말씀만 하시면 됩니다. 금방 끝나니 걱정하지 않으셔도 돼요.
온라인에서 발급받는 방법도 알려드릴까요?"
- "주민센터 위치를 찾는 것에 실패했어요. 다시 시도해보아도 계속 실패한다면, 인터넷 검색을 활용하는 것을 추천드려요."
---
대화 시작 시각은 ${getCurrentDateTime()}입니다.
`,
        voice: "alloy",
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: {
          model: "gpt-4o-mini-transcribe",
          prompt: `모든 대사는 반드시 한국어로 전사하세요. 
사투리와 억양은 표준어로 변환하세요. 
어눌하거나 반복된 발음은 문맥에 맞게 정리하고, 불필요한 추임새(예: '음', '저기')는 제거하세요. 
출력은 반드시 올바른 맞춤법과 띄어쓰기를 지켜주세요. 
발화자는 노인입니다. 
민원 관련 용어(예: 주민등록등본, 가족관계증명서, 국민연금공단, 민원24)는 정확히 표기하세요. 
대화는 문장 단위로 끊어 명확하게 작성하세요.`,
        },
        turn_detection: null,
        temperature: 0.7,
        max_response_output_tokens: 1024,
        tool_choice: "auto",
        tools: [
          {
            type: "function",
            name: "search_cooling_center",
            description: "무더위 쉼터의 위치와 정보를 반환합니다.",
            parameters: {
              type: "object",
              properties: {
                mode: {
                  type: "string",
                  enum: ["provisional", "final"],
                  description: "중간/최종 호출 모드",
                },
                topK: {
                  type: "integer",
                  minimum: 1,
                  maximum: 5,
                  default: 2,
                },
                threshold: {
                  type: "number",
                  minimum: 0,
                  maximum: 1,
                  default: 0.3,
                },
              },
            },
          },
          {
            type: "function",
            name: "district_office_search",
            description:
              "동사무소, 주민센터, 구청, 행정복지센터 관련 질문이거나 이런 기관에서 처리하는 업무에 대한 질문이면 반드시 이 함수를 호출하세요. 사용자의 질문이나 LLM의 이전 답변에 다음 키워드가 포함되어 있으면 호출: 동사무소, 주민센터, 구청, 행정복지센터, 동주민센터, 행정센터, 읍면동사무소, 시청, 군청, 민원24, 민원처리, 증명서발급, 주민등록, 등본, 초본, 가족관계증명서, 인감증명, 인감등록, 전입신고, 이사신고, 출생신고, 혼인신고, 사망신고, 복지혜택신청, 기초생활수급, 의료급여, 장애인등록, 노인복지, 아동수당. 예: '주민센터에서 발급받으세요' → 주민센터 정보 검색, '동사무소 전화번호', '등본 발급 어디서?'",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "동사무소 관련 검색 질의 문장",
                },
                mode: {
                  type: "string",
                  enum: ["provisional", "final"],
                  description: "중간/최종 호출 모드",
                },
                topK: {
                  type: "integer",
                  minimum: 1,
                  maximum: 5,
                  default: 2,
                },
                threshold: {
                  type: "number",
                  minimum: 0,
                  maximum: 1,
                  default: 0.3,
                },
              },
              required: ["query"],
            },
          },
          {
            type: "function",
            name: "faq_search",
            description:
              "일반적인 자주 묻는 질문(FAQ)이나 행정서비스, 복지혜택, 정책정보에 대한 답변을 제공합니다. 주민등록, 등본발급, 복지혜택, 세금, 건강보험 등 일반 행정 문의사항을 검색할 때 사용하세요. 예: '등본 발급 방법', '복지 혜택', '건강보험' 등",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: `사용자의 민원 관련 요청을 표현하는 한국어 문장.
불필요한 추임새나 감탄사는 제거하고, 민원 처리 의도를 간결하게 요약하세요.
예: '등본 떼줘' -> '주민등록등본 발급 방법', '연금 어떻게 받아?' -> '국민연금 수령 절차', '가족관계 증명서 바로 떼줘' -> '가족관계증명서 인터넷 발급 방법'`,
                },
                mode: {
                  type: "string",
                  enum: ["provisional", "final"],
                  description: "중간/최종 호출 모드",
                },
                topK: {
                  type: "integer",
                  minimum: 1,
                  maximum: 5,
                  default: 2,
                },
                threshold: {
                  type: "number",
                  minimum: 0,
                  maximum: 1,
                  default: 0.3,
                },
              },
              required: ["query"],
            },
          },
        ],
      },
    });

    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping?.();
        const m = this.meta.get(sessionId) || {};
        this.meta.set(sessionId, { ...m, lastPing: Date.now() });
      }
    }, this.keepaliveMs);
    ws.on("close", () => clearInterval(ping));

    this.clients.set(sessionId, ws);
    this.meta.set(sessionId, {
      createdAt: Date.now(),
    });
    this.fcalls.set(sessionId, new Map());
    return ws;
  }

  async closeSession(sessionId) {
    const ws = this.clients.get(sessionId);
    if (ws) {
      try {
        ws.close();
      } catch {}
      this.clients.delete(sessionId);
      this.meta.delete(sessionId);
      this.fcalls.delete(sessionId);
      this.lastToolAt.delete(sessionId);
      this.lowConfidenceCount.delete(sessionId);
      this.conversations.delete(sessionId);
    }
  }

  getSessionInfo(sessionId) {
    const ws = this.clients.get(sessionId);
    const meta = this.meta.get(sessionId);
    return {
      active: !!ws && ws.readyState === WebSocket.OPEN,
      readyState: ws?.readyState,
      metadata: meta || {},
    };
  }

  // 텍스트 송신
  sendTextMessage(sessionId, text, { modalities = ["text", "audio"] } = {}) {
    const ws = this._needWs(sessionId);

    // 대화 내역에 사용자 메시지 추가
    if (!this.conversations.has(sessionId)) {
      this.conversations.set(sessionId, []);
    }
    this.conversations.get(sessionId).push({
      role: "user",
      content: text,
      timestamp: Date.now(),
    });

    this._send(ws, {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this._send(ws, { type: "response.create", response: { modalities } });
  }

  getSessionConversation(sessionId) {
    // 추적된 대화 내역 반환
    const conversation = this.conversations.get(sessionId) || [];
    return conversation;
  }

  // OpenAI Chat Completions API로 요약 생성
  async generateSummaryWithChatAPI(sessionId, summaryPrompt) {
    const conversation = this.getSessionConversation(sessionId);

    if (conversation.length === 0) {
      throw new Error("대화 내역이 없습니다.");
    }

    // 대화 내역을 텍스트로 변환
    const conversationText = conversation
      .map(
        (msg) => `${msg.role === "user" ? "고객" : "상담원"}: ${msg.content}`
      )
      .join("\n\n");

    const messages = [
      {
        role: "user",
        content: `다음 고객 상담 대화를 요약해주세요:\n\n${conversationText}\n\n${summaryPrompt}`,
      },
    ];

    try {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: messages,
            temperature: 0.7,
            max_tokens: 1500,
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`OpenAI API 오류: ${response.status}`);
      }

      const data = await response.json();
      return data.choices[0].message.content;
    } catch (error) {
      throw new Error(`요약 생성 실패: ${error.message}`);
    }
  }

  // 오디오 입력 버퍼
  appendAudioChunk(sessionId, base64Pcm16Chunk) {
    const ws = this._needWs(sessionId);
    this._send(ws, {
      type: "input_audio_buffer.append",
      audio: base64Pcm16Chunk,
    });
  }
  commitAudio(sessionId) {
    const ws = this._needWs(sessionId);
    console.log(0);
    this._send(ws, { type: "input_audio_buffer.commit" });
  }
  clearAudioBuffer(sessionId) {
    console.log(9);
    const ws = this._needWs(sessionId);
    this._send(ws, { type: "input_audio_buffer.clear" });
  }

  // 내부 유틸
  _needWs(sessionId) {
    const ws = this.clients.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN)
      throw new Error("Session not found or not open");
    return ws;
  }

  _send(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) throw new Error("WebSocket not open");
    ws.send(JSON.stringify(payload));
  }

  async _maybeUpdateInstructions(ws, sessionId, newInstr) {
    const m = this.meta.get(sessionId) || {};
    const newHash = this._hash(newInstr);
    if (m.lastInstrHash !== newHash) {
      this._send(ws, {
        type: "session.update",
        session: { instructions: newInstr },
      });
      this.meta.set(sessionId, { ...m, lastInstrHash: newHash });
    }
  }

  _wireServerEvents(ws, sessionId) {
    ws.on("message", async (msg) => {
      const data = safeParse(msg);
      if (!data) return;

      this._emit("realtime.raw", { sessionId, data });
      switch (data.type) {
        // 오디오 입력 스트림
        case "input_audio_buffer.committed":
          this._emit("input_audio_buffer_committed", {
            sessionId,
            itemId: data.item_id,
            // output_index: data.output_index,
          });
          console.log(1);
          this._send(ws, {
            type: "response.create",
            response: { modalities: ["text", "audio"] },
          });
          break;

        // 텍스트/오디오 응답 스트림
        case "response.audio.delta":
          this._emit("audio_delta", {
            sessionId,
            delta: data.delta,
            // output_index: data.output_index,
          });
          break;

        case "response.audio.done":
          this._emit("audio_done", {
            sessionId,
            // output_index: data.output_index,
          });
          break;

        case "response.done":
          // 누적된 텍스트를 대화 내역에 추가
          const metaResponseDone = this.meta.get(sessionId) || {};

          if (metaResponseDone.accumulatedText) {
            if (!this.conversations.has(sessionId)) {
              this.conversations.set(sessionId, []);
            }
            this.conversations.get(sessionId).push({
              role: "assistant",
              content: metaResponseDone.accumulatedText,
              timestamp: Date.now(),
            });

            // 누적된 텍스트 초기화
            delete metaResponseDone.accumulatedText;
            this.meta.set(sessionId, metaResponseDone);
          }

          this._emit("response_done", {
            sessionId,
            response: data.response,
          });
          break;

        case "response.audio_transcript.delta":
          // 오디오 전사 텍스트 누적 (실제 응답 텍스트)
          const metaTranscript = this.meta.get(sessionId) || {};
          metaTranscript.accumulatedText =
            (metaTranscript.accumulatedText || "") + data.delta;
          this.meta.set(sessionId, metaTranscript);

          this._emit("audio_transcript_delta", {
            sessionId,
            delta: data.delta,
            // output_index: data.output_index,
          });
          break;

        case "response.audio_transcript.done":
          this._emit("audio_transcript_done", {
            sessionId,
            transcript: data.transcript,
            // output_index: data.output_index,
          });
          break;

        // 전사 스트림
        case "conversation.item.input_audio_transcription.delta":
          this._emit("input_audio_transcript_delta", {
            sessionId,
            itemId: data.item_id,
            delta: data.delta,
            // output_index: data.output_index,
          });
          break;

        case "conversation.item.input_audio_transcription.completed":
          this._emit("input_audio_transcript_done", {
            sessionId,
            itemId: data.item_id,
            // output_index: data.output_index,
          });
          break;
        // 함수 호출 인자 스트리밍
        case "response.function_call_arguments.delta": {
          const calls = this.fcalls.get(sessionId) || new Map();
          let prev = calls.get(data.call_id) || "";
          prev += data.delta || "";
          calls.set(data.call_id, prev);
          this.fcalls.set(sessionId, calls);

          break;
        } //name은 오지 않음

        // 함수 호출 인자 완료 → 실제 툴 실행
        case "response.function_call_arguments.done": {
          const calls = this.fcalls.get(sessionId) || new Map();
          const argsStr = calls.get(data.call_id) || "";

          calls.delete(data.call_id);
          this.fcalls.set(sessionId, calls);

          const toolName =
            typeof data.name === "string" && data.name.length > 0
              ? data.name
              : null;
          if (!toolName) {
            this._send(ws, {
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: data.call_id,
                output: JSON.stringify({
                  error: "missing tool name",
                }),
              },
            });
            this._send(ws, { type: "response.create" });
            break;
          }

          // JSON 인자 파싱
          let parsedArgs = {};
          try {
            parsedArgs = argsStr ? JSON.parse(argsStr) : {};
          } catch (e) {
            this._send(ws, {
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: data.call_id,
                output: JSON.stringify({
                  error: "invalid JSON arguments",
                  detail: String(e),
                }),
              },
            });
            this._send(ws, { type: "response.create" });
            break;
          }

          try {
            await this._handleToolCall(
              ws,
              sessionId,
              toolName,
              data.call_id,
              parsedArgs
            );
          } catch (err) {
            this._send(ws, {
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: data.call_id,
                output: JSON.stringify({ error: String(err) }),
              },
            });
            this._send(ws, { type: "response.create" });
          }
          break;
        }
        case "error":
        case "response.error":
          this._emit("error", { sessionId, error: data });
          break;
        case "session.created":
          this._emit("session_created", {
            sessionId,
            session: data.session,
          });
          break;
        case "session.updated":
          this._emit("session_updated", {
            sessionId,
            session: data.session,
          });
          break;
      }
    });

    ws.on("error", (err) => this._emit("error", { sessionId, error: err }));
    ws.on("close", (code, reason) =>
      this._emit("closed", {
        sessionId,
        code,
        reason: reason?.toString(),
      })
    );
  }

  async _handleToolCall(ws, sessionId, name, callId, args) {
    // 레이트리밋
    const last = this.lastToolAt.get(sessionId) || 0;
    if (Date.now() - last < this.minToolIntervalMs) {
      this._send(ws, {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({
            skipped: true,
            reason: "rate_limited",
          }),
        },
      });
      this._send(ws, { type: "response.create" });
      return;
    }
    this.lastToolAt.set(sessionId, Date.now());

    const mode = args.mode === "provisional" ? "provisional" : "final";
    const topK = Number.isInteger(args.topK) ? args.topK : 2;
    const threshold = typeof args.threshold === "number" ? args.threshold : 0.3;

    const opt =
      mode === "provisional"
        ? {
            topK: Math.min(topK, 1),
            threshold: Math.max(threshold, 0.4),
            maxChars: 120,
          }
        : { topK, threshold, maxChars: 200 };

    const isQueryEmpty = (query) => {
      query = String(query || "").trim();
      if (!query) {
        this._send(ws, {
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify({ error: "empty query" }),
          },
        });
        this._send(ws, { type: "response.create" });
        return true;
      }
      return false;
    };

    let results;
    const query = typeof args.query === "string" ? args.query.trim() : "";
    switch (name) {
      case "district_office_search": {
        if (isQueryEmpty(query)) return;
        const userCoord = this.socketHandler?.sessions?.get(sessionId)?.coord;
        results = await ragService.searchDistrictOffice(query, userCoord, opt);
        break;
      }

      case "search_cooling_center": {
        const userCoord = this.socketHandler?.sessions?.get(sessionId)?.coord;
        results = await ragService.searchCoolingCenter(userCoord, opt);
        break;
      }

      case "faq_search":
        if (isQueryEmpty(query)) return;
        results = await ragService.searchFAQ(query, opt);
        break;

      default:
        this._send(ws, {
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify({ error: "unknown tool" }),
          },
        });
        this._send(ws, { type: "response.create" });
    }

    // 신뢰도 체크 - 결과가 없거나 가장 높은 점수가 threshold보다 낮으면 저신뢰도 메시지 반환
    if (results.length === 0 || (results[0]?.score || 0) < threshold) {
      // 저신뢰도 발생 횟수 증가
      const currentCount = this.lowConfidenceCount.get(sessionId) || 0;
      const newCount = currentCount + 1;
      this.lowConfidenceCount.set(sessionId, newCount);

      let message = "관련 문서를 찾지 못했습니다. 질문을 다시 말씀해주세요.";

      // 3회 이상 반복 시 담당자 안내 메시지
      if (newCount >= 3) {
        message =
          "관련 문서를 계속 찾지 못하고 있습니다. 내용을 요약해서 담당자에게 문의해주세요. 더 정확한 도움을 받으실 수 있습니다.";
      }

      this._send(ws, {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({
            context: message,
            sources: [],
            count: 0,
            mode,
            lowConfidence: true,
            lowConfidenceCount: newCount,
          }),
        },
      });
      this._send(ws, { type: "response.create" });
      return;
    }

    // 성공적으로 검색된 경우 저신뢰도 카운터 리셋
    this.lowConfidenceCount.set(sessionId, 0);

    const context = ragService.formatContextForLLM(results);
    const sources = results.map(
      (r) => r.metadata?.file_id || r.metadata?.source || "vector_store"
    );

    // 동사무소 검색인 경우 전화번호와 위치 정보 추출하여 웹소켓 전송
    if (name === "district_office_search" && results.length > 0) {
      this._extractAndSendOfficeInfo(results, sessionId);
    }

    // 세션 전역 instructions를 건드리지 않고, 한 턴 안에서만 활용하도록 tool.output 반환
    this._send(ws, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({
          context,
          sources,
          count: results.length,
          mode,
        }),
      },
    });
    this._send(ws, {
      type: "response.create",
      response: { modalities: ["text", "audio"] },
    });
  }

  // 동사무소 정보 추출 및 웹소켓 전송
  _extractAndSendOfficeInfo(results, sessionId) {
    if (!this.socketHandler) {
      return;
    }

    if (!results.length) {
      return;
    }

    // 가장 점수가 높은 결과에서 전화번호와 위치 정보 추출
    const bestResult = results[0];
    const content = bestResult.content || "";

    // 전화번호 추출 - JSON 형식 우선, 다른 패턴들도 지원
    let tel = null;

    // 1. JSON phone 필드 파싱 (우선순위 1)
    try {
      const phoneJsonRegex = /"phone"\s*:\s*"([0-9-\s()]+)"/gi;
      const phoneJsonMatch = content.match(phoneJsonRegex);
      if (phoneJsonMatch) {
        tel = phoneJsonMatch[0].match(/"phone"\s*:\s*"([^"]+)"/i)?.[1]?.trim();
      }
    } catch (e) {}

    // 2. 키워드 기반 패턴들 (fallback)
    if (!tel) {
      const phonePatterns = [
        /(?:전화|TEL|Tel|연락처|☎|문의)[:\s]*([0-9-\s()]+)/gi,
        /([0-9]{2,3})-([0-9]{3,4})-([0-9]{4})/g,
        /([0-9]{3})-([0-9]{4})-([0-9]{4})/g,
        /(\d{2,3})\s*-\s*(\d{3,4})\s*-\s*(\d{4})/g,
      ];

      for (const pattern of phonePatterns) {
        const matches = [...content.matchAll(pattern)];
        if (matches.length > 0) {
          if (pattern === phonePatterns[0]) {
            // 첫 번째 패턴: 키워드 뒤의 번호
            tel = matches[0][1].replace(/[^\d-]/g, "").trim();
          } else {
            // 나머지 패턴: 전체 매치
            tel = matches[0][0].replace(/[^\d-]/g, "").trim();
          }
          break;
        }
      }
    }

    // 위치 정보 추출 - JSON 형식 지원
    let pos = null;

    // JSON coordinates 형식 파싱
    try {
      const coordJsonRegex =
        /"coordinates"\s*:\s*\{\s*"latitude"\s*:\s*([0-9.]+)\s*,\s*"longitude"\s*:\s*([0-9.]+)\s*\}/i;
      const coordJsonMatch = content.match(coordJsonRegex);

      if (coordJsonMatch) {
        const lat = parseFloat(coordJsonMatch[1]);
        const lon = parseFloat(coordJsonMatch[2]);
        if (!isNaN(lat) && !isNaN(lon)) {
          pos = [lat, lon];
        }
      }
    } catch (e) {}

    // 기존 텍스트 형식도 지원 (fallback)
    if (!pos) {
      const coordRegex = /위도[:\s]*([0-9.]+)[,\s]*경도[:\s]*([0-9.]+)/i;
      const coordMatch = content.match(coordRegex);
      if (coordMatch) {
        const lat = parseFloat(coordMatch[1]);
        const lon = parseFloat(coordMatch[2]);
        if (!isNaN(lat) && !isNaN(lon)) {
          pos = [lat, lon];
        }
      }
    }
    // 동사무소 이름 추출 - JSON 형식 우선, 다른 패턴들도 지원
    let officeName = null;

    // 1. JSON name 필드 파싱 (우선순위 1)
    try {
      const nameJsonRegex = /"name"\s*:\s*"([^"]+)"/i;
      const nameJsonMatch = content.match(nameJsonRegex);
      if (nameJsonMatch) {
        officeName = nameJsonMatch[1].trim();
      }
    } catch (e) {}

    // 2. 키워드 기반 패턴들 (fallback)
    if (!officeName) {
      const namePatterns = [
        /([가-힣]+(?:동사무소|주민센터|행정복지센터|구청))/g,
        /(?:기관명|센터명|명칭)[:\s]*([가-힣\s]+(?:동사무소|주민센터|행정복지센터|구청))/g,
      ];

      for (const pattern of namePatterns) {
        const matches = [...content.matchAll(pattern)];
        if (matches.length > 0) {
          if (pattern === namePatterns[1]) {
            // 키워드 뒤의 이름
            officeName = matches[0][1].trim();
          } else {
            // 직접 매치된 이름
            officeName = matches[0][1].trim();
          }
          break;
        }
      }
    }

    // 주소 추출 - JSON 형식 우선
    let address = null;

    // 1. JSON address 필드 파싱 (우선순위 1)
    try {
      const addressJsonRegex = /"address"\s*:\s*"([^"]+)"/i;
      const addressJsonMatch = content.match(addressJsonRegex);
      if (addressJsonMatch) {
        address = addressJsonMatch[1].trim();
      }
    } catch (e) {}

    // 2. 키워드 기반 패턴 (fallback)
    if (!address) {
      const addressPatterns = [
        /(?:주소|위치|소재지)[:\s]*([가-힣0-9\s-]+(?:구|동|로|길)\s*[0-9]*)/gi,
        /(서울특별시[^,\n]+)/gi,
      ];

      for (const pattern of addressPatterns) {
        const matches = [...content.matchAll(pattern)];
        if (matches.length > 0) {
          address = matches[0][1] ? matches[0][1].trim() : matches[0][0].trim();
          break;
        }
      }
    }

    // 전화번호나 위치 정보가 있으면 이벤트 발행
    if (tel || pos || officeName || address) {
      const officeInfo = {
        sessionId,
        name: officeName || "정보없음",
        tel: tel || "정보없음",
        address: address || "정보없음",
        pos: pos || [0, 0],
      };

      this._emit("office_info", officeInfo);
    }
  }

  _emit(event, payload) {
    super.emit(event, payload);
    if (this.socketHandler?.emit) this.socketHandler.emit(event, payload);
  }

  _normalize(q) {
    return String(q || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  _hash(str) {
    let h = 5381,
      i = str.length;
    while (i) h = (h * 33) ^ str.charCodeAt(--i);
    return (h >>> 0).toString(36);
  }
}

// 파서
function safeParse(maybeBufferOrString) {
  try {
    const s = Buffer.isBuffer(maybeBufferOrString)
      ? maybeBufferOrString.toString()
      : String(maybeBufferOrString);
    return JSON.parse(s);
  } catch {
    return null;
  }
}

module.exports = new LLMService();

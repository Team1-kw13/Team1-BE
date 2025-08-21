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
        this.meta = new Map(); // sessionId -> { paused, createdAt, lastPing, lastInstrHash }
        this.conversations = new Map(); // sessionId -> [{ role, content, timestamp }]
        this.socketHandler = null;
        this.ragCache = new Map(); // sessionId -> { query, ragContext, sources, ts }

        this.maxRagChars = 1200;
        this.keepaliveMs = 20_000;
        this.ragCacheMs = 5 * 60_000;

        this.fcalls = new Map(); // sessionId -> Map(call_id -> { name, args })
        this.lastToolAt = new Map(); // sessionId -> ts
        this.minToolIntervalMs = 1200; // 연속 호출 제한
        this.lowConfidenceCount = new Map(); // sessionId -> 저신뢰도 발생 횟수
    }

    setSocketHandler(socket) {
        this.socketHandler = socket;
    }

    // 세션 생성: 전사 꺼둠, 출력 토큰 제한 축소, 기본 모달리티 텍스트 위주, tools 등록
    async createRealtimeSession(
        sessionId,
        sessionContext = "",
        audioContext = ""
    ) {
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

        const baseInstructions = this._buildSystemPrompt(
            "",
            sessionContext,
            audioContext
        );

        this._send(ws, {
            type: "session.update",
            session: {
                instructions: baseInstructions,
                voice: "alloy",
                input_audio_format: "pcm16",
                output_audio_format: "pcm16",
                input_audio_transcription: { model: "whisper-1" },
                turn_detection: null,
                temperature: 0.7,
                max_response_output_tokens: 350,
                tool_choice: "auto",
                tools: [
                    {
                        type: "function",
                        name: "district_office_search",
                        description:
                            "동사무소, 주민센터, 구청, 행정복지센터와 관련된 모든 질문에 답변합니다. 전화번호, 주소, 위치, 업무시간, 민원업무, 증명서 발급 등 행정기관 정보를 검색할 때 사용하세요. 예: '노원구 동사무소', '주민센터 전화번호', '구청 위치', '민원 처리' 등",
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
                                    description: "FAQ 관련 검색 질의 문장",
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
            paused: false,
            lastInstrHash: this._hash(baseInstructions),
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
                (msg) =>
                    `${msg.role === "user" ? "고객" : "상담원"}: ${msg.content}`
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
    commitAudioAndCreateResponse(
        sessionId,
        { modalities = ["text", "audio"] } = {}
    ) {
        const ws = this._needWs(sessionId);
        this._send(ws, { type: "input_audio_buffer.commit" });
        this._send(ws, { type: "response.create", response: { modalities } });
    }
    clearAudioBuffer(sessionId) {
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
        if (ws.readyState !== WebSocket.OPEN)
            throw new Error("WebSocket not open");
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
                    break;

                // 텍스트/오디오 응답 스트림
                case "response.text.delta":
                    // 세션별 텍스트 누적
                    const meta = this.meta.get(sessionId) || {};
                    meta.accumulatedText =
                        (meta.accumulatedText || "") + data.delta;
                    this.meta.set(sessionId, meta);
                    // 일반 대화 응답
                    this._emit("text_delta", {
                        sessionId,
                        delta: data.delta,
                        // output_index: data.output_index,
                    });
                    break;

                case "response.text.done":
                    // 누적된 텍스트를 대화 내역에 추가
                    const metaDone = this.meta.get(sessionId) || {};
                    if (metaDone.accumulatedText) {
                        if (!this.conversations.has(sessionId)) {
                            this.conversations.set(sessionId, []);
                        }
                        this.conversations.get(sessionId).push({
                            role: "assistant",
                            content: metaDone.accumulatedText,
                            timestamp: Date.now(),
                        });
                    }

                    // 누적된 텍스트 초기화
                    delete metaDone.accumulatedText;
                    this.meta.set(sessionId, metaDone);

                    this._emit("text_done", {
                        sessionId,
                        // output_index: data.output_index,
                    });
                    break;

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
                    this._emit("response_done", {
                        sessionId,
                        response: data.response,
                    });
                    break;

                case "response.audio_transcript.delta":
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

        if (name !== "district_office_search" && name !== "faq_search") {
            this._send(ws, {
                type: "conversation.item.create",
                item: {
                    type: "function_call_output",
                    call_id: callId,
                    output: JSON.stringify({ error: "unknown tool" }),
                },
            });
            this._send(ws, { type: "response.create" });
            return;
        }

        const query = String(args.query || "").trim();
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
            return;
        }

        const mode = args.mode === "provisional" ? "provisional" : "final";
        const topK = Number.isInteger(args.topK) ? args.topK : 2;
        const threshold =
            typeof args.threshold === "number" ? args.threshold : 0.3;

        const opt =
            mode === "provisional"
                ? {
                      topK: Math.min(topK, 1),
                      threshold: Math.max(threshold, 0.4),
                      maxChars: 120,
                  }
                : { topK, threshold, maxChars: 200 };

        let results;
        if (name === "district_office_search") {
            // 사용자 위치 정보 가져오기
            const userCoord =
                this.socketHandler?.sessions?.get(sessionId)?.coord;
            results = await ragService.searchDistrictOffice(
                query,
                userCoord,
                opt
            );
        } else if (name === "faq_search") {
            results = await ragService.searchFAQ(query, opt);
        }

        // 신뢰도 체크 - 결과가 없거나 가장 높은 점수가 threshold보다 낮으면 저신뢰도 메시지 반환
        if (results.length === 0 || (results[0]?.score || 0) < threshold) {
            // 저신뢰도 발생 횟수 증가
            const currentCount = this.lowConfidenceCount.get(sessionId) || 0;
            const newCount = currentCount + 1;
            this.lowConfidenceCount.set(sessionId, newCount);

            let message =
                "관련 문서를 찾지 못했습니다. 질문을 다시 말씀해주세요.";

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

        // 전화번호 추출 - 더 포괄적인 패턴들
        const phonePatterns = [
            /(?:전화|TEL|Tel|연락처|☎|문의)[:\s]*([0-9-\s()]+)/gi,
            /([0-9]{2,3})-([0-9]{3,4})-([0-9]{4})/g,
            /([0-9]{3})-([0-9]{4})-([0-9]{4})/g,
            /(\d{2,3})\s*-\s*(\d{3,4})\s*-\s*(\d{4})/g,
        ];

        let tel = null;
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

        // 전화번호나 위치 정보가 있으면 이벤트 발행
        if (tel || pos) {
            const officeInfo = {
                sessionId,
                tel: tel || "정보없음",
                pos: pos || [0, 0],
            };

            this._emit("office_info", officeInfo);
        }
    }

    _emit(event, payload) {
        super.emit(event, payload);
        if (this.socketHandler?.emit) this.socketHandler.emit(event, payload);
    }

    _truncate(s, max = this.maxRagChars) {
        if (!s) return s;
        return s.length > max ? s.slice(0, max) + "...(truncated)" : s;
    }

    _buildSystemPrompt(ragContext, sessionContext, audioContext) {
        const rag = this._truncate(ragContext || "");
        let p = `당신은 행정복지 전문 AI 어시스턴트입니다. 사용자의 질문에 정확하고 도움이 되는 답변을 제공하세요.

**도구 사용 지침:**
- 동사무소, 주민센터, 구청, 행정기관 관련 질문 → district_office_search 사용
- 일반 행정서비스, 복지, 정책, FAQ 관련 질문 → faq_search 사용
- 위치나 전화번호를 묻는다면 반드시 관련 검색 도구를 사용하세요

관련 문서:\n${rag || "(없음)"}`;

        if (sessionContext) p += `\n\n세션 컨텍스트:\n${sessionContext}`;
        if (audioContext) p += `\n\n오디오 컨텍스트:\n${audioContext}`;

        p += `\n\n답변 원칙:
1) 관련 질문에는 먼저 적절한 검색 도구를 사용해서 정확한 정보를 찾으세요
2) 검색 결과를 바탕으로 정확하고 친근한 답변을 제공하세요
3) 검색 도구 사용 후에는 반드시 사용자에게 도움이 되는 답변을 추가로 제공하세요
4) 출처를 명시하고 불확실한 경우 추정하지 마세요`;

        return p;
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

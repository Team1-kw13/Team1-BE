const WebSocket = require("ws");
const EventEmitter = require("events");
const ragService = require("./ragService");

// 모델/엔드포인트
const REALTIME_MODEL = "gpt-4o-realtime-preview-2024-12-17";
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
                        name: "rag_search",
                        description:
                            "사용자 발화에서 필요한 경우 관련 문서를 검색해 간결한 컨텍스트를 제공한다.",
                        parameters: {
                            type: "object",
                            properties: {
                                query: {
                                    type: "string",
                                    description: "검색 질의 문장",
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
    sendTextMessage(sessionId, text, { modalities = ["text"] } = {}) {
        const ws = this._needWs(sessionId);
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

    sendTextMessageWithResponse(sessionId, text) {
        const ws = this._needWs(sessionId);
        return new Promise((resolve, reject) => {
            let acc = "";

            const onDelta = (e) => {
                const data = safeParse(e);
                if (
                    data?.type === "response.text.delta" &&
                    typeof data.delta === "string"
                )
                    acc += data.delta;
            };
            const onDone = (e) => {
                const data = safeParse(e);
                if (data?.type === "response.done") {
                    ws.off?.("message", onDelta);
                    ws.off?.("message", onDone);
                    ws.off?.("message", onErrorEvt);
                    resolve({ text: acc, raw: data });
                }
            };
            const onErrorEvt = (e) => {
                const data = safeParse(e);
                if (data?.type === "error" || data?.type === "response.error") {
                    ws.off?.("message", onDelta);
                    ws.off?.("message", onDone);
                    ws.off?.("message", onErrorEvt);
                    reject(new Error(data?.message || "realtime error"));
                }
            };

            ws.on("message", onDelta);
            ws.on("message", onDone);
            ws.on("message", onErrorEvt);

            this.sendTextMessage(sessionId, text, { modalities: ["text"] });
        });
    }

    // 오디오 입력 버퍼
    appendAudioChunk(sessionId, base64Pcm16Chunk) {
        const ws = this._needWs(sessionId);
        this._send(ws, {
            type: "input_audio_buffer.append",
            audio: base64Pcm16Chunk,
        });
    }
    commitAudioAndCreateResponse(sessionId, { modalities = ["text"] } = {}) {
        const ws = this._needWs(sessionId);
        this._send(ws, { type: "input_audio_buffer.commit" });
        this._send(ws, { type: "response.create", response: { modalities } });
    }
    clearAudioBuffer(sessionId) {
        const ws = this._needWs(sessionId);
        this._send(ws, { type: "input_audio_buffer.clear" });
    }

    // RAG: 컨텍스트 축소, 캐시 5분, 동일 instructions면 업데이트 생략
    // async updateSessionWithRAG(
    //     sessionId,
    //     query,
    //     sessionContext = "",
    //     audioContext = ""
    // ) {
    //     const ws = this._needWs(sessionId);
    //     const normQuery = this._normalize(query);

    //     const cached = this.ragCache.get(sessionId);
    //     if (
    //         cached &&
    //         cached.query === normQuery &&
    //         Date.now() - cached.ts < this.ragCacheMs
    //     ) {
    //         const newInstr = this._buildSystemPrompt(
    //             cached.ragContext,
    //             sessionContext,
    //             audioContext
    //         );
    //         await this._maybeUpdateInstructions(ws, sessionId, newInstr);
    //         return { ragContext: cached.ragContext, sources: cached.sources };
    //     }

    //     const results = await ragService.searchVectorDB(normQuery, {
    //         topK: 2,
    //         threshold: 0.3,
    //         maxChars: 200,
    //     });
    //     const ragContext = ragService.formatContextForLLM(results);
    //     const sources = results.map(
    //         (r) => r.metadata?.file_id || r.metadata?.source || "vector_store"
    //     );

    //     this.ragCache.set(sessionId, {
    //         query: normQuery,
    //         ragContext,
    //         sources,
    //         ts: Date.now(),
    //     });

    //     const newInstr = this._buildSystemPrompt(
    //         ragContext,
    //         sessionContext,
    //         audioContext
    //     );
    //     await this._maybeUpdateInstructions(ws, sessionId, newInstr);

    //     return { ragContext, sources };
    // }

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

            // 텍스트/오디오 응답 스트림
            if (data.type === "response.text.delta")
                this._emit("text_delta", {
                    sessionId,
                    delta: data.delta,
                    output_index: data.output_index,
                });
            if (data.type === "response.text.done")
                this._emit("text_done", {
                    sessionId,
                    output_index: data.output_index,
                });
            if (data.type === "response.audio.delta")
                this._emit("audio_delta", {
                    sessionId,
                    delta: data.delta,
                    output_index: data.output_index,
                });
            if (data.type === "response.audio.done")
                this._emit("audio_done", {
                    sessionId,
                    output_index: data.output_index,
                });
            if (data.type === "response.done")
                this._emit("response_done", {
                    sessionId,
                    response: data.response,
                });

            // 전사 스트림
            if (data.type === "response.audio_transcript.delta")
                this._emit("audio_transcript_delta", {
                    sessionId,
                    delta: data.delta,
                    output_index: data.output_index,
                });
            if (data.type === "response.audio_transcript.done")
                this._emit("audio_transcript_done", {
                    sessionId,
                    transcript: data.transcript,
                    output_index: data.output_index,
                });

            // 함수 호출 인자 스트리밍
            if (data.type === "response.function_call.arguments.delta") {
                const calls = this.fcalls.get(sessionId) || new Map();
                const prev = calls.get(data.call_id) || {
                    name: data.name,
                    args: "",
                };
                prev.args += data.delta || "";
                calls.set(data.call_id, prev);
                this.fcalls.set(sessionId, calls);
                return;
            }

            // 함수 호출 인자 완료 → 실제 툴 실행
            if (data.type === "response.function_call.arguments.done") {
                const calls = this.fcalls.get(sessionId) || new Map();
                const info = calls.get(data.call_id);
                if (!info) return;
                let args = {};
                try {
                    args = info.args ? JSON.parse(info.args) : {};
                } catch {}
                calls.delete(data.call_id);
                this.fcalls.set(sessionId, calls);

                try {
                    await this._handleToolCall(
                        ws,
                        sessionId,
                        info.name,
                        data.call_id,
                        args
                    );
                } catch (err) {
                    this._send(ws, {
                        type: "tool.output",
                        tool_call_id: data.call_id,
                        output: JSON.stringify({ error: String(err) }),
                    });
                }
                return;
            }

            if (data.type === "error" || data.type === "response.error")
                this._emit("error", { sessionId, error: data });
            if (data.type === "session.created")
                this._emit("session_created", {
                    sessionId,
                    session: data.session,
                });
            if (data.type === "session.updated")
                this._emit("session_updated", {
                    sessionId,
                    session: data.session,
                });
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
                type: "tool.output",
                tool_call_id: callId,
                output: JSON.stringify({
                    skipped: true,
                    reason: "rate_limited",
                }),
            });
            return;
        }
        this.lastToolAt.set(sessionId, Date.now());

        if (name !== "rag_search") {
            this._send(ws, {
                type: "tool.output",
                tool_call_id: callId,
                output: JSON.stringify({ error: "unknown tool" }),
            });
            return;
        }

        const query = String(args.query || "").trim();
        if (!query) {
            this._send(ws, {
                type: "tool.output",
                tool_call_id: callId,
                output: JSON.stringify({ error: "empty query" }),
            });
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

        const results = await ragService.searchVectorDB(query, opt);

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
                type: "tool.output",
                tool_call_id: callId,
                output: JSON.stringify({
                    context: message,
                    sources: [],
                    count: 0,
                    mode,
                    lowConfidence: true,
                    lowConfidenceCount: newCount,
                }),
            });
            return;
        }

        // 성공적으로 검색된 경우 저신뢰도 카운터 리셋
        this.lowConfidenceCount.set(sessionId, 0);

        const context = ragService.formatContextForLLM(results);
        const sources = results.map(
            (r) => r.metadata?.file_id || r.metadata?.source || "vector_store"
        );

        // 세션 전역 instructions를 건드리지 않고, 한 턴 안에서만 활용하도록 tool.output 반환
        this._send(ws, {
            type: "tool.output",
            tool_call_id: callId,
            output: JSON.stringify({
                context,
                sources,
                count: results.length,
                mode,
            }),
        });
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
        let p = `당신은 도움이 되는 AI 어시스턴트입니다. 제공된 컨텍스트를 활용해 정확하고 간결하게 답변하세요.\n\n관련 문서:\n${
            rag || "(없음)"
        }`;
        if (sessionContext) p += `\n\n세션 컨텍스트:\n${sessionContext}`;
        if (audioContext) p += `\n\n오디오 컨텍스트:\n${audioContext}`;
        p += `\n\n유의사항:\n1) 문서 기반으로 답하되 부족하면 상식으로 보완 2) 출처를 간단히 표기 3) 불확실하면 추정 금지`;
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

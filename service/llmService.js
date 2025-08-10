const WebSocket = require("ws");
const EventEmitter = require("events");
const ragService = require("./ragService");

// 실서비스용: 최신 리얼타임 모델로 교체 가능
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
        this.meta = new Map(); // sessionId -> { paused, createdAt, lastPing }
        this.socketHandler = null; // 외부 WS로 이벤트 중계
        this.ragCache = new Map(); // sessionId -> { query, ragContext, sources, ts }
        this.maxRagChars = 3000;
        this.keepaliveMs = 20_000; // ping 주기
    }

    // ---------- 공용 훅 ----------
    setSocketHandler(socket) {
        this.socketHandler = socket;
    }

    // ---------- 세션 ----------
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
                turn_detection: { type: "server_vad" },
                temperature: 0.7,
                max_response_output_tokens: 1000,
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
        this.meta.set(sessionId, { createdAt: Date.now(), paused: false });
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

    pauseSession(sessionId) {
        const ws = this._needWs(sessionId);
        this._send(ws, {
            type: "session.update",
            session: { input_audio_transcription: null, turn_detection: null },
        });
        const m = this.meta.get(sessionId) || {};
        this.meta.set(sessionId, { ...m, paused: true });
    }

    resumeSession(sessionId) {
        const ws = this._needWs(sessionId);
        this._send(ws, {
            type: "session.update",
            session: {
                input_audio_transcription: { model: "whisper-1" },
                turn_detection: { type: "server_vad" },
            },
        });
        const m = this.meta.get(sessionId) || {};
        this.meta.set(sessionId, { ...m, paused: false });
    }

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
                if (data?.type === "response.text.delta") {
                    if (typeof data.delta === "string") acc += data.delta;
                }
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

    // ---------- 오디오 ----------
    // 음성 한 방에!!
    sendFullAudioMessage(
        sessionId,
        base64Audio,
        { modalities = ["audio", "text"] } = {}
    ) {
        const ws = this._needWs(sessionId);
        this._send(ws, {
            type: "conversation.item.create",
            item: {
                type: "message",
                role: "user",
                content: [{ type: "input_audio", audio: base64Audio }],
            },
        });
        this._send(ws, { type: "response.create", response: { modalities } });
    }

    // 스트리밍(append/commit) 경로
    appendAudioChunk(sessionId, base64Pcm16Chunk) {
        const ws = this._needWs(sessionId);
        this._send(ws, {
            type: "input_audio_buffer.append",
            audio: base64Pcm16Chunk,
        });
    }
    commitAudioAndCreateResponse(
        sessionId,
        { modalities = ["audio", "text"] } = {}
    ) {
        const ws = this._needWs(sessionId);
        this._send(ws, { type: "input_audio_buffer.commit" });
        this._send(ws, { type: "response.create", response: { modalities } });
    }
    clearAudioBuffer(sessionId) {
        const ws = this._needWs(sessionId);
        this._send(ws, { type: "input_audio_buffer.clear" });
    }

    // ---------- RAG ----------
    async updateSessionWithRAG(
        sessionId,
        query,
        sessionContext = "",
        audioContext = ""
    ) {
        const ws = this._needWs(sessionId);

        // 1분 캐시
        const cached = this.ragCache.get(sessionId);
        if (
            cached &&
            cached.query === query &&
            Date.now() - cached.ts < 60_000
        ) {
            this._send(ws, {
                type: "session.update",
                session: {
                    instructions: this._buildSystemPrompt(
                        cached.ragContext,
                        sessionContext,
                        audioContext
                    ),
                },
            });
            return { ragContext: cached.ragContext, sources: cached.sources };
        }

        const results = await ragService.searchVectorDB(query);
        const ragContext = ragService.formatContextForLLM(results);
        const sources = results.map(
            (r) => r.metadata?.file_id || r.metadata?.source || "vector_store"
        );

        this.ragCache.set(sessionId, {
            query,
            ragContext,
            sources,
            ts: Date.now(),
        });

        this._send(ws, {
            type: "session.update",
            session: {
                instructions: this._buildSystemPrompt(
                    ragContext,
                    sessionContext,
                    audioContext
                ),
            },
        });

        return { ragContext, sources };
    }

    // ---------- 내부 유틸 ----------
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

    _wireServerEvents(ws, sessionId) {
        ws.on("message", (msg) => {
            const data = safeParse(msg);
            if (!data) return;

            // 원본 이벤트 그대로도 중계
            this._emit("realtime.raw", { sessionId, data });

            // 텍스트/오디오 델타, 완료, 전사 등 주요 이벤트 축약 중계
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

    _emit(event, payload) {
        super.emit(event, payload);
        if (this.socketHandler?.emit) {
            this.socketHandler.emit(event, payload);
        }
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

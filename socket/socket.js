const { Server: WebSocketServer } = require("ws");
const llmService = require("../service/llmService");
const audioService = require("../service/audioService");
const summaryService = require("../service/summaryService");

function safeParse(m) {
    try {
        return JSON.parse(m);
    } catch {
        return null;
    }
}
function genId(p = "sonj") {
    return `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toInt(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function sanitizeError(err) {
    const code = toInt(err?.code ?? err?.error?.code, 1011);
    let message =
        (typeof err?.message === "string" && err.message) ||
        (typeof err?.error?.message === "string" && err.error.message) ||
        "Upstream error";
    // 원문 보호
    if (message.length > 500) {
        message = message.slice(0, 500) + "…";
    }
    return { code, message };
}

class Socket {
    constructor() {
        this.wss = null;
        this._hb = null;
        this.sessions = new Map(); // sessionId -> { turnCount: number }
    }

    init(server) {
        this.wss = new WebSocketServer({
            server,
            path: "/",
            clientTracking: true,
        });
        llmService.setSocketHandler(this);
        this._bind();
        console.log("Socket server ready on '/'");
    }

    _bind() {
        const heartbeat = function () {
            this.isAlive = true;
        };

        this.wss.on("connection", async (ws) => {
            ws.isAlive = true;
            ws.on("pong", heartbeat);

            // 연결당 1 세션
            const sessionId = genId("sonj");
            ws._sessionId = sessionId;
            this.sessions.set(sessionId, { turnCount: 0 });

            try {
                await llmService.createRealtimeSession(
                    sessionId,
                    "복지 상담",
                    "웹 테스트"
                );
                this._setupLLMForwarding(sessionId, ws);
            } catch (e) {
                return this._sendError(
                    ws,
                    503,
                    `Session create failed: ${e.message}`
                );
            }

            ws.on("message", async (raw, isBinary) => {
                if (isBinary) {
                    try {
                        audioService.toBase64PcmChunks(raw).forEach((b64) => {
                            llmService.appendAudioChunk(sessionId, b64);
                        });
                    } catch (e) {
                        return this._sendError(
                            ws,
                            400,
                            `Invalid binary audio: ${e.message}`
                        );
                    }
                    return;
                }

                const msg = safeParse(raw.toString());
                if (!msg || typeof msg !== "object") {
                    return this._sendError(ws, 400, "Invalid message format");
                }

                const { channel, type } = msg;
                if (!channel) {
                    return this._sendError(ws, 400, "Missing 'channel' field");
                }
                if (!type && channel === "openai:conversation") {
                    return this._sendError(
                        ws,
                        400,
                        "Missing 'type' for openai:conversation"
                    );
                }

                if (channel === "openai:conversation") {
                    return this._handleConversation(ws, sessionId, msg);
                }
                if (channel === "sonju:summarize") {
                    return this._handleSummarize(ws, sessionId);
                }

                // 수신 전용 채널은 클라 → 서버 요청 무시
                if (
                    channel === "sonju:suggestedQuestion" ||
                    channel === "sonju:officeInfo"
                )
                    return;

                return this._sendError(ws, 400, `Unknown channel: ${channel}`);
            });

            ws.on("close", async () => {
                this._cleanupLLMForwarding(ws);
                try {
                    await llmService.closeSession(sessionId);
                } catch {}
                this.sessions.delete(sessionId);
            });
        });

        // Heartbeat
        this._hb = setInterval(() => {
            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) {
                    return ws.terminate();
                }
                ws.isAlive = false;
                ws.ping();
            });
        }, 30_000);

        this.wss.on("close", () => clearInterval(this._hb));
    }

    // ====== Conversation Handler ======
    _handleConversation(ws, sessionId, msg) {
        const { type } = msg;

        if (type === "input_audio_buffer.commit") {
            try {
                llmService.clearAudioBuffer(sessionId);
            } catch {}
            return;
        }

        // append는 항상 바이너리 프레임
        if (type === "input_audio_buffer.append") {
            return this._sendError(
                ws,
                400,
                "Use binary frame for audio append (PCM16)."
            );
        }

        if (type === "input_audio_buffer.end") {
            this._addTurnCount(sessionId);
            try {
                llmService.commitAudioAndCreateResponse(sessionId, {
                    modalities: ["text", "audio"],
                });
            } catch (e) {
                return this._sendError(ws, 500, `Commit failed: ${e.message}`);
            }
            return;
        }

        if (type === "input_text") {
            this._addTurnCount(sessionId);
            try {
                const text = String(msg.text ?? "");
                llmService.sendTextMessage(sessionId, text, {
                    modalities: ["text", "audio"],
                });
            } catch (e) {
                return this._sendError(
                    ws,
                    500,
                    `Text send failed: ${e.message}`
                );
            }
            return;
        }

        if (type === "preprompted") {
            this._addTurnCount(sessionId);
            const selected = msg.enum || "";
            return this._sendConv(ws, {
                type: "preprompted.done",
                output: `선택된 프리프롬프트: ${selected}`,
            });
        }

        // 그 외 이벤트는 무시
    }

    // ====== summarize ======
    async _handleSummarize(ws, sessionId) {
        try {
            // 실제 요약 생성
            const report = await summaryService.generateSessionReport(
                llmService,
                sessionId,
                { format: "image" }
            );

            if (report.image && report.image.data) {
                // Buffer를 base64로 변환
                const base64Image = report.image.data.toString("base64");

                // 클라이언트에게 전송 (WebSocket 상태 체크)
                if (ws.readyState === ws.OPEN) {
                    ws.send(
                        JSON.stringify({
                            channel: "sonju:summarize",
                            type: "summary.image",
                            image_base64: base64Image,
                            image_format: report.image.format || "png",
                            sessionId,
                            timestamp: report.timestamp,
                        })
                    );
                }
            } else {
                // 이미지 생성 실패
                this._sendError(ws, 500, "요약 이미지 생성에 실패했습니다.");
            }
        } catch (error) {
            const { code, message } = sanitizeError(error);
            this._sendError(ws, code, `요약 생성 실패: ${message}`);
        }
    }

    // ====== LLM event → client forwarding ======
    _setupLLMForwarding(sessionId, ws) {
        const fwd = (event, mapper) => {
            const handler = (data) => {
                if (data.sessionId !== sessionId) {
                    return;
                }
                const out = mapper(data);
                const s = this.sessions.get(sessionId);
                const turn_index = s?.turnCount ?? 0;
                if (
                    out.type == "response.audio.delta" &&
                    ws.readyState === ws.OPEN
                ) {
                    try {
                        const buf = audioService.fromBase64Pcm(out.delta);
                        ws.send(buf, { binary: true });
                    } catch (e) {
                        this._sendError(
                            ws,
                            502,
                            `Upstream audio decode failed: ${e.message}`
                        );
                    }
                } else if (out && ws.readyState === ws.OPEN) {
                    ws.send(
                        JSON.stringify({
                            channel: "openai:conversation",
                            ...out,
                        })
                    );
                }
            };
            llmService.on(event, handler);
            if (!ws._llmHandlers) {
                ws._llmHandlers = [];
            }
            ws._llmHandlers.push({ event, handler });
        };

        fwd("text_delta", ({ delta }) => {
            const s = this.sessions.get(sessionId);
            return {
                type: "response.text.delta",
                output_index: s?.turnCount ?? 0,
                delta,
            };
        });
        fwd("text_done", () => {
            const s = this.sessions.get(sessionId);
            return {
                type: "response.text.done",
                output_index: s?.turnCount ?? 0,
            };
        });

        fwd("audio_transcript_delta", ({ delta }) => {
            const s = this.sessions.get(sessionId);
            return {
                type: "response.audio_transcript.delta",
                output_index: s?.turnCount ?? 0,
                delta,
            };
        });

        fwd("audio_transcript_done", () => {
            const s = this.sessions.get(sessionId);
            return {
                type: "response.audio_transcript.done",
                output_index: s?.turnCount ?? 0,
            };
        });

        fwd("audio_delta", ({ delta }) => {
            const s = this.sessions.get(sessionId);
            return {
                type: "response.audio.delta",
                output_index: s?.turnCount ?? 0,
                delta,
            };
        });

        fwd("audio_done", () => {
            const s = this.sessions.get(sessionId);
            return {
                type: "response.audio.done",
                output_index: s?.turnCount ?? 0,
            };
        });

        const onErr = ({ sessionId: sid, error }) => {
            if (sid !== sessionId) {
                return;
            }

            const { code, message } = sanitizeError(error);
            this._sendError(ws, code, message);
        };

        const onClosed = ({ sessionId: sid, code, reason }) => {
            if (sid !== sessionId) {
                return;
            }
            const c = toInt(code, 1011);
            const r =
                (typeof reason === "string" && reason) || "Upstream closed";
            this._sendError(ws, c, r);
        };

        llmService.on("error", onErr);
        llmService.on("closed", onClosed);
        ws._llmHandlers.push({ event: "error", handler: onErr });
        ws._llmHandlers.push({ event: "closed", handler: onClosed });
    }

    _addTurnCount(sessionId) {
        const s = this.sessions.get(sessionId);
        if (s) {
            s.turnCount += 1;
        }
    }

    _cleanupLLMForwarding(ws) {
        if (ws._llmHandlers) {
            ws._llmHandlers.forEach(({ event, handler }) => {
                llmService.removeListener(event, handler);
            });
            ws._llmHandlers = [];
        }
    }

    _sendConv(ws, payload) {
        if (ws.readyState !== ws.OPEN) {
            return;
        }
        ws.send(JSON.stringify({ channel: "openai:conversation", ...payload }));
    }

    _sendError(ws, code, message, extra = {}) {
        if (ws.readyState !== ws.OPEN) {
            return;
        }
        ws.send(
            JSON.stringify({ channel: "openai:error", code, message, ...extra })
        );
    }

    // llmService → socket 역호출이 필요하면 구현
    emit(_event, _payload) {}
}

module.exports = new Socket();

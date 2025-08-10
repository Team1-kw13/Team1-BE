const WebSocket = require("ws");
const llmService = require("../service/llmService");

class VoiceSocketHandler {
    constructor(server) {
        this.wss = new WebSocket.Server({
            server,
            path: "/voice",
            clientTracking: true,
        });
        this.clients = new Map(); // sessionId -> { ws, sessionData }
        this.setupWebSocketServer();
        console.log("🎤 Voice WebSocket server initialized on /voice");
    }

    setupWebSocketServer() {
        this.wss.on("connection", (ws, req) => {
            const clientId = this.generateClientId();
            console.log(`🔗 New WebSocket connection: ${clientId}`);

            ws.clientId = clientId;
            ws.sessionId = null;
            ws.isAlive = true;

            // Ping/Pong for connection health check
            ws.on("pong", () => {
                ws.isAlive = true;
            });

            ws.on("message", async (message) => {
                try {
                    await this.handleMessage(ws, message);
                } catch (error) {
                    console.error("Message handling error:", error);
                    this.sendError(
                        ws,
                        "MESSAGE_PROCESSING_ERROR",
                        error.message
                    );
                }
            });

            ws.on("close", () => {
                console.log(`🔌 WebSocket connection closed: ${clientId}`);
                this.handleDisconnection(ws);
            });

            ws.on("error", (error) => {
                console.error(`❌ WebSocket error for ${clientId}:`, error);
                this.handleDisconnection(ws);
            });

            // 연결 성공 메시지
            this.sendMessage(ws, "CONNECTED", { clientId });
        });

        // Health check interval
        this.heartbeatInterval = setInterval(() => {
            this.wss.clients.forEach((ws) => {
                if (!ws.isAlive) {
                    console.log(
                        `💔 Terminating dead connection: ${ws.clientId}`
                    );
                    return ws.terminate();
                }
                ws.isAlive = false;
                ws.ping();
            });
        }, 30000);
    }

    async handleMessage(ws, message) {
        let data;
        try {
            data = JSON.parse(message);
        } catch (error) {
            throw new Error("Invalid JSON format");
        }

        const { type, data: payload } = data;
        console.log(`📥 Received message: ${type} from ${ws.clientId}`);

        switch (type) {
            case "CREATE_SESSION":
                await this.handleCreateSession(ws, payload);
                break;

            case "CLOSE_SESSION":
                await this.handleCloseSession(ws, payload);
                break;

            case "SEND_TEXT_MESSAGE":
                await this.handleTextMessage(ws, payload);
                break;

            case "SEND_AUDIO_MESSAGE":
                await this.handleAudioMessage(ws, payload);
                break;

            case "PAUSE_SESSION":
                await this.handlePauseSession(ws, payload);
                break;

            case "RESUME_SESSION":
                await this.handleResumeSession(ws, payload);
                break;

            case "GET_SESSION_INFO":
                await this.handleGetSessionInfo(ws, payload);
                break;

            default:
                throw new Error(`Unknown message type: ${type}`);
        }
    }

    async handleCreateSession(ws, payload) {
        const { sessionId, sessionContext = "", audioContext = "" } = payload;

        if (!sessionId) {
            throw new Error("Session ID is required");
        }

        if (this.clients.has(sessionId)) {
            throw new Error(`Session ${sessionId} already exists`);
        }

        try {
            // LLM 서비스에 세션 생성 요청
            await llmService.createRealtimeSession(
                sessionId,
                sessionContext,
                audioContext
            );

            // 클라이언트 등록
            this.clients.set(sessionId, {
                ws,
                sessionData: {
                    sessionId,
                    sessionContext,
                    audioContext,
                    createdAt: new Date(),
                    messageCount: 0,
                },
            });

            ws.sessionId = sessionId;

            // LLM 서비스 이벤트를 WebSocket으로 전달
            this.setupLLMEventForwarding(sessionId);

            console.log(`✅ Session created: ${sessionId}`);
            this.sendMessage(ws, "SESSION_CREATED", {
                sessionId,
                status: "active",
            });
        } catch (error) {
            console.error(`Session creation failed for ${sessionId}:`, error);
            throw error;
        }
    }

    async handleCloseSession(ws, payload) {
        const { sessionId } = payload;

        if (!sessionId) {
            throw new Error("Session ID is required");
        }

        try {
            // LLM 서비스에서 세션 종료
            await llmService.closeSession(sessionId);

            // 클라이언트에서 제거
            this.clients.delete(sessionId);
            ws.sessionId = null;

            console.log(`✅ Session closed: ${sessionId}`);
            this.sendMessage(ws, "SESSION_CLOSED", { sessionId });
        } catch (error) {
            console.error(`Session closure failed for ${sessionId}:`, error);
            throw error;
        }
    }

    async handleTextMessage(ws, payload) {
        const { sessionId, message } = payload;

        if (!sessionId || !message) {
            throw new Error("Session ID and message are required");
        }

        const client = this.clients.get(sessionId);
        if (!client) {
            throw new Error(`Session ${sessionId} not found`);
        }

        try {
            // RAG 컨텍스트 업데이트
            const ragResult = await llmService.updateSessionWithRAG(
                sessionId,
                message,
                client.sessionData.sessionContext,
                client.sessionData.audioContext
            );

            // RAG 출처 정보 전송
            this.sendMessage(ws, "RAG_SOURCES", {
                sources: ragResult.sources,
                contextLength: ragResult.ragContext.length,
            });

            // 텍스트 메시지 전송
            await llmService.sendTextMessage(sessionId, message);

            // 메시지 카운트 업데이트
            client.sessionData.messageCount++;

            console.log(`💬 Text message sent to session ${sessionId}`);
        } catch (error) {
            console.error(`Text message failed for ${sessionId}:`, error);
            throw error;
        }
    }

    async handleAudioMessage(ws, payload) {
        const { sessionId, audioData } = payload;

        if (!sessionId || !audioData) {
            throw new Error("Session ID and audio data are required");
        }

        const client = this.clients.get(sessionId);
        if (!client) {
            throw new Error(`Session ${sessionId} not found`);
        }

        try {
            // Base64 디코딩 (클라이언트에서 Base64로 전송하는 경우)
            const audioBuffer = Buffer.from(audioData, "base64");

            // LLM 서비스에 오디오 전송
            await llmService.sendAudioMessage(sessionId, audioBuffer);

            console.log(`🎤 Audio message sent to session ${sessionId}`);
            this.sendMessage(ws, "AUDIO_MESSAGE_SENT", { sessionId });
        } catch (error) {
            console.error(`Audio message failed for ${sessionId}:`, error);
            throw error;
        }
    }

    async handlePauseSession(ws, payload) {
        const { sessionId } = payload;

        if (!sessionId) {
            throw new Error("Session ID is required");
        }

        try {
            llmService.pauseSession(sessionId);
            console.log(`⏸️ Session paused: ${sessionId}`);
            this.sendMessage(ws, "SESSION_PAUSED", { sessionId });
        } catch (error) {
            console.error(`Pause session failed for ${sessionId}:`, error);
            throw error;
        }
    }

    async handleResumeSession(ws, payload) {
        const { sessionId } = payload;

        if (!sessionId) {
            throw new Error("Session ID is required");
        }

        try {
            llmService.resumeSession(sessionId);
            console.log(`▶️ Session resumed: ${sessionId}`);
            this.sendMessage(ws, "SESSION_RESUMED", { sessionId });
        } catch (error) {
            console.error(`Resume session failed for ${sessionId}:`, error);
            throw error;
        }
    }

    async handleGetSessionInfo(ws, payload) {
        const { sessionId } = payload;

        if (!sessionId) {
            throw new Error("Session ID is required");
        }

        try {
            const sessionInfo = llmService.getSessionInfo(sessionId);
            const client = this.clients.get(sessionId);

            const info = {
                ...sessionInfo,
                clientData: client ? client.sessionData : null,
            };

            this.sendMessage(ws, "SESSION_INFO", info);
        } catch (error) {
            console.error(`Get session info failed for ${sessionId}:`, error);
            throw error;
        }
    }

    setupLLMEventForwarding(sessionId) {
        const client = this.clients.get(sessionId);
        if (!client) return;

        // LLM 서비스 이벤트를 WebSocket으로 전달
        const eventTypes = [
            "audio_transcript_delta",
            "audio_transcript_done",
            "text_delta",
            "text_done",
            "audio_delta",
            "audio_done",
        ];

        eventTypes.forEach((eventType) => {
            const handler = (data) => {
                console.log(
                    `🎯 Received LLM event: ${eventType} for session ${data.sessionId}`
                );
                if (data.sessionId === sessionId) {
                    // 이벤트 이름을 대문자로 변환
                    const messageType = eventType.toUpperCase();
                    console.log(
                        `📡 Forwarding event to WebSocket: ${messageType}`
                    );
                    this.sendMessage(client.ws, messageType, data);
                }
            };

            llmService.on(eventType, handler);
            console.log(
                `✅ Event listener registered: ${eventType} for session ${sessionId}`
            );

            // 세션 종료 시 이벤트 리스너 정리를 위해 저장
            if (!client.eventHandlers) {
                client.eventHandlers = [];
            }
            client.eventHandlers.push({ eventType, handler });
        });
    }

    handleDisconnection(ws) {
        if (ws.sessionId) {
            const client = this.clients.get(ws.sessionId);
            if (client) {
                // 이벤트 리스너 정리
                if (client.eventHandlers) {
                    client.eventHandlers.forEach(({ eventType, handler }) => {
                        llmService.removeListener(eventType, handler);
                    });
                }

                // LLM 세션 종료
                llmService.closeSession(ws.sessionId).catch((error) => {
                    console.error(
                        `Error closing session ${ws.sessionId}:`,
                        error
                    );
                });

                this.clients.delete(ws.sessionId);
                console.log(`🧹 Cleaned up session: ${ws.sessionId}`);
            }
        }
    }

    sendMessage(ws, type, data = {}) {
        if (ws.readyState === WebSocket.OPEN) {
            const message = { type, data, timestamp: Date.now() };
            ws.send(JSON.stringify(message));
        }
    }

    sendError(ws, errorType, message, details = {}) {
        this.sendMessage(ws, "ERROR", {
            errorType,
            message,
            details,
            timestamp: Date.now(),
        });
    }

    generateClientId() {
        return `client_${Date.now()}_${Math.random()
            .toString(36)
            .substr(2, 9)}`;
    }

    // 서버 종료 시 정리
    close() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }

        // 모든 클라이언트 연결 종료
        this.clients.forEach(async (client, sessionId) => {
            try {
                await llmService.closeSession(sessionId);
            } catch (error) {
                console.error(`Error closing session ${sessionId}:`, error);
            }
        });

        this.wss.close();
        console.log("🔌 Voice WebSocket server closed");
    }

    // 서버 상태 조회
    getServerStatus() {
        return {
            totalConnections: this.wss.clients.size,
            activeSessions: this.clients.size,
            sessions: Array.from(this.clients.entries()).map(
                ([sessionId, client]) => ({
                    sessionId,
                    clientId: client.ws.clientId,
                    createdAt: client.sessionData.createdAt,
                    messageCount: client.sessionData.messageCount,
                })
            ),
        };
    }
}

module.exports = VoiceSocketHandler;

const { Server: WebSocketServer } = require("ws");
const llmService = require("../service/llmService");
const audioService = require("../service/audioService");

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

class Socket {
  constructor() {
    this.wss = null;
    this._hb = null;
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

      try {
        await llmService.createRealtimeSession(
          sessionId,
          "복지 상담",
          "웹 테스트"
        );
        this._setupLLMForwarding(sessionId, ws);
      } catch (e) {
        return this._sendError(ws, 503, `Session create failed: ${e.message}`);
      }

      ws.on("message", async (raw, isBinary) => {
        if (isBinary) {
          try {
            const chunks = audioService.toBase64PcmChunks(raw);
            for (const b64 of chunks)
              llmService.appendAudioChunk(sessionId, b64);
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
          return this._handleSummarize(ws);
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
      try {
        const text = String(msg.text ?? "");
        llmService.sendTextMessage(sessionId, text, {
          modalities: ["text", "audio"],
        });
      } catch (e) {
        return this._sendError(ws, 500, `Text send failed: ${e.message}`);
      }
      return;
    }

    if (type === "preprompted") {
      const selected = msg.enum || "";
      return this._sendConv(ws, {
        type: "preprompted.done",
        output: `선택된 프리프롬프트: ${selected}`,
      });
    }

    // 그 외 이벤트는 무시
  }

  // ====== summarize ======
  _handleSummarize(ws) {
    const onePx =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAkMBg9CqTg0AAAAASUVORK5CYII=";
    ws.send(
      JSON.stringify({
        channel: "sonju:summarize",
        type: "summary.image",
        image_base64: onePx,
      })
    );
  }

  // ====== LLM event → client forwarding ======
  _setupLLMForwarding(sessionId, ws) {
    const fwd = (event, mapper) => {
      const handler = (data) => {
        if (data.sessionId !== sessionId) {
          return;
        }
        const out = mapper(data);
        if (out && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ channel: "openai:conversation", ...out }));
        }
      };
      llmService.on(event, handler);
      if (!ws._llmHandlers) {
        ws._llmHandlers = [];
      }
      ws._llmHandlers.push({ event, handler });
    };

    fwd("text_delta", ({ output_index, delta }) => ({
      type: "response.text.delta",
      output_index,
      delta,
    }));
    fwd("text_done", ({ output_index }) => ({
      type: "response.text.done",
      output_index,
    }));

    fwd("audio_transcript_delta", ({ output_index, delta }) => ({
      type: "response.audio_transcript.delta",
      output_index,
      delta,
    }));
    fwd("audio_transcript_done", ({ output_index }) => ({
      type: "response.audio_transcript.done",
      output_index,
    }));

    fwd("audio_delta", ({ output_index, delta }) => ({
      type: "response.audio.delta",
      output_index,
      delta,
    }));
    fwd("audio_done", ({ output_index }) => ({
      type: "response.audio.done",
      output_index,
    }));

    const onErr = ({ error }) =>
      this._sendError(
        ws,
        error?.code ?? 1011,
        error?.message ?? "Upstream error",
        { raw: error }
      );
    const onClosed = ({ code, reason }) =>
      this._sendError(ws, code ?? 1011, reason || "Upstream closed");
    llmService.on("error", onErr);
    llmService.on("closed", onClosed);
    ws._llmHandlers.push({ event: "error", handler: onErr });
    ws._llmHandlers.push({ event: "closed", handler: onClosed });
  }

  _cleanupLLMForwarding(ws) {
    if (ws._llmHandlers) {
      ws._llmHandlers.forEach(({ event, handler }) =>
        llmService.removeListener(event, handler)
      );
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

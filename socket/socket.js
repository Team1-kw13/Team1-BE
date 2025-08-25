const { Server: WebSocketServer } = require("ws");
const llmService = require("../service/llmService");
const audioService = require("../service/audioService");
const summaryService = require("../service/summaryService");
const suggestionService = require("../service/suggestionService");

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
    this.sessions = new Map(); // sessionId -> { turn: [itemId | "text"], userTranscript: String, coord: [ float ]}
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

  getCoord(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return [0.0, 0.0];
    const [lat, lon] = Array.isArray(s.coord) ? s.coord : [0.0, 0.0];
    return [Number(lat) || 0.0, Number(lon) || 0.0];
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
      this.sessions.set(sessionId, {
        turn: [],
        userTranscript: "", // 사용자 음성 전사 누적
        coord: [0.0, 0.0],
      });

      try {
        await llmService.createRealtimeSession(sessionId);
        this._setupLLMForwarding(sessionId, ws);
      } catch (e) {
        return this._sendError(ws, 503, `Session create failed: ${e.message}`);
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
        if (channel === "sonju:currentCoord") {
          const s = this.sessions.get(sessionId);
          if (s) {
            const lat = Number(msg.lat);
            const lon = Number(msg.lon);
            s.coord = [
              Number.isFinite(lat) ? lat : 0.0,
              Number.isFinite(lon) ? lon : 0.0,
            ];
          }
          return;
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
      console.log(10);
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
        llmService.commitAudio(sessionId);
      } catch (e) {
        return this._sendError(ws, 500, `Commit failed: ${e.message}`);
      }
      return;
    }

    if (type === "input_text") {
      this._addTurn(sessionId);
      try {
        const text = String(msg.text ?? "");
        this._setUserContext(sessionId, text); // 처음에 이게 없으면 제안을 안 함
        llmService.sendTextMessage(sessionId, text, {
          modalities: ["text", "audio"],
        });
      } catch (e) {
        return this._sendError(ws, 500, `Text send failed: ${e.message}`);
      }
      return;
    }

    if (type === "preprompted") {
      this._addTurn(sessionId);
      const selected = msg.enum || "";
      let preprompt = "";
      switch (selected) {
        case "무더위 쉼터":
          preprompt = `사용자가 무더위 쉼터 위치에 대해 질문했습니다. 
손주처럼 따뜻하고 친근하게, 노인에게 설명하듯 답하세요. 
반드시 search_cooling_center 도구를 호출하여 정보를 찾으세요. 
현재 무더위 쉼터 검색은 베타 버전입니다. 주변 동사무소를 찾았다는 설명과 함께, 주변 관공서로 가면 더위를 피할 수 있다는 말을 덧붙이는 것을 잊지 마세요.
                    `;
          break;
        case "동사무소":
          preprompt = `사용자가 주변 주민센터(동사무소)의 위치에 대해 질문했습니다. 
손주처럼 따뜻하고 친근하게, 노인에게 설명하듯 답하세요. 
반드시 district_office_search 도구를 호출하여 해당 동 주민센터의 정보를 찾으세요. 
명심하세요. 사용자는 동사무소가 어떤 곳인지가 궁금한 것이 아니라, 위치 등의 정보가 궁금한 것입니다. 반드시 district_office_search 도구를 사용하세요.
"절대로 동사무소에 대한 설명(정의, 업무 등)을 제공하지 마세요. 정보를 제공하는 것으로 충분합니다."
                    `;
          break;
        case "등본 발급":
          preprompt = `사용자가 주민등록등본 발급에 대해 질문했습니다. 
손주처럼 따뜻하고 친근하게, 노인에게 설명하듯 답하세요. 
반드시 faq_search 도구를 호출하여 등본 발급 방법, 준비물, 무인발급기 이용 가능 여부, 수수료 등을 찾으세요. 
                    `;
          break;
        default:
          return this._sendError(
            ws,
            400,
            `Unknown preprompt enum: ${selected}`
          );
      }
      this._setUserContext(sessionId, preprompt.trim());
      return llmService.sendTextMessage(sessionId, preprompt.trim());
    }
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

  async _generateSuggestionsAfterResponse(ws, sessionId) {
    try {
      const session = this.sessions.get(sessionId);
      // LLM 서비스에서 전체 대화 내역 가져오기
      const conversation = llmService.getSessionConversation(sessionId);

      if (conversation.length === 0) return;

      const context = conversation
        .map(
          (msg) => `${msg.role === "user" ? "사용자" : "AI"}: ${msg.content}`
        )
        .join("\n");
      const suggestions = await suggestionService.generate(context);

      if (ws.readyState === ws.OPEN) {
        ws.send(
          JSON.stringify({
            channel: "sonju:suggestedQuestion",
            type: "suggestion.response",
            questions: suggestions,
            timestamp: Date.now(),
          })
        );
      }
    } catch (err) {
      console.error("자동 제안 질문 생성 실패:", err.message);
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
        if (out.type == "response.audio.delta" && ws.readyState === ws.OPEN) {
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

    fwd("response_done", () => {
      this._generateSuggestionsAfterResponse(ws, sessionId);

      return {
        type: "response.done",
        output_index: this._getTurnCount(sessionId),
      };
    });

    fwd("audio_transcript_delta", ({ delta }) => {
      return {
        type: "response.audio_transcript.delta",
        output_index: this._getTurnCount(sessionId),
        delta,
      };
    });

    fwd("audio_transcript_done", () => {
      return {
        type: "response.audio_transcript.done",
        output_index: this._getTurnCount(sessionId),
      };
    });

    // audio
    fwd("audio_delta", ({ delta }) => {
      return {
        type: "response.audio.delta",
        output_index: this._getTurnCount(sessionId),
        delta,
      };
    });

    fwd("audio_done", () => {
      return {
        type: "response.audio.done",
        output_index: this._getTurnCount(sessionId),
      };
    });

    // transcript
    fwd("input_audio_transcript_delta", ({ delta, itemId }) => {
      // 사용자 음성 전사 누적
      this._accumUserTranscript(sessionId, delta);
      return {
        type: "input_audio_transcription.delta",
        output_index: this._getTurnIdx(sessionId, itemId),
        delta,
      };
    });

    fwd("input_audio_transcript_done", ({ itemId }) => {
      // 누적된 사용자 전사를 lastUserInput로 설정
      const fullTranscript = this._consumeUserTranscript(sessionId);
      if (fullTranscript) {
        this._setUserContext(sessionId, fullTranscript);
      }

      return {
        type: "input_audio_transcription.done",
        output_index: this._getTurnIdx(sessionId, itemId),
      };
    });

    // committed
    const onCommitted = ({ itemId }) => {
      this._addTurn(sessionId, itemId);
    };

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
      const r = (typeof reason === "string" && reason) || "Upstream closed";
      this._sendError(ws, c, r);
    };

    // office_info 이벤트 핸들러
    const onOfficeInfo = ({ sessionId: sid, name, tel, pos }) => {
      if (sid !== sessionId) return;

      if (ws.readyState === ws.OPEN) {
        const message = {
          channel: "sonju:officeInfo",
          type: "officeInfo",
          name,
          tel,
          pos,
          timestamp: Date.now(),
        };

        ws.send(JSON.stringify(message));
      }
    };

    llmService.on("input_audio_buffer_committed", onCommitted);
    llmService.on("error", onErr);
    llmService.on("closed", onClosed);
    llmService.on("office_info", onOfficeInfo);

    ws._llmHandlers.push({
      event: "input_audio_buffer_committed",
      handler: onCommitted,
    });
    ws._llmHandlers.push({ event: "error", handler: onErr });
    ws._llmHandlers.push({ event: "closed", handler: onClosed });
    ws._llmHandlers.push({ event: "office_info", handler: onOfficeInfo });
  }

  _setUserContext(sessionId, userInput) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastUserInput = userInput;
    }
  }

  // 사용자 음성 전사 누적
  _accumUserTranscript(sessionId, delta) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.userTranscript =
      (session.userTranscript || "") + String(delta || "");
  }

  // 누적된 사용자 전사를 소비하고 초기화
  _consumeUserTranscript(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return "";
    const transcript = String(session.userTranscript || "").trim();
    session.userTranscript = "";
    return transcript;
  }

  _addTurn(sessionId, itemId = "text") {
    const s = this.sessions.get(sessionId);
    if (!s) {
      return;
    }

    if (!Array.isArray(s.turn)) {
      s.turn = [];
    }
    s.turn.push(itemId);
  }

  _getTurnCount(sessionId) {
    const s = this.sessions.get(sessionId);
    return Array.isArray(s?.turn) ? s.turn.length - 1 : 0;
  }

  _getTurnIdx(sessionId, itemId) {
    const s = this.sessions.get(sessionId);
    if (!Array.isArray(s?.turn)) return 0;

    const idx = s.turn.indexOf(itemId);
    return idx !== -1 ? idx : 0;
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

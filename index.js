const express = require("express");
const http = require("http");
require("dotenv").config();
const { swaggerUi, specs } = require("./config/swagger");
const corsMiddleware = require("./config/cors");

const openai = require("./config/openai");
const VoiceSocketHandler = require("./socket/voiceSocket");

const app = express();
const PORT = 3000;

// HTTP 서버 생성
const server = http.createServer(app);

app.use(express.json());
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));
app.use(corsMiddleware);

// 음성 WebSocket 서버 설정
const voiceSocket = new VoiceSocketHandler(server);

app.get("/", (req, res) => {
    res.send("민원 음성 도우미 서버가 실행 중입니다.");
});

server.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
    console.log(`음성 WebSocket: ws://localhost:${PORT}/voice`);
});

const express = require("express");
const http = require("http");
const path = require("path");
require("dotenv").config();
const { swaggerUi, specs } = require("./config/swagger");
const corsMiddleware = require("./config/cors");
const Socket = require("./socket/socket");

const app = express();
const server = http.createServer(app);
const PORT = 3000;

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));
app.use(corsMiddleware);
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.send("민원 음성 도우미 서버가 실행 중입니다.");
});

// 테스트 페이지 라우트
app.get("/test", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "test-llm.html"));
});

// WebSocket 서버 초기화
Socket.init(server);

server.listen(PORT, () => {
  console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
  console.log(`테스트 페이지: http://localhost:${PORT}/test`);
  console.log(`음성 WebSocket: ws://localhost:${PORT}/`);
});

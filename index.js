const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { swaggerUi, specs } = require("./config/swagger");

const app = express();
const PORT = 3000;

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));
app.use(
    cors({
        origin: process.env.CLIENT_ORIGIN,
        credentials: true,
    })
);

app.get("/", (req, res) => {
    res.send("민원 음성 도우미 서버가 실행 중입니다.");
});

app.listen(PORT, () => {
    // console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});

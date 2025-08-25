const WebSocket = require("ws");
const fs = require("fs");

// 로그 파일 이름 생성
const logFileName = `test-log-${Date.now()}.txt`;
const logFile = fs.createWriteStream(logFileName, { flags: "a" });

function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    console.log(message);
    logFile.write(logMessage);
    logFile.uncork(); // 즉시 파일에 쓰기
}

// WebSocket 연결 및 preprompt 테스트
async function testPreprompt() {
    console.log("WebSocket 연결 시작...");

    const ws = new WebSocket("ws://localhost:3000");

    ws.on("open", async () => {
        log("WebSocket 연결됨");

        // 잠시 대기 (세션 생성 완료까지)
        await new Promise((resolve) => setTimeout(resolve, 2000));

        log("preprompt 테스트 시작...");

        // preprompt 메시지 전송
        const prepromptMessage = {
            channel: "openai:conversation",
            type: "preprompted",
            enum: "무더위 쉼터",
        };

        log("전송할 메시지: " + JSON.stringify(prepromptMessage, null, 2));
        ws.send(JSON.stringify(prepromptMessage));

        // 3초 후 다른 preprompt 테스트
        setTimeout(() => {
            const prepromptMessage2 = {
                channel: "openai:conversation",
                type: "preprompted",
                enum: "동사무소",
            };
            log(
                "두 번째 메시지 전송: " +
                    JSON.stringify(prepromptMessage2, null, 2)
            );
            ws.send(JSON.stringify(prepromptMessage2));
        }, 15000);

        // 6초 후 일반 텍스트 메시지 테스트
        setTimeout(() => {
            const textMessage = {
                channel: "openai:conversation",
                type: "input_text",
                text: "안녕하세요, 테스트입니다",
            };
            log("텍스트 메시지 전송: " + JSON.stringify(textMessage, null, 2));
            ws.send(JSON.stringify(textMessage));
        }, 30000);

        // 10초 후 연결 종료
        setTimeout(() => {
            log("연결 종료...");
            logFile.end(); // 로그 파일 닫기
            ws.close();
        }, 60000);
    });

    ws.on("message", (data, isBinary) => {
        // 바이너리 데이터 필터링
        if (isBinary) {
            //log("바이너리 데이터 수신: " + data.length + " bytes");
            return;
        }

        try {
            const message = JSON.parse(data.toString());

            // 텍스트 메시지만 기록 (response.text.delta 포함)
            if (
                message.type &&
                (message.type.includes("text") ||
                    message.type === "response.text.delta")
            ) {
                // 실제 응답 텍스트 내용 추출
                const responseText =
                    message.delta ||
                    message.text ||
                    message.content ||
                    message.message;

                if (responseText) {
                    log("🔥 응답 텍스트: " + responseText);
                }
                return;
            }

            // 오디오 관련 메시지 필터링
            if (message.type && message.type.includes("audio")) {
                log("🔊 오디오 메시지: " + message.type);
                return;
            }

            // 기타 중요한 메시지들
            log(
                "📨 받은 메시지: " +
                    JSON.stringify(
                        {
                            type: message.type,
                            channel: message.channel,
                            status: message.status,
                            message:
                                typeof message.message === "string"
                                    ? message.message
                                    : message.message,
                            error: message.error,
                        },
                        null,
                        2
                    )
            );
        } catch (e) {
            const dataStr = data.toString();
            // 바이너리가 아닌 경우만 출력
            if (dataStr.length > 0 && !dataStr.includes("\x00")) {
                log("파싱 불가한 텍스트: " + dataStr.substring(0, 100) + "...");
            }
        }
    });

    ws.on("error", (error) => {
        log("WebSocket 오류: " + error.message);
    });

    ws.on("close", (code, reason) => {
        log(
            "WebSocket 연결 종료: " +
                JSON.stringify({
                    code,
                    reason: reason?.toString(),
                })
        );
        logFile.end(); // 로그 파일 닫기
        process.exit(0);
    });
}

// 서버 상태 확인
async function checkServer() {
    try {
        const response = await fetch("http://localhost:3000/");
        if (response.ok) {
            console.log("서버 상태: OK");
            return true;
        } else {
            console.log("서버 상태: 오류", response.status);
            return false;
        }
    } catch (e) {
        console.log("서버 연결 실패:", e.message);
        return false;
    }
}

async function main() {
    console.log("=== Preprompt WebSocket 테스트 ===\n");

    // 서버 상태 확인
    const serverOk = await checkServer();
    if (!serverOk) {
        console.log("서버가 실행되지 않았거나 응답하지 않습니다.");
        console.log("npm start 또는 node index.js로 서버를 먼저 실행하세요.");
        process.exit(1);
    }

    console.log("");
    await testPreprompt();
}

main().catch(console.error);

const openai = require("../config/openai");
const puppeteer = require("puppeteer");
const { z } = require("zod");

// zod 스키마 정의
const SummarySchema = z.object({
    topic: z.string().describe("고객이 문의한 핵심 주제"),
    issues: z.string().describe("고객의 구체적인 질문과 요청사항"),
    resolved: z.string().describe("현재까지 제공한 답변, 해결책, 안내사항"),
    remaining: z
        .string()
        .describe("아직 해결되지 않은 문제나 추가 확인이 필요한 사항"),
    emotion: z
        .enum(["만족", "보통", "불만족", "화남", "급함", "중립"])
        .describe("고객의 현재 감정 상태"),
    urgency: z.enum(["낮음", "보통", "높음"]).describe("상담의 긴급도"),
    progress: z.string().describe("대화의 흐름과 고객 반응"),
    additional: z
        .string()
        .describe("고객이 제공한 특이사항이나 중요한 배경 정보"),
    followUp: z.string().describe("다음에 해야 할 구체적인 액션 아이템"),
});

class SummaryService {
    constructor() {
        this.browser = null;
    }

    // Puppeteer 브라우저 초기화 (최적화됨)
    async _initPuppeteer() {
        if (!this.browser) {
            this.browser = await puppeteer.launch({
                headless: true,
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage", // 메모리 최적화
                    "--disable-gpu", // GPU 비활성화
                    "--no-first-run", // 첫 실행 설정 건너뛰기
                    "--disable-default-apps", // 기본 앱 비활성화
                    "--disable-features=VizDisplayCompositor", // 렌더링 최적화
                ],
                defaultViewport: { width: 800, height: 1200 }, // 기본 뷰포트 설정
            });
        }
        return this.browser;
    }

    // 브라우저 종료
    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }

    // 세션 요약 생성 (Chat API + Realtime 대화 히스토리)
    async requestSessionSummary(llmService, sessionId, options = {}) {
        const { format = "report" } = options;

        // 1. Realtime 세션에서 대화 히스토리 가져오기
        const conversationHistory = await this._getRealtimeConversationHistory(
            llmService,
            sessionId
        );

        if (!conversationHistory || conversationHistory.trim().length === 0) {
            throw new Error("요약할 대화 내용이 없습니다.");
        }

        // 2. Chat API로 요약 생성
        try {
            let response;

            if (format === "report") {
                // Structured output 사용
                response = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        {
                            role: "system",
                            content:
                                "당신은 고객 상담 내용을 담당자 인수인계용으로 정확하게 요약하는 전문가입니다.",
                        },
                        {
                            role: "user",
                            content: `다음 고객 상담 내용을 구조화된 형태로 요약해주세요:\n\n${conversationHistory}`,
                        },
                    ],
                    response_format: {
                        type: "json_schema",
                        json_schema: {
                            name: "summary_report",
                            schema: {
                                type: "object",
                                properties: {
                                    topic: {
                                        type: "string",
                                        description: "고객이 문의한 핵심 주제",
                                    },
                                    issues: {
                                        type: "string",
                                        description:
                                            "고객의 구체적인 질문과 요청사항",
                                    },
                                    resolved: {
                                        type: "string",
                                        description:
                                            "현재까지 제공한 답변, 해결책, 안내사항",
                                    },
                                    remaining: {
                                        type: "string",
                                        description:
                                            "아직 해결되지 않은 문제나 추가 확인이 필요한 사항",
                                    },
                                    emotion: {
                                        type: "string",
                                        enum: [
                                            "만족",
                                            "보통",
                                            "불만족",
                                            "화남",
                                            "급함",
                                            "중립",
                                        ],
                                        description: "고객의 현재 감정 상태",
                                    },
                                    urgency: {
                                        type: "string",
                                        enum: ["낮음", "보통", "높음"],
                                        description: "상담의 긴급도",
                                    },
                                    progress: {
                                        type: "string",
                                        description: "대화의 흐름과 고객 반응",
                                    },
                                    additional: {
                                        type: "string",
                                        description:
                                            "고객이 제공한 특이사항이나 중요한 배경 정보",
                                    },
                                    followUp: {
                                        type: "string",
                                        description:
                                            "다음에 해야 할 구체적인 액션 아이템",
                                    },
                                },
                                required: [
                                    "topic",
                                    "issues",
                                    "resolved",
                                    "remaining",
                                    "emotion",
                                    "urgency",
                                    "progress",
                                    "additional",
                                    "followUp",
                                ],
                                additionalProperties: false,
                            },
                        },
                    },
                    temperature: 0.3,
                    max_tokens: 1000,
                });

                // JSON 파싱 및 검증
                const jsonData = JSON.parse(
                    response.choices[0].message.content
                );
                const validatedData = SummarySchema.parse(jsonData);

                // 텍스트 형태로 변환
                const summaryText = `상담 주제: ${validatedData.topic}
주요 문의사항: ${validatedData.issues}
해결된 내용: ${validatedData.resolved}
남은 이슈: ${validatedData.remaining}
고객 감정: ${validatedData.emotion}
긴급도: ${validatedData.urgency}
상담 진행 상황: ${validatedData.progress}
추가 정보: ${validatedData.additional}
후속 조치: ${validatedData.followUp}`;

                return {
                    sessionId,
                    summary: summaryText,
                    format,
                    timestamp: Date.now(),
                    usage: response.usage,
                    structured: validatedData,
                };
            } else {
                // 간단한 요약 (기존 방식)
                const summaryPrompt =
                    format === "brief"
                        ? `다음 대화를 3-4문장으로 간략하게 요약해주세요:\n\n${conversationHistory}`
                        : `다음 상담 내용을 요약해주세요:\n\n${conversationHistory}`;

                response = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [{ role: "user", content: summaryPrompt }],
                    temperature: 0.3,
                    max_tokens: 800,
                });

                return {
                    sessionId,
                    summary: response.choices[0].message.content,
                    format,
                    timestamp: Date.now(),
                    usage: response.usage,
                };
            }
        } catch (error) {
            throw new Error(`Chat API 요약 생성 실패: ${error.message}`);
        }
    }

    // Realtime 세션에서 대화 히스토리 추출 (간단한 버전)
    async _getRealtimeConversationHistory(llmService, sessionId) {
        // 이 부분은 llmService의 내부 구조에 따라 다를 수 있습니다
        // 간단한 요약 요청으로 대화 내용을 가져오는 방법
        try {
            const response = await llmService.sendTextMessageWithResponse(
                sessionId,
                "지금까지의 대화 내용을 그대로 정리해서 보여주세요. 사용자와 어시스턴트의 모든 대화를 시간순으로 나열해주세요."
            );
            return response.text;
        } catch (error) {
            throw new Error(`대화 히스토리 가져오기 실패: ${error.message}`);
        }
    }

    // 세션 요약 후 이미지 보고서 생성 (Chat API + Puppeteer)
    async generateSessionReport(llmService, sessionId, options = {}) {
        const { theme = "light", format = "image" } = options; // format: "image" | "html" | "both"

        // 1. Chat API로 요약 요청
        const summaryResult = await this.requestSessionSummary(
            llmService,
            sessionId,
            { format: "report" }
        );

        // 2. 요약 텍스트를 파싱해서 구조화
        const parsed = this._parseSummaryText(summaryResult.summary);

        // 3. HTML 보고서 생성
        const html = this._generateReportHTML(summaryResult, parsed, { theme });

        // 4. 이미지 생성 (Puppeteer 사용)
        let imageBuffer = null;
        if (format === "image" || format === "both") {
            imageBuffer = await this._htmlToImageWithPuppeteer(html, {
                width: 800,
                height: 1200,
            });
        }

        const result = {
            sessionId,
            summary: summaryResult.summary,
            timestamp: Date.now(),
            usage: summaryResult.usage || null,
        };

        if (format === "html" || format === "both") {
            result.html = html;
        }

        if (format === "image" || format === "both") {
            result.image = imageBuffer
                ? {
                      data: imageBuffer,
                      format: "png",
                  }
                : null;
        }

        return result;
    }

    // HTML을 이미지로 변환 (Puppeteer 사용 - 최적화됨)
    async _htmlToImageWithPuppeteer(html, options = {}) {
        const {
            format = "png",
            width = 800,
            height = 1200,
            quality = 90,
        } = options;

        const browser = await this._initPuppeteer();
        const page = await browser.newPage();

        try {
            // 최적화: 빠른 설정
            await page.setViewport({ width, height, deviceScaleFactor: 1 });

            // 최적화: domcontentloaded로 변경 (networkidle0보다 빠름)
            await page.setContent(html, {
                waitUntil: "domcontentloaded",
                timeout: 5000,
            });

            // 폰트 로딩 대기 (최소한)
            await new Promise((resolve) => setTimeout(resolve, 200));

            const imageBuffer = await page.screenshot({
                type: format,
                quality: format === "jpeg" ? quality : undefined,
                fullPage: true,
            });

            return imageBuffer;
        } finally {
            await page.close();
        }
    }

    // HTML을 이미지로 변환 (SVG 사용 - 기존 호환성)
    async _htmlToImage(html, options = {}, parsedData = null) {
        return this._generateSimpleTextImage(html, options, parsedData);
    }

    // 텍스트 줄바꿈 헬퍼 함수
    _wrapText(text, maxCharsPerLine = 70) {
        if (!text) return [];
        const words = text.split(" ");
        const lines = [];
        let currentLine = "";

        for (const word of words) {
            if ((currentLine + word).length <= maxCharsPerLine) {
                currentLine += (currentLine ? " " : "") + word;
            } else {
                if (currentLine) {
                    lines.push(currentLine);
                    currentLine = word;
                } else {
                    // 단어가 너무 긴 경우 강제로 나누기
                    lines.push(word.substring(0, maxCharsPerLine));
                    currentLine = word.substring(maxCharsPerLine);
                }
            }
        }
        if (currentLine) lines.push(currentLine);
        return lines;
    }

    // Canvas API를 사용한 간단한 텍스트 이미지 생성 (fallback)
    _generateSimpleTextImage(html, options = {}, parsedData = null) {
        let { width = 800, height = "auto" } = options;

        let finalParsed;

        if (parsedData) {
            // 이미 파싱된 데이터가 있으면 사용
            finalParsed = {
                topic: parsedData.topic || "고객 상담 문의",
                issues: parsedData.issues || "문의 내용을 확인해주세요",
                resolved: parsedData.resolved || "상담 진행중",
                emotion: parsedData.emotion || "보통",
                urgency: parsedData.urgency || "보통",
                progress: parsedData.progress || "상담 진행중",
                additional: parsedData.additional || "특이사항 없음",
            };
        } else {
            // HTML에서 주요 정보 추출 (fallback)
            const textContent = html
                .replace(/<[^>]*>/g, " ")
                .replace(/\s+/g, " ")
                .trim();
            const parsed = this._parseSummaryText(textContent);

            finalParsed = {
                topic: parsed.topic || "고객 상담 문의",
                issues: parsed.issues || textContent.substring(0, 100),
                resolved: parsed.resolved || "상담 진행중",
                emotion: parsed.emotion || "보통",
                urgency: parsed.urgency || "보통",
                progress: parsed.progress || "상담 진행중",
                additional: parsed.additional || "특이사항 없음",
            };
        }

        // 텍스트 줄바꿈 처리
        const topicLines = this._wrapText(finalParsed.topic, 90);
        const issuesLines = this._wrapText(finalParsed.issues, 90);
        const resolvedLines = this._wrapText(finalParsed.resolved, 90);
        const emotionLines = this._wrapText(finalParsed.emotion, 90);
        const urgencyLines = this._wrapText(finalParsed.urgency, 90);
        const progressLines = this._wrapText(finalParsed.progress, 90);
        const additionalLines = this._wrapText(finalParsed.additional, 90);

        // Y 좌표 계산
        let y = 110;
        const sections = [
            { title: "📋 상담 주제:", lines: topicLines },
            { title: "❓ 주요 문의사항:", lines: issuesLines },
            { title: "✅ 해결된 내용:", lines: resolvedLines },
            { title: "📊 고객 감정:", lines: emotionLines },
            { title: "⚠️ 긴급도:", lines: urgencyLines },
            { title: "📈 상담 진행 상황:", lines: progressLines },
            { title: "💡 추가 정보:", lines: additionalLines },
        ];

        let svgContent = "";
        for (const section of sections) {
            svgContent += `    <text x="50" y="${y}" class="section">${section.title}</text>\n`;
            y += 25;
            for (const line of section.lines) {
                svgContent += `    <text x="50" y="${y}" class="content">${line}</text>\n`;
                y += 20;
            }
            y += 10; // 섹션 간 여백
        }

        const footerY = y + 20;
        const finalHeight = footerY + 50;

        const svg = `<svg width="${width}" height="${finalHeight}" xmlns="http://www.w3.org/2000/svg">
    <defs>
        <style>
            .title { font-family: Arial, sans-serif; font-size: 24px; font-weight: bold; fill: #0066cc; }
            .section { font-family: Arial, sans-serif; font-size: 16px; font-weight: bold; fill: #333; }
            .content { font-family: Arial, sans-serif; font-size: 14px; fill: #666; }
        </style>
    </defs>
    
    <!-- Background -->
    <rect width="100%" height="100%" fill="#ffffff"/>
    
    <!-- Header -->
    <text x="50" y="40" class="title">🔍 고객 상담 요약 보고서</text>
    <text x="50" y="65" class="content">생성일: ${new Date().toLocaleString(
        "ko-KR"
    )}</text>
    
    <!-- Content -->
${svgContent}    
    <!-- Footer -->
    <text x="50" y="${footerY}" class="content" style="font-size: 12px; opacity: 0.7;">이 보고서는 AI를 통해 자동 생성되었습니다.</text>
</svg>`;

        // SVG를 Buffer로 변환
        return Buffer.from(svg, "utf-8");
    }

    // HTML 템플릿 생성
    _generateSummaryHTML(summaryData, options = {}) {
        const { theme, includeHeader, includeFooter } = options;
        const { summary, sessionId, timestamp } = summaryData;

        const isDark = theme === "dark";
        const bgColor = isDark ? "#1a1a1a" : "#ffffff";
        const textColor = isDark ? "#ffffff" : "#333333";
        const cardBg = isDark ? "#2d2d2d" : "#f8f9fa";

        const urgencyColors = {
            low: "#28a745",
            medium: "#ffc107",
            high: "#dc3545",
        };

        const sentimentIcons = {
            positive: "😊",
            neutral: "😐",
            negative: "😞",
        };

        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: ${bgColor};
            color: ${textColor};
            margin: 0;
            padding: 20px;
            line-height: 1.6;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
        }
        .header {
            text-align: center;
            padding: 20px 0;
            border-bottom: 2px solid #e0e0e0;
            margin-bottom: 30px;
        }
        .title {
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 10px;
        }
        .subtitle {
            font-size: 14px;
            opacity: 0.7;
        }
        .card {
            background: ${cardBg};
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .card-title {
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 15px;
            color: #0066cc;
        }
        .issue-item, .keypoint-item {
            margin-bottom: 8px;
            padding-left: 20px;
            position: relative;
        }
        .issue-item:before, .keypoint-item:before {
            content: "•";
            position: absolute;
            left: 0;
            color: #0066cc;
            font-weight: bold;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 15px;
            margin-top: 15px;
        }
        .stat-item {
            text-align: center;
            padding: 10px;
            background: rgba(0, 102, 204, 0.1);
            border-radius: 4px;
        }
        .stat-value {
            font-size: 20px;
            font-weight: bold;
            color: #0066cc;
        }
        .urgency-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 20px;
            color: white;
            font-size: 12px;
            font-weight: bold;
            background: ${urgencyColors[summary.urgency] || "#6c757d"};
        }
        .sentiment {
            font-size: 16px;
        }
        .footer {
            text-align: center;
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #e0e0e0;
            font-size: 12px;
            opacity: 0.7;
        }
    </style>
</head>
<body>
    <div class="container">
        ${
            includeHeader
                ? `
        <div class="header">
            <div class="title">고객 상담 요약 보고서</div>
            <div class="subtitle">Session ID: ${sessionId}</div>
            <div class="subtitle">생성일: ${new Date(timestamp).toLocaleString(
                "ko-KR"
            )}</div>
        </div>
        `
                : ""
        }

        <div class="card">
            <div class="card-title">📋 상담 주제</div>
            <div style="font-size: 16px; font-weight: 500;">${
                summary.title
            }</div>
        </div>

        <div class="card">
            <div class="card-title">❓ 주요 문의사항</div>
            ${summary.mainIssues
                .map((issue) => `<div class="issue-item">${issue}</div>`)
                .join("")}
        </div>

        <div class="card">
            <div class="card-title">💡 핵심 내용</div>
            ${summary.keyPoints
                .map((point) => `<div class="keypoint-item">${point}</div>`)
                .join("")}
        </div>

        <div class="card">
            <div class="card-title">✅ 해결 내용</div>
            <div>${summary.resolution}</div>
        </div>

        <div class="card">
            <div class="card-title">📊 상담 정보</div>
            <div style="margin-bottom: 15px;">
                <strong>카테고리:</strong> ${summary.category} |
                <strong>긴급도:</strong> <span class="urgency-badge">${summary.urgency.toUpperCase()}</span> |
                <strong>감정:</strong> <span class="sentiment">${
                    sentimentIcons[summary.sentiment]
                } ${summary.sentiment}</span>
            </div>
            <div style="margin-bottom: 10px;">
                <strong>추가 조치 필요:</strong> ${
                    summary.followUpNeeded ? "⚠️ 예" : "✅ 아니오"
                }
            </div>
            
            ${
                summary.statistics
                    ? `
            <div class="stats-grid">
                <div class="stat-item">
                    <div class="stat-value">${summary.statistics.totalMessages}</div>
                    <div>총 메시지</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${summary.statistics.duration}</div>
                    <div>상담 시간</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${summary.statistics.userMessages}</div>
                    <div>고객 메시지</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${summary.statistics.avgResponseTime}</div>
                    <div>평균 응답시간</div>
                </div>
            </div>
            `
                    : ""
            }
        </div>

        ${
            includeFooter
                ? `
        <div class="footer">
            이 보고서는 AI를 통해 자동 생성되었습니다.<br>
            자세한 내용은 원본 대화 기록을 참조하세요.
        </div>
        `
                : ""
        }
    </div>
</body>
</html>`;
    }

    // 시간 포맷 유틸리티
    _formatDuration(milliseconds) {
        const seconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}시간 ${minutes % 60}분`;
        } else if (minutes > 0) {
            return `${minutes}분 ${seconds % 60}초`;
        } else {
            return `${seconds}초`;
        }
    }

    // HTML 템플릿 생성 (Puppeteer용)
    _generateReportHTML(summaryResult, parsed, options = {}) {
        const { theme = "light" } = options;
        const { sessionId, timestamp } = summaryResult;

        const isDark = theme === "dark";
        const bgColor = isDark ? "#1a1a1a" : "#ffffff";
        const textColor = isDark ? "#ffffff" : "#333333";
        const cardBg = isDark ? "#2d2d2d" : "#f8f9fa";

        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
            background: ${bgColor};
            color: ${textColor};
            padding: 40px;
            line-height: 1.6;
            width: 800px;
            margin: 0 auto;
            /* 렌더링 최적화 */
            -webkit-font-smoothing: antialiased;
            text-rendering: optimizeSpeed;
            will-change: auto;
        }
        .header {
            text-align: center;
            padding: 30px 0;
            border-bottom: 3px solid #0066cc;
            margin-bottom: 40px;
        }
        .title {
            font-size: 32px;
            font-weight: bold;
            color: #0066cc;
            margin-bottom: 10px;
        }
        .subtitle {
            font-size: 16px;
            color: #666;
            margin-bottom: 5px;
        }
        .section {
            margin-bottom: 30px;
            padding: 25px;
            background: ${cardBg};
            border-radius: 12px;
            border-left: 4px solid #0066cc;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .section-title {
            font-size: 20px;
            font-weight: bold;
            color: #0066cc;
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .section-content {
            font-size: 16px;
            line-height: 1.7;
            word-wrap: break-word;
        }
        .two-column {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
        }
        .summary-box {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 25px;
            border-radius: 12px;
            margin-bottom: 30px;
        }
        .summary-title {
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 15px;
        }
        .footer {
            text-align: center;
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
            font-size: 14px;
            color: #888;
        }
        @media print {
            body { padding: 20px; }
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="title">🔍 고객 상담 요약 보고서</div>
        <div class="subtitle">Session ID: ${sessionId}</div>
        <div class="subtitle">생성일: ${new Date(timestamp).toLocaleString(
            "ko-KR"
        )}</div>
    </div>

    ${
        parsed.topic
            ? `
    <div class="section">
        <div class="section-title">📋 상담 주제</div>
        <div class="section-content">${parsed.topic}</div>
    </div>
    `
            : ""
    }

    ${
        parsed.issues
            ? `
    <div class="section">
        <div class="section-title">❓ 주요 문의사항</div>
        <div class="section-content">${parsed.issues}</div>
    </div>
    `
            : ""
    }

    ${
        parsed.resolved
            ? `
    <div class="section">
        <div class="section-title">✅ 해결된 내용</div>
        <div class="section-content">${parsed.resolved}</div>
    </div>
    `
            : ""
    }

    ${
        parsed.remaining
            ? `
    <div class="section">
        <div class="section-title">⚠️ 남은 이슈</div>
        <div class="section-content">${parsed.remaining}</div>
    </div>
    `
            : ""
    }

    <div class="two-column">
        ${
            parsed.emotion
                ? `
        <div class="section">
            <div class="section-title">📊 고객 감정</div>
            <div class="section-content">${parsed.emotion}</div>
        </div>
        `
                : ""
        }

        ${
            parsed.urgency
                ? `
        <div class="section">
            <div class="section-title">⚠️ 긴급도</div>
            <div class="section-content">${parsed.urgency}</div>
        </div>
        `
                : ""
        }
    </div>

    ${
        parsed.progress
            ? `
    <div class="section">
        <div class="section-title">📈 상담 진행 상황</div>
        <div class="section-content">${parsed.progress}</div>
    </div>
    `
            : ""
    }

    ${
        parsed.additional
            ? `
    <div class="section">
        <div class="section-title">💡 추가 정보</div>
        <div class="section-content">${parsed.additional}</div>
    </div>
    `
            : ""
    }

    ${
        parsed.followUp
            ? `
    <div class="section">
        <div class="section-title">🎯 후속 조치</div>
        <div class="section-content">${parsed.followUp}</div>
    </div>
    `
            : ""
    }

    <div class="summary-box">
        <div class="summary-title">📝 원본 요약</div>
        <div style="white-space: pre-wrap;">${summaryResult.summary}</div>
    </div>

    <div class="footer">
        이 보고서는 AI를 통해 자동 생성되었습니다.
    </div>
</body>
</html>`;
    }

    // 요약 텍스트 파싱 (** 없는 형식)
    _parseSummaryText(summaryText) {
        const result = {};

        const topicMatch = summaryText.match(
            /상담 주제:?\s*(.+?)(?=\n(?:주요 문의사항|고객 감정|긴급도|상담 진행|추가 정보|후속 조치|남은 이슈|해결된 내용)|$)/is
        );
        if (topicMatch) result.topic = topicMatch[1].trim();

        const issuesMatch = summaryText.match(
            /주요 문의사항:?\s*(.+?)(?=\n(?:상담 주제|고객 감정|긴급도|상담 진행|추가 정보|후속 조치|남은 이슈|해결된 내용)|$)/is
        );
        if (issuesMatch) result.issues = issuesMatch[1].trim();

        const resolvedMatch = summaryText.match(
            /해결된 내용:?\s*(.+?)(?=\n(?:상담 주제|주요 문의사항|고객 감정|긴급도|상담 진행|추가 정보|후속 조치|남은 이슈)|$)/is
        );
        if (resolvedMatch) result.resolved = resolvedMatch[1].trim();

        const remainingMatch = summaryText.match(
            /남은 이슈:?\s*(.+?)(?=\n(?:상담 주제|주요 문의사항|고객 감정|긴급도|상담 진행|추가 정보|후속 조치|해결된 내용)|$)/is
        );
        if (remainingMatch) result.remaining = remainingMatch[1].trim();

        const emotionMatch = summaryText.match(
            /고객 감정:?\s*(.+?)(?=\n(?:상담 주제|주요 문의사항|긴급도|상담 진행|추가 정보|후속 조치|남은 이슈|해결된 내용)|$)/is
        );
        if (emotionMatch) result.emotion = emotionMatch[1].trim();

        const urgencyMatch = summaryText.match(
            /긴급도:?\s*(.+?)(?=\n(?:상담 주제|주요 문의사항|고객 감정|상담 진행|추가 정보|후속 조치|남은 이슈|해결된 내용)|$)/is
        );
        if (urgencyMatch) result.urgency = urgencyMatch[1].trim();

        const progressMatch = summaryText.match(
            /상담 진행 상황:?\s*(.+?)(?=\n(?:상담 주제|주요 문의사항|고객 감정|긴급도|추가 정보|후속 조치|남은 이슈|해결된 내용)|$)/is
        );
        if (progressMatch) result.progress = progressMatch[1].trim();

        const additionalMatch = summaryText.match(
            /추가 정보:?\s*(.+?)(?=\n(?:상담 주제|주요 문의사항|고객 감정|긴급도|상담 진행|후속 조치|남은 이슈|해결된 내용)|$)/is
        );
        if (additionalMatch) result.additional = additionalMatch[1].trim();

        const followUpMatch = summaryText.match(
            /후속 조치:?\s*(.+?)(?=\n(?:상담 주제|주요 문의사항|고객 감정|긴급도|상담 진행|추가 정보|남은 이슈|해결된 내용)|$)/is
        );
        if (followUpMatch) result.followUp = followUpMatch[1].trim();

        return result;
    }

    // 간단한 HTML 보고서 생성
    _generateReportHTML(summaryResult, parsed, options = {}) {
        const { theme = "light" } = options;
        const { sessionId, timestamp } = summaryResult;

        const isDark = theme === "dark";
        const bgColor = isDark ? "#1a1a1a" : "#ffffff";
        const textColor = isDark ? "#ffffff" : "#333333";

        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; background: ${bgColor}; color: ${textColor}; margin: 20px; line-height: 1.6; }
        .container { max-width: 800px; margin: 0 auto; }
        .header { text-align: center; padding: 20px; border-bottom: 2px solid #ddd; margin-bottom: 20px; }
        .card { background: ${
            isDark ? "#2d2d2d" : "#f8f9fa"
        }; padding: 15px; margin-bottom: 15px; border-radius: 8px; }
        .card-title { font-size: 18px; font-weight: bold; color: #0066cc; margin-bottom: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔍 고객 상담 요약 보고서</h1>
            <p>Session ID: ${sessionId}</p>
            <p>생성일: ${new Date(timestamp).toLocaleString("ko-KR")}</p>
        </div>

        ${
            parsed.topic
                ? `
        <div class="card">
            <div class="card-title">📋 상담 주제</div>
            <div>${parsed.topic}</div>
        </div>
        `
                : ""
        }

        ${
            parsed.issues
                ? `
        <div class="card">
            <div class="card-title">❓ 주요 문의사항</div>
            <div>${parsed.issues}</div>
        </div>
        `
                : ""
        }

        ${
            parsed.resolved
                ? `
        <div class="card">
            <div class="card-title">✅ 해결된 내용</div>
            <div>${parsed.resolved}</div>
        </div>
        `
                : ""
        }

        ${
            parsed.remaining
                ? `
        <div class="card">
            <div class="card-title">⚠️ 남은 이슈</div>
            <div>${parsed.remaining}</div>
        </div>
        `
                : ""
        }

        ${
            parsed.progress
                ? `
        <div class="card">
            <div class="card-title">📈 상담 진행 상황</div>
            <div>${parsed.progress}</div>
        </div>
        `
                : ""
        }

        ${
            parsed.additional
                ? `
        <div class="card">
            <div class="card-title">💡 추가 정보</div>
            <div>${parsed.additional}</div>
        </div>
        `
                : ""
        }

        <div class="card">
            <div class="card-title">📊 상담 정보</div>
            <p><strong>고객 감정:</strong> ${parsed.emotion || "N/A"}</p>
            <p><strong>긴급도:</strong> ${parsed.urgency || "N/A"}</p>
            <p><strong>후속 조치:</strong> ${parsed.followUp || "N/A"}</p>
        </div>

        <div class="card">
            <div class="card-title">📝 원본 요약</div>
            <div style="white-space: pre-wrap;">${summaryResult.summary}</div>
        </div>

        <div style="text-align: center; margin-top: 30px; font-size: 12px; opacity: 0.7;">
            이 보고서는 AI를 통해 자동 생성되었습니다.
        </div>
    </div>
</body>
</html>`;
    }
}

module.exports = new SummaryService();

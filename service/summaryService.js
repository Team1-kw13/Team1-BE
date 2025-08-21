const puppeteer = require("puppeteer");

class SummaryService {
    constructor() {
        this.browser = null;
    }

    // Puppeteer 브라우저 초기화
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

    // Realtime API에서 직접 구조화된 요약 요청 (silent 모드 사용)
    async _getStructuredSummaryFromRealtime(llmService, sessionId) {
        try {
            const summaryPrompt = `지금까지의 고객 상담 내용을 담당자 인수인계용으로 정확하고 자세하게 구조화해서 요약해주세요.

**출력 형식을 정확히 준수하세요:**

상담 주제: [고객이 문의한 핵심 주제를 구체적으로 기술]

주요 문의사항: [고객의 구체적인 질문과 요청사항을 상세히 나열]

해결된 내용: [현재까지 제공한 답변, 해결책, 안내사항을 구체적으로 기술]

남은 이슈: [아직 해결되지 않은 문제나 추가 확인이 필요한 사항을 명확히 기술]

고객 감정: [만족/보통/불만/불만족/화남/급함/중립 중 정확히 하나만 선택]

긴급도: [낮음/보통/높음 중 정확히 하나만 선택]

상담 진행 상황: [다음 항목을 포함하여 상세히 작성]
- 초기 접촉 방식과 고객 태도
- 문제 파악 과정에서의 고객 협조도
- 해결책 제시 시 고객 반응
- 대화 중 감정 변화나 특이사항
- 현재 상담 단계 (문제 파악/해결책 제시/해결 완료/추가 지원 필요 등)
- 고객 만족도 변화 추이

추가 정보: [고객이 제공한 특이사항, 중요한 배경 정보, 시스템 환경, 사용 패턴 등을 구체적으로 기술]

후속 조치: [다음에 해야 할 구체적인 액션 아이템을 우선순위와 함께 나열]

**중요: 각 항목의 제목을 정확히 유지하고, 내용은 구체적이고 실용적으로 작성하세요.**`;

            const response = await llmService.sendTextMessageWithResponse(
                sessionId,
                summaryPrompt,
                { silent: true }
            );
            return response.text;
        } catch (error) {
            throw new Error(`Realtime 요약 생성 실패: ${error.message}`);
        }
    }

    async generateSessionReport(llmService, sessionId, options = {}) {
        const { theme = "light", format = "image" } = options; // format: "image" | "html" | "both"

        const summaryText = await this._getStructuredSummaryFromRealtime(
            llmService,
            sessionId
        );

        const summaryResult = {
            sessionId,
            summary: summaryText,
            format: "report",
            timestamp: Date.now(),
            usage: null,
        };

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
            compress = false,
            maxSize = 1024 * 1024,
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

            let imageBuffer = await page.screenshot({
                type: format,
                quality: format === "jpeg" ? quality : undefined,
                fullPage: true,
            });

            // 이미지 크기 확인 및 압축 (옵션)
            if (compress && imageBuffer.length > maxSize) {
                // JPEG로 변환하여 압축 (PNG보다 용량 작음)
                if (format !== "jpeg") {
                    imageBuffer = await page.screenshot({
                        type: "jpeg",
                        quality: Math.max(60, quality - 20), // 품질 조정
                        fullPage: true,
                    });
                }

                // 여전히 크면 크기 축소
                if (imageBuffer.length > maxSize) {
                    const scaleFactor = Math.sqrt(maxSize / imageBuffer.length);
                    const newWidth = Math.floor(width * scaleFactor);
                    const newHeight = Math.floor(height * scaleFactor);

                    await page.setViewport({
                        width: newWidth,
                        height: newHeight,
                        deviceScaleFactor: 1,
                    });

                    imageBuffer = await page.screenshot({
                        type: "jpeg",
                        quality: 60,
                        fullPage: true,
                    });
                }
            }

            return imageBuffer;
        } finally {
            await page.close();
        }
    }

    // 상담 진행 상황 내용 포맷팅
    _formatProgressContent(progressText) {
        if (!progressText) return "";

        // 텍스트를 줄 단위로 분리하고 구조화
        const lines = progressText.split("\n").filter((line) => line.trim());
        let formattedContent = "";

        for (const line of lines) {
            const trimmedLine = line.trim();

            // 불릿 포인트나 대시로 시작하는 항목들
            if (
                trimmedLine.startsWith("-") ||
                trimmedLine.startsWith("•") ||
                trimmedLine.startsWith("*")
            ) {
                const content = trimmedLine.substring(1).trim();
                formattedContent += `<div class="progress-item">${content}</div>`;
            }
            // 카테고리 제목 (콜론으로 끝나는 경우)
            else if (trimmedLine.includes(":") && trimmedLine.length < 50) {
                formattedContent += `<div class="progress-category">${trimmedLine}</div>`;
            }
            // 일반 텍스트
            else if (trimmedLine.length > 0) {
                formattedContent += `<div class="progress-item">${trimmedLine}</div>`;
            }
        }

        // 구조화된 내용이 없으면 원본 텍스트 사용
        return (
            formattedContent ||
            `<div class="progress-item">${progressText}</div>`
        );
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
        .progress-detailed {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 8px;
            border-left: 4px solid #0066cc;
        }
        .progress-item {
            margin-bottom: 12px;
            padding-left: 20px;
            position: relative;
        }
        .progress-item:before {
            content: "▶";
            position: absolute;
            left: 0;
            color: #0066cc;
            font-size: 12px;
        }
        .progress-category {
            font-weight: bold;
            color: #0066cc;
            margin-bottom: 5px;
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
        <div class="section-content progress-detailed">
            ${this._formatProgressContent(parsed.progress)}
        </div>
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
}

module.exports = new SummaryService();

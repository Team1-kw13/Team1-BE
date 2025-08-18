require("dotenv").config();
const OpenAI = require("openai");

class SuggestionService {
    constructor() {
        this.client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
        // 비용 절감 위해 작은 모델 사용
        this.model = "gpt-4o-mini";
    }

    async generate(context = "") {
        const prompt = this._buildPrompt(context);

        try {
            const response = await this.client.chat.completions.create({
                model: this.model,
                messages: [
                    {
                        role: "system",
                        content:
                            "당신은 노인분들을 돕는 친절한 상담 도우미입니다. 대화 맥락을 보고 다음에 물어볼 수 있는 간단한 질문 3개를 추천하십시오.",
                    },
                    {
                        role: "user",
                        content: prompt,
                    },
                ],
                temperature: 0.7,
                max_tokens: 200,
            });

            const text = response.choices[0].message.content;
            return this._parseSuggestions(text);
        } catch (err) {
            console.error("제안 질문 생성 실패:", err.message);
            return [
                "더 자세한 정보가 필요해요",
                "다른 방법도 있나요?",
                "언제까지 가능한가요?",
            ];
        }
    }

    _buildPrompt(context) {
        return `현재 대화 맥락: ${context}

사용자가 이어서 물어볼 수 있는 질문 3개를 만들어주세요.
각 질문은 민원 상담과 관련된 실용적인 내용이어야 하고, 노인분들이 이해하기 쉽게 간단한 표현을 써주세요.

형식:
1. ...
2. ...
3. ...`;
    }

    _parseSuggestions(text) {
        const lines = text.split("\n").map((l) => l.trim());
        const suggestions = [];
        for (const line of lines) {
            const match = line.match(/^\d+\.\s*(.+)$/);
            if (match) suggestions.push(match[1]);
        }
        while (suggestions.length < 3) {
            const defaults = [
                "더 자세한 정보가 필요해요",
                "다른 방법도 있나요?",
                "언제까지 가능한가요?",
            ];
            suggestions.push(defaults[suggestions.length]);
        }
        return suggestions.slice(0, 3);
    }
}

module.exports = new SuggestionService();

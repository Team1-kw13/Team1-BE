require("dotenv").config();
const OpenAI = require("openai");

class SuggestionService {
  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

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
              "당신은 민원 상담 AI입니다. 고객과의 대화 맥락을 보고, 고객이 추가로 물어볼 만한 관련 질문들을 제안해주세요.",
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

위 대화와 관련해서 고객이 AI에게 추가로 물어볼 만한 질문 2개를 제안해주세요.

요구사항:
- 고객이 AI에게 직접 묻는 형식으로 작성
- 구체적이고 실용적인 민원 관련 질문으로만 작성
- 노인분들이 실제로 필요로 할 만한 후속 질문
- 현재 대화 주제의 연관성 있는 심화 질문
- 간단하고 자연스러운 말투, 반말로 (예: "~어떻게 해줘", "~어디서 하는지 알려줘", "~얼마나 걸리는지 말해줘")
- 민원 절차, 준비물, 비용, 시간 등 실무적 내용 중심
- 따옴표 없이 질문만 작성

예시:
- 신분증 없으면 어떻게 하는지 말해줘
- 온라인으로도 신청 가능한지 알려줘
- 수수료 얼마인지 말해줘
- 몇 시까지 접수 가능한지 알려줘
- 대리인이 대신 할 수 있는지 말해줘

형식:
1. ...
2. ...
`;
  }

  _parseSuggestions(text) {
    const lines = text.split("\n").map((l) => l.trim());
    const suggestions = [];
    for (const line of lines) {
      const match = line.match(/^\d+\.\s*(.+)$/);
      if (match) suggestions.push(match[1]);
    }
    while (suggestions.length < 2) {
      const defaults = ["더 자세한 정보가 필요해요", "다른 방법도 있나요?"];
      suggestions.push(defaults[suggestions.length]);
    }
    return suggestions.slice(0, 3);
  }
}

module.exports = new SuggestionService();

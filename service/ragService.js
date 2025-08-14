const openai = require("../config/openai");
const { z } = require("zod");
const { zodTextFormat } = require("openai/helpers/zod");

const VECTOR_STORE_ID = "vs_6896108447848191b1aca6b1aff8310b";

function truncate(s, max = 400) {
    if (!s) return "";
    return s.length > max ? s.slice(0, max) + "\n...[truncated]" : s;
}

class RAGService {
    async searchVectorDB(query, options = {}) {
        const { topK = 3, threshold = 0, maxChars = 400 } = options;
        const results = await this.semanticSearch(query, { topK, maxChars });
        return results
            .filter(
                (r) => (typeof r.score === "number" ? r.score : 0) >= threshold
            )
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    }

    async semanticSearch(query, { topK = 3, maxChars = 400 } = {}) {
        if (typeof VECTOR_STORE_ID !== "string") {
            throw new Error(
                `VECTOR_STORE_ID must be string. got: ${typeof VECTOR_STORE_ID}`
            );
        }

        const SearchItem = z.object({
            file_id: z.string(),
            filename: z.string().nullish(),
            score: z.number().min(0).max(1),
            text: z.string(),
        });

        // 최상위를 object로 감싸기
        const SearchResults = z.object({
            results: z.array(SearchItem).max(topK),
        });

        const resp = await openai.responses.parse({
            model: "gpt-4o-mini",
            tools: [
                { type: "file_search", vector_store_ids: [VECTOR_STORE_ID] },
            ],
            input: [
                {
                    role: "user",
                    content: [
                        {
                            type: "input_text", // 이 환경에선 input_text가 정답
                            text: [
                                `질문: ${query}`,
                                `지시사항:`,
                                `- 첨부된 벡터 스토어에서만 근거를 찾아라.`,
                                `- 관련성이 높은 조각 최대 ${topK}개만 선택.`,
                                `- 각 text는 최대 ${maxChars}자 이내로 요약.`,
                                `- score는 검색 유사도 기반 0~1(근거 없으면 0).`,
                                `- 스키마 외 필드는 절대 추가하지 말 것.`,
                            ].join("\n"),
                        },
                    ],
                },
            ],
            // 최상위 object를 요구하므로 이 스키마를 연결
            text: { format: zodTextFormat(SearchResults, "search_results") },
        });

        const parsed = resp.output_parsed ?? { results: [] };
        const items = parsed.results;

        return items.map((item) => ({
            content:
                (item.text || "").length > maxChars
                    ? String(item.text).slice(0, maxChars) + "\n...[truncated]"
                    : String(item.text || ""),
            score: typeof item.score === "number" ? item.score : 0,
            metadata: {
                source: "OpenAI Vector Store",
                file_id: item.file_id ?? null,
                filename: item.filename ?? null,
            },
        }));
    }

    formatContextForLLM(searchResults, format = "default") {
        if (format === "structured") {
            return {
                sources: searchResults.map((r) => r.metadata.source),
                content: searchResults.map((r) => r.content),
                context: searchResults
                    .map(
                        (r) =>
                            `[출처: ${
                                r.metadata.file_id ?? r.metadata.source
                            }]\n${r.content}`
                    )
                    .join("\n\n"),
            };
        }
        return searchResults
            .map(
                (r) =>
                    `[출처: ${r.metadata.file_id ?? r.metadata.source}]\n${
                        r.content
                    }`
            )
            .join("\n\n");
    }
}

module.exports = new RAGService();

const openai = require("../config/openai");

const VECTOR_STORE_ID = "vs_6896108447848191b1aca6b1aff8310b";

function truncate(s, max = 400) {
    if (!s) return "";
    return s.length > max ? s.slice(0, max) + "\n...[truncated]" : s;
}

function safeParseJSON(text) {
    try {
        return JSON.parse(text);
    } catch (_) {
        return null;
    }
}

class RAGService {
    async searchVectorDB(query, options = {}) {
        const {
            topK = 3, // 최대 스니펫 개수
            threshold = 0,
            maxChars = 400, // 스니펫 길이 제한
        } = options;

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

        const prompt = [
            `질문: ${query}`,
            "",
            "지침:",
            `- 첨부된 벡터 스토어에서 질문과 가장 관련성이 높은 텍스트 조각만 반환.`,
            `- 반드시 JSON 배열만 출력. 형식: [{"file_id":"...", "score":0~1, "text":"..."}]`,
            `- 최대 개수: ${topK}, 각 text 최대 ${maxChars}자.`,
            "- 설명/서문/코드블록/기타 문구 금지. JSON 이외 어떤 것도 출력 금지.",
        ].join("\n");

        const resp = await openai.responses.create({
            model: "gpt-4o-mini",
            tools: [
                {
                    type: "file_search",
                    vector_store_ids: [VECTOR_STORE_ID],
                    max_num_results: topK,
                },
            ],
            tool_choice: { type: "file_search" },
            input: [
                {
                    role: "user",
                    content: [{ type: "input_text", text: prompt }],
                },
            ],
        });

        const rawText =
            resp.output_text ||
            resp.output?.[0]?.content?.find((c) => c.type === "output_text")
                ?.text ||
            "";

        const parsed = safeParseJSON(rawText);
        if (Array.isArray(parsed) && parsed.length) {
            return parsed.slice(0, topK).map((item) => ({
                content: truncate(String(item.text || ""), maxChars),
                score: typeof item.score === "number" ? item.score : 0,
                metadata: {
                    source: "OpenAI Vector Store",
                    file_id: item.file_id || null,
                    filename: item.filename || null,
                },
            }));
        }

        const hits = [];
        const outputs = Array.isArray(resp.output) ? resp.output : [];
        for (const out of outputs) {
            const parts = Array.isArray(out.content) ? out.content : [];
            for (const part of parts) {
                if (!Array.isArray(part.annotations)) continue;
                for (const ann of part.annotations) {
                    if (ann?.type === "file_citation") {
                        const fileId = ann.file_citation?.file_id || null;
                        const quote =
                            ann.file_citation?.quote ||
                            (typeof part.text === "string" &&
                            Number.isInteger(ann.start_index) &&
                            Number.isInteger(ann.end_index)
                                ? part.text.slice(
                                      ann.start_index,
                                      ann.end_index
                                  )
                                : "");
                        if (fileId || quote) {
                            hits.push({
                                content: truncate(quote || "", maxChars),
                                score: 0,
                                metadata: {
                                    source: "OpenAI Vector Store",
                                    file_id: fileId,
                                },
                            });
                        }
                    }
                }
            }
        }

        if (hits.length) {
            const uniq = [];
            const seen = new Set();
            for (const h of hits) {
                const key = `${h.metadata.file_id}|${h.content}`;
                if (!seen.has(key)) {
                    uniq.push(h);
                    seen.add(key);
                }
            }
            return uniq.slice(0, topK);
        }

        return [];
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

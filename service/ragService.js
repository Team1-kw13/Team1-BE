const openai = require("../config/openai");

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

        const search_result = await openai.vectorStores.search(VECTOR_STORE_ID, {
            query: query,
            max_num_results: topK,
            rewrite_query: true
        });

        const obj = {
            file_id: "",
            filename: "",
            score: 0,
            text: "",
        };
        let items = [];
        search_result.data.forEach((data) => {
            obj.file_id = data.file_id;
            obj.filename = data.filename;
            obj.score = data.score;
            data.content.forEach((item) => {
                obj.text += item.text;
            });
            items.push(obj);
        });

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

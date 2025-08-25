const openai = require("../config/openai");

// Vector Store ID 분리
const VECTOR_STORE_IDS = {
  DISTRICT_OFFICE: process.env.VECTOR_STORE_DISTRICT_OFFICE, // 동사무소
  FAQ: process.env.VECTOR_STORE_FAQ, // FAQ용
};

class RAGService {
  async searchVectorDB(query, options = {}) {
    const { topK = 3, threshold = 0, maxChars = 400 } = options;
    const results = await this.semanticSearch(query, { topK, maxChars });
    return results
      .filter((r) => (typeof r.score === "number" ? r.score : 0) >= threshold)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  async semanticSearch(
    query,
    {
      topK = 3,
      maxChars = 400,
      vectorStoreId = VECTOR_STORE_IDS.DISTRICT_OFFICE,
    } = {}
  ) {
    const targetVectorStoreId = vectorStoreId;

    if (
      typeof targetVectorStoreId !== "string" ||
      targetVectorStoreId.length === 0
    ) {
      throw new Error(
        `vectorStoreId must be a non-empty string. got: ${String(
          targetVectorStoreId
        )}`
      );
    }

    let search_result;
    try {
      search_result = await openai.vectorStores.search(targetVectorStoreId, {
        query: query,
        max_num_results: topK,
        rewrite_query: false,
      });

      if (search_result?.data?.length > 0) {
      }
    } catch (error) {
      console.error(
        `Vector Store 검색 오류 (${targetVectorStoreId}):`,
        error.message
      );
      throw error;
    }

    const items = (
      Array.isArray(search_result?.data) ? search_result.data : []
    ).map((data) => {
      const text = Array.isArray(data?.content)
        ? data.content
            .map((c) => (typeof c?.text === "string" ? c.text : ""))
            .join("")
        : "";
      return {
        file_id: data?.file_id ?? null,
        filename: data?.filename ?? null,
        score: typeof data?.score === "number" ? data.score : 0,
        text,
      };
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
              `[출처: ${r.metadata.file_id ?? r.metadata.source}]\n${r.content}`
          )
          .join("\n\n"),
      };
    }
    return searchResults
      .map(
        (r) =>
          `[출처: ${r.metadata.file_id ?? r.metadata.source}]\n${r.content}`
      )
      .join("\n\n");
  }

  async searchCoolingCenter(userCoord = null, options = {}) {
    const { topK = 3, threshold = 0, maxChars = 400 } = options;

    let searchQuery = "";
    if (userCoord && Array.isArray(userCoord) && userCoord.length >= 2) {
      const [latRaw, lonRaw] = userCoord;
      const lat = Number(latRaw);
      const lon = Number(lonRaw);
      const isFiniteCoord = Number.isFinite(lat) && Number.isFinite(lon);
      if (isFiniteCoord && (lat !== 0 || lon !== 0)) {
        searchQuery = ` 위치: 위도 ${lat}, 경도 ${lon} 근처`;
      } else {
        searchQuery = `노원구`;
      }
    } else {
      searchQuery = `노원구`;
    }

    // RAG 문서 준비되기 전까지는 주변 동사무소로 안내.
    const results = await this.semanticSearch(searchQuery, {
      topK,
      maxChars,
      vectorStoreId: VECTOR_STORE_IDS.DISTRICT_OFFICE,
    });

    return results
      .filter((r) => (typeof r.score === "number" ? r.score : 0) >= threshold)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  // 동사무소 전용 검색
  async searchDistrictOffice(query, userCoord = null, options = {}) {
    const { topK = 3, threshold = 0, maxChars = 400 } = options;

    // 사용자 위치가 있으면 쿼리에 위치 정보 추가
    let searchQuery = query;
    if (userCoord && Array.isArray(userCoord) && userCoord.length >= 2) {
      const [latRaw, lonRaw] = userCoord;
      const lat = Number(latRaw);
      const lon = Number(lonRaw);
      const isFiniteCoord = Number.isFinite(lat) && Number.isFinite(lon);
      if (isFiniteCoord && (lat !== 0 || lon !== 0)) {
        searchQuery = `${query} 위치: 위도 ${lat}, 경도 ${lon} 근처`;
      } else {
        searchQuery = `${query} 노원구`;
      }
    } else {
      // 좌표가 없는 경우에도 노원구 기본 설정
      searchQuery = `${query} 노원구`;
    }

    const results = await this.semanticSearch(searchQuery, {
      topK,
      maxChars,
      vectorStoreId: VECTOR_STORE_IDS.DISTRICT_OFFICE,
    });

    // 노원구 결과 우선순위 적용
    const prioritizedResults = this._prioritizeNowonResults(results);

    return prioritizedResults
      .filter((r) => (typeof r.score === "number" ? r.score : 0) >= threshold)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  // 노원구 결과 우선순위 적용
  _prioritizeNowonResults(results) {
    return results.map((result) => {
      const content = result.content || "";
      const isNowonRelated = /노원구|노원|상계|중계|월계|공릉|하계/.test(
        content
      );

      if (isNowonRelated) {
        // 노원구 관련 결과는 점수를 약간 높여줌
        result.score = Math.min((result.score || 0) + 0.1, 1.0);
      }

      return result;
    });
  }

  // FAQ 전용 검색
  async searchFAQ(query, options = {}) {
    const { topK = 3, threshold = 0, maxChars = 400 } = options;

    const results = await this.semanticSearch(query, {
      topK,
      maxChars,
      vectorStoreId: VECTOR_STORE_IDS.FAQ,
    });

    return results
      .filter((r) => (typeof r.score === "number" ? r.score : 0) >= threshold)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }
}

module.exports = new RAGService();

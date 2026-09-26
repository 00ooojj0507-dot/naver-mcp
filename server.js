// server.js
// 네이버 지역검색 API를 호출하는 원격 MCP 서버
// Render 같은 곳에 올려서 HTTP로 서비스하면, PC/폰 어디서든 Claude가 접속 가능합니다.

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ── 1. 환경변수로 인증 모드를 명시적으로 선택 ──────────────────────────────
// "classic" : 네이버 개발자센터(openapi.naver.com)에서 발급받은 키
// "apihub"  : 네이버클라우드플랫폼 콘솔(NAVER API HUB)에서 발급받은 키
// → 두 방식은 엔드포인트와 헤더 이름이 다르므로, 절대 섞어 쓰지 않도록
//   모드를 코드에서 강제로 분기시킵니다. (401 오류의 가장 흔한 원인)
const NAVER_API_MODE = (process.env.NAVER_API_MODE || "classic").toLowerCase();
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
  console.error("[설정 오류] NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 없습니다.");
  process.exit(1);
}
if (!["classic", "apihub"].includes(NAVER_API_MODE)) {
  console.error(`[설정 오류] NAVER_API_MODE는 "classic" 또는 "apihub"여야 합니다. (현재: ${NAVER_API_MODE})`);
  process.exit(1);
}

// ── 2. 모드별 요청 정보 조립 ────────────────────────────────────────────
function buildRequest(query, display, sort) {
  const params = new URLSearchParams({
    query,
    display: String(display),
    start: "1", // 지역검색은 페이징(start) 미지원 — 항상 1 고정
    sort,
  });

  if (NAVER_API_MODE === "classic") {
    return {
      url: `https://openapi.naver.com/v1/search/local.json?${params.toString()}`,
      headers: {
        "X-Naver-Client-Id": NAVER_CLIENT_ID,
        "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
      },
    };
  }
  // apihub 모드
  return {
    url: `https://naverapihub.apigw.ntruss.com/search/v1/local?${params.toString()}`,
    headers: {
      "X-NCP-APIGW-API-KEY-ID": NAVER_CLIENT_ID,
      "X-NCP-APIGW-API-KEY": NAVER_CLIENT_SECRET,
    },
  };
}

// ── 3. 네이버 에러 응답을 사람이 이해할 메시지로 변환 ─────────────────────
// 두 모드는 에러 바디 형태가 다릅니다:
//   classic : { errorMessage, errorCode }
//   apihub  : 게이트웨이 오류 { error: { errorCode, message, details } }
//             또는 파라미터 오류 { errorCode, errorMessage }
function explainError(status, body) {
  let detail = "";
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message || parsed?.errorMessage || body;
  } catch {
    detail = body;
  }

  if (status === 401) {
    return (
      `인증 실패(401): ${detail}\n` +
      `→ 지금 NAVER_API_MODE="${NAVER_API_MODE}"로 호출 중입니다. ` +
      (NAVER_API_MODE === "classic"
        ? "이 키가 네이버 '개발자센터'(developers.naver.com)에서 발급받은 것이 맞는지 확인하세요. " +
          "네이버클라우드플랫폼(API HUB)에서 발급받은 키라면 NAVER_API_MODE=apihub로 바꿔야 합니다."
        : "이 키가 '네이버클라우드플랫폼 콘솔'(NAVER API HUB)에서 발급받은 것이 맞는지 확인하세요. " +
          "개발자센터에서 발급받은 키라면 NAVER_API_MODE=classic으로 바꿔야 합니다.")
    );
  }
  if (status === 403) {
    return `요청 거부(403): ${detail}\n→ HTTPS로 호출했는지, 필수 파라미터가 빠지지 않았는지 확인하세요.`;
  }
  if (status === 429) {
    return `호출 한도 초과(429): ${detail}\n→ 지역검색 API는 하루 25,000회 제한이 있습니다. 잠시 후 다시 시도하세요.`;
  }
  if (status === 400) {
    return `요청 오류(400): ${detail}\n→ display 값은 1~5 범위만 허용됩니다.`;
  }
  return `네이버 API 오류(${status}): ${detail}`;
}

// ── 4. MCP 서버 정의 ───────────────────────────────────────────────────
function createServer() {
  const server = new McpServer({ name: "naver-local-search", version: "1.0.0" });

  server.registerTool(
    "search_local",
    {
      title: "네이버 지역 검색",
      description: "네이버 지역 서비스에 등록된 업체/기관을 검색합니다 (예: '정자동 카페').",
      inputSchema: {
        query: z.string().min(1).describe("검색어 (예: '강남역 맛집')"),
        display: z.number().int().min(1).max(5).default(5).describe("결과 개수 (1~5)"),
        sort: z
          .enum(["random", "comment"])
          .default("random")
          .describe("random: 정확도순 / comment: 리뷰 많은 순"),
      },
    },
    async ({ query, display, sort }) => {
      const { url, headers } = buildRequest(query, display, sort);

      let res;
      try {
        res = await fetch(url, { headers });
      } catch (networkErr) {
        return {
          content: [{ type: "text", text: `네이버 서버에 연결하지 못했습니다: ${networkErr.message}` }],
          isError: true,
        };
      }

      const bodyText = await res.text();

      if (!res.ok) {
        return {
          content: [{ type: "text", text: explainError(res.status, bodyText) }],
          isError: true,
        };
      }

      const data = JSON.parse(bodyText);
      if (!data.items || data.items.length === 0) {
        return { content: [{ type: "text", text: `"${query}"에 대한 검색 결과가 없습니다.` }] };
      }

      // 결과를 사람이 읽기 좋은 텍스트로 정리 (HTML 태그 <b> 제거)
      const strip = (s) => s.replace(/<[^>]*>/g, "");
      const lines = data.items.map((item, i) => {
        return (
          `${i + 1}. ${strip(item.title)} (${item.category})\n` +
          `   주소: ${item.roadAddress || item.address}\n` +
          `   링크: ${item.link}`
        );
      });

      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );

  return server;
}

// ── 5. Express + Streamable HTTP 전송 (Claude가 폰/PC에서 접속하는 경로) ──
const app = express();
app.use(express.json());

// Render의 헬스체크/콜드스타트 확인용 — 배포 후 살아있는지 확인하는 용도
app.get("/health", (_req, res) => res.status(200).send("ok"));

app.post("/mcp", async (req, res) => {
  // 매 요청마다 새 서버/전송 인스턴스를 만드는 "stateless" 모드.
  // 다중 사용자·서버리스 환경(Render 등)에서 가장 안전한 방식입니다.
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MCP 서버 실행 중 (포트 ${PORT}, 모드: ${NAVER_API_MODE})`);
});

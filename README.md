# 네이버 지역검색 MCP 서버

## 1. 로직 구조

```
Claude 앱(폰/PC) → HTTPS 요청 → Render 서버(/mcp) → 네이버 검색 API → 결과 반환
```

- `/mcp` 엔드포인트가 MCP 프로토콜을 처리하는 부분 (Streamable HTTP 방식)
- `search_local` 도구가 실제로 네이버 API를 호출하는 부분
- 이 서버는 상태를 저장하지 않는(stateless) 구조라, 여러 사람/여러 기기가 동시에 접속해도 안전합니다.

## 2. 로컬 테스트

```bash
npm install
cp .env.example .env   # 값 채우기
npm start
```

`http://localhost:3000/health` 가 "ok"를 반환하면 정상.

## 3. Render 배포

1. 이 폴더를 GitHub 저장소에 push
2. Render → New → Web Service → 해당 저장소 연결
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Environment → 아래 변수 추가:
   - `NAVER_API_MODE`
   - `NAVER_CLIENT_ID`
   - `NAVER_CLIENT_SECRET`
6. 배포 완료 후 Claude 커스텀 커넥터에 `https://<서비스이름>.onrender.com/mcp` 등록

## 4. 네이버 API 조사 결과 — 반드시 확인할 주의사항

**(1) 인증 방식이 두 종류입니다 (401의 가장 흔한 원인)**

| | 개발자센터(classic) | NAVER API HUB(apihub) |
|---|---|---|
| 키 발급처 | developers.naver.com | 네이버클라우드플랫폼 콘솔 |
| 엔드포인트 | openapi.naver.com/v1/search/local.json | naverapihub.apigw.ntruss.com/search/v1/local |
| 인증 헤더 | X-Naver-Client-Id / X-Naver-Client-Secret | X-NCP-APIGW-API-KEY-ID / X-NCP-APIGW-API-KEY |

→ 키를 어디서 발급받았는지에 맞춰 `.env`의 `NAVER_API_MODE`를 정확히 맞춰야 합니다. 이전에 겪으신 401 오류는 대부분 이 조합이 어긋나서 발생합니다.

**(2) 그 외 401 체크리스트**
- 애플리케이션 등록 시 "검색" API 사용 권한을 켰는지
- 키를 URL 파라미터가 아니라 HTTP 헤더로 보내고 있는지 (코드에는 이미 반영됨)

**(3) 지역검색 API 자체의 제약**
- `display`는 최대 5까지 (다른 검색 API와 달리 100 아님)
- `start`(페이징)는 지원되지 않음 — 항상 1
- 하루 호출 한도 25,000회 → 초과 시 429
- HTTP(비암호화)로 호출하면 403 — 반드시 HTTPS

**(4) Render 무료 플랜 특성 (폰에서 쓸 때 체감되는 부분)**
- 일정 시간 요청이 없으면 서버가 잠들어서, 오랜만에 폰에서 호출하면 첫 응답이 수십 초 걸릴 수 있습니다.
- 유료 플랜으로 올리거나, 외부에서 주기적으로 `/health`를 핑(ping)하면 완화됩니다.

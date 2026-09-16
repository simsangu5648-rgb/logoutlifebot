// 30일 리부트 챌린지 기록을 구글시트에 실시간으로 쌓는 모듈.
//
// 환경변수(REBOOT_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)가
// 하나라도 없으면 조용히 건너뜁니다 — 이 기능을 설정하지 않아도 봇의 다른 기능(구매/워터마크/
// 랜딩페이지 등)은 전혀 영향받지 않습니다. 설정 방법은 docs/google-sheets-setup.md 참고.
const { google } = require("googleapis");

const SHEET_ID = process.env.REBOOT_SHEET_ID || "";
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
// Railway 등 환경변수 입력창은 줄바꿈을 그대로 못 받는 경우가 많아서, 개인키를
// "\n" 문자열로 이스케이프해서 넣는 걸 기준으로 하고 여기서 실제 줄바꿈으로 되돌립니다.
const SERVICE_ACCOUNT_PRIVATE_KEY = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const SHEET_TAB_NAME = process.env.REBOOT_SHEET_TAB_NAME || "리부트챌린지기록";
const TZ = process.env.TIMEZONE || "Asia/Seoul";

function isConfigured() {
  return !!(SHEET_ID && SERVICE_ACCOUNT_EMAIL && SERVICE_ACCOUNT_PRIVATE_KEY);
}

let warnedMissingConfig = false;
let sheetsClientPromise = null;
let headerEnsured = false;

async function getSheetsClient() {
  if (!sheetsClientPromise) {
    const auth = new google.auth.JWT({
      email: SERVICE_ACCOUNT_EMAIL,
      key: SERVICE_ACCOUNT_PRIVATE_KEY,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    sheetsClientPromise = auth.authorize().then(() => google.sheets({ version: "v4", auth }));
  }
  return sheetsClientPromise;
}

// 탭 맨 위에 헤더 행이 없으면 한 번만 만들어둡니다.
async function ensureHeader(sheets) {
  if (headerEnsured) return;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!A1:H1`,
    });
    if (!res.data.values || !res.data.values.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_TAB_NAME}!A1:H1`,
        valueInputOption: "RAW",
        requestBody: {
          values: [["시각(KST)", "디스코드ID", "닉네임", "유형", "Day", "날짜", "내용", "위기감지"]],
        },
      });
    }
    headerEnsured = true;
  } catch (e) {
    console.error("[구글시트] 헤더 확인/생성 실패 (다음 기록 때 다시 시도합니다):", e.message || e);
  }
}

// 리부트 챌린지 이벤트 한 건을 시트에 한 줄 추가합니다.
// event: { discordUserId, label, type, day, date, text, crisisDetected }
// 실패해도 절대 예외를 던지지 않습니다 — 이 함수 때문에 참가자 응답이 막히면 안 되므로,
// 호출하는 쪽에서 await 없이 부르고 .catch()만 붙이는 걸 권장합니다.
async function appendRebootEvent(event) {
  if (!isConfigured()) {
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      console.warn(
        "[구글시트] REBOOT_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY 중 " +
          "설정 안 된 게 있어서 시트 기록 기능을 건너뜁니다. (docs/google-sheets-setup.md 참고)"
      );
    }
    return;
  }
  try {
    const sheets = await getSheetsClient();
    await ensureHeader(sheets);
    const nowKST = new Intl.DateTimeFormat("ko-KR", {
      timeZone: TZ,
      dateStyle: "short",
      timeStyle: "medium",
    }).format(new Date());
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!A:H`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [
          [
            nowKST,
            event.discordUserId || "",
            event.label || "",
            event.type || "",
            event.day ?? "",
            event.date || "",
            (event.text || "").slice(0, 4900), // 구글시트 셀 글자수 한도(5만자)보다 훨씬 여유있게 컷
            event.crisisDetected ? "Y" : "",
          ],
        ],
      },
    });
  } catch (e) {
    console.error("[구글시트] 기록 실패 (봇 동작에는 영향 없음):", e.message || e);
  }
}

module.exports = { appendRebootEvent, isConfigured };

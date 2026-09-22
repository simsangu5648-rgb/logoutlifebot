// 아주 단순한 JSON 파일 기반 저장소.
// 소규모 커뮤니티 봇이라 별도 DB 없이 파일 하나로 충분합니다.
// 나중에 사용자가 많아지면 sqlite/postgres로 옮기면 됩니다.

const fs = require("fs");
const path = require("path");

// Railway 등에 영구 저장공간(Volume)이 마운트되어 있으면 그 경로에 저장합니다.
// (DATA_DIR 환경변수로 지정, 기본값 /data — 배포할 때마다 데이터가 초기화되는 것을 막기 위함)
// 마운트된 경로가 없으면(로컬 개발 등) 기존처럼 프로젝트 폴더에 저장합니다.
const DATA_DIR = process.env.DATA_DIR || "/data";
const DATA_PATH = fs.existsSync(DATA_DIR)
  ? path.join(DATA_DIR, "data.json")
  : path.join(__dirname, "..", "data.json");

function load() {
  if (!fs.existsSync(DATA_PATH)) {
    return {
      users: {},
      processedPayments: {},
      convoStarterIndex: 0,
      confessionResponseIndex: 0,
      confessionRelays: {},
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
    if (!parsed.processedPayments) parsed.processedPayments = {};
    if (typeof parsed.convoStarterIndex !== "number") parsed.convoStarterIndex = 0;
    if (typeof parsed.confessionResponseIndex !== "number") parsed.confessionResponseIndex = 0;
    if (!parsed.confessionRelays) parsed.confessionRelays = {};
    return parsed;
  } catch (e) {
    console.error("[store] data.json 파싱 실패, 빈 상태로 시작합니다.", e);
    return {
      users: {},
      processedPayments: {},
      convoStarterIndex: 0,
      confessionResponseIndex: 0,
      confessionRelays: {},
    };
  }
}

let state = load();

function save() {
  // 임시 파일에 쓴 뒤 rename → 쓰다가 죽어도 파일이 깨지지 않도록.
  const tmp = DATA_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_PATH);
}

function getUser(userId) {
  if (!state.users[userId]) {
    state.users[userId] = {
      cumulativeCount: 0,
      lastCheckInDate: null, // YYYY-MM-DD (KST 기준)
      joinedAt: null, // ISO string, 최초 캐시
      dmFlags: {
        // 결제 전환 시퀀스 (가입 D+25/32/40) - 간격을 고르게(7일, 8일) 벌려서
        // 뒤로 갈수록 재촉하는 느낌이 들지 않게 했습니다.
        d25: false,
        d32: false,
        d40: false,
        // 온보딩 미션 시퀀스 (가입 D+1/3/7)
        o1: false,
        o3: false,
        o7: false,
      },
      lastInactivityNudgeDate: null,

      // ── 데일리 스트릭 대시보드 ──
      currentStreak: 0,
      longestStreak: 0,
      lastStreakReminderDate: null, // 스트릭 끊기기 전 리마인더 중복 발송 방지 (YYYY-MM-DD)

      // ── 월간 리포트 카드 ──
      monthlyCounts: {}, // { "2026-08": 12, ... }
      lastMonthlyReportMonth: null, // 이미 리포트를 보낸 달 (YYYY-MM), 중복 발송 방지

      // ── 승급 알림 & 배지 시스템 ──
      publicAnnounceOptOut: false, // true면 공개 채널 승급 축하 메시지에서 제외

      // ── 즉시반응 시스템 (SOS 헬퍼 알림 쿨다운) ──
      lastHelperPingAt: null, // ISO string, 너무 자주 헬퍼로 호출되지 않도록

      // ── 멘토 하이라이트 시스템 ──
      weeklyHelperPoints: 0, // 주간 집계, 하이라이트 발표 후 0으로 리셋
      totalHelperPoints: 0, // 누적 (추후 랭킹 페이지용)

      // ── 전자책 구매 (그로우-크루 자동 승급) ──
      ebookPurchased: false, // true가 되는 즉시 그로우-크루로 승급
      ebookPurchasedAt: null, // ISO string, 구매(승급) 확정 시각

      // ── SOS 트리거 기록 ──
      sosTriggers: [], // [{ date: "2026-08-23", note: "..." }, ...]
      awaitingTriggerReply: false, // SOS 직후 "뭐 때문에 그랬는지" 질문에 대한 답을 기다리는 중인지
      triggerPromptSentAt: null, // ISO string, 질문 보낸 시각 (응답 대기 만료 판단용)

      // ── 스트릭 프리즈권 (한 달에 한 번, 하루 빠져도 연속기록 유지) ──
      streakFreezesUsedThisMonth: 0,
      lastStreakFreezeMonth: null, // YYYY-MM, 프리즈권이 갱신된 달

      // ── 주간 팁 & 회고 ──
      lastWeeklyTipWeek: null, // ISO 주차 (YYYY-Www), 중복 발송 방지
      lastWeeklyReflectionWeek: null,
      awaitingReflectionReply: false,
      reflectionPromptSentAt: null,
      reflections: [], // [{ week: "2026-W34", text: "..." }, ...]

      // ── 고해성사 (판단 없이 마음속 얘기를 DM으로 편하게 털어놓는 기능) ──
      // 내용 자체는 저장하지 않습니다 (가장 취약한 순간의 글이 영구 보관되는 걸
      // 막기 위함) — 언제, 몇 번 이용했는지만 남겨서 필요하면 나중에 참고할 수 있게 합니다.
      awaitingConfessionReply: false,
      confessionPromptSentAt: null,
      confessionCount: 0,
      lastConfessionAt: null, // ISO string

      // ── 30일 리부트 챌린지 (전자책 구매자 대상 데일리 DM 챌린지) ──
      rebootChallenge: {
        active: false,
        status: null, // null | 'pending_day0' | 'in_progress' | 'completed' | 'failed' | 'opted_out'
        attemptNumber: 0, // 몇 번째 시도인지 (재도전 이력 추적용)
        startDate: null, // YYYY-MM-DD (KST), 이번 시도의 Day 0 발송일
        currentDay: 0, // 0~31
        selfCompassionNote: null, // Day 0에 적은, 무너졌을 때 나에게 해줄 말
        awaitingCheckinReply: false,
        checkinPromptSentAt: null,
        pendingCatchupDay: null, // 하루 유예 중인, 아직 결번 확정 전인 날짜
        reminderSentToday: false,
        missedDays: [], // 영구 결번된 일자 배열 (길이 3이면 실패)
        formulas: [], // Day 8에 확정한 If-Then 공식 (최대 5개, 원문 그대로)
        entries: [], // 매일 기록: { day, date, rawText, catchup?, alsoCoversDay?, createdAt }
        day7DigestSentAt: null, // Day7 다이제스트를 운영자에게 보낸 시각 (중복 발송 방지)
        day31DigestSentAt: null, // Day31 다이제스트를 운영자에게 보낸 시각 (중복 발송 방지)
        day6NotifiedAt: null, // Day6 완료 실시간 알림을 운영자에게 보낸 시각
        day29NotifiedAt: null, // Day29 완료 실시간 알림을 운영자에게 보낸 시각
        day7AnalysisSentAt: null, // 운영자가 !챌린지분석으로 Day7 분석을 참가자에게 전달한 시각
        day31AnalysisSentAt: null, // 운영자가 !챌린지분석으로 Day31(최종) 분석을 참가자에게 전달한 시각
        masterCrewGrantedAt: null, // 최초 완주로 마스터-크루 승급한 시각 (중복 승급 방지)
        completedAt: null,
        failedAt: null,
        optedOutAt: null,
        cooldownUntil: null, // YYYY-MM-DD, 실패 후 이 날짜부터 재시작 가능
      },

      // ── 매달 30일 챌린지 (금딸챌린지 — 매달 1일부터 도는 공개 코호트 이벤트) ──
      // 30일 리부트 챌린지(위)와는 완전히 별개입니다. 재발해도 스트릭을 0으로
      // 되돌리지 않고, "이번 달 성공한 날 수"를 누적으로만 카운트합니다
      // (sim님 요청, 2026-09 — 재발 한 번에 그동안 버틴 날이 날아가지 않도록).
      monthlyChallenge: {
        active: false, // 이 챌린지에 참가 중인지 (한 번 참가하면 매달 자동으로 이어짐)
        monthKey: null, // "YYYY-MM", 지금 추적 중인 달
        joinedAt: null, // ISO string, 최초 참가 시각
        successDays: 0, // 이번 달 누적 성공일수 (재발해도 절대 안 깎임)
        lastCheckinDate: null, // YYYY-MM-DD (KST), 오늘자 체크인 중복 반영 방지
        awaitingCheckinReply: false,
        checkinPromptSentAt: null,
        reminderSentToday: false,
        completedThisMonth: false, // 이번 달 30일 다 채웠는지 (퍼펙트 완주)
        completedAt: null, // ISO string
        completedMonthsTotal: 0, // 영구 누적 완주 개월 수 — 등급 산정 기준, 절대 리셋 안 됨
        rankTierIndex: 0, // 현재 등급 인덱스 (index.js의 RANK_LADDER 배열 인덱스)
      },

      // ── 신규 참가자 모집 DM (아직 신청 안 한 멤버에게 매달 마지막 주에 먼저 물어보는 흐름) ──
      // null이면 진행 중인 모집 대화가 없다는 뜻. { promptSentAt, stage: "asked"|"confirmed" }
      monthlyChallengeRecruit: null,
    };
    save();
  }
  const user = state.users[userId];
  // 기존에 저장된(구버전) 유저 데이터에 새 필드가 없을 수 있으니 안전하게 채워줌
  if (user.dmFlags && user.dmFlags.o1 === undefined) {
    user.dmFlags.o1 = false;
    user.dmFlags.o3 = false;
    user.dmFlags.o7 = false;
  }
  if (user.currentStreak === undefined) user.currentStreak = 0;
  if (user.longestStreak === undefined) user.longestStreak = 0;
  if (user.lastStreakReminderDate === undefined) user.lastStreakReminderDate = null;
  if (user.monthlyCounts === undefined) user.monthlyCounts = {};
  if (user.lastMonthlyReportMonth === undefined) user.lastMonthlyReportMonth = null;
  if (user.publicAnnounceOptOut === undefined) user.publicAnnounceOptOut = false;
  if (user.lastHelperPingAt === undefined) user.lastHelperPingAt = null;
  if (user.weeklyHelperPoints === undefined) user.weeklyHelperPoints = 0;
  if (user.totalHelperPoints === undefined) user.totalHelperPoints = 0;
  if (user.ebookPurchased === undefined) user.ebookPurchased = false;
  if (user.ebookPurchasedAt === undefined) user.ebookPurchasedAt = null;
  if (user.sosTriggers === undefined) user.sosTriggers = [];
  if (user.awaitingTriggerReply === undefined) user.awaitingTriggerReply = false;
  if (user.triggerPromptSentAt === undefined) user.triggerPromptSentAt = null;
  if (user.streakFreezesUsedThisMonth === undefined) user.streakFreezesUsedThisMonth = 0;
  if (user.lastStreakFreezeMonth === undefined) user.lastStreakFreezeMonth = null;
  if (user.lastWeeklyTipWeek === undefined) user.lastWeeklyTipWeek = null;
  if (user.lastWeeklyReflectionWeek === undefined) user.lastWeeklyReflectionWeek = null;
  if (user.awaitingReflectionReply === undefined) user.awaitingReflectionReply = false;
  if (user.reflectionPromptSentAt === undefined) user.reflectionPromptSentAt = null;
  if (user.reflections === undefined) user.reflections = [];
  if (user.awaitingConfessionReply === undefined) user.awaitingConfessionReply = false;
  if (user.confessionPromptSentAt === undefined) user.confessionPromptSentAt = null;
  if (user.confessionCount === undefined) user.confessionCount = 0;
  if (user.lastConfessionAt === undefined) user.lastConfessionAt = null;
  if (user.rebootChallenge === undefined) {
    user.rebootChallenge = {
      active: false,
      status: null,
      attemptNumber: 0,
      startDate: null,
      currentDay: 0,
      selfCompassionNote: null,
      awaitingCheckinReply: false,
      checkinPromptSentAt: null,
      pendingCatchupDay: null,
      reminderSentToday: false,
      missedDays: [],
      formulas: [],
      entries: [],
      day7DigestSentAt: null,
      day31DigestSentAt: null,
      day6NotifiedAt: null,
      day29NotifiedAt: null,
      day7AnalysisSentAt: null,
      day31AnalysisSentAt: null,
      masterCrewGrantedAt: null,
      completedAt: null,
      failedAt: null,
      optedOutAt: null,
      cooldownUntil: null,
    };
  }
  if (user.monthlyChallenge === undefined) {
    user.monthlyChallenge = {
      active: false,
      monthKey: null,
      joinedAt: null,
      successDays: 0,
      lastCheckinDate: null,
      awaitingCheckinReply: false,
      checkinPromptSentAt: null,
      reminderSentToday: false,
      completedThisMonth: false,
      completedAt: null,
      completedMonthsTotal: 0,
      rankTierIndex: 0,
    };
  }
  if (user.monthlyChallengeRecruit === undefined) user.monthlyChallengeRecruit = null;
  return user;
}

function updateUser(userId, patch) {
  const user = getUser(userId);
  Object.assign(user, patch);
  save();
  return user;
}

function allUserIds() {
  return Object.keys(state.users);
}

// ── PayApp 웹훅 중복 처리 방지 ──────────────────────────────
// PayApp은 같은 결제건에 대해 feedbackurl을 여러 번 재호출할 수 있으므로,
// mul_no(결제요청번호) 단위로 이미 처리한 결제인지 기록해둡니다.
function isPaymentProcessed(mulNo) {
  return !!state.processedPayments[String(mulNo)];
}

function markPaymentProcessed(mulNo) {
  state.processedPayments[String(mulNo)] = new Date().toISOString();
  save();
}

// ── 채널 대화거리(먼저 말 걸기) 순번 ──────────────────────────
// 부르는 순서대로 0,1,2,3...을 반환하는 단순 증가 카운터입니다. 실제로 어떤
// 풀(가벼운 질문/깊은 질문)에서 몇 번째 항목을 쓸지는 index.js에서 이 값을
// 나눠서(% 풀 길이) 계산합니다 — 재배포/재시작돼도 이어서 순환하도록, 값
// 자체를 data.json에 영구 저장합니다.
function nextConvoStarterIndex() {
  const n = state.convoStarterIndex || 0;
  state.convoStarterIndex = n + 1;
  save();
  return n;
}

// ── 고해성사 응답 문구 순번 ────────────────────────────────────
// convoStarterIndex와 같은 방식 — 어떤 문구 풀에서 몇 번째 항목을 쓸지는
// index.js에서 이 값을 나눠서(% 풀 길이) 계산합니다. 재배포/재시작돼도
// 이어서 순환하도록 값 자체를 data.json에 영구 저장해서, 같은 사람이
// 여러 번 이용해도 최소한 풀 전체를 한 바퀴 돌기 전엔 안 겹칩니다.
function nextConfessionResponseIndex() {
  const n = state.confessionResponseIndex || 0;
  state.confessionResponseIndex = n + 1;
  save();
  return n;
}

// ── 고해성사 답장 릴레이 ────────────────────────────────────────
// 운영자에게 보낸 "고해성사 — @누구" 알림 메시지의 ID를, 그 글을 쓴 사람의
// 디스코드 ID와 매핑해서 저장해둡니다. 운영자가 봇 DM에서 그 알림 메시지에
// "답장"(Discord 답장 기능)을 누르면, index.js가 이 매핑으로 누구한테
// 전달할지 찾아냅니다. 한 사람이 여러 번 답장해도(대화를 이어가도) 되도록
// 한 번 쓰고 지우지 않고 계속 남겨둡니다.
function recordConfessionRelay(notificationMessageId, discordUserId) {
  state.confessionRelays[notificationMessageId] = discordUserId;
  save();
}

function getConfessionRelayTarget(notificationMessageId) {
  return state.confessionRelays[notificationMessageId] || null;
}

module.exports = {
  getUser,
  updateUser,
  save,
  allUserIds,
  isPaymentProcessed,
  markPaymentProcessed,
  nextConvoStarterIndex,
  nextConfessionResponseIndex,
  recordConfessionRelay,
  getConfessionRelayTarget,
};

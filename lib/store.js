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
    return { users: {}, processedPayments: {}, buddyPool: [], nextBuddyGroupNumber: 1, buddyGroups: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
    if (!parsed.processedPayments) parsed.processedPayments = {};
    if (!parsed.buddyPool) parsed.buddyPool = [];
    if (!parsed.nextBuddyGroupNumber) parsed.nextBuddyGroupNumber = 1;
    if (!parsed.buddyGroups) parsed.buddyGroups = [];
    return parsed;
  } catch (e) {
    console.error("[store] data.json 파싱 실패, 빈 상태로 시작합니다.", e);
    return { users: {}, processedPayments: {}, buddyPool: [], nextBuddyGroupNumber: 1, buddyGroups: [] };
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
        d25: false,
        d27: false,
        d29: false,
        d30: false,
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

      // ── 버디 그룹 ──
      buddyGroupNumber: null, // 배정된 버디 그룹 번호
      buddyRoleId: null,
      buddyChannelId: null,

      // ── 주간 팁 & 회고 ──
      lastWeeklyTipWeek: null, // ISO 주차 (YYYY-Www), 중복 발송 방지
      lastWeeklyReflectionWeek: null,
      awaitingReflectionReply: false,
      reflectionPromptSentAt: null,
      reflections: [], // [{ week: "2026-W34", text: "..." }, ...]
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
  if (user.buddyGroupNumber === undefined) user.buddyGroupNumber = null;
  if (user.buddyRoleId === undefined) user.buddyRoleId = null;
  if (user.buddyChannelId === undefined) user.buddyChannelId = null;
  if (user.lastWeeklyTipWeek === undefined) user.lastWeeklyTipWeek = null;
  if (user.lastWeeklyReflectionWeek === undefined) user.lastWeeklyReflectionWeek = null;
  if (user.awaitingReflectionReply === undefined) user.awaitingReflectionReply = false;
  if (user.reflectionPromptSentAt === undefined) user.reflectionPromptSentAt = null;
  if (user.reflections === undefined) user.reflections = [];
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

// ── 버디 그룹 대기열 ────────────────────────────────────────
// 첫 체크인을 한 멤버를 여기 쌓아두었다가, BUDDY_GROUP_SIZE명이 모이면
// index.js에서 새 그룹(역할+채널)을 만들고 이 대기열을 비웁니다.
function getBuddyPool() {
  return state.buddyPool;
}

function addToBuddyPool(userId) {
  if (!state.buddyPool.includes(userId)) {
    state.buddyPool.push(userId);
    save();
  }
  return state.buddyPool;
}

function clearBuddyPool() {
  state.buddyPool = [];
  save();
}

function nextBuddyGroupNumber() {
  const n = state.nextBuddyGroupNumber || 1;
  state.nextBuddyGroupNumber = n + 1;
  save();
  return n;
}

// ── 버디 그룹 목록 (채널이 실제로 만들어질 때마다 기록) ──────────
// 주간 안부 메시지 작업(index.js)이 매번 전체 유저를 스캔하지 않고
// 바로 순회할 수 있도록, 생성된 그룹 채널만 따로 보관합니다.
function getBuddyGroups() {
  return state.buddyGroups;
}

function addBuddyGroupRecord(group) {
  state.buddyGroups.push(group);
  save();
  return state.buddyGroups;
}

function removeBuddyGroupRecord(channelId) {
  state.buddyGroups = state.buddyGroups.filter((g) => g.channelId !== channelId);
  save();
  return state.buddyGroups;
}

module.exports = {
  getUser,
  updateUser,
  save,
  allUserIds,
  isPaymentProcessed,
  markPaymentProcessed,
  getBuddyPool,
  addToBuddyPool,
  clearBuddyPool,
  nextBuddyGroupNumber,
  getBuddyGroups,
  addBuddyGroupRecord,
  removeBuddyGroupRecord,
  _state: () => state,
};

// 아주 단순한 JSON 파일 기반 저장소.
// 소규모 커뮤니티 봇이라 별도 DB 없이 파일 하나로 충분합니다.
// 나중에 사용자가 많아지면 sqlite/postgres로 옮기면 됩니다.

const fs = require("fs");
const path = require("path");

const DATA_PATH = path.join(__dirname, "..", "data.json");

function load() {
  if (!fs.existsSync(DATA_PATH)) {
    return { users: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
  } catch (e) {
    console.error("[store] data.json 파싱 실패, 빈 상태로 시작합니다.", e);
    return { users: {} };
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

module.exports = { getUser, updateUser, save, allUserIds, _state: () => state };

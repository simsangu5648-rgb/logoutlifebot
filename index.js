require("dotenv").config();
const path = require("path");
const fs = require("fs");
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  PermissionFlagsBits,
  AttachmentBuilder,
} = require("discord.js");
const cron = require("node-cron");
const express = require("express");
const {
  getUser,
  updateUser,
  allUserIds,
  isPaymentProcessed,
  markPaymentProcessed,
  addToBuddyPool,
  clearBuddyPool,
  nextBuddyGroupNumber,
  getBuddyGroups,
  addBuddyGroupRecord,
  removeBuddyGroupRecord,
} = require("./lib/store");

const {
  DISCORD_TOKEN,
  GUILD_ID,
  ROLE_ID_REBOOT,
  ROLE_ID_GROW,
  ROLE_ID_MASTER,
  ROLE_ID_FREE,
  TRACK_CHANNEL_NAMES,
  THRESHOLD_MASTER,
  PAYMENT_LINK,
  DAILY_CRON,
  TIMEZONE,
} = process.env;

const REQUIRED = { DISCORD_TOKEN, GUILD_ID, ROLE_ID_GROW, ROLE_ID_MASTER };
for (const [k, v] of Object.entries(REQUIRED)) {
  if (!v) {
    console.error(`[설정 오류] .env 에 ${k} 값이 없습니다. .env.example을 참고해 채워주세요.`);
    process.exit(1);
  }
}

const TRACKED_CHANNELS = (TRACK_CHANNEL_NAMES || "스크린타임-기록,끄고-인증,자연-인증")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 자연-인증 채널은 핀 공지에서 "사진이어도 좋고, 그냥 한 줄 텍스트여도 좋다"고
// 이미 안내하고 있으므로, 이 채널만 이미지 첨부가 없어도 의미 있는 텍스트가 있으면 인정합니다.
const TEXT_OK_CHANNELS = (process.env.TEXT_OK_CHANNEL_NAMES || "자연-인증")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 마스터-크루는 "이미 그로우-크루(전자책 구매 완료)인 사람"이 누적 인증을 더 쌓았을 때 도달하는
// 최종 등급입니다. (그로우-크루 자체는 더 이상 누적 횟수가 아니라 전자책 구매로만 승급합니다 - 아래 참고)
const T_MASTER = parseInt(THRESHOLD_MASTER || "30", 10);
const TZ = TIMEZONE || "Asia/Seoul";

// ── 일반멤버(무료) 4단계 등급 시스템 ──────────────────────────
// 전자책을 구매하기 전까지의 "일반사람들"은 누적 인증 횟수만으로 4단계를 올라갑니다.
// 그로우-크루/마스터-크루로 승급하면 이 배지 역할은 자동으로 회수됩니다.
const FREE_LEVELS = [
  {
    key: "lv4",
    label: process.env.FREE_LV4_LABEL || "베테랑",
    threshold: parseInt(process.env.FREE_LV4_THRESHOLD || "90", 10),
    roleId: process.env.ROLE_ID_FREE_LV4,
  },
  {
    key: "lv3",
    label: process.env.FREE_LV3_LABEL || "실천가",
    threshold: parseInt(process.env.FREE_LV3_THRESHOLD || "30", 10),
    roleId: process.env.ROLE_ID_FREE_LV3,
  },
  {
    key: "lv2",
    label: process.env.FREE_LV2_LABEL || "습관러",
    threshold: parseInt(process.env.FREE_LV2_THRESHOLD || "7", 10),
    roleId: process.env.ROLE_ID_FREE_LV2,
  },
  {
    key: "lv1",
    label: process.env.FREE_LV1_LABEL || "새싹",
    threshold: parseInt(process.env.FREE_LV1_THRESHOLD || "1", 10),
    roleId: process.env.ROLE_ID_FREE_LV1,
  },
]; // threshold 내림차순 - 배열을 순서대로 훑으며 가장 먼저 만족하는 단계가 "현재 단계"

const FREE_LEVEL_ROLE_IDS = FREE_LEVELS.map((lv) => lv.roleId).filter(Boolean);

// ── 전자책 결제(PayApp) 연동 ───────────────────────────────
const PAYAPP_USERID = process.env.PAYAPP_USERID;
const PAYAPP_LINKKEY = process.env.PAYAPP_LINKKEY;
const PAYAPP_LINKVAL = process.env.PAYAPP_LINKVAL;
const EBOOK_NAME = process.env.EBOOK_NAME || "로그아웃라이프 전자책";
const EBOOK_PRICE = process.env.EBOOK_PRICE;
const EBOOK_DOWNLOAD_URL = process.env.EBOOK_DOWNLOAD_URL || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const EBOOK_PURCHASE_COMMANDS = ["구매", "!구매", "전자책구매", "전자책 구매"];
// 결제 전 소개/랜딩 페이지. 설정하면 DM "구매"에 결제 링크를 바로 주는 대신
// 이 페이지 링크(본인 uid 포함)를 먼저 보내고, 페이지의 구매 버튼이
// "/go/:discordUserId" 라우트를 거쳐 실제 결제 페이지로 연결됩니다.
const LANDING_PAGE_URL = (process.env.LANDING_PAGE_URL || "").replace(/\/+$/, "");

// ── 전자책 무료 미리보기 (파일 직접 첨부) ────────────────────
const EBOOK_PREVIEW_COMMANDS = ["미리보기", "!미리보기", "전자책미리보기", "전자책 미리보기"];
const EBOOK_PREVIEW_PATH = path.join(__dirname, "assets", "ebook_preview.pdf");

// ── 즉시반응 시스템 (#충동-sos) ─────────────────────────────────
const SOS_CHANNEL_NAME = process.env.SOS_CHANNEL_NAME || "충동-sos";
const SOS_REACT_EMOJI = process.env.SOS_REACT_EMOJI || "🫂";
const HELPER_NOTIFY_COUNT = parseInt(process.env.HELPER_NOTIFY_COUNT || "3", 10);
const HELPER_ACTIVE_WITHIN_DAYS = parseInt(process.env.HELPER_ACTIVE_WITHIN_DAYS || "3", 10);
const HELPER_NOTIFY_COOLDOWN_HOURS = parseInt(process.env.HELPER_NOTIFY_COOLDOWN_HOURS || "6", 10);

// ── SOS 온콜 에스컬레이션 (사람이 직접 챙기는 안전망) ──────────
// ONCALL_ROLE_ID/ONCALL_CHANNEL_NAME을 둘 다 채우면, SOS가 올라올 때마다
// 그 채널에 온콜 역할을 태그해서 알려줍니다. (운영자가 직접 순번을 정해서
// 그 역할을 사람들에게 부여해두는 방식 - 봇이 당번을 자동으로 정하진 않아요)
const ONCALL_ROLE_ID = process.env.ONCALL_ROLE_ID || "";
const ONCALL_CHANNEL_NAME = process.env.ONCALL_CHANNEL_NAME || "";

// SOS 직후 "뭐 때문에 그랬는지" DM 질문에 대한 응답을 인정할 시간 (분)
const TRIGGER_REPLY_WINDOW_MINUTES = parseInt(process.env.TRIGGER_REPLY_WINDOW_MINUTES || "30", 10);

// ── 데일리 스트릭 대시보드 (+ 스트릭 프리즈권) ────────────────
const STREAK_CHANNEL_NAME = process.env.STREAK_CHANNEL_NAME || "나의-그래프";
const STREAK_COMMAND = process.env.STREAK_COMMAND || "!기록";
// 한 달에 이 횟수만큼은, 하루를 걸러도 연속기록(스트릭)이 끊기지 않습니다.
const STREAK_FREEZE_PER_MONTH = parseInt(process.env.STREAK_FREEZE_PER_MONTH || "1", 10);

// ── 승급 알림 & 배지 시스템 ────────────────────────────────
const ANNOUNCE_CHANNEL_NAME = process.env.ANNOUNCE_CHANNEL_NAME || "자유수다";

// ── 멘토 하이라이트 시스템 ─────────────────────────────────
const HELPER_THANKS_EMOJI = process.env.HELPER_THANKS_EMOJI || "🙏";
const HONOR_CHANNEL_NAME = process.env.HONOR_CHANNEL_NAME || "명예의-전당";

// ── 베테랑(무료 등급 최고 단계) 달성 축하 ─────────────────────
const VETERAN_LOUNGE_CHANNEL_NAME = process.env.VETERAN_LOUNGE_CHANNEL_NAME || "베테랑-라운지";

// ── 리부트 버디 그룹 (그로우-크루 전용) ─────────────────────────
// 전자책을 구매해 그로우-크루가 된 멤버가 이만큼 모이면 자동으로 역할+비공개 채널을 만들어 묶어줍니다.
// 무료멤버 대상 버디 그룹은 폐지되었고, 이제 결제(리부트 시작) 시점에만 대기열에 들어갑니다.
// 봇에게 "채널 관리(Manage Channels)" 권한이 필요합니다.
const BUDDY_GROUP_SIZE = parseInt(process.env.BUDDY_GROUP_SIZE || "5", 10);
const BUDDY_CATEGORY_NAME = process.env.BUDDY_CATEGORY_NAME || "리부트 버디 그룹";
const BUDDY_GROUPS_ENABLED = process.env.BUDDY_GROUPS_ENABLED !== "false";

// 버디 그룹 채팅방이 대화 없이 조용해지지 않도록, 매주 한 번씩 봇이 안부 메시지를 보냅니다.
const BUDDY_CHECKIN_CRON = process.env.BUDDY_CHECKIN_CRON || "0 20 * * 3"; // 기본: 매주 수요일 저녁 8시
const BUDDY_CHECKIN_MESSAGES = [
  "이번 주는 다들 어떻게 지내고 계세요? 짧게라도 안부 한마디 남겨주세요 🙂",
  "오늘 인증한 거 있으면 여기에도 슬쩍 공유해봐요. 서로 보면 은근 힘이 돼요.",
  "이번 주 컨디션은 어떤가요? 잘 되고 있는 것도, 힘든 것도 편하게 나눠주세요.",
  "다들 잘 지내고 계신가요? 오늘 하루 어땠는지 한 줄씩 남겨봐요.",
  "버디 여러분, 이번 주 목표 잘 지키고 계세요? 서로 응원 한마디씩 남겨주세요 💪",
  "요즘 가장 힘든 순간이 언제인지, 그리고 어떻게 넘기고 있는지 나눠보면 어떨까요?",
  "이번 주도 다들 고생 많으셨어요. 스스로 잘한 점 하나씩만 남겨볼까요?",
  "오랜만에 조용했네요 🙂 다들 잘 지내고 계신지 안부 여쭤봐요.",
];

// ── 주간 팁 & 회고 ──────────────────────────────────────────
const REFLECTION_REPLY_WINDOW_HOURS = parseInt(process.env.REFLECTION_REPLY_WINDOW_HOURS || "24", 10);

const WEEKLY_TIPS = [
  "화면을 보다가 무의식적으로 켜는 앱 아이콘을 홈 화면 첫 페이지에서 치워보세요. 접근성이 낮아지는 것만으로도 습관이 줄어들어요.",
  "자기 전 30분은 침실 밖에서 휴대폰을 충전해보세요. 아침에 눈뜨자마자 폰부터 보는 습관도 같이 줄어들어요.",
  "심심할 때 손이 갈 수 있는 대체물(책, 스트레칭, 산책) 하나를 미리 정해두면 무의식적인 습관을 끊기 쉬워요.",
  "급하지 않은 앱의 알림부터 꺼보세요. 폰을 확인할 이유 자체가 줄어들어요.",
  "완벽하게 안 하는 날보다, 어제보다 1분이라도 줄인 오늘이 더 중요해요. 숫자보다 방향에 집중해보세요.",
  "충동이 올라올 때 5분만 미뤄보세요. 대부분의 충동은 몇 분 안에 잦아들어요.",
  "같이 하는 사람이 있으면 훨씬 오래갑니다. 이번 주엔 서버에서 한 명에게 먼저 안부를 물어보는 건 어때요?",
  "하루를 돌아보며 '오늘 폰을 안 봐서 좋았던 순간'을 하나만 떠올려보세요. 작은 보상 감각이 습관을 강화해줘요.",
];

const REFLECTION_QUESTIONS = [
  "이번 주 가장 힘들었던 순간은 언제였나요?",
  "이번 주, 폰 대신 다른 걸 선택했던 순간이 있었나요?",
  "요즘 나를 가장 많이 붙잡는 앱이나 습관은 뭔가요?",
  "이번 주 스스로 칭찬해주고 싶은 게 있다면?",
  "다음 주에 하나만 바꿀 수 있다면 뭘 바꾸고 싶나요?",
];

// ── 이주의 챌린지 (그로우-크루/마스터-크루 전용) ──────────────
// 50개를 순서대로 돌리고, 51주차부터는 다시 1번으로 돌아가 계속 반복됩니다.
const CHALLENGE_CHANNEL_NAME = process.env.CHALLENGE_CHANNEL_NAME || "이주의-챌린지";
const CHALLENGE_VERIFY_CHANNEL_NAME = process.env.CHALLENGE_VERIFY_CHANNEL_NAME || "챌린지-인증";

const WEEKLY_CHALLENGES = [
  "하루 스크린타임을 평소보다 30분 줄여보기",
  "이번 주 3일 이상 #자연-인증에 인증 남기기",
  "자기 전 30분은 폰을 침실 밖에 두고 자보기",
  "SNS 앱 하나를 홈 화면에서 지워보기 (삭제 말고 숨기기만 해도 OK)",
  "아침에 눈뜨자마자 폰 대신 물 한 잔부터 마시기, 3일 이상 시도",
  "#충동-sos에 한 번도 안 써봤다면, 충동이 올 때 딱 한 번 글 남겨보기",
  "잘 모르는 멤버 한 명에게 먼저 안부 인사 남기기",
  "자기 전 알람을 다른 방에 두고 자보기 (폰 대신 물리 알람 사용)",
  "급하지 않은 앱 알림을 5개 이상 꺼보기",
  "하루 동안 SNS 없이 지내보기 (딱 하루만)",
  "산책이나 스트레칭 10분, 3일 이상 해보기",
  "이번 주 회고 질문(주간 팁 DM)에 답장 한 번 남겨보기",
  "#자유수다에 오늘 내가 지킨 작은 습관 하나 자랑해보기",
  "스크린타임 앱으로 이번 주 사용시간을 매일 확인해보기",
  "폰 없이 밥 한 끼, 3번 이상 먹어보기",
  "유튜브나 SNS 앱에 하루 사용 제한 시간을 걸어보기",
  "잠들기 전 5분, 오늘 있었던 좋은 일 하나 적어보기 (3일 이상)",
  "충동이 올 때 5분만 미뤄보기, 이번 주 한 번이라도 성공해보기",
  "다른 멤버의 승급 소식이나 글에 리액션 남겨주기",
  "하루는 폰을 흑백 화면으로 써보기 (설정에서 그레이스케일 켜기)",
  "이번 주 3일 이상 #끄고-인증 남기기",
  "심심할 때 손이 가는 대체 행동(책, 그림, 악기 등) 하나 정해서 이번 주 2번 시도해보기",
  "자기 전 루틴에서 폰 보는 시간을 10분만 줄여보기, 3일 이상",
  "오늘 하루는 SNS 피드를 아예 열지 않아보기",
  "낮잠이나 짧은 휴식을 폰 없이 취해보기, 2번 이상",
  "#자연-인증에 사진 대신 글로 오늘 하루 짧게 남겨보기",
  "이번 주 한 번은 도움이 필요해 보이는 멤버에게 먼저 댓글 남겨보기",
  "스크린타임 알림이 뜨면 그 순간 딱 5분만 다른 걸 해보기",
  "주말 중 하루는 오전 시간대(기상~정오) 동안 폰 사용 최소화해보기",
  "이번 주 스트릭을 하루도 안 끊기게 유지해보기",
  "새로운 대체 취미(운동, 독서, 요리 등) 하나 이번 주에 딱 한 번 시도해보기",
  "폰 잠금화면 배경을 \"지금 이걸 왜 켰지?\"로 바꿔서 습관을 인식해보기",
  "이번 주 3일 이상 아침 기상 직후 1시간 동안 폰 안 보기",
  "#충동-sos에서 다른 멤버 글에 응원 댓글 한 번 남겨보기",
  "밖에 나가서 20분 이상 걷기, 이번 주 2번 이상",
  "하루 동안 유튜브 추천 피드 대신 검색으로만 찾아보기",
  "미디어 없이 혼자 있는 시간을 하루 15분씩 가져보기, 이번 주에",
  "스크린타임 주간 리포트를 확인하고 지난주와 비교해보기",
  "버디 그룹이 있다면 이번 주 안부 한 번 물어보기",
  "자기 전 명상이나 심호흡 5분, 3일 이상 시도해보기",
  "오늘 하루는 폰을 무음이나 방해금지 모드로 지내보기",
  "이번 주 3일 이상 아무 인증이든 남겨서 스트릭 유지해보기",
  "SNS 팔로우 목록을 정리해서 필요없는 계정 5개 언팔로우해보기",
  "충동이 올라올 때 물 한 잔 마시고 60초만 버텨보기, 이번 주 한 번이라도",
  "폰 없이 목욕이나 샤워 후 15분 정도 여유 시간 가져보기",
  "이번 주 하루는 디지털 기기 없는 저녁 시간(2시간)을 만들어보기",
  "#자기소개 채널에 오랜만에 근황 한 줄 남겨보기",
  "스크린타임에서 가장 오래 쓴 앱 하나를 찾아 하루만 사용 안 해보기",
  "이번 주 목표를 스스로 정하고 #자유수다에 선언해보기",
  "이번 주 가장 뿌듯했던 순간을 스스로 떠올려보고 댓글로 남겨보기",
];

function todayKST() {
  // YYYY-MM-DD, TZ 기준
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}

function daysBetween(a, b) {
  const MS = 24 * 60 * 60 * 1000;
  return Math.round((b - a) / MS);
}

function daysInMonth(year, month /* 1-12 */) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isLastDayOfMonthKST(todayStr) {
  const [y, m, d] = todayStr.split("-").map(Number);
  return d === daysInMonth(y, m);
}

function prevMonthKey(monthKey /* "YYYY-MM" */) {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1)); // m은 1-indexed라 -2 해야 전달 1일
  const py = d.getUTCFullYear();
  const pm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${py}-${pm}`;
}

// ISO 주차 문자열 (예: "2026-W34") - 주간 팁/회고 중복 발송 방지 및 콘텐츠 로테이션에 사용
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[봇 시작] ${c.user.tag} 로 로그인 완료`);
  if (!ROLE_ID_FREE) {
    console.warn("[설정 경고] ROLE_ID_FREE가 없어 신규 멤버에게 무료멤버 역할을 자동으로 부여하지 못합니다. .env.example을 참고해 채워주세요.");
  }
  if (FREE_LEVEL_ROLE_IDS.length === 0) {
    console.warn("[설정 경고] ROLE_ID_FREE_LV1~4가 설정되어 있지 않아 일반멤버 4단계 등급 배지를 부여하지 못합니다.");
  }
  if (!PAYAPP_USERID || !PAYAPP_LINKKEY || !PAYAPP_LINKVAL || !EBOOK_PRICE || !PUBLIC_BASE_URL) {
    console.warn("[설정 경고] PayApp 관련 환경변수가 부족해 전자책 자동결제/자동승급 기능이 동작하지 않습니다. .env.example을 참고해 채워주세요.");
  }
  scheduleDailyJob();
  scheduleStreakReminderJob();
  scheduleWeeklyHighlightJob();
  scheduleWeeklyTipJob();
  scheduleWeeklyChallengeJob();
  scheduleBuddyCheckinJob();
});

// ── 신규 멤버 자동 역할 부여 ───────────────────────────────
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (member.guild.id !== GUILD_ID) return;
    if (!ROLE_ID_FREE) return; // 설정 안 됐으면 조용히 스킵 (시작 시 경고는 이미 남김)

    await member.roles.add(ROLE_ID_FREE);
    console.log(`[역할부여] ${member.user.tag} 에게 무료멤버 역할 부여 완료`);
  } catch (err) {
    console.error("[GuildMemberAdd 처리 오류]", err);
  }
});

// ── 메시지 처리: 체크인 카운트 + SOS 즉시반응 + DM 명령어 + 스트릭 조회 ──
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;

    // DM 명령어 처리 (승급 공개 알림 옵트아웃/인 + 전자책 구매 + SOS 트리거/회고 응답)
    if (!message.guild) {
      const content = message.content.trim();
      if (content === "알림끄기" || content === "!알림끄기") {
        updateUser(message.author.id, { publicAnnounceOptOut: true });
        await message.reply(
          "앞으로 승급하셔도 공개 채널에는 알리지 않을게요. 다시 켜고 싶으면 \"알림켜기\"라고 보내주세요."
        );
      } else if (content === "알림켜기" || content === "!알림켜기") {
        updateUser(message.author.id, { publicAnnounceOptOut: false });
        await message.reply("좋아요! 승급하시면 다시 공개 채널에서 축하 메시지를 남길게요 🎉");
      } else if (EBOOK_PURCHASE_COMMANDS.includes(content)) {
        await handleEbookPurchaseRequest(message);
      } else if (EBOOK_PREVIEW_COMMANDS.includes(content)) {
        await handleEbookPreviewRequest(message);
      } else if (content === "회고" || content === "!회고") {
        await handleReflectionHistoryRequest(message);
      } else if (content === "패턴" || content === "!패턴") {
        await handleSosPatternHistoryRequest(message);
      } else {
        await handlePendingDmReply(message, content);
      }
      return;
    }

    if (message.guild.id !== GUILD_ID) return;

    // 즉시반응 시스템: #충동-sos
    if (message.channel.name === SOS_CHANNEL_NAME) {
      await safeReact(message, SOS_REACT_EMOJI);
      notifyHelpers(message).catch((e) => console.error("[SOS 헬퍼 알림 오류]", e));
      escalateToOnCall(message).catch((e) => console.error("[SOS 온콜 에스컬레이션 오류]", e));

      // 진정된 뒤에, 원하면 어떤 상황이었는지 한 줄 남길 수 있게 물어봅니다 (완전 선택사항).
      updateUser(message.author.id, {
        awaitingTriggerReply: true,
        triggerPromptSentAt: new Date().toISOString(),
      });
      const posterMember = await message.guild.members.fetch(message.author.id).catch(() => null);
      if (posterMember) {
        await safeDM(
          posterMember,
          "괜찮으세요? 혹시 방금 어떤 상황/기분이었는지 한 줄로 남겨주실 수 있어요? 나중에 스스로 패턴을 돌아보는 데 쓰일 거예요. (완전 선택이에요, 그냥 넘어가셔도 괜찮아요 🙂)"
        );
      }
      // SOS 채널은 체크인 집계 대상이 아니므로 여기서 종료
      return;
    }

    // 데일리 스트릭 대시보드: #나의-그래프에서 "!기록" 조회
    if (message.channel.name === STREAK_CHANNEL_NAME && message.content.trim() === STREAK_COMMAND) {
      const user = getUser(message.author.id);
      const monthKey = todayKST().slice(0, 7);
      const thisMonthCount = (user.monthlyCounts && user.monthlyCounts[monthKey]) || 0;
      await message.reply(
        `📊 **${message.author.username}**님의 기록\n` +
          `누적 인증: ${user.cumulativeCount}회\n` +
          `현재 등급: ${describeCurrentLevel(message.member, user)}\n` +
          `${describeNextLevelProgress(message.member, user)}\n` +
          `현재 연속: ${user.currentStreak || 0}일 🔥\n` +
          `최고 기록: ${user.longestStreak || 0}일\n` +
          `이번 달: ${thisMonthCount}회`
      );
      return;
    }

    if (!TRACKED_CHANNELS.includes(message.channel.name)) return;

    const hasAttachment = message.attachments.size > 0;
    const hasMeaningfulText = message.content.trim().length >= 2; // 이모지 하나 정도는 인정 안 함
    const channelAllowsTextOnly = TEXT_OK_CHANNELS.includes(message.channel.name);

    // 기본은 이미지 첨부가 있어야 인정. 단, 자연-인증처럼 텍스트 인증을 허용한다고
    // 채널 안내에 명시된 곳은 첨부가 없어도 의미 있는 텍스트면 인정합니다.
    if (!hasAttachment && !(channelAllowsTextOnly && hasMeaningfulText)) return;

    const user = getUser(message.author.id);
    const today = todayKST();

    if (user.lastCheckInDate === today) {
      // 하루 중복 방지 - 카운트는 안 올리고 리액션만
      await safeReact(message, "⏳");
      return;
    }

    const newCount = user.cumulativeCount + 1;

    // 데일리 스트릭 계산 (한 달에 STREAK_FREEZE_PER_MONTH번은 하루 걸러도 안 끊기게)
    const freezeMonthKey = today.slice(0, 7);
    let freezesUsedThisMonth = user.lastStreakFreezeMonth === freezeMonthKey ? user.streakFreezesUsedThisMonth || 0 : 0;
    let newStreak;
    let usedFreezeThisCheckIn = false;
    if (!user.lastCheckInDate) {
      newStreak = 1;
    } else {
      const last = new Date(user.lastCheckInDate + "T00:00:00+09:00");
      const gap = daysBetween(last, new Date(today + "T00:00:00+09:00"));
      if (gap === 1) {
        newStreak = (user.currentStreak || 0) + 1;
      } else if (gap === 2 && freezesUsedThisMonth < STREAK_FREEZE_PER_MONTH) {
        newStreak = (user.currentStreak || 0) + 1;
        usedFreezeThisCheckIn = true;
        freezesUsedThisMonth += 1;
      } else {
        newStreak = 1;
      }
    }
    const newLongestStreak = Math.max(user.longestStreak || 0, newStreak);

    // 월간 카운트 집계
    const monthKey = today.slice(0, 7);
    const monthlyCounts = { ...(user.monthlyCounts || {}) };
    monthlyCounts[monthKey] = (monthlyCounts[monthKey] || 0) + 1;

    updateUser(message.author.id, {
      cumulativeCount: newCount,
      lastCheckInDate: today,
      currentStreak: newStreak,
      longestStreak: newLongestStreak,
      monthlyCounts,
      streakFreezesUsedThisMonth: freezesUsedThisMonth,
      lastStreakFreezeMonth: freezeMonthKey,
    });
    await safeReact(message, "✅");

    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return;

    if (usedFreezeThisCheckIn) {
      await safeDM(
        member,
        `어제는 못 하셨지만 이번 달 프리즈권을 사용해서 연속기록이 끊기지 않았어요! (지금 ${newStreak}일째 🔥) 프리즈권은 매달 ${STREAK_FREEZE_PER_MONTH}번 자동으로 적용돼요.`
      );
    }

    const isGrowOrAbove = member.roles.cache.has(ROLE_ID_GROW) || member.roles.cache.has(ROLE_ID_MASTER);

    if (!isGrowOrAbove) {
      // 아직 전자책을 구매하지 않은 "일반멤버"는 누적 횟수로 4단계 배지만 오릅니다.
      // (그로우-크루 승급 자체는 더 이상 누적 횟수가 아니라 전자책 구매로만 이루어집니다.)
      await syncFreeLevel(member, newCount);
    } else if (member.roles.cache.has(ROLE_ID_GROW) && !member.roles.cache.has(ROLE_ID_MASTER)) {
      // 그로우-크루(=전자책 구매 완료)인 사람이 누적 인증을 계속 쌓으면 최종 단계인 마스터-크루로 승급합니다.
      if (newCount >= T_MASTER) {
        await member.roles.add(ROLE_ID_MASTER).catch((e) => console.error("[역할부여 실패] 마스터-크루", e));
        await safeDM(
          member,
          `축하해요! 누적 ${newCount}회 기록을 달성해서 마스터-크루로 승급했어요. #마스터-크루, #우선질문 채널이 열렸습니다.\n🏆 마스터-크루는 최종 등급이에요. 여기까지 와주셔서 정말 대단해요!`
        );
        await announcePromotion(message.guild, member, "마스터-크루");
      } else {
        const remaining = T_MASTER - newCount;
        if (remaining > 0 && remaining <= 3) {
          // 막바지에는 얼마 안 남았다는 걸 알려주면 동기부여가 되니, 체크인 리액션 후 짧게 살짝 귀띔만 해줍니다.
          await safeDM(member, `마스터-크루까지 ${remaining}회 남았어요. 조금만 더 힘내요! 💪`);
        }
      }
    }
  } catch (err) {
    console.error("[messageCreate 처리 오류]", err);
  }
});

// ── 일반멤버 4단계 등급 배지 동기화 ──────────────────────────
async function syncFreeLevel(member, cumulativeCount) {
  const target = FREE_LEVELS.find((lv) => lv.roleId && cumulativeCount >= lv.threshold);
  if (!target) return; // 아직 어떤 단계도 설정 안 됐거나(ROLE_ID 미설정) 조건 미달

  if (member.roles.cache.has(target.roleId)) return; // 이미 해당 등급 - 변화 없음

  // 이전 단계 배지 제거 후 새 단계 배지 부여 (등급은 항상 하나만 유지)
  for (const lv of FREE_LEVELS) {
    if (lv.roleId && lv.roleId !== target.roleId && member.roles.cache.has(lv.roleId)) {
      await member.roles.remove(lv.roleId).catch(() => {});
    }
  }
  await member.roles.add(target.roleId).catch((e) => console.error(`[무료등급 역할부여 실패] ${target.label}`, e));
  const user = getUser(member.id);

  if (target.key === "lv4") {
    // 무료 등급 중 최고 단계(베테랑) 달성은 따로 더 신경 써서 축하해줍니다.
    await safeDM(
      member,
      `🔥 축하해요! 누적 인증 ${cumulativeCount}회를 채워서 무료 등급 중 최고 단계인 "베테랑"에 도달했어요.\n` +
        `이제 #${VETERAN_LOUNGE_CHANNEL_NAME} 채널이 열렸고, #${SOS_CHANNEL_NAME} 헬퍼 알림 대상에도 포함돼요 — 도움받던 입장에서 이제 도움을 줄 수 있는 차례예요.\n` +
        `여기까지 꾸준히 오신 것 자체가 정말 대단한 거예요. 혹시 다음 단계가 궁금하시면, 전자책을 구매하면 바로 그로우-크루로 승급돼요 (DM으로 "구매"라고 보내보세요).`
    );
    await announceVeteranAchievement(member.guild, member, cumulativeCount);
  } else {
    await safeDM(
      member,
      `🌱 활동 등급이 "${target.label}"(으)로 올랐어요! (누적 인증 ${cumulativeCount}회)\n${describeNextLevelProgress(member, user)}`
    );
  }
  console.log(`[등급변경] ${member.user.tag} → ${target.label} (누적 ${cumulativeCount}회)`);
}

// ── 베테랑 달성 알림: 명예의-전당에 소개 ─────────────────────
async function announceVeteranAchievement(guild, member, cumulativeCount) {
  try {
    const u = getUser(member.id);
    if (u.publicAnnounceOptOut) return;
    const channel = guild.channels.cache.find(
      (c) => c.name === HONOR_CHANNEL_NAME && typeof c.send === "function"
    );
    if (!channel) return;
    await channel.send(
      `🔥 **${member.displayName}**님이 무료 등급 중 최고 단계인 베테랑(누적 인증 ${cumulativeCount}회)을 달성했어요! 꾸준함이 만든 결과예요, 축하해주세요 👏`
    );
  } catch (e) {
    console.error("[베테랑 달성 알림 실패]", e);
  }
}

function describeCurrentLevel(member, user) {
  if (!member) return "-";
  if (member.roles.cache.has(ROLE_ID_MASTER)) return "마스터-크루";
  if (member.roles.cache.has(ROLE_ID_GROW)) return "그로우-크루";
  const current = FREE_LEVELS.find((lv) => lv.roleId && member.roles.cache.has(lv.roleId));
  return current ? current.label : "무료멤버";
}

// 다음 등급까지 몇 회 남았는지 안내하는 문구를 만듭니다.
function describeNextLevelProgress(member, user) {
  if (!member || !user) return "";

  if (member.roles.cache.has(ROLE_ID_MASTER)) {
    return "🏆 마스터-크루는 최종 등급이에요. 여기까지 와주셔서 정말 대단해요!";
  }

  if (member.roles.cache.has(ROLE_ID_GROW)) {
    const remaining = Math.max(0, T_MASTER - user.cumulativeCount);
    if (remaining === 0) return "다음 인증 한 번이면 마스터-크루로 승급해요! 🚀";
    return `마스터-크루까지 ${remaining}회 남았어요.`;
  }

  // 무료 등급 (누적 횟수 오름차순으로 다음 단계를 찾음)
  const ascending = [...FREE_LEVELS].reverse();
  const next = ascending.find((lv) => lv.roleId && user.cumulativeCount < lv.threshold);
  if (next) {
    const remaining = next.threshold - user.cumulativeCount;
    return `다음 등급 "${next.label}"까지 ${remaining}회 남았어요.`;
  }

  return `무료 등급은 모두 달성하셨어요! 전자책을 구매하면 바로 그로우-크루로 승급돼요 (DM으로 "구매"라고 보내보세요).`;
}

// ── SOS 트리거 기록 / 주간 회고: 어떤 명령어에도 안 걸리는 DM은
// "방금 보낸 질문에 대한 답"일 수 있으니 확인해서 저장합니다 ──────
async function handlePendingDmReply(message, content) {
  if (!content) return;
  const user = getUser(message.author.id);
  const now = new Date();

  if (
    user.awaitingTriggerReply &&
    user.triggerPromptSentAt &&
    now - new Date(user.triggerPromptSentAt) <= TRIGGER_REPLY_WINDOW_MINUTES * 60 * 1000
  ) {
    const sosTriggers = [...(user.sosTriggers || []), { date: todayKST(), note: content.slice(0, 300) }];
    updateUser(message.author.id, { sosTriggers, awaitingTriggerReply: false, triggerPromptSentAt: null });
    await message.reply('남겨주셔서 고마워요. "패턴"이라고 보내시면 지금까지 남긴 기록을 다시 볼 수 있어요 🙂');
    return;
  }

  if (
    user.awaitingReflectionReply &&
    user.reflectionPromptSentAt &&
    now - new Date(user.reflectionPromptSentAt) <= REFLECTION_REPLY_WINDOW_HOURS * 60 * 60 * 1000
  ) {
    const weekKey = isoWeekKey(now);
    const reflections = [...(user.reflections || []), { week: weekKey, text: content.slice(0, 500) }];
    updateUser(message.author.id, { reflections, awaitingReflectionReply: false, reflectionPromptSentAt: null });
    await message.reply('적어주셔서 고마워요. "회고"라고 보내시면 그동안 남긴 회고를 다시 볼 수 있어요.');
    return;
  }

  // 어느 쪽에도 해당하지 않는 DM은 조용히 무시합니다 (기존 동작과 동일).
}

async function handleReflectionHistoryRequest(message) {
  const user = getUser(message.author.id);
  const recent = [...(user.reflections || [])].slice(-5).reverse();
  if (recent.length === 0) {
    await message.reply('아직 남긴 회고가 없어요. 매주 보내드리는 회고 질문에 답장해보시면 여기 쌓여요!');
    return;
  }
  const text = recent.map((r) => `**${r.week}**: ${r.text}`).join("\n\n");
  await message.reply(`📝 최근에 남긴 회고예요\n\n${text}`);
}

// ── SOS 트리거 기록 다시 보기 (DM "패턴") ──────────────────────
async function handleSosPatternHistoryRequest(message) {
  const user = getUser(message.author.id);
  const all = user.sosTriggers || [];
  if (all.length === 0) {
    await message.reply(
      '아직 남겨주신 SOS 기록이 없어요. #충동-sos에 글을 남기시면 봇이 DM으로 "어떤 상황이었는지" 물어봐요 — 답해주시면 여기 쌓여요!'
    );
    return;
  }

  const recent = [...all].slice(-5).reverse();
  const text = recent.map((t) => `**${t.date}**: ${t.note}`).join("\n\n");

  // 아주 가벼운 패턴 힌트: 요일별로 몇 번씩 남겼는지 세어봅니다.
  const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
  const dayCounts = {};
  for (const t of all) {
    const d = new Date(`${t.date}T00:00:00+09:00`);
    if (Number.isNaN(d.getTime())) continue;
    const label = WEEKDAY_LABELS[d.getDay()];
    dayCounts[label] = (dayCounts[label] || 0) + 1;
  }
  const sortedDays = Object.entries(dayCounts).sort((a, b) => b[1] - a[1]);
  const insight =
    sortedDays.length > 0 && sortedDays[0][1] >= 2
      ? `\n\n📊 지금까지 남기신 기록 중 **${sortedDays[0][0]}요일**이 ${sortedDays[0][1]}번으로 가장 잦았어요.`
      : "";

  await message.reply(`🫂 최근 남기신 SOS 기록이에요 (총 ${all.length}개 중 최근 ${recent.length}개)\n\n${text}${insight}`);
}

// ── 전자책 구매(그로우-크루 승급) ────────────────────────────
async function handleEbookPurchaseRequest(message) {
  const user = getUser(message.author.id);

  if (user.ebookPurchased) {
    await message.reply("이미 전자책을 구매하고 그로우-크루로 승급하셨어요! 🎉");
    return;
  }

  if (!PAYAPP_USERID || !PAYAPP_LINKKEY || !PAYAPP_LINKVAL || !EBOOK_PRICE || !PUBLIC_BASE_URL) {
    await message.reply("아직 결제 기능이 준비 중이에요. 잠시만 기다려주세요!");
    return;
  }

  // LANDING_PAGE_URL이 설정되어 있으면, 결제 링크를 바로 주는 대신
  // 소개 페이지(본인 uid 포함)를 먼저 보냅니다. 페이지의 구매 버튼이
  // "/go/:discordUserId"를 거쳐 그때그때 새 결제 링크를 받아 이동해요.
  if (LANDING_PAGE_URL) {
    const sep = LANDING_PAGE_URL.includes("?") ? "&" : "?";
    const personalizedUrl = `${LANDING_PAGE_URL}${sep}uid=${message.author.id}`;
    await message.reply(
      `📘 **${EBOOK_NAME}** 소개 페이지예요 👇 (본인 전용 링크라 다른 분과 공유하지 말아주세요)\n${personalizedUrl}\n\n` +
        `페이지를 다 보시고 "지금 리부트 시작하기" 버튼을 누르면 결제 페이지로 바로 넘어가요. 결제를 완료하시면,\n` +
        `1) 자동으로 그로우-크루로 승급되고 (#그로우-라운지 채널 오픈 + 공개 축하)\n` +
        `2) 전자책 다운로드 링크를 이 DM으로 바로 보내드려요.\n` +
        `별도로 다시 뭘 누르실 필요 없이, 결제만 하시면 끝이에요!`
    );
    return;
  }

  // LANDING_PAGE_URL 미설정 시에는 기존 방식대로 결제 링크를 DM에 바로 보냅니다.
  try {
    const payUrl = await createPayAppPaymentLink(message.author.id);
    if (!payUrl) {
      await message.reply("결제 링크 생성에 실패했어요. 잠시 후 다시 시도해주세요.");
      return;
    }
    await message.reply(
      `📘 **${EBOOK_NAME}** 구매 링크예요 👇 (본인 확인용 링크라 다른 분과 공유하지 말고 1회만 사용해주세요)\n${payUrl}\n\n` +
        `위 링크를 누르면 PayApp 결제 전용 페이지가 열려요. 그 페이지에서 결제를 완료하시면,\n` +
        `1) 자동으로 그로우-크루로 승급되고 (#그로우-라운지 채널 오픈 + 공개 축하)\n` +
        `2) 전자책 다운로드 링크를 이 DM으로 바로 보내드려요.\n` +
        `별도로 다시 뭘 누르실 필요 없이, 결제만 하시면 끝이에요!`
    );
  } catch (e) {
    console.error("[구매링크 생성 오류]", e);
    await message.reply("결제 링크 생성 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.");
  }
}
async function handleEbookPreviewRequest(message) {
  try {
    if (!fs.existsSync(EBOOK_PREVIEW_PATH)) {
      await message.reply("미리보기 파일을 찾을 수 없어요. 운영자에게 문의해주세요.");
      console.error("[전자책 미리보기 오류] 파일 없음:", EBOOK_PREVIEW_PATH);
      return;
    }
    const attachment = new AttachmentBuilder(EBOOK_PREVIEW_PATH, { name: "로그아웃라이프_REBOOT_미리보기.pdf" });
    await message.reply({
      content: `📖 **${EBOOK_NAME}** 무료 미리보기예요! (프롤로그 + 1장 전체 수록)\n전체 내용이 마음에 드시면 "${EBOOK_PURCHASE_COMMANDS[0]}"라고 보내주세요 🙂`,
      files: [attachment],
    });
  } catch (e) {
    console.error("[전자책 미리보기 전송 오류]", e);
    await message.reply("미리보기 전송 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.");
  }
}


async function createPayAppPaymentLink(discordUserId) {
  const params = new URLSearchParams({
    cmd: "payrequest",
    userid: PAYAPP_USERID,
    goodname: EBOOK_NAME,
    price: String(EBOOK_PRICE),
    recvphone: "01000000000", // PayApp API 필수값이나, smsuse=n 이라 실제 문자는 발송되지 않습니다.
    smsuse: "n",
    var1: discordUserId, // 결제완료 웹훅에서 이 값으로 디스코드 유저를 식별합니다.
    feedbackurl: `${PUBLIC_BASE_URL}/payapp/feedback`,
  });

  const res = await fetch("https://api.payapp.kr/oapi/apiLoad.html", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await res.text();
  const parsed = new URLSearchParams(text);

  if (parsed.get("state") !== "1") {
    console.error("[PayApp 결제요청 실패]", text);
    return null;
  }
  return decodeURIComponent(parsed.get("payurl") || "");
}

async function promoteToGrowCrewByEbook(discordUserId) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordUserId).catch(() => null);
    if (!member) {
      console.error(`[전자책 승급 실패] 길드에서 멤버를 찾을 수 없음: ${discordUserId}`);
      return;
    }
    if (member.roles.cache.has(ROLE_ID_GROW)) return; // 이미 승급됨 (중복 웹훅 방지)

    // 일반멤버 등급 배지 제거
    for (const lv of FREE_LEVELS) {
      if (lv.roleId && member.roles.cache.has(lv.roleId)) {
        await member.roles.remove(lv.roleId).catch(() => {});
      }
    }
    await member.roles.add(ROLE_ID_GROW).catch((e) => console.error("[역할부여 실패] 그로우-크루(전자책)", e));
    await safeDM(member, `전자책 구매가 확인됐어요! 그로우-크루로 승급했어요 🎉 #그로우-라운지 채널이 열렸습니다.`);

    if (BUDDY_GROUPS_ENABLED) {
      // 전자책 구매(리부트 시작) 시점에 리부트 버디 그룹 대기열에 추가 (그룹 인원이 차면 자동으로 채널을 만들어드려요)
      addMemberToBuddyPool(guild, member).catch((e) => console.error("[버디풀 처리 오류]", e));
    }
    if (EBOOK_DOWNLOAD_URL) {
      await safeDM(member, `📘 **${EBOOK_NAME}** 다운로드 링크예요 👇\n${EBOOK_DOWNLOAD_URL}`);
    } else {
      console.warn(`[전자책 다운로드 안내 누락] EBOOK_DOWNLOAD_URL이 설정되어 있지 않아 ${member.user.tag}에게 다운로드 링크를 보내지 못했습니다.`);
      await safeDM(member, `전자책 다운로드 링크는 확인 후 곧 별도로 보내드릴게요. 잠시만 기다려주세요!`);
    }
    await announcePromotion(guild, member, "그로우-크루");

    // 구매 이전에 이미 누적 인증이 마스터-크루 기준을 넘어섰던 사람은
    // 다음 체크인을 기다릴 필요 없이 곧바로 마스터-크루까지 승급시켜줍니다.
    const u = getUser(discordUserId);
    if (u.cumulativeCount >= T_MASTER) {
      await member.roles.add(ROLE_ID_MASTER).catch((e) => console.error("[역할부여 실패] 마스터-크루(구매 즉시)", e));
      await safeDM(
        member,
        `그동안 쌓아온 누적 ${u.cumulativeCount}회 기록 덕분에 마스터-크루로도 바로 승급했어요! #마스터-크루, #우선질문 채널이 열렸습니다.`
      );
      await announcePromotion(guild, member, "마스터-크루");
    }
  } catch (e) {
    console.error("[전자책 승급 처리 오류]", e);
  }
}

// ── PayApp 결제완료 웹훅 수신 서버 ────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("OK"));

// 전자책 소개 랜딩페이지를 직접 서빙합니다 (외부 사이트 의존 없이,
// 로그인 없이 누구나 바로 볼 수 있어요). ?uid=디스코드유저ID를 붙이면
// 페이지 내 구매 버튼이 본인 전용 결제 링크로 자동 연결됩니다.
app.get("/landing", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});

app.post("/payapp/feedback", async (req, res) => {
  // PayApp은 이 엔드포인트가 정확히 'SUCCESS' 응답을 주지 않으면 재시도하므로,
  // 처리 중 어떤 오류가 나도 일단 200 SUCCESS는 보내고 로그로만 남깁니다.
  try {
    const body = req.body || {};
    console.log("[PayApp 웹훅 수신]", JSON.stringify(body));

    if (!PAYAPP_USERID || !PAYAPP_LINKKEY || !PAYAPP_LINKVAL) {
      console.error("[PayApp 웹훅] 서버에 PayApp 검증키가 설정되어 있지 않습니다.");
      return res.status(200).send("SUCCESS");
    }

    const isAuthentic =
      String(body.userid) === PAYAPP_USERID &&
      String(body.linkkey) === PAYAPP_LINKKEY &&
      String(body.linkval) === PAYAPP_LINKVAL;

    if (!isAuthentic) {
      console.error("[PayApp 웹훅] 인증값(userid/linkkey/linkval) 불일치 - 위조 요청 가능성, 무시합니다.");
      return res.status(200).send("SUCCESS");
    }

    if (String(body.pay_state) !== "4") {
      // 4 = 결제완료. 그 외(취소/대기 등)는 무시.
      return res.status(200).send("SUCCESS");
    }

    const mulNo = body.mul_no;
    const discordUserId = body.var1;

    if (!discordUserId) {
      console.error("[PayApp 웹훅] var1(디스코드 유저ID)이 비어있습니다.", mulNo);
      return res.status(200).send("SUCCESS");
    }

    if (mulNo && isPaymentProcessed(mulNo)) {
      return res.status(200).send("SUCCESS"); // 이미 처리한 결제건 - 중복 무시
    }
    if (mulNo) markPaymentProcessed(mulNo);

    updateUser(discordUserId, { ebookPurchased: true, ebookPurchasedAt: new Date().toISOString() });
    await promoteToGrowCrewByEbook(discordUserId);

    res.status(200).send("SUCCESS");
  } catch (e) {
    console.error("[PayApp 웹훅 처리 오류]", e);
    res.status(200).send("SUCCESS");
  }
});

// ── 랜딩페이지 구매 버튼 → 결제 페이지 리다이렉트 ────────────────
// 랜딩페이지의 구매 버튼이 이 주소로 연결됩니다. PayApp 결제 링크는
// 1회용이라 미리 만들어두지 않고, 버튼을 누른 바로 이 시점에 새로 생성해서
// 곧장 그 결제 페이지로 이동(302)시킵니다. 비밀키(PAYAPP_LINKKEY 등)는
// 이 서버 밖으로 절대 나가지 않습니다.
app.get("/go/:discordUserId", async (req, res) => {
  const discordUserId = (req.params.discordUserId || "").trim();
  const backToDiscordMsg =
    "디스코드로 돌아가서 봇에게 다시 \"구매\"라고 DM을 보내주세요.";

  if (!discordUserId) {
    return res.status(400).send(`요청이 올바르지 않아요. ${backToDiscordMsg}`);
  }

  try {
    const user = getUser(discordUserId);
    if (user.ebookPurchased) {
      return res
        .status(200)
        .send("이미 구매를 완료하고 그로우-크루로 승급하셨어요! 디스코드로 돌아가서 #그로우-라운지를 확인해보세요.");
    }

    if (!PAYAPP_USERID || !PAYAPP_LINKKEY || !PAYAPP_LINKVAL || !EBOOK_PRICE || !PUBLIC_BASE_URL) {
      return res.status(503).send(`아직 결제 기능이 준비 중이에요. ${backToDiscordMsg}`);
    }

    const payUrl = await createPayAppPaymentLink(discordUserId);
    if (!payUrl) {
      console.error("[/go 리다이렉트] 결제 링크 생성 실패", discordUserId);
      return res.status(502).send(`결제 링크 생성에 실패했어요. ${backToDiscordMsg}`);
    }

    res.redirect(302, payUrl);
  } catch (e) {
    console.error("[/go 리다이렉트 오류]", e);
    res.status(500).send(`오류가 발생했어요. ${backToDiscordMsg}`);
  }
});

const HTTP_PORT = process.env.PORT || 3000;
app.listen(HTTP_PORT, () => {
  console.log(`[웹서버 시작] PayApp 웹훅 서버가 ${HTTP_PORT} 포트에서 대기중`);
});

// ── SOS 온콜 에스컬레이션: 지정한 채널에 온콜 역할을 태그해서 사람이 직접 챙기게 함 ──
async function escalateToOnCall(message) {
  if (!ONCALL_ROLE_ID || !ONCALL_CHANNEL_NAME) return; // 둘 다 설정 안 했으면 조용히 스킵
  const channel = message.guild.channels.cache.find(
    (c) => c.name === ONCALL_CHANNEL_NAME && typeof c.send === "function"
  );
  if (!channel) return;
  await channel.send(`🚨 <@&${ONCALL_ROLE_ID}> #${SOS_CHANNEL_NAME}에 새 SOS 요청이 있어요.\n${message.url}`);
}

// ── 리부트 버디 그룹: 전자책을 구매한(그로우-크루) 멤버들을 모아 자동으로 소그룹(역할+비공개 채널)을 만듭니다 ──
async function addMemberToBuddyPool(guild, member) {
  const pool = addToBuddyPool(member.id);
  if (pool.length < BUDDY_GROUP_SIZE) return;

  const groupMemberIds = pool.slice(0, BUDDY_GROUP_SIZE);
  const leftover = pool.slice(BUDDY_GROUP_SIZE);
  clearBuddyPool();
  for (const id of leftover) addToBuddyPool(id); // 동시에 더 쌓였을 수 있는 인원은 다음 그룹으로

  await formBuddyGroup(guild, groupMemberIds);
}

async function formBuddyGroup(guild, memberIds) {
  const groupNumber = nextBuddyGroupNumber();
  const roleName = `리부트버디-${groupNumber}`;
  const channelName = `리부트-버디-${groupNumber}`;

  try {
    const role = await guild.roles.create({ name: roleName, mentionable: true, reason: "리부트 버디 그룹 자동 생성" });

    let category = guild.channels.cache.find(
      (c) => c.name === BUDDY_CATEGORY_NAME && c.type === ChannelType.GuildCategory
    );
    if (!category) {
      category = await guild.channels.create({
        name: BUDDY_CATEGORY_NAME,
        type: ChannelType.GuildCategory,
        reason: "리부트 버디 그룹 카테고리 자동 생성",
      });
    }

    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: role.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      },
    ];
    if (guild.members.me) {
      overwrites.push({
        id: guild.members.me.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels],
      });
    }

    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: overwrites,
      reason: "리부트 버디 그룹 채널 자동 생성",
    });

    const mentions = [];
    for (const id of memberIds) {
      const m = await guild.members.fetch(id).catch(() => null);
      if (!m) continue;
      await m.roles.add(role).catch((e) => console.error("[버디 역할부여 실패]", e));
      updateUser(id, { buddyGroupNumber: groupNumber, buddyRoleId: role.id, buddyChannelId: channel.id });
      mentions.push(`<@${id}>`);
    }

    await channel.send(
      `👋 ${mentions.join(" ")}\n` +
        `비슷한 시기에 전자책을 구매하고 리부트를 시작한 분들끼리 작은 버디 그룹으로 묶어드렸어요!\n\n` +
        `이 채널은 이렇게 쓰시면 좋아요.\n` +
        `- 오늘 인증한 스크린샷이나 짧은 한 줄을 여기에도 남겨보세요. 같은 걸 겪는 사람들이 보면 그 자체로 자극이 돼요.\n` +
        `- 힘든 날엔 여기서 먼저 말을 걸어보세요. 제일 잘 이해해줄 사람들이에요.\n` +
        `- 가끔 서로 안부만 물어봐도 충분해요. 정해진 규칙은 없어요.\n\n` +
        `혼자보다 몇 명이서 같이 하는 게 훨씬 오래갑니다 🙂`
    );
    addBuddyGroupRecord({ groupNumber, channelId: channel.id, roleId: role.id });
    console.log(`[리부트버디그룹 생성] ${roleName} / ${channelName} (${memberIds.length}명)`);
  } catch (e) {
    console.error("[리부트버디그룹 생성 실패] (봇에 '채널 관리' 권한이 있는지 확인해주세요)", e);
  }
}

// ── 즉시반응 시스템: 최근 활동한 그로우/마스터-크루에게 조용히 알림 ──
async function notifyHelpers(message) {
  const guild = message.guild;
  // 그로우-크루/마스터-크루뿐 아니라, 무료회원 중 가장 활발한 베테랑(90회+) 등급도
  // SOS 도움 요청에 응답해줄 수 있는 헬퍼 풀에 포함합니다.
  const roleIds = [ROLE_ID_GROW, ROLE_ID_MASTER, process.env.ROLE_ID_FREE_LV4].filter(Boolean);
  if (roleIds.length === 0) return;

  const members = await guild.members.fetch();
  const now = new Date();

  const candidates = members.filter((m) => {
    if (m.user.bot) return false;
    if (m.id === message.author.id) return false;
    if (!roleIds.some((rid) => m.roles.cache.has(rid))) return false;

    const u = getUser(m.id);
    if (!u.lastCheckInDate) return false;
    const last = new Date(u.lastCheckInDate + "T00:00:00+09:00");
    if (daysBetween(last, now) > HELPER_ACTIVE_WITHIN_DAYS) return false;

    if (u.lastHelperPingAt) {
      const hoursSince = (now - new Date(u.lastHelperPingAt)) / (1000 * 60 * 60);
      if (hoursSince < HELPER_NOTIFY_COOLDOWN_HOURS) return false;
    }
    return true;
  });

  const shuffled = [...candidates.values()].sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, HELPER_NOTIFY_COUNT);

  for (const member of picked) {
    await safeDM(
      member,
      `지금 #${SOS_CHANNEL_NAME}에 도움이 필요한 분이 있는 것 같아요. 시간 되실 때 한마디 남겨주실 수 있을까요?\n${message.url}`
    );
    updateUser(member.id, { lastHelperPingAt: now.toISOString() });
  }
}

// ── 승급 알림 & 배지 시스템: 공개 채널 축하 메시지 ──────────
async function announcePromotion(guild, member, roleLabel) {
  try {
    const u = getUser(member.id);
    if (u.publicAnnounceOptOut) return;
    const channel = guild.channels.cache.find(
      (c) => c.name === ANNOUNCE_CHANNEL_NAME && typeof c.send === "function"
    );
    if (!channel) return;
    await channel.send(`🎉 **${member.displayName}**님이 ${roleLabel}로 승급했어요! 축하해주세요 👏`);
  } catch (e) {
    console.error("[승급 공개 알림 실패]", e);
  }
}

// ── 멘토 하이라이트 시스템: 감사 리액션 집계 ─────────────────
client.on(Events.MessageReactionAdd, async (reaction, reactUser) => {
  try {
    if (reactUser.bot) return;
    if (reaction.partial) await reaction.fetch().catch(() => null);
    if (reaction.message.partial) await reaction.message.fetch().catch(() => null);
    if (reaction.emoji.name !== HELPER_THANKS_EMOJI) return;

    const message = reaction.message;
    if (!message.guild || message.guild.id !== GUILD_ID) return;
    if (!message.author || message.author.bot) return;
    if (message.author.id === reactUser.id) return; // 자기 글 셀프 감사 방지

    const authorMember = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!authorMember) return;
    const isHelperRole =
      (ROLE_ID_GROW && authorMember.roles.cache.has(ROLE_ID_GROW)) ||
      (ROLE_ID_MASTER && authorMember.roles.cache.has(ROLE_ID_MASTER));
    if (!isHelperRole) return;

    const u = getUser(message.author.id);
    updateUser(message.author.id, {
      weeklyHelperPoints: (u.weeklyHelperPoints || 0) + 1,
      totalHelperPoints: (u.totalHelperPoints || 0) + 1,
    });
  } catch (e) {
    console.error("[감사 리액션 처리 오류]", e);
  }
});

client.on(Events.MessageReactionRemove, async (reaction, reactUser) => {
  try {
    if (reactUser.bot) return;
    if (reaction.partial) await reaction.fetch().catch(() => null);
    if (reaction.message.partial) await reaction.message.fetch().catch(() => null);
    if (reaction.emoji.name !== HELPER_THANKS_EMOJI) return;

    const message = reaction.message;
    if (!message.guild || message.guild.id !== GUILD_ID) return;
    if (!message.author || message.author.bot) return;
    if (message.author.id === reactUser.id) return;

    const u = getUser(message.author.id);
    updateUser(message.author.id, {
      weeklyHelperPoints: Math.max(0, (u.weeklyHelperPoints || 0) - 1),
      totalHelperPoints: Math.max(0, (u.totalHelperPoints || 0) - 1),
    });
  } catch (e) {
    console.error("[감사 리액션 취소 처리 오류]", e);
  }
});

// ── 매일 정기 점검: 온보딩 미션 + 미기록 독려 + 월간 리포트 + 결제전환 DM ──
function scheduleDailyJob() {
  const expr = DAILY_CRON || "0 9 * * *";
  cron.schedule(expr, () => runDailyJob().catch((e) => console.error("[dailyJob 오류]", e)), { timezone: TZ });
  console.log(`[예약 등록] 매일 정기 점검 cron: "${expr}" (${TZ})`);
}

async function runDailyJob() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const members = await guild.members.fetch();
  const now = new Date();
  const today = todayKST();
  const lastDay = isLastDayOfMonthKST(today);

  for (const member of members.values()) {
    if (member.user.bot) continue;
    const user = getUser(member.id);

    // 1) 미기록 독려 DM (3일 이상 기록 없을 때, 같은 날 중복 발송 방지)
    if (user.lastCheckInDate) {
      const last = new Date(user.lastCheckInDate + "T00:00:00+09:00");
      const gap = daysBetween(last, now);
      if (gap >= 3 && user.lastInactivityNudgeDate !== today) {
        await safeDM(member, "요즘 기록이 뜸하네요. 괜찮아요, 아무때나 다시 시작하면 됩니다 🙂");
        updateUser(member.id, { lastInactivityNudgeDate: today });
      }
    }

    // 2) 온보딩 미션 시퀀스 (가입 D+1/3/7) - 결제 여부와 무관하게 모두 대상
    if (member.joinedAt) {
      const daysSinceJoin = daysBetween(member.joinedAt, now);
      if (daysSinceJoin === 1 && !user.dmFlags.o1) {
        await safeDM(
          member,
          `가입한 지 하루 됐어요! 오늘의 미션: #끄고-인증이나 #자연-인증에 오늘 하루를 기록해보세요. 사진이어도 좋고 짧은 한 줄이어도 좋아요.`
        );
        markDmSent(member.id, "o1");
      } else if (daysSinceJoin === 3 && !user.dmFlags.o3) {
        await safeDM(
          member,
          `벌써 3일째예요! 오늘은 #자유수다에 인사 한마디 남겨보는 거 어때요? 혼자보다 같이가 훨씬 오래 갑니다.`
        );
        markDmSent(member.id, "o3");
      } else if (daysSinceJoin === 7 && !user.dmFlags.o7) {
        await safeDM(
          member,
          `가입한 지 일주일이에요. 지금까지 누적 인증 ${user.cumulativeCount}회 하셨어요. 꾸준히 잘 해오고 계세요, 계속 가봐요!`
        );
        markDmSent(member.id, "o7");
      }
    }

    // 3) 월간 리포트 카드 (매월 마지막 날, 유저당 최초 1회)
    if (lastDay) {
      const monthKey = today.slice(0, 7);
      if (user.lastMonthlyReportMonth !== monthKey) {
        const monthCount = (user.monthlyCounts && user.monthlyCounts[monthKey]) || 0;
        if (monthCount > 0) {
          const prevKey = prevMonthKey(monthKey);
          const prevCount = (user.monthlyCounts && user.monthlyCounts[prevKey]) || 0;
          const diff = monthCount - prevCount;
          const diffStr = diff > 0 ? `+${diff}` : `${diff}`;
          await safeDM(
            member,
            `📊 이번 달 기록을 정리해봤어요.\n` +
              `이번 달 인증 ${monthCount}회, 최장 연속 ${user.longestStreak || 0}일, 지난달 대비 ${diffStr}회.\n` +
              `꾸준히 잘 해오고 계세요!`
          );
        }
        updateUser(member.id, { lastMonthlyReportMonth: monthKey });
      }
    }

    // 4) 결제전환 시퀀스 (D+25/27/29/30) - 아직 전자책을 구매하지 않은 사람만
    if (user.ebookPurchased) continue;
    if (!member.joinedAt) continue;

    const daysSinceJoin = daysBetween(member.joinedAt, now);

    if (daysSinceJoin === 25 && !user.dmFlags.d25) {
      await safeDM(
        member,
        `지금까지 쌓은 기록을 정리해봤어요.\n누적 인증 ${user.cumulativeCount}회, 현재 등급: ${describeCurrentLevel(member, user)}.\n${describeNextLevelProgress(member, user)}\n꾸준히 잘 해오고 계세요!`
      );
      markDmSent(member.id, "d25");
    } else if (daysSinceJoin === 27 && !user.dmFlags.d27) {
      await safeDM(
        member,
        `그로우-크루가 되면 #그로우-라운지 같은 전용 공간이 열리고, 꾸준히 더 쌓으면 최종 등급인 마스터-크루까지 갈 수 있어요.\n` +
          `전자책을 구매하면 바로 그로우-크루로 승급돼요. DM으로 "구매"라고 보내시면 구매 링크를 받아보실 수 있어요. 지금까지의 기록이 아깝지 않게, 한번 둘러보세요.`
      );
      markDmSent(member.id, "d27");
    } else if (daysSinceJoin === 29 && !user.dmFlags.d29) {
      await safeDM(
        member,
        `벌써 가입한 지 29일째예요! 지금까지 누적 인증 ${user.cumulativeCount}회, 현재 등급: ${describeCurrentLevel(member, user)}.\n` +
          `여기까지 꾸준히 잘 오셨어요. 그로우-크루로 승급하면 전용 공간과 콘텐츠가 열리니, 아직이시라면 한번 살펴보세요.`
      );
      markDmSent(member.id, "d29");
    } else if (daysSinceJoin === 30 && !user.dmFlags.d30) {
      await safeDM(
        member,
        `가입한 지 한 달이 됐어요 🎉 그동안 쌓아온 기록은 계속 그대로 남아있으니 걱정 마세요.\n` +
          `DM으로 "구매"라고 보내시면 전자책 구매 링크를 바로 받아보실 수 있고, 결제 완료 즉시 그로우-크루로 승급돼요.` +
          (PAYMENT_LINK ? `\n더 알아보기 👉 ${PAYMENT_LINK}` : "")
      );
      markDmSent(member.id, "d30");
    }
  }
}

// ── 데일리 스트릭 대시보드: 스트릭 끊기기 전 저녁 리마인더 ──────
function scheduleStreakReminderJob() {
  const expr = process.env.STREAK_REMINDER_CRON || "0 21 * * *";
  cron.schedule(
    expr,
    () => runStreakReminderJob().catch((e) => console.error("[스트릭 리마인더 오류]", e)),
    { timezone: TZ }
  );
  console.log(`[예약 등록] 스트릭 리마인더 cron: "${expr}" (${TZ})`);
}

async function runStreakReminderJob() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const members = await guild.members.fetch();
  const now = new Date();
  const today = todayKST();

  for (const member of members.values()) {
    if (member.user.bot) continue;
    const user = getUser(member.id);
    if (!user.lastCheckInDate || !user.currentStreak) continue;
    if (user.lastCheckInDate === today) continue; // 오늘 이미 체크인함 - 리마인더 불필요
    if (user.lastStreakReminderDate === today) continue; // 오늘 이미 보냄

    const last = new Date(user.lastCheckInDate + "T00:00:00+09:00");
    const gap = daysBetween(last, now);
    if (gap === 1) {
      // 마지막 체크인이 어제라 아직 스트릭을 이어갈 기회가 있는 상태
      await safeDM(
        member,
        `지금 ${user.currentStreak}일째 이어오고 계세요 🔥 오늘 하루도 잊지 않으셨다면 인증 한 번 남겨서 기록을 이어가보세요.`
      );
      updateUser(member.id, { lastStreakReminderDate: today });
    }
  }
}

// ── 멘토 하이라이트 시스템: 주간 도움왕 발표 ────────────────
function scheduleWeeklyHighlightJob() {
  const expr = process.env.WEEKLY_HIGHLIGHT_CRON || "0 21 * * 0";
  cron.schedule(
    expr,
    () => runWeeklyHighlightJob().catch((e) => console.error("[주간 하이라이트 오류]", e)),
    { timezone: TZ }
  );
  console.log(`[예약 등록] 주간 도움왕 하이라이트 cron: "${expr}" (${TZ})`);
}

async function runWeeklyHighlightJob() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const ids = allUserIds();

  let top = null;
  for (const id of ids) {
    const u = getUser(id);
    if (!u.weeklyHelperPoints) continue;
    if (!top || u.weeklyHelperPoints > top.points) {
      top = { id, points: u.weeklyHelperPoints };
    }
  }

  if (top) {
    const member = await guild.members.fetch(top.id).catch(() => null);
    const channel = guild.channels.cache.find(
      (c) => c.name === HONOR_CHANNEL_NAME && typeof c.send === "function"
    );
    if (member && channel) {
      await channel
        .send(
          `🏆 이주의 도움왕: **${member.displayName}**님 (감사 반응 ${top.points}회)\n다른 멤버를 도와주셔서 정말 고마워요!`
        )
        .catch((e) => console.error("[주간 하이라이트 발표 실패]", e));
    }
  }

  // 주간 포인트 리셋 (누적 포인트는 유지 - 추후 랭킹 페이지용)
  for (const id of ids) {
    updateUser(id, { weeklyHelperPoints: 0 });
  }
}

// ── 주간 팁 & 회고 질문 ──────────────────────────────────────
function scheduleWeeklyTipJob() {
  const expr = process.env.WEEKLY_TIP_CRON || "0 10 * * 2"; // 기본: 매주 화요일 오전 10시
  cron.schedule(expr, () => runWeeklyTipJob().catch((e) => console.error("[주간 팁 오류]", e)), { timezone: TZ });
  console.log(`[예약 등록] 주간 팁 cron: "${expr}" (${TZ})`);
}

async function runWeeklyTipJob() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const members = await guild.members.fetch();
  const weekKey = isoWeekKey(new Date());
  const weekNum = parseInt(weekKey.split("-W")[1], 10) || 0;
  const tip = WEEKLY_TIPS[weekNum % WEEKLY_TIPS.length];
  const reflectionQuestion = REFLECTION_QUESTIONS[weekNum % REFLECTION_QUESTIONS.length];

  for (const member of members.values()) {
    if (member.user.bot) continue;
    const user = getUser(member.id);
    if (user.lastWeeklyTipWeek === weekKey) continue; // 이번 주 이미 보냄

    await safeDM(
      member,
      `💡 이번 주 팁\n${tip}\n\n📝 이번 주 질문: ${reflectionQuestion}\n(이 메시지에 편하게 답장해주시면 기록해둬요. "회고"라고 보내면 그동안 남긴 회고를 다시 볼 수 있어요. 답 안 하셔도 전혀 괜찮아요!)`
    );
    updateUser(member.id, {
      lastWeeklyTipWeek: weekKey,
      lastWeeklyReflectionWeek: weekKey,
      awaitingReflectionReply: true,
      reflectionPromptSentAt: new Date().toISOString(),
    });
  }
}

// ── 이주의 챌린지: 매주 새 미션 발행 ─────────────────────────
function scheduleWeeklyChallengeJob() {
  const expr = process.env.CHALLENGE_CRON || "0 9 * * 1"; // 기본: 매주 월요일 오전 9시
  cron.schedule(
    expr,
    () => runWeeklyChallengeJob().catch((e) => console.error("[주간 챌린지 오류]", e)),
    { timezone: TZ }
  );
  console.log(`[예약 등록] 주간 챌린지 cron: "${expr}" (${TZ})`);
}

async function runWeeklyChallengeJob() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = guild.channels.cache.find(
    (c) => c.name === CHALLENGE_CHANNEL_NAME && typeof c.send === "function"
  );
  if (!channel) return;

  const weekKey = isoWeekKey(new Date());
  const weekNum = parseInt(weekKey.split("-W")[1], 10) || 0;
  // 50개를 순서대로 돌리고, 다 쓰면(51주차부터) 다시 처음으로 돌아가 계속 반복됩니다.
  const challenge = WEEKLY_CHALLENGES[weekNum % WEEKLY_CHALLENGES.length];

  const verifyChannel = guild.channels.cache.find(
    (c) => c.name === CHALLENGE_VERIFY_CHANNEL_NAME && typeof c.send === "function"
  );
  const verifyMention = verifyChannel ? `<#${verifyChannel.id}>` : `#${CHALLENGE_VERIFY_CHANNEL_NAME}`;

  await channel
    .send(`🎯 이번 주 챌린지\n\n${challenge}\n\n완료했다면 ${verifyMention} 에서 인증해주세요!`)
    .catch((e) => console.error("[주간 챌린지 발행 실패]", e));
}

// ── 버디 그룹 채널 주간 안부: 채팅방이 조용해지지 않도록 매주 한 번 메시지를 보냅니다 ──
function scheduleBuddyCheckinJob() {
  cron.schedule(
    BUDDY_CHECKIN_CRON,
    () => runBuddyCheckinJob().catch((e) => console.error("[버디 안부 오류]", e)),
    { timezone: TZ }
  );
  console.log(`[예약 등록] 버디 안부 cron: "${BUDDY_CHECKIN_CRON}" (${TZ})`);
}

async function runBuddyCheckinJob() {
  const groups = getBuddyGroups();
  if (groups.length === 0) return;

  const guild = await client.guilds.fetch(GUILD_ID);
  const weekKey = isoWeekKey(new Date());
  const weekNum = parseInt(weekKey.split("-W")[1], 10) || 0;
  const message = BUDDY_CHECKIN_MESSAGES[weekNum % BUDDY_CHECKIN_MESSAGES.length];

  for (const group of groups) {
    const channel = await guild.channels.fetch(group.channelId).catch(() => null);
    if (!channel) {
      // 채널이 삭제된 경우, 다음부터는 대상에서 제외되도록 기록을 정리합니다.
      removeBuddyGroupRecord(group.channelId);
      continue;
    }
    await channel.send(`👋 ${message}`).catch((e) => console.error("[버디 안부 발송 실패]", e));
  }
}

function markDmSent(userId, key) {
  const user = getUser(userId);
  user.dmFlags[key] = true;
  updateUser(userId, { dmFlags: user.dmFlags });
}

// ── 공용 유틸: 실패해도 봇이 죽지 않게 감싸기 ──────────────────
async function safeReact(message, emoji) {
  try {
    await message.react(emoji);
  } catch (e) {
    // 리액션 권한 없거나 메시지 삭제된 경우 등 - 무시
  }
}

async function safeDM(member, text) {
  try {
    await member.send(text);
  } catch (e) {
    // DM 차단한 유저 - 무시하고 로그만 남김
    console.warn(`[DM 실패] ${member.user.tag} (${member.id}) - DM이 막혀있을 수 있어요.`);
  }
}

client.login(DISCORD_TOKEN);

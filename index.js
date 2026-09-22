require("dotenv").config();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
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
  nextConvoStarterIndex,
  nextConfessionResponseIndex,
  recordConfessionRelay,
  getConfessionRelayTarget,
} = require("./lib/store");
const {
  appendRebootEvent,
  appendSalesEvent,
  appendConfessionEvent,
  appendMonthlyChallengeEvent,
  isConfigured: isSheetsConfigured,
} = require("./lib/sheets");

const {
  DISCORD_TOKEN,
  GUILD_ID,
  ROLE_ID_REBOOT,
  ROLE_ID_GROW,
  ROLE_ID_MASTER,
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

// 체크인 인정 채널을 특정 채널로 한정하지 않고, 서버 어느 채널에 글을 남겨도
// (하루 1회만 카운트) 누적 인증으로 인정합니다. 최소한의 스팸 방지로 "의미 있는
// 텍스트(2자 이상)"나 "첨부파일" 둘 중 하나는 있어야 합니다.

// 마스터-크루는 "이미 리부트-크루(전자책 구매 완료)인 사람"이 누적 인증을 더 쌓았을 때 도달하는
// 최종 등급입니다. (리부트-크루 자체는 더 이상 누적 횟수가 아니라 전자책 구매로만 승급합니다 - 아래 참고)
const T_MASTER = parseInt(THRESHOLD_MASTER || "30", 10);
const TZ = TIMEZONE || "Asia/Seoul";

// (일반멤버 4단계 등급 배지 시스템 - 탈출시작/저항력/실천가/베테랑 - 은
// 채널 구조를 오늘의-기록/힘든날-나눔으로 통합하면서 카운팅 대상 채널이 모두
// 사라져 더 이상 아무도 새로 승급할 수 없는 상태였고, 커뮤니티 초간소화 개편에
// 맞춰 역할·코드 모두 삭제했습니다.)

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

// ── 전자책 원본 파일 저장 + 구매자별 워터마크 발급 ──────────────
// 실제 판매되는 전자책 원본 PDF는 유출 방지를 위해 git 저장소에는 절대 커밋하지 않고,
// Railway 영구 볼륨(lib/store.js와 동일한 DATA_DIR)에만 저장합니다.
// 운영진이 봇 DM으로 "!전자책원본업로드" + PDF 파일을 함께 보내면 그 파일로 저장/교체되고,
// 이후 결제가 확인될 때마다 이 원본에 구매자 워터마크를 새로 입혀서 DM으로 보내드립니다.
const EBOOK_DATA_DIR = process.env.DATA_DIR || "/data";
const EBOOK_MASTER_PATH = fs.existsSync(EBOOK_DATA_DIR)
  ? path.join(EBOOK_DATA_DIR, "ebook_master.pdf")
  : path.join(__dirname, "ebook_master.local.pdf"); // 볼륨이 없는 로컬 개발 환경용
const EBOOK_UPLOAD_COMMAND = "!전자책원본업로드";
const EBOOK_RESET_COMMAND = "!구매초기화";
const EBOOK_PURCHASE_DELETE_COMMAND = "!구매기록삭제";
const PROMOTION_ANNOUNCE_COMMAND = "!승급축하";

// 판매 상품은 전자책 + 30일 워크북 "두 파일" 번들이라(랜딩페이지에도 "전자책과 워크북
// 두 파일 모두" 라고 명시되어 있음), 워크북도 전자책과 완전히 동일한 방식(원본 별도 업로드 +
// 구매자별 워터마크 + DM 첨부 발송)으로 처리합니다.
const WORKBOOK_NAME = process.env.WORKBOOK_NAME || "30일 리부트 챌린지 워크북";
const WORKBOOK_MASTER_PATH = fs.existsSync(EBOOK_DATA_DIR)
  ? path.join(EBOOK_DATA_DIR, "workbook_master.pdf")
  : path.join(__dirname, "workbook_master.local.pdf");
const WORKBOOK_UPLOAD_COMMAND = "!워크북원본업로드";

// 워터마크 텍스트(한글 포함)를 이미지로 그려서 PDF에 얹기 위한 한글 폰트.
// (pdf-lib에 직접 한글 폰트를 임베드하면 일부 글자가 깨지는 문제가 있어,
// @napi-rs/canvas로 텍스트를 이미지로 렌더링한 뒤 그 이미지를 페이지에 얹는 방식을 씁니다.)
const EBOOK_WATERMARK_FONT_PATH = path.join(__dirname, "assets", "fonts", "Pretendard-Regular.ttf");
const EBOOK_WATERMARK_FONT_FAMILY = "Pretendard";
if (fs.existsSync(EBOOK_WATERMARK_FONT_PATH)) {
  try {
    require("@napi-rs/canvas").GlobalFonts.registerFromPath(EBOOK_WATERMARK_FONT_PATH, EBOOK_WATERMARK_FONT_FAMILY);
  } catch (e) {
    console.error("[전자책 워터마크 폰트 등록 실패]", e);
  }
}

// ── 즉시반응 시스템 (#충동-sos) ─────────────────────────────────
const SOS_CHANNEL_NAME = process.env.SOS_CHANNEL_NAME || "충동-sos";
const SOS_REACT_EMOJI = process.env.SOS_REACT_EMOJI || "🫂";
const HELPER_NOTIFY_COUNT = parseInt(process.env.HELPER_NOTIFY_COUNT || "3", 10);
const HELPER_ACTIVE_WITHIN_DAYS = parseInt(process.env.HELPER_ACTIVE_WITHIN_DAYS || "3", 10);
const HELPER_NOTIFY_COOLDOWN_HOURS = parseInt(process.env.HELPER_NOTIFY_COOLDOWN_HOURS || "6", 10);

// ── 신규 멤버 첫 인사 알림 ────────────────────────────────
// 자기소개/오늘의-기록에 신규 멤버가 첫 글을 남기면, SOS와 같은 헬퍼 풀(최근 활동한
// 리부트-크루/마스터-크루)에게 "인사해주세요" 알림을 보냅니다. 신규 멤버 환영이
// 운영자 혼자만의 일이 아니라 커뮤니티 전체의 일이 되도록 하기 위함입니다.
const SELF_INTRO_CHANNEL_NAME = process.env.SELF_INTRO_CHANNEL_NAME || "자기소개";
const DAILY_LOG_CHANNEL_NAME = process.env.DAILY_LOG_CHANNEL_NAME || "오늘의-기록";
const NEWCOMER_WELCOME_CHANNELS = [SELF_INTRO_CHANNEL_NAME, DAILY_LOG_CHANNEL_NAME];

// ── SOS 온콜 에스컬레이션 (사람이 직접 챙기는 안전망) ──────────
// ONCALL_ROLE_ID/ONCALL_CHANNEL_NAME을 둘 다 채우면, SOS가 올라올 때마다
// 그 채널에 온콜 역할을 태그해서 알려줍니다. (운영자가 직접 순번을 정해서
// 그 역할을 사람들에게 부여해두는 방식 - 봇이 당번을 자동으로 정하진 않아요)
const ONCALL_ROLE_ID = process.env.ONCALL_ROLE_ID || "";
const ONCALL_CHANNEL_NAME = process.env.ONCALL_CHANNEL_NAME || "";

// SOS 직후 "뭐 때문에 그랬는지" DM 질문에 대한 응답을 인정할 시간 (분)
const TRIGGER_REPLY_WINDOW_MINUTES = parseInt(process.env.TRIGGER_REPLY_WINDOW_MINUTES || "30", 10);

// ── 경고 누적 시스템 (모욕/욕설/성적 발언 등, AutoMod 키워드 필터로는 못 거르는 것들) ──
// 운영진(타임아웃/관리자 권한 보유자)이 "!경고 @유저 사유"로 경고를 주면 자동으로 쌓이고,
// 2회째 자동 타임아웃, 3회째 자동 추방으로 에스컬레이션됩니다.
const WARNING_COMMAND = process.env.WARNING_COMMAND || "!경고";
const WARNING_CHECK_COMMAND = process.env.WARNING_CHECK_COMMAND || "!경고확인";
const WARNING_RESET_COMMAND = process.env.WARNING_RESET_COMMAND || "!경고초기화";
const WARNING_TIMEOUT_HOURS = parseInt(process.env.WARNING_TIMEOUT_HOURS || "24", 10);
const MOD_LOG_CHANNEL_NAME = process.env.MOD_LOG_CHANNEL_NAME || "신고";

// ── 데일리 스트릭 대시보드 (+ 스트릭 프리즈권) — 봇 DM에서 "!기록"으로 조회 ──
const STREAK_COMMAND = process.env.STREAK_COMMAND || "!기록";
// 한 달에 이 횟수만큼은, 하루를 걸러도 연속기록(스트릭)이 끊기지 않습니다.
const STREAK_FREEZE_PER_MONTH = parseInt(process.env.STREAK_FREEZE_PER_MONTH || "1", 10);

// ── 멘토 하이라이트 시스템 ─────────────────────────────────
const HELPER_THANKS_EMOJI = process.env.HELPER_THANKS_EMOJI || "🙏";

// ── 지킴이 배지: 도움 포인트 누적 시 자동 부여 ──────────────────
// 마스터-크루(자기 자신의 인증 누적)와는 완전히 별개로, 다른 사람을 도운 감사 리액션
// 누적치(totalHelperPoints, 주간 집계와 달리 절대 초기화되지 않음)가 일정 점수를 넘으면
// 구매/등급과 무관하게 누구나 "지킴이" 역할을 자동으로 받습니다. 커뮤니티가 운영자 혼자가
// 아니라 서로 돕는 사람들에 의해 굴러간다는 걸 눈에 보이는 배지로 만들기 위함입니다.
// ROLE_ID_GUARDIAN을 아직 설정하지 않았다면(예: 역할을 만들었지만 .env/Railway에 반영 전)
// 조용히 건너뛰고 나머지 기능에는 영향을 주지 않습니다.
const ROLE_ID_GUARDIAN = process.env.ROLE_ID_GUARDIAN || "";
const GUARDIAN_THRESHOLD = parseInt(process.env.GUARDIAN_THRESHOLD || "10", 10);
const HONOR_CHANNEL_NAME = process.env.HONOR_CHANNEL_NAME || "명예의-전당";
// 커뮤니티 초간소화 개편으로 HONOR_CHANNEL_NAME(명예의-전당)이 삭제된 경우를 대비해,
// 못 찾으면 항상 존재하는 자유수다로 조용히 폴백합니다 (공개 축하 메시지가 아예
// 발송되지 않고 사라지는 것을 막기 위함).
const HONOR_CHANNEL_FALLBACK_NAME = "자유수다";
// 채널 이름에 정확히 일치(===)가 아니라 포함(includes) 여부로 찾습니다. 디스코드
// 채널 이름 앞뒤에 🎉 같은 장식 이모지를 붙이는 건 흔한 일인데, 예전엔 그것만으로도
// 정확히 일치하지 않아 채널을 못 찾고 조용히(로그도 없이) 실패하는 문제가 있었습니다.
function findAnnounceChannel(guild) {
  const found =
    guild.channels.cache.find((c) => typeof c.send === "function" && c.name.includes(HONOR_CHANNEL_NAME)) ||
    guild.channels.cache.find((c) => typeof c.send === "function" && c.name.includes(HONOR_CHANNEL_FALLBACK_NAME)) ||
    null;
  if (!found) {
    console.error(
      `[승급 공개 알림] 채널을 찾지 못했어요. "${HONOR_CHANNEL_NAME}" 또는 "${HONOR_CHANNEL_FALLBACK_NAME}"을 ` +
        `포함하는, 메시지를 보낼 수 있는 채널이 서버에 없어요.`
    );
  }
  return found;
}

// (리부트 버디 그룹 자동 매칭 시스템은 커뮤니티 초간소화 개편 때 삭제되었습니다.
// #자유수다에서 자연스럽게 형성되는 관계로 대체합니다.)

// ── 주간 팁 & 회고 ──────────────────────────────────────────
const REFLECTION_REPLY_WINDOW_HOURS = parseInt(process.env.REFLECTION_REPLY_WINDOW_HOURS || "24", 10);

const WEEKLY_TIPS = [
  "나를 자극하는 트리거(시간대, 감정, 장소)를 하나 적어보고, 그 순간에 쓸 대체 행동을 미리 정해두세요. 준비된 사람이 훨씬 덜 흔들려요.",
  "자기 전 30분은 침실 밖에서 휴대폰을 충전해보세요. 밤 시간대는 재발 위험이 가장 높은 시간대예요.",
  "차단 앱이나 필터를 설정해두면 의지력에만 기대지 않아도 돼요. 접근성을 낮추는 것만으로도 큰 도움이 돼요.",
  "완벽하게 참는 날보다, 재발해도 솔직하게 기록하는 오늘이 더 중요해요. 숨기지 않는 게 회복의 시작이에요.",
  "충동이 올라올 때 5분만 미뤄보세요. 대부분의 충동은 몇 분 안에 잦아들어요.",
  "같이 하는 사람이 있으면 훨씬 오래갑니다. 이번 주엔 서버에서 한 명에게 먼저 안부를 물어보는 건 어때요?",
  "하루를 돌아보며 '오늘 잘 버텨서 좋았던 순간'을 하나만 떠올려보세요. 작은 보상 감각이 회복을 강화해줘요.",
  "충동이 올 때 손이 갈 수 있는 대체 행동(운동, 산책, 통화) 하나를 미리 정해두면 훨씬 쉽게 넘길 수 있어요.",
];

const REFLECTION_QUESTIONS = [
  "이번 주 가장 힘들었던 순간은 언제였나요?",
  "이번 주, 충동이 왔을 때 다른 걸 선택했던 순간이 있었나요?",
  "요즘 나를 가장 많이 자극하는 상황이나 감정은 뭔가요?",
  "이번 주 스스로 칭찬해주고 싶은 게 있다면?",
  "다음 주에 하나만 바꿀 수 있다면 뭘 바꾸고 싶나요?",
];

// (자동 발행되던 "이주의 챌린지" 시스템은 커뮤니티 초간소화 개편 때 삭제되었습니다.
// 챌린지는 이제 sim이 필요할 때만 수동으로 공지하는 이벤트로 운영합니다.)

// ── 채널 대화거리(먼저 말 걸기) ─────────────────────────────
// 신규 커뮤니티가 죽어 보이는 제일 흔한 이유는 "먼저 말 걸 거리가 없어서"라서,
// #자유수다에 주기적으로 가벼운 질문을 자동으로 올립니다. 매번 같은 무게의
// 질문만 나오면 지루해지고, 매번 무거운 질문만 나오면 부담스러워서 아예 답을
// 안 하게 되므로, "가벼운 질문 풀"과 "깊은 질문 풀"을 따로 두고 매번 번갈아
// 뽑습니다 (가벼움 → 깊음 → 가벼움 → 깊음 ...). data.json에 저장된 순번
// (nextConvoStarterIndex)을 기준으로 순환하므로, 재배포/재시작돼도 중복 없이
// 이어서 나갑니다.
const CONVO_STARTER_LOW = [
  "오늘 점심(또는 저녁) 뭐 드셨어요?",
  "요즘 자기 전에 하는 루틴이 있어요?",
  "어릴 때 꿈이 뭐였어요?",
  "오늘 화면(휴대폰) 보는 시간, 스스로 만족스러워요?",
  "최근에 웃겼던 일 하나만 공유해주세요.",
  "여기 처음 들어왔을 때 어떤 마음이었어요?",
  "아침형 인간이에요, 저녁형 인간이에요?",
  "오늘 밥은 제때 챙겨 먹었어요?",
  "반려동물 키우세요? 자랑해주세요.",
  "요즘 기분 전환하려고 제일 자주 하는 게 뭐예요?",
  "최근에 산 물건 중에 제일 마음에 드는 거 있어요?",
  "오늘 하루 중 제일 편안했던 순간이 언제였어요?",
  "최근에 새로 배운 거 있어요?",
  "요즘 산책이나 바깥 공기 쐬는 시간 있어요?",
  "최근에 몸을 움직여서(운동, 산책 등) 기분 나아진 적 있어요?",
  "오늘 하루, 한 단어로 표현한다면?",
  "오늘 처음 눈뜨고 제일 먼저 한 행동이 뭐예요?",
  "이 서버 들어온 지 얼마나 됐어요? 계기가 뭐였어요?",
  "오늘 하루 중 스마트폰 제일 안 본 시간대가 언제였어요?",
  "요즘 하루 중 제일 기다려지는 시간이 언제예요?",
  "최근에 조용히 혼자 좋았던 순간 있어요?",
  "요즘 여기서 제일 자주 들어오는 채널이 어디예요?",
  "오늘 하루, 기억하고 싶은 장면 하나만 있다면요?",
  "요즘 제일 마음 편한 장소가 어디예요? (집 안이든 밖이든)",
  "오늘 여기 들어와서 제일 먼저 본 게 뭐였어요?",
  "오늘 하루 컨디션 1~10점 준다면 몇 점이에요?",
  "요즘 잠은 잘 자요?",
  "이번 주에 제일 기억에 남는 순간 하나만 얘기해주세요.",
  "요즘 스트레스 제일 많이 받는 게 뭐예요?",
  "오늘 스스로한테 칭찬해주고 싶은 거 하나 있어요?",
  "최근에 누군가한테 고맙다고 느낀 순간 있어요?",
  "요즘 습관 들이려고 노력하는 거 있어요?",
  "오늘 계획이 있다면 뭐예요?",
  "이번 주 제일 힘들었던 시간대는 언제였어요?",
  "최근에 스스로 뿌듯했던 순간 있어요?",
  "요즘 제일 즐거운 시간이 언제예요?",
  "오늘 아침 일어났을 때 기분 어땠어요?",
  "요즘 나를 웃게 하는 게 뭐예요?",
  "최근에 미뤄왔던 일 하나 해낸 거 있어요?",
  "이번 주 목표 하나만 얘기해주세요.",
  "요즘 제일 많이 하는 생각이 뭐예요?",
  "최근에 누군가에게 털어놓고 나서 후련했던 적 있어요?",
  "오늘 나한테 하고 싶은 말 한마디만 해준다면?",
  "요즘 시간 잘 가는 것 같아요, 안 가는 것 같아요?",
  "최근에 혼자만의 시간 어떻게 보냈어요?",
  "요즘 자신에게 후한 편이에요, 박한 편이에요?",
  "최근에 예상 못 하게 기분 좋았던 일 있어요?",
  "오늘 컨디션 안 좋으면 뭐가 제일 도움 돼요?",
  "이번 주 나 자신한테 점수 준다면 몇 점 줄 것 같아요?",
  "요즘 제일 감사한 거 하나만 얘기해주세요.",
];

const CONVO_STARTER_HIGH = [
  "요즘 충동 올라오는 시간대가 대충 언제예요?",
  "최근에 충동을 잘 넘긴 순간 있었어요? 어떻게 넘겼어요?",
  "요즘 나를 지치게 하는 상황이 뭐예요?",
  "최근에 대체 행동으로 뭘 해봤어요?",
  "오늘 하루 트리거가 있었다면 뭐였어요?",
  "요즘 혼자 있는 시간이 많아요, 적어요?",
  "최근에 스스로 잘 버텼다고 느낀 날 있어요?",
  "요즘 밤 시간에 뭘 하면서 보내요?",
  "최근에 재발했을 때 스스로한테 뭐라고 말해줬어요?",
  "요즘 이 커뮤니티가 도움 되는 부분이 있다면 뭐예요?",
  "최근에 무너지기 직전에 멈췄던 경험 있어요?",
  "요즘 스스로에게 제일 관대해지고 싶은 부분이 뭐예요?",
  "최근에 습관 하나 바꾸려고 시도한 거 있어요?",
  "요즘 제일 자주 쓰는 대체 행동이 뭐예요?",
  "요즘 나를 가장 잘 아는 건 나 자신이라고 느껴요?",
  "최근에 예전보다 나아졌다고 느낀 부분 있어요?",
  "요즘 이 여정에서 제일 어려운 부분이 뭐예요?",
  "최근에 스스로한테 실망했다가도 다시 일어선 적 있어요?",
  "요즘 회복이라는 단어가 어떻게 느껴져요?",
  "최근에 나만의 신호(트리거 직전 느낌) 알아챈 적 있어요?",
  "요즘 제일 든든한 게 뭐예요? (사람이든 습관이든)",
  "최근에 실패를 실패로 안 보려고 노력한 적 있어요?",
  "요즘 몸 상태나 컨디션이 충동이랑 관련 있다고 느껴요?",
  "최근에 이 여정 시작하길 잘했다고 느낀 순간 있어요?",
  "처음 이 문제를 자각했던 순간, 기억나요?",
  "지금의 나에게 가장 해주고 싶은 말은 뭐예요?",
  "회복하고 싶은 진짜 이유, 한 문장으로 표현한다면?",
  "무너졌던 날 중에 가장 오래 기억에 남는 날은 언제예요?",
  "나를 가장 힘들게 하는 감정은 뭐예요?",
  "이 여정에서 가장 두려운 게 뭐예요?",
  "스스로를 용서하기 가장 어려웠던 순간은 언제였어요?",
  "예전의 나와 지금의 나, 뭐가 제일 달라졌어요?",
  "아무도 몰랐으면 하는 나만의 힘든 부분, 조금만 얘기해줄 수 있어요?",
  "이 커뮤니티가 없었다면 지금 어땠을 것 같아요?",
  "회복 과정에서 가장 예상 못 했던 깨달음이 있어요?",
  "스스로에게 가장 미안한 순간은 언제였어요?",
  "지금 내가 가장 지키고 싶은 게 뭐예요?",
  "무너지는 순간, 진짜로 원했던 건 뭐였을까요?",
  "이 여정을 통해 얻고 싶은 게, 차단 이상으로 뭐가 있어요?",
  "나를 힘들게 했던 과거의 경험이 지금에 어떤 영향을 줬다고 느껴요?",
  "완벽하지 않아도 괜찮다는 걸, 언제 처음 느꼈어요?",
  "지금 이 순간 나에게 가장 필요한 위로는 뭐예요?",
  "회복이 완치가 아니라 과정이라는 걸 받아들이는 게 어때요?",
  "가장 힘들었던 시기에 나를 버티게 해준 게 뭐였어요?",
  "스스로에게 가장 솔직해지기 어려운 부분이 뭐예요?",
  "지금 이 순간, 나에게 가장 큰 응원이 되는 말은 뭘까요?",
  "회복 과정에서 가장 자랑스러웠던 순간은 언제예요?",
  "미래의 나에게 지금 해주고 싶은 말이 있다면요?",
  "이 여정이 끝나지 않아도 괜찮다는 걸, 어떻게 받아들이고 있어요?",
  "오늘 하루, 나한테 가장 후하게 점수를 준다면 어떤 부분일까요?",
];

const CONVO_STARTER_CHANNEL_NAME = process.env.CONVO_STARTER_CHANNEL_NAME || "자유수다";
// 기본: 월/수/금 오전 11시 (주 3회) — 필요하면 Railway 환경변수로 횟수/요일 조정 가능.
const CONVO_STARTER_CRON = process.env.CONVO_STARTER_CRON || "0 11 * * 1,3,5";

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

function nextMonthKey(monthKey /* "YYYY-MM" */) {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1)); // m은 1-indexed라 그대로 넣으면 다음달 1일 (UTC월은 0-indexed)
  const ny = d.getUTCFullYear();
  const nm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${ny}-${nm}`;
}

// 매달챌린지 신청 창구: "이번 달 마지막 주"에만 다음 달 챌린지 신청을 받습니다
// (sim님 요청, 2026-09). 마지막 7일(말일 기준 -6일)을 "마지막 주"로 봅니다.
function isLastWeekOfMonthKST(dateStr /* "YYYY-MM-DD" */) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return d > daysInMonth(y, m) - 7;
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

function addDaysKST(dateStr /* YYYY-MM-DD */, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(dt);
}

// ══════════════════════════════════════════════════════════════════════════
// ── 30일 리부트 챌린지 (전자책 구매자 대상 데일리 DM 챌린지) ────────────────
// docs/reboot-challenge-plan.md 기획안 그대로 구현. 기존 기능(구매 플로우 등)에는
// 영향을 주지 않고, 새 DM 명령어/크론/파싱 분기만 독립적으로 추가합니다.
// ══════════════════════════════════════════════════════════════════════════
const REBOOT_START_COMMAND = "!챌린지시작";
const REBOOT_OPT_OUT_PHRASES = ["챌린지그만", "!챌린지그만"];
const REBOOT_ANALYSIS_COMMAND = "!챌린지분석";
const REBOOT_STATUS_COMMAND = "!챌린지현황";
const REBOOT_SHEET_BACKFILL_COMMAND = "!챌린지시트백필";
const REBOOT_STATS_COMMAND = "!챌린지통계";
const REBOOT_PROMPT_CRON = process.env.REBOOT_PROMPT_CRON || "0 20 * * *"; // 매일 20시 발송
const REBOOT_REMINDER_CRON = process.env.REBOOT_REMINDER_CRON || "0 22 * * *"; // 매일 22시 리마인더
const REBOOT_MORNING_CRON = process.env.REBOOT_MORNING_CRON || "0 9 * * *"; // D+1 자동시작 + Day7 다이제스트
const REBOOT_COOLDOWN_DAYS = 3;

// SOS 키워드: Day 0에 적어둔 selfCompassionNote를 즉시 다시 보여주는 사적인 자기 진정 도구.
// 기존 #충동-sos 채널 시스템(공개 헬퍼 알림)과는 완전히 별개 — 헬퍼 알림/온콜을 트리거하지 않음.
function isRebootSosKeyword(content) {
  return /^sos$/i.test((content || "").trim());
}

// ── 안전 알림: 위기 신호 키워드 (실시간, 분석 주기와 무관하게 항상 작동) ──────
// 워크북 "위기 대응 프로토콜 6단계 · 도움이 필요한 신호" 체크리스트와 같은 맥락.
// 띄어쓰기 변형(예: "죽고 싶다" vs "죽고싶다")까지 잡기 위해 공백을 제거한 텍스트로 매칭합니다.
// ※ 최초 배포용 기본값 — 운영하면서 필요하면 이 배열만 수정하면 됩니다.
const CRISIS_KEYWORDS_DIRECT = [
  "자살",
  "죽고싶",
  "죽어버리",
  "자해",
  "살기싫",
  "사라지고싶",
  "없어지고싶",
  "목숨을끊",
  "극단적선택",
  "자해충동",
];
const CRISIS_KEYWORDS_INDIRECT = ["위험한생각", "다포기하고싶", "더는못버티", "다끝내고싶", "무너질것같"];
const CRISIS_HOTLINE_NOTE =
  "\n\n🧡 혹시 지금 많이 힘드시다면, 정신건강 위기상담전화 1577-0199 (24시간)로 전화해서 이야기 나눠보실 수 있어요.";

function stripSpaces(s) {
  return (s || "").replace(/\s+/g, "");
}

function detectCrisisLevel(content) {
  const stripped = stripSpaces(content);
  if (CRISIS_KEYWORDS_DIRECT.some((kw) => stripped.includes(kw))) return "direct";
  if (CRISIS_KEYWORDS_INDIRECT.some((kw) => stripped.includes(kw))) return "indirect";
  return null;
}

// 모든 DM 메시지에 대해 항상 호출됩니다 (다른 명령어 처리와 무관, 절대 가로막지 않음).
// 감지되면 즉시 운영자에게 DM으로 원문을 알리고, true를 반환해서 호출부가 참가자 답장에
// 위기상담전화 안내를 덧붙일 수 있게 해줍니다.
async function checkCrisisKeywordsAndNotify(message, content) {
  try {
    const level = detectCrisisLevel(content);
    if (!level) return false;
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    const owner = guild ? await guild.members.fetch(guild.ownerId).catch(() => null) : null;
    const label = level === "direct" ? "🚨 직접 위기 신호" : "⚠️ 간접 위기 신호(맥락 확인 필요)";
    const text =
      `${label} 감지 — <@${message.author.id}> (${message.author.tag || message.author.username}, ID: ${message.author.id})\n` +
      `원문: "${content.slice(0, 500)}"`;
    if (owner) {
      await safeDM(owner, text);
    } else {
      console.error("[안전 알림] 서버 소유자를 찾지 못해 DM을 보내지 못했습니다.", text);
    }
    return true;
  } catch (e) {
    console.error("[안전 알림 처리 오류]", e);
    return false;
  }
}

// ── 고해성사: 판단 없이 마음속 얘기를 DM으로 편하게 털어놓는 기능 ─────────────
// #충동-sos(지금 막 충동이 올라오는 실시간 SOS)와는 성격이 달라서 별도로 뒀습니다 —
// 이미 있었던 일이든, 그냥 오늘 힘들었던 마음이든 형식 없이 털어놓는 용도입니다.
// 공개 채널에는 절대 올라가지 않고, 항상 DM 안에서만 이루어집니다.
const CONFESSION_COMMAND = process.env.CONFESSION_COMMAND || "!고해성사";
// "!고해성사"를 보낸 뒤 실제 고백 내용을 몇 분 안에 보내야 그 답으로 인정할지 (분)
const CONFESSION_REPLY_WINDOW_MINUTES = parseInt(process.env.CONFESSION_REPLY_WINDOW_MINUTES || "60", 10);

// 1차 반응 문구 풀 — 큰 풀 + (재배포돼도 이어지는) 순환으로, 같은 사람이 여러 번
// 이용해도 풀 전체를 한 바퀴 돌기 전엔 같은 문구가 반복되지 않게 했습니다.
// 여기에 사람이 쓴 것처럼 자연스러운 문장을 계속 추가해도 되고, 순서를 바꿔도 됩니다.
const CONFESSION_RESPONSES = [
  "여기 있어요. 오늘 그 얘기 꺼낸 것만으로도 쉬운 일 아니었을 거예요.",
  "혼자 갖고 있지 않고 여기 적어주셔서 다행이에요.",
  "잘했다 못했다 판단하러 온 거 아니에요. 그냥 듣고 있어요.",
  "이런 날도 있는 거예요. 내일 또 시작하면 돼요.",
  "말하기 전보다 지금이 조금은 더 가벼워졌길 바라요.",
  "솔직하게 적어주신 것, 그 자체로 이미 의미 있어요.",
  "지금 이 마음, 여기 남겨뒀어요. 혼자 짊어지지 않으셔도 돼요.",
  "누구나 이런 순간이 있어요. 오늘도 여기까지 온 것만으로 충분해요.",
  "괜찮아요, 천천히 가도 돼요. 지금 이 순간으로 자신을 탓하지 마세요.",
  "이 얘기, 저한테 남겨주셔서 고마워요. 잘 받았어요.",
  "무너진 것 같아도, 지금 이렇게 말하고 있다는 것 자체가 다시 시작하고 있다는 뜻이에요.",
  "당신 잘못이 아니에요. 그냥 지나가는 파도예요, 결국 가라앉아요.",
];

function nextConfessionResponse() {
  const n = nextConfessionResponseIndex();
  return CONFESSION_RESPONSES[n % CONFESSION_RESPONSES.length];
}

async function handleConfessionStart(message) {
  updateUser(message.author.id, {
    awaitingConfessionReply: true,
    confessionPromptSentAt: new Date().toISOString(),
  });
  await message.reply(
    "여기 있어요. 무슨 얘기든 편하게 써주세요. 재발이든, 그냥 오늘 힘들었던 거든 다 괜찮아요.\n" +
      "준비되시면 다음 메시지로 편하게 보내주시면 돼요."
  );
}

// awaitingConfessionReply 상태에서 다음 DM을 받으면 이 함수가 실제 처리를 맡습니다.
// (위기 키워드 검사 자체는 이미 상위 라우터에서 모든 DM에 대해 항상 실행된 뒤입니다 —
// 여기서는 그 결과를 이 사람에게 보여줄 답장 문구를 고르는 데에만 다시 씁니다.)
async function handleConfessionReply(message, content) {
  const crisisDetected = !!detectCrisisLevel(content);

  updateUser(message.author.id, {
    awaitingConfessionReply: false,
    confessionPromptSentAt: null,
    confessionCount: (getUser(message.author.id).confessionCount || 0) + 1,
    lastConfessionAt: new Date().toISOString(),
  });

  const user = getUser(message.author.id);
  const note = user.rebootChallenge && user.rebootChallenge.selfCompassionNote;

  let replyText = nextConfessionResponse();
  if (note) {
    replyText += `\n\n🛬 예전에 스스로 이렇게 적어두셨었어요:\n"${note}"`;
  }
  if (crisisDetected) replyText += CRISIS_HOTLINE_NOTE;

  await message.reply(replyText);

  // 운영자에게 조용히 알림 (완전히 선택 사항인 후속 답장을 위함 - 의무 아님, 읽씹해도 무방).
  // 이 알림 메시지에 그대로 Discord "답장"을 하면 작성자에게 자동으로 전달됩니다
  // (handleConfessionRelayIfAny 참고) — 채널을 옮겨다닐 필요 없이 여기서 바로 답할 수 있어요.
  // 위기 신호가 감지된 경우엔 상위 라우터의 checkCrisisKeywordsAndNotify가 별도로 🚨 원문
  // 알림도 보내지만, 여기 알림도 함께 보내서 같은 자리에서 바로 답장(전달)할 수 있게 합니다.
  notifyOwnerAboutConfession(
    message.author.id,
    `${crisisDetected ? "🆘" : "💬"} 고해성사 — <@${message.author.id}> (${message.author.username})\n` +
      `"${content.slice(0, 500)}"\n\n(이 메시지에 그대로 답장하시면 전달돼요)`
  ).catch((e) => console.error("[고해성사 운영자 알림 오류]", e));

  appendConfessionEvent({
    discordUserId: message.author.id,
    label: message.author.username,
    crisisDetected,
  }).catch((e) => console.error("[고해성사 기록 오류]", e));
}

// ══════════════════════════════════════════════════════════════════════════
// ── 매달 30일 챌린지 (금딸챌린지) ────────────────────────────────────────
// 30일 리부트 챌린지(위)와는 완전히 별개의, 매달 1일부터 도는 공개 코호트
// 이벤트입니다. 재발해도 스트릭을 0으로 되돌리지 않고 "이번 달 성공한 날 수"를
// 누적으로만 카운트합니다 (sim님 요청, 2026-09).
//
// ⚠️ 디스코드 쪽(13개 등급 역할 생성, 봇 역할 계층, 닉네임 관리 권한)은 아직
// 준비 전이라는 전제로 짰습니다. 아래 RANK_ROLE_ID_1~13, MONTHLY_CHALLENGE_
// NICKNAME_TAG_ENABLED 환경변수를 하나도 안 넣어도 이 기능은 정상 동작하고,
// 등급 부여·닉네임 태그 부분만 조용히 건너뜁니다. 나중에 디스코드에서 역할을
// 만들고 Railway에 환경변수를 채워 넣으면, 코드 수정 없이 그 다음 승급부터
// 바로 적용됩니다.
//
// ⚠️ 참고: 기획 초안에서는 이 등급 사다리를 기존 ROLE_ID_GROW/ROLE_ID_MASTER에
// 매핑하는 안을 검토했지만, 실제 코드를 보니 그 두 역할은 이미 다른 용도로
// 고정돼 있었습니다 (GROW=전자책 구매, MASTER=30일 리부트 챌린지 완주). 그래서
// 이 등급 사다리는 기존 역할을 재사용하지 않고, 완전히 새로운 RANK_ROLE_ID_1~13
// 역할 13개를 새로 만드는 걸로 바꿨습니다 — 기존 기능과 절대 안 겹칩니다.
// ══════════════════════════════════════════════════════════════════════════
const MONTHLY_CHALLENGE_COMMAND = process.env.MONTHLY_CHALLENGE_COMMAND || "!금딸챌린지";
const MONTHLY_CHALLENGE_STATUS_COMMAND = process.env.MONTHLY_CHALLENGE_STATUS_COMMAND || "!금딸현황";
const MONTHLY_CHALLENGE_TARGET_DAYS = parseInt(process.env.MONTHLY_CHALLENGE_TARGET_DAYS || "30", 10);
const MONTHLY_CHALLENGE_PROMPT_CRON = process.env.MONTHLY_CHALLENGE_PROMPT_CRON || "0 21 * * *"; // 매일 21시 발송
const MONTHLY_CHALLENGE_REMINDER_CRON = process.env.MONTHLY_CHALLENGE_REMINDER_CRON || "30 22 * * *"; // 매일 22시30분 리마인더
const MONTHLY_CHALLENGE_ROLLOVER_CRON = process.env.MONTHLY_CHALLENGE_ROLLOVER_CRON || "5 0 1 * *"; // 매달 1일 00:05
const MONTHLY_CHALLENGE_REPLY_WINDOW_HOURS = parseInt(process.env.MONTHLY_CHALLENGE_REPLY_WINDOW_HOURS || "24", 10);
// "재발"이라고만 짧게 답하면 그날 하루만 카운트에서 빠집니다 (지금까지 쌓은 날짜는 안 깎임).
const MONTHLY_CHALLENGE_RELAPSE_PHRASES = ["재발", "!재발", "실패", "무너졌어요", "무너졌어"];
// 서버 부스트/역할 계층/봇 권한이 아직 준비 안 됐을 수 있어서 기본은 꺼둡니다.
// Railway에 MONTHLY_CHALLENGE_NICKNAME_TAG_ENABLED=true를 넣으면 켜집니다.
const MONTHLY_CHALLENGE_NICKNAME_TAG_ENABLED = process.env.MONTHLY_CHALLENGE_NICKNAME_TAG_ENABLED === "true";

// 회사 직급 13단계 — 아래로 갈수록 사람이 몰리고 위로 갈수록 희소해지도록 간격을
// 점점 벌렸습니다 (기획서 "5. 등급 시스템" 참고). threshold는 "누적 완주 개월 수".
const RANK_LADDER = [
  { name: "인턴(사원)", tag: "사원", threshold: 0, envKey: "RANK_ROLE_ID_1" },
  { name: "주임", tag: "주임", threshold: 1, envKey: "RANK_ROLE_ID_2" },
  { name: "대리", tag: "대리", threshold: 3, envKey: "RANK_ROLE_ID_3" },
  { name: "과장", tag: "과장", threshold: 6, envKey: "RANK_ROLE_ID_4" },
  { name: "차장", tag: "차장", threshold: 12, envKey: "RANK_ROLE_ID_5" },
  { name: "부장", tag: "부장", threshold: 20, envKey: "RANK_ROLE_ID_6" },
  { name: "이사", tag: "이사", threshold: 30, envKey: "RANK_ROLE_ID_7" },
  { name: "상무", tag: "상무", threshold: 42, envKey: "RANK_ROLE_ID_8" },
  { name: "전무", tag: "전무", threshold: 54, envKey: "RANK_ROLE_ID_9" },
  { name: "부사장", tag: "부사장", threshold: 66, envKey: "RANK_ROLE_ID_10" },
  { name: "사장", tag: "사장", threshold: 78, envKey: "RANK_ROLE_ID_11" },
  { name: "부회장", tag: "부회장", threshold: 90, envKey: "RANK_ROLE_ID_12" },
  { name: "회장", tag: "회장", threshold: 102, envKey: "RANK_ROLE_ID_13" },
];

function rankRoleId(tierIndex) {
  const tier = RANK_LADDER[tierIndex];
  if (!tier) return null;
  return process.env[tier.envKey] || null;
}

function computeRankTierIndex(completedMonthsTotal) {
  let idx = 0;
  for (let i = 0; i < RANK_LADDER.length; i++) {
    if (completedMonthsTotal >= RANK_LADDER[i].threshold) idx = i;
  }
  return idx;
}

function currentMonthKeyKST() {
  return todayKST().slice(0, 7);
}

// ── 참가 명령어: !금딸챌린지 (DM) ────────────────────────────────────────
// 신청 창구는 "이번 달 마지막 주"에만 열려있고, 그 안에 신청하면 다음 달
// 챌린지로 등록됩니다 (sim님 요청, 2026-09 — 아무 때나 중간 합류하던 방식에서
// "매달 정해진 주에만 신청받는" 방식으로 변경). 이미 참가 중인 사람은 매달
// 자동으로 이어지므로(러버 잡이 처리) 이 신청 창구는 새로 들어오는 사람 전용입니다.
async function handleMonthlyChallengeJoin(message) {
  const discordUserId = message.author.id;
  const user = getUser(discordUserId);
  const mc = user.monthlyChallenge;
  const today = todayKST();
  const currentMonthKey = today.slice(0, 7);

  if (mc.active && mc.monthKey >= currentMonthKey) {
    if (mc.monthKey === currentMonthKey) {
      await message.reply(
        `이미 이번 달 챌린지 참가 중이에요! 지금까지 ${mc.successDays}/${MONTHLY_CHALLENGE_TARGET_DAYS}일 성공하셨어요.`
      );
    } else {
      await message.reply(`이미 ${mc.monthKey} 챌린지 신청이 완료됐어요. ${mc.monthKey} 1일부터 자동으로 시작돼요.`);
    }
    return;
  }

  if (!isLastWeekOfMonthKST(today)) {
    const [y, m] = today.split("-").map(Number);
    const lastDay = daysInMonth(y, m);
    const windowStart = lastDay - 6;
    await message.reply(
      `다음 달 챌린지 신청은 매달 마지막 주(이번 달 기준 ${m}월 ${windowStart}일~${lastDay}일)에만 받아요. 그때 다시 "${MONTHLY_CHALLENGE_COMMAND}"라고 보내주세요!`
    );
    return;
  }

  const targetMonthKey = nextMonthKey(currentMonthKey);
  updateUser(discordUserId, {
    monthlyChallenge: {
      ...mc,
      active: true,
      monthKey: targetMonthKey,
      joinedAt: new Date().toISOString(),
      successDays: 0,
      lastCheckinDate: null,
      awaitingCheckinReply: false,
      checkinPromptSentAt: null,
      reminderSentToday: false,
      completedThisMonth: false,
      completedAt: null,
    },
  });

  await message.reply(
    `🔥 ${targetMonthKey} 챌린지 신청 완료! ${targetMonthKey} 1일부터 자동으로 시작돼서, 매일 저녁 9시쯤 "오늘 하루 어떠셨어요?"라고 물어볼게요.\n` +
      `아무 답장이나 주시면 성공한 날로 기록돼요. 재발했으면 그냥 "재발"이라고 편하게 보내주세요 — 그래도 지금까지 쌓은 날짜는 절대 안 사라져요.\n` +
      `"${MONTHLY_CHALLENGE_STATUS_COMMAND}"라고 보내시면 언제든 진행 상황을 볼 수 있어요.`
  );
}

// ── 현황 조회: !금딸현황 (DM) ────────────────────────────────────────────
async function handleMonthlyChallengeStatus(message) {
  const user = getUser(message.author.id);
  const mc = user.monthlyChallenge;
  const currentMonthKey = currentMonthKeyKST();
  if (!mc || !mc.active) {
    await message.reply(
      `아직 챌린지에 참가 안 하셨어요. 매달 마지막 주에 "${MONTHLY_CHALLENGE_COMMAND}"라고 보내시면 다음 달 챌린지로 신청할 수 있어요.`
    );
    return;
  }
  const tier = RANK_LADDER[mc.rankTierIndex || 0];

  if (mc.monthKey > currentMonthKey) {
    await message.reply(
      `📅 ${mc.monthKey} 챌린지 신청 완료 상태예요. ${mc.monthKey} 1일부터 자동으로 시작돼요.\n` +
        `누적 완주 개월: ${mc.completedMonthsTotal || 0}회\n` +
        `현재 등급: ${tier ? tier.name : "-"}`
    );
    return;
  }

  await message.reply(
    `📅 이번 달(${mc.monthKey}) 챌린지 현황\n` +
      `성공 일수: ${mc.successDays}/${MONTHLY_CHALLENGE_TARGET_DAYS}일${mc.completedThisMonth ? " ✅ 완주!" : ""}\n` +
      `누적 완주 개월: ${mc.completedMonthsTotal || 0}회\n` +
      `현재 등급: ${tier ? tier.name : "-"}`
  );
}

// ── 참가자 DM 답장 처리 (handlePendingDmReply에서 최우선 호출) ─────────────
async function handleMonthlyChallengeCheckinReply(message, content) {
  const discordUserId = message.author.id;
  const user = getUser(discordUserId);
  const mc = user.monthlyChallenge;
  if (!mc || !mc.awaitingCheckinReply || !mc.checkinPromptSentAt) return false;

  const now = new Date();
  if (now - new Date(mc.checkinPromptSentAt) > MONTHLY_CHALLENGE_REPLY_WINDOW_HOURS * 60 * 60 * 1000) return false;

  const today = todayKST();
  if (mc.lastCheckinDate === today) return false; // 오늘자는 이미 반영됨 (중복 방지)

  const trimmed = content.trim();
  const isRelapse = MONTHLY_CHALLENGE_RELAPSE_PHRASES.includes(trimmed);
  const crisisDetected = !!detectCrisisLevel(content);

  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  const member = guild ? await guild.members.fetch(discordUserId).catch(() => null) : null;
  const label = member ? member.displayName : discordUserId;

  if (isRelapse) {
    updateUser(discordUserId, {
      monthlyChallenge: { ...mc, awaitingCheckinReply: false, lastCheckinDate: today },
    });
    await message.reply(
      `오늘 하루만 카운트 안 될 뿐이에요. 지금까지 쌓은 ${mc.successDays}일은 그대로예요. 내일 다시 이어가요.${
        crisisDetected ? CRISIS_HOTLINE_NOTE : ""
      }`
    );
    appendMonthlyChallengeEvent({
      discordUserId,
      label,
      monthKey: mc.monthKey,
      successDays: mc.successDays,
      completed: false,
      completedMonthsTotal: mc.completedMonthsTotal || 0,
      crisisDetected,
      relapse: true,
    }).catch((e) => console.error("[매달챌린지 기록 오류]", e));
    return true;
  }

  const newSuccessDays = (mc.successDays || 0) + 1;
  const justCompleted = !mc.completedThisMonth && newSuccessDays >= MONTHLY_CHALLENGE_TARGET_DAYS;

  updateUser(discordUserId, {
    monthlyChallenge: {
      ...mc,
      awaitingCheckinReply: false,
      lastCheckinDate: today,
      successDays: newSuccessDays,
      completedThisMonth: justCompleted || mc.completedThisMonth,
      completedAt: justCompleted ? new Date().toISOString() : mc.completedAt,
    },
  });

  await message.reply(
    justCompleted
      ? `🎉 ${newSuccessDays}/${MONTHLY_CHALLENGE_TARGET_DAYS}일 완주하셨어요! 이번 달 챌린지 완주예요, 정말 대단해요.${
          crisisDetected ? CRISIS_HOTLINE_NOTE : ""
        }`
      : `기록했어요. 지금 ${newSuccessDays}/${MONTHLY_CHALLENGE_TARGET_DAYS}일이에요.${crisisDetected ? CRISIS_HOTLINE_NOTE : ""}`
  );

  appendMonthlyChallengeEvent({
    discordUserId,
    label,
    monthKey: mc.monthKey,
    successDays: newSuccessDays,
    completed: justCompleted,
    completedMonthsTotal: mc.completedMonthsTotal || 0,
    crisisDetected,
    relapse: false,
  }).catch((e) => console.error("[매달챌린지 기록 오류]", e));

  if (justCompleted) {
    await finalizeMonthlyChallengeCompletion(discordUserId, member).catch((e) =>
      console.error("[매달챌린지 완주 처리 오류]", e)
    );
  }
  return true;
}

// ── 등급 역할 적용: RANK_ROLE_ID_n이 .env에 없으면 조용히 건너뜁니다 ─────────
async function applyRankNicknameTag(member, tierIndex) {
  const tier = RANK_LADDER[tierIndex];
  if (!tier || !member) return;
  // 디스코드 정책상 서버 소유자 본인 닉네임은 봇이 못 바꿉니다 — 조용히 건너뜁니다.
  if (member.id === member.guild.ownerId) return;
  const base = (member.nickname || member.user.username).replace(/^\[[^\]]+\]\s*/, "");
  const newNick = `[${tier.tag}] ${base}`.slice(0, 32);
  await member.setNickname(newNick).catch((e) => console.error("[등급 닉네임 태그 적용 실패]", e));
}

async function applyRankRole(member, oldTierIndex, newTierIndex) {
  const oldRoleId = rankRoleId(oldTierIndex);
  const newRoleId = rankRoleId(newTierIndex);
  if (oldRoleId && oldRoleId !== newRoleId && member.roles.cache.has(oldRoleId)) {
    await member.roles.remove(oldRoleId).catch((e) => console.error("[등급 역할 제거 실패]", e));
  }
  if (newRoleId) {
    await member.roles.add(newRoleId).catch((e) => console.error("[등급 역할 부여 실패]", e));
  }
  if (MONTHLY_CHALLENGE_NICKNAME_TAG_ENABLED) {
    await applyRankNicknameTag(member, newTierIndex);
  }
}

// ── 완료 처리: 누적 완주 개월 +1, 등급 재계산, 승급 시에만 역할/공지 ─────────
async function finalizeMonthlyChallengeCompletion(discordUserId, member) {
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  const m = member || (guild ? await guild.members.fetch(discordUserId).catch(() => null) : null);
  const mc1 = getUser(discordUserId).monthlyChallenge;

  const newCompletedMonthsTotal = (mc1.completedMonthsTotal || 0) + 1;
  const oldTierIndex = mc1.rankTierIndex || 0;
  const newTierIndex = computeRankTierIndex(newCompletedMonthsTotal);

  updateUser(discordUserId, {
    monthlyChallenge: {
      ...getUser(discordUserId).monthlyChallenge,
      completedMonthsTotal: newCompletedMonthsTotal,
      rankTierIndex: newTierIndex,
    },
  });

  if (newTierIndex > oldTierIndex && m) {
    await applyRankRole(m, oldTierIndex, newTierIndex).catch((e) => console.error("[등급 역할 적용 오류]", e));
    const tier = RANK_LADDER[newTierIndex];
    await safeDM(m, `🎖️ 누적 완주 ${newCompletedMonthsTotal}회 달성으로 "${tier.name}"로 승급했어요!`);
    if (guild) await announcePromotion(guild, m, tier.name);
  }
}

// ── 저녁 9시: 오늘 하루 어땠는지 DM으로 물어봅니다 ────────────────────────
async function runMonthlyChallengeEveningJob() {
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return;
  const members = await guild.members.fetch();
  const monthKey = currentMonthKeyKST();

  for (const member of members.values()) {
    if (member.user.bot) continue;
    const mc = getUser(member.id).monthlyChallenge;
    if (!mc || !mc.active || mc.monthKey !== monthKey || mc.completedThisMonth) continue;
    if (mc.awaitingCheckinReply) continue; // 어제 질문에 아직 답 안 함 → 리마인더 잡이 챙김

    await safeDM(
      member,
      `오늘 하루 어떠셨어요? 아무 답장이나 주시면 성공한 날로 기록돼요. 재발했으면 "재발"이라고 편하게 보내주세요.`
    );
    const fresh = getUser(member.id).monthlyChallenge;
    updateUser(member.id, {
      monthlyChallenge: { ...fresh, awaitingCheckinReply: true, checkinPromptSentAt: new Date().toISOString(), reminderSentToday: false },
    });
  }
}

// ── 22시 30분: 오늘 질문에 아직 답 안 한 사람에게 리마인더 1회 ─────────────
async function runMonthlyChallengeReminderJob() {
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return;
  const members = await guild.members.fetch();
  const today = todayKST();

  for (const member of members.values()) {
    if (member.user.bot) continue;
    const mc = getUser(member.id).monthlyChallenge;
    if (!mc || !mc.active || !mc.awaitingCheckinReply || mc.reminderSentToday || !mc.checkinPromptSentAt) continue;
    const sentDate = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(mc.checkinPromptSentAt));
    if (sentDate !== today) continue;
    await safeDM(member, "⏰ 오늘 이번 달 챌린지 체크인 아직 안 하셨어요. 짧게 아무 말이나 답장 주세요 🙂");
    const fresh = getUser(member.id).monthlyChallenge;
    updateUser(member.id, { monthlyChallenge: { ...fresh, reminderSentToday: true } });
  }
}

// ── 매달 1일 00:05: 새 달로 갱신 + 공개 채널 공지 ───────────────────────────
// 한 번 참가하면 매달 자동으로 이어집니다(다시 !금딸챌린지를 안 쳐도 됨) — 이번 달
// 진행도(successDays 등)만 새로 시작하고, completedMonthsTotal·등급은 그대로 유지됩니다.
async function runMonthlyChallengeRolloverJob() {
  const monthKey = currentMonthKeyKST();
  const ids = allUserIds();
  for (const id of ids) {
    const mc = getUser(id).monthlyChallenge;
    if (!mc || !mc.active || mc.monthKey === monthKey) continue;
    updateUser(id, {
      monthlyChallenge: {
        ...mc,
        monthKey,
        successDays: 0,
        lastCheckinDate: null,
        awaitingCheckinReply: false,
        checkinPromptSentAt: null,
        reminderSentToday: false,
        completedThisMonth: false,
        completedAt: null,
      },
    });
  }

  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return;
  const channel = findAnnounceChannel(guild);
  if (channel) {
    await channel
      .send(`🔥 ${monthKey} 금딸챌린지가 시작됐어요! 아직 참가 안 하셨다면 봇 DM에 "${MONTHLY_CHALLENGE_COMMAND}"라고 보내보세요.`)
      .catch((e) => console.error("[매달챌린지 공지 실패]", e));
  }
}

function scheduleMonthlyChallengeJobs() {
  cron.schedule(
    MONTHLY_CHALLENGE_PROMPT_CRON,
    () => runMonthlyChallengeEveningJob().catch((e) => console.error("[매달챌린지 저녁잡 오류]", e)),
    { timezone: TZ }
  );
  cron.schedule(
    MONTHLY_CHALLENGE_REMINDER_CRON,
    () => runMonthlyChallengeReminderJob().catch((e) => console.error("[매달챌린지 리마인더 오류]", e)),
    { timezone: TZ }
  );
  cron.schedule(
    MONTHLY_CHALLENGE_ROLLOVER_CRON,
    () => runMonthlyChallengeRolloverJob().catch((e) => console.error("[매달챌린지 월간갱신 오류]", e)),
    { timezone: TZ }
  );
  console.log(
    `[예약 등록] 매달챌린지 cron: 저녁 "${MONTHLY_CHALLENGE_PROMPT_CRON}" / 리마인더 "${MONTHLY_CHALLENGE_REMINDER_CRON}" / 월간갱신 "${MONTHLY_CHALLENGE_ROLLOVER_CRON}" (${TZ})`
  );
}

// ── 데이 템플릿 ────────────────────────────────────────────────────────
function rebootDay0Message() {
  return (
    `🛬 REBOOT 구매하신 지 하루 됐네요. 30일 리부트 챌린지를 시작해볼까요?\n` +
    `매일 저녁 8시에 짧은 질문 하나씩 드리고, 그대로 답장만 해주시면 돼요.\n` +
    `챌린지가 필요 없으시면 "챌린지그만"이라고 답장해주세요, 더 이상 안 보내드려요.\n\n` +
    `먼저 딱 하나만 적어주세요 — 무너지는 순간엔 판단력이 떨어져서, 그때 가서 다짐하는 건 소용이 없어요.\n` +
    `그래서 지금, 평온할 때 딱 한 문장만 미리 적어두는 거예요.\n\n` +
    `내가 무너졌을 때, 나에게 해줄 말:\n` +
    `(예: "이건 실패가 아니라 데이터야. 오늘 하루만 다시 시작하면 돼.")\n\n` +
    `✅ 적어주시면, 나중에 진짜 무너지는 순간이 왔을 때 저한테 "SOS"라고만 보내주세요.\n` +
    `방금 적어주신 문장을 그 즉시 그대로 다시 보여드릴게요.`
  );
}

function rebootDay1to7Message(day) {
  return (
    `📋 리부트 챌린지 Day ${day}/7 · 트리거 기록\n` +
    `오늘 충동/트리거가 있었다면 아래 4가지에 맞춰 적어주세요. 없었다면 "없음"이라고만 보내주세요.\n\n` +
    `1) 언제인가? (시간대, 요일)\n` +
    `2) 어디서, 무엇을 하다가인가? (장소, 직전 활동, 기기·앱)\n` +
    `3) 어떤 감정이었는가? (외로움, 지루함, 스트레스, 분노, 공허함 등)\n` +
    `4) 강도는 어느 정도였는가? (1~5점, 5가 가장 강함)`
  );
}

function rebootDay8Message() {
  return (
    `🔧 리부트 챌린지 Day 8 · If-Then 공식 확정\n` +
    `지난 7일간의 트리거 기록을 바탕으로, 나만의 If-Then 공식을 최대 5개까지 적어주세요.\n` +
    `(운영자가 Day 7 기록을 분석해서 참고할 내용을 먼저 DM으로 드릴 수도 있어요 — 받으셨다면 참고해서 적어주세요.)\n\n` +
    `형식: "IF (트리거) ___ THEN ___"\n\n` +
    `1) IF ___ THEN ___\n2) IF ___ THEN ___\n3) IF ___ THEN ___\n4) IF ___ THEN ___\n5) IF ___ THEN ___\n\n` +
    `다 못 채우셔도 괜찮아요, 적은 만큼만 보내주세요.`
  );
}

function rebootDay9to31Message(day) {
  const n = day - 8; // 실행 몇일차 (1~23)
  return (
    `📈 리부트 챌린지 Day ${day} (실행 ${n}/23일차)\n\n` +
    `1) 오늘 충동 강도는 어느 정도였나요? (1~5점, 5가 가장 강함)\n` +
    `2) 확정한 공식을 오늘 썼나요? 썼다면 몇 번, 효과 있었는지 한 줄로.\n` +
    `3) 오늘 미끄러진(재발) 순간이 있었다면 몇 시쯤·어떤 상황이었는지. 없으면 "없음"만 적어주세요.`
  );
}

function rebootPhase(day) {
  if (day >= 1 && day <= 7) return "diagnosis";
  if (day >= 9 && day <= 31) return "execution";
  return "gate"; // 0, 8
}

function rebootPromptTextForDay(day) {
  if (day >= 1 && day <= 7) return rebootDay1to7Message(day);
  if (day >= 9 && day <= 31) return rebootDay9to31Message(day);
  return null;
}

// 어제(catchupDay) 기록을 놓쳤을 때, 오늘 것과 같이 볼 수 있게 두 날짜 질문을 한 메시지로 합칩니다.
// (같은 형식군끼리만 합칩니다 — 진단 구간끼리, 실행 구간끼리. 게이트 날짜와는 합치지 않아요.)
function buildRebootNightlyPrompt(day, catchupDay) {
  const main = rebootPromptTextForDay(day);
  if (catchupDay && rebootPhase(catchupDay) === rebootPhase(day)) {
    const catchupText = rebootPromptTextForDay(catchupDay);
    return (
      `⏳ 어제(Day ${catchupDay}) 기록을 놓치셨네요. 오늘 것과 같이 남겨주셔도 괜찮아요 — 순서대로 편하게 적어주세요.\n\n` +
      `[Day ${catchupDay}]\n${catchupText}\n\n[Day ${day}]\n${main}`
    );
  }
  return main;
}

// Day 9~31 답변에서 "재발 없음"인지 대략 판별합니다 (엄격한 파싱은 하지 않는다는 기획 원칙에
// 따라, 형식이 안 맞아도 재요청 없이 항상 원문을 그대로 저장 — 이건 selfCompassionNote를
// 다시 보여줄지 판단하기 위한 가벼운 휴리스틱일 뿐입니다).
function rebootReplyIndicatesRelapse(content) {
  const trimmed = (content || "").trim();
  if (/없음\s*$/.test(trimmed)) return false;
  if (/(재발|미끄러|무너)/.test(trimmed)) return true;
  return false;
}

// Day 8 답변에서 "IF ... THEN ..." 형태의 줄을 최대한 뽑아봅니다. 못 뽑아도 원문은
// 항상 별도로 저장하니 파싱 실패가 데이터 손실로 이어지지 않습니다.
function parseRebootFormulas(content) {
  const lines = (content || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const formulas = lines.filter((l) => /if/i.test(l) && /then/i.test(l));
  return formulas.length ? formulas.slice(0, 5) : [content.trim()];
}

async function notifyOwnerText(text) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    const owner = guild ? await guild.members.fetch(guild.ownerId).catch(() => null) : null;
    if (owner) await safeDM(owner, text);
  } catch (e) {
    console.error("[운영자 DM 알림 오류]", e);
  }
}

// 고해성사 알림 전용 — 보낸 메시지의 ID를 작성자 ID와 함께 저장해둬서, 운영자가
// 이 알림에 Discord "답장" 기능으로 답하면 그대로 작성자에게 전달할 수 있게 합니다
// (handleConfessionRelayIfAny 참고). notifyOwnerText는 다른 곳에서도 널리 쓰이는
// 범용 함수라 그대로 두고, 이건 고해성사 전용으로 따로 뒀습니다.
async function notifyOwnerAboutConfession(discordUserId, text) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    const owner = guild ? await guild.members.fetch(guild.ownerId).catch(() => null) : null;
    if (!owner) {
      console.error("[고해성사 운영자 알림] 서버 소유자를 찾지 못했습니다.");
      return;
    }
    const sent = await owner.send(text);
    recordConfessionRelay(sent.id, discordUserId);
  } catch (e) {
    console.error("[고해성사 운영자 알림 오류]", e);
  }
}

// 운영자가 봇 DM에서 고해성사 알림 메시지에 "답장"으로 남긴 내용을, 그 알림이 가리키는
// 작성자에게 그대로 전달합니다. 관련 없는 답장(다른 메시지에 대한 답장)이면 false를
// 반환해서 호출부가 기존 명령어 처리 흐름을 그대로 이어가게 합니다.
async function handleConfessionRelayIfAny(message, content) {
  if (!message.reference || !message.reference.messageId) return false;
  const targetUserId = getConfessionRelayTarget(message.reference.messageId);
  if (!targetUserId) return false;

  try {
    const targetUser = await client.users.fetch(targetUserId).catch(() => null);
    if (!targetUser) {
      await message.reply("전달하려던 상대를 더 이상 찾을 수 없어요 (서버를 나갔을 수 있어요).");
      return true;
    }
    const attachmentUrls = [...message.attachments.values()].map((a) => a.url);
    await targetUser.send({
      content: content ? `💬 sim님이 답장을 남겼어요:\n\n${content}` : "💬 sim님이 답장을 남겼어요:",
      files: attachmentUrls,
    });
    await message.reply("전달했어요 🙂");
  } catch (e) {
    console.error("[고해성사 답장 전달 오류]", e);
    await message.reply("전달하다가 오류가 났어요. 다시 한 번 답장해보시겠어요?");
  }
  return true;
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
  if (!PAYAPP_USERID || !PAYAPP_LINKKEY || !PAYAPP_LINKVAL || !EBOOK_PRICE || !PUBLIC_BASE_URL) {
    console.warn("[설정 경고] PayApp 관련 환경변수가 부족해 전자책 자동결제/자동승급 기능이 동작하지 않습니다. .env.example을 참고해 채워주세요.");
  }
  scheduleDailyJob();
  scheduleStreakReminderJob();
  scheduleWeeklyHighlightJob();
  scheduleWeeklyTipJob();
  scheduleInsightReminderJob();
  scheduleRebootChallengeJobs();
  scheduleMonthlyChallengeJobs();
  scheduleConvoStarterJob();
});

// (무료멤버 자동 역할 부여는 커뮤니티 초간소화 개편으로 무료 등급 자체가
// 없어지면서 삭제되었습니다. 이제 신규 멤버는 별도 역할 없이 서버에 바로 참여합니다.)

// ── 메시지 처리: 체크인 카운트 + SOS 즉시반응 + DM 명령어 + 스트릭 조회 ──
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;

    // DM 명령어 처리 (승급 공개 알림 옵트아웃/인 + 전자책 구매 + SOS 트리거/회고 응답)
    if (!message.guild) {
      const content = message.content.trim();

      // 안전 알림: 위기 신호 키워드는 어떤 명령어와 매칭되든 상관없이 항상 감지합니다.
      await checkCrisisKeywordsAndNotify(message, content).catch((e) => console.error("[안전 알림 오류]", e));

      // 고해성사 답장 릴레이: 운영자가 고해성사 알림 메시지에 "답장"했다면, 다른 명령어
      // 매칭보다 먼저 처리해서 그대로 작성자에게 전달합니다.
      const relayed = await handleConfessionRelayIfAny(message, content).catch((e) => {
        console.error("[고해성사 답장 전달 오류]", e);
        return false;
      });
      if (relayed) return;

      if (content === "알림끄기" || content === "!알림끄기") {
        updateUser(message.author.id, { publicAnnounceOptOut: true });
        await message.reply(
          "앞으로 승급하셔도 공개 채널에는 알리지 않을게요. 다시 켜고 싶으면 \"알림켜기\"라고 보내주세요."
        );
      } else if (content === "알림켜기" || content === "!알림켜기") {
        updateUser(message.author.id, { publicAnnounceOptOut: false });
        await message.reply("좋아요! 승급하시면 다시 공개 채널에서 축하 메시지를 남길게요 🎉");
      } else if (isRebootSosKeyword(content)) {
        await handleRebootSosKeyword(message);
      } else if (EBOOK_PURCHASE_COMMANDS.includes(content)) {
        await handleEbookPurchaseRequest(message);
      } else if (EBOOK_PREVIEW_COMMANDS.includes(content)) {
        await handleEbookPreviewRequest(message);
      } else if (content === EBOOK_UPLOAD_COMMAND) {
        await handleEbookMasterUpload(message);
      } else if (content === WORKBOOK_UPLOAD_COMMAND) {
        await handleWorkbookMasterUpload(message);
      } else if (content === EBOOK_RESET_COMMAND) {
        await handleEbookPurchaseReset(message);
      } else if (
        content === EBOOK_PURCHASE_DELETE_COMMAND ||
        content.startsWith(EBOOK_PURCHASE_DELETE_COMMAND + " ")
      ) {
        await handleEbookPurchaseDelete(message, content);
      } else if (
        content === PROMOTION_ANNOUNCE_COMMAND ||
        content.startsWith(PROMOTION_ANNOUNCE_COMMAND + " ")
      ) {
        await handlePromotionAnnounce(message, content);
      } else if (content === REBOOT_ANALYSIS_COMMAND || content.startsWith(REBOOT_ANALYSIS_COMMAND + " ")) {
        await handleRebootAnalysisCommand(message, content);
      } else if (content === REBOOT_STATUS_COMMAND || content.startsWith(REBOOT_STATUS_COMMAND + " ")) {
        await handleRebootStatusCommand(message, content);
      } else if (content === REBOOT_SHEET_BACKFILL_COMMAND) {
        await handleRebootSheetBackfillCommand(message);
      } else if (content === REBOOT_STATS_COMMAND) {
        await handleRebootStatsCommand(message);
      } else if (content === REBOOT_START_COMMAND) {
        await handleRebootStartCommand(message);
      } else if (content === "회고" || content === "!회고") {
        await handleReflectionHistoryRequest(message);
      } else if (content === "패턴" || content === "!패턴") {
        await handleSosPatternHistoryRequest(message);
      } else if (content === "기록" || content === STREAK_COMMAND) {
        await handleStreakRequest(message);
      } else if (content === "고해성사" || content === CONFESSION_COMMAND) {
        await handleConfessionStart(message);
      } else if (content === MONTHLY_CHALLENGE_STATUS_COMMAND || content === "금딸현황") {
        await handleMonthlyChallengeStatus(message);
      } else if (content === MONTHLY_CHALLENGE_COMMAND || content === "금딸챌린지") {
        await handleMonthlyChallengeJoin(message);
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

    // 신규 멤버 첫 인사 알림: 자기소개/오늘의-기록에 첫 글을 남기면, 최근 활동한
    // 헬퍼 풀에게 조용히 알림을 보내 누군가 먼저 반겨줄 수 있게 합니다. (멤버당 1회만)
    if (NEWCOMER_WELCOME_CHANNELS.includes(message.channel.name)) {
      const introUser = getUser(message.author.id);
      if (!introUser.newcomerWelcomeNotified) {
        updateUser(message.author.id, { newcomerWelcomeNotified: true });
        notifyHelpers(
          message,
          `#${message.channel.name}에 새 멤버가 첫 글을 남겼어요. 시간 되실 때 반갑게 인사 한마디 남겨주실 수 있을까요?\n${message.url}`
        ).catch((e) => console.error("[신규 멤버 환영 알림 오류]", e));
      }
    }

    // 체크인 인정: 채널 구분 없이, 의미 있는 글(2자 이상) 또는 첨부파일이 있으면
    // 서버 어느 채널에 올려도 인정합니다. (하루 1회만 카운트, 아래에서 중복 방지)
    const hasAttachment = message.attachments.size > 0;
    const hasMeaningfulText = message.content.trim().length >= 2; // 이모지 하나 정도는 인정 안 함
    if (!hasAttachment && !hasMeaningfulText) return;

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

    // (전자책을 구매하지 않은 "일반멤버"에게 부여되던 4단계 배지 시스템은 삭제되었습니다.
    // 리부트-크루 승급은 전자책 구매로만 이루어집니다.)
    // 마스터-크루 승급 기준 변경: 예전엔 "전자책 구매 후 누적 인증 T_MASTER회"였지만,
    // 지금은 "30일 리부트 챌린지 최초 완주"로만 승급합니다 (finalizeRebootCompletion 참고).
    // 이미 마스터-크루인 기존 유저는 소급 적용 없이 그대로 유지됩니다.
  } catch (err) {
    console.error("[messageCreate 처리 오류]", err);
  }
});

// ── 경고 누적 시스템 ─────────────────────────────────────────
function isModerator(member) {
  if (!member) return false;
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ModerateMembers)
  );
}

async function logToModChannel(guild, text) {
  try {
    const channel = guild.channels.cache.find(
      (c) => c.name === MOD_LOG_CHANNEL_NAME && typeof c.send === "function"
    );
    if (channel) await channel.send(text);
  } catch (e) {
    console.error("[운영 로그 발송 실패]", e);
  }
}

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot || !message.guild || message.guild.id !== GUILD_ID) return;
    const content = message.content.trim();

    // "!경고 @유저 사유" — 운영진(타임아웃/관리자 권한 보유자) 전용
    if (content === WARNING_COMMAND || content.startsWith(WARNING_COMMAND + " ")) {
      if (!isModerator(message.member)) return;
      const target = message.mentions.members?.first();
      if (!target) {
        await message.reply(`사용법: ${WARNING_COMMAND} @유저 사유`);
        return;
      }
      if (target.id === message.author.id) {
        await message.reply("자기 자신에게는 경고를 줄 수 없어요.");
        return;
      }
      if (target.user.bot) {
        await message.reply("봇에게는 경고를 줄 수 없어요.");
        return;
      }
      const reason =
        content
          .slice(WARNING_COMMAND.length)
          .replace(/<@!?\d+>/g, "")
          .trim() || "사유 없음";

      const u = getUser(target.id);
      const warnings = [...(u.warnings || []), { date: todayKST(), reason, byModId: message.author.id }];
      updateUser(target.id, { warnings });
      const count = warnings.length;

      let actionText = "";
      try {
        if (count === 2) {
          await target.timeout(WARNING_TIMEOUT_HOURS * 60 * 60 * 1000, `경고 누적 ${count}회: ${reason}`);
          actionText = `${WARNING_TIMEOUT_HOURS}시간 타임아웃 처리됐어요.`;
        } else if (count >= 3) {
          await target.kick(`경고 누적 ${count}회: ${reason}`);
          actionText = "서버에서 추방됐어요.";
        }
      } catch (e) {
        console.error("[경고 자동 조치 실패] (봇에 '멤버 타임아웃'/'멤버 추방' 권한이 있는지 확인해주세요)", e);
        actionText += " (자동 조치를 시도했지만 실패했어요 — 봇 권한을 확인해주세요)";
      }

      await safeDM(
        target,
        `⚠️ 커뮤니티 가이드라인 위반으로 경고를 받았어요. (누적 ${count}회)\n사유: ${reason}\n` +
          (count === 1
            ? "다음 위반부터는 타임아웃이 적용돼요."
            : count === 2
            ? `이번엔 ${WARNING_TIMEOUT_HOURS}시간 타임아웃이 적용됐어요. 다음 위반 시 서버에서 추방돼요.`
            : "서버에서 추방됐어요.")
      );

      await message.reply(
        `⚠️ ${target.user.tag}님에게 경고 ${count}회 누적됐어요. (사유: ${reason})${actionText ? " " + actionText : ""}`
      );
      await logToModChannel(
        message.guild,
        `⚠️ **경고 기록**\n대상: ${target.user.tag} (${target.id})\n사유: ${reason}\n누적: ${count}회\n처리자: ${message.author.tag}${
          actionText ? "\n조치: " + actionText : ""
        }`
      );
      return;
    }

    // "!경고확인 [@유저]" — 운영진 전용, 누적 내역 조회 (대상 생략 시 본인)
    if (content === WARNING_CHECK_COMMAND || content.startsWith(WARNING_CHECK_COMMAND + " ")) {
      if (!isModerator(message.member)) return;
      const target = message.mentions.members?.first() || message.member;
      const u = getUser(target.id);
      const warnings = u.warnings || [];
      if (warnings.length === 0) {
        await message.reply(`${target.user.tag}님은 경고 이력이 없어요.`);
        return;
      }
      const list = warnings.map((w, i) => `${i + 1}. [${w.date}] ${w.reason}`).join("\n");
      await message.reply(`⚠️ ${target.user.tag}님 경고 누적 ${warnings.length}회\n${list}`);
      return;
    }

    // "!경고초기화 @유저" — 운영진 전용
    if (content === WARNING_RESET_COMMAND || content.startsWith(WARNING_RESET_COMMAND + " ")) {
      if (!isModerator(message.member)) return;
      const target = message.mentions.members?.first();
      if (!target) {
        await message.reply(`사용법: ${WARNING_RESET_COMMAND} @유저`);
        return;
      }
      updateUser(target.id, { warnings: [] });
      await message.reply(`${target.user.tag}님의 경고 기록을 초기화했어요.`);
      return;
    }
  } catch (e) {
    console.error("[경고 시스템 오류]", e);
  }
});

// (일반멤버 4단계 등급 배지 동기화 함수 syncFreeLevel / announceVeteranAchievement 는
// FREE_LEVELS 시스템과 함께 삭제되었습니다.)

function describeCurrentLevel(member, user) {
  if (!member) return "-";
  if (member.roles.cache.has(ROLE_ID_MASTER)) return "마스터-크루";
  if (member.roles.cache.has(ROLE_ID_GROW)) return "리부트-크루";
  return "무료멤버";
}

// 다음 등급까지 몇 회 남았는지 안내하는 문구를 만듭니다.
function describeNextLevelProgress(member, user) {
  if (!member || !user) return "";

  if (member.roles.cache.has(ROLE_ID_MASTER)) {
    return "🏆 마스터-크루는 최종 등급이에요. 여기까지 와주셔서 정말 대단해요!";
  }

  if (member.roles.cache.has(ROLE_ID_GROW)) {
    const rc = user.rebootChallenge;
    if (!rc || !rc.status) {
      return `전자책 구매 다음 날부터 "30일 리부트 챌린지" DM이 자동으로 시작돼요. 이 챌린지를 완주하면 마스터-크루로 승급해요.`;
    }
    if (rc.status === "in_progress" || rc.status === "pending_day0") {
      return `지금 30일 리부트 챌린지 진행 중이에요 (Day ${rc.currentDay}/31). 완주하면 마스터-크루로 승급해요!`;
    }
    if (rc.status === "completed") {
      return "🏆 30일 리부트 챌린지를 완주해서 마스터-크루가 되셨어요!";
    }
    if (rc.status === "failed") {
      return `리부트 챌린지가 중단됐었어요. ${rc.cooldownUntil ? `${rc.cooldownUntil}부터 ` : ""}"${REBOOT_START_COMMAND}"라고 보내시면 다시 도전할 수 있어요.`;
    }
    if (rc.status === "opted_out") {
      return `리부트 챌린지를 쉬고 계세요. "${REBOOT_START_COMMAND}"라고 보내시면 다시 시작할 수 있어요.`;
    }
    return "";
  }

  return `전자책을 구매하면 바로 리부트-크루로 승급되고, 다음 날부터 30일 리부트 챌린지가 시작돼요 (DM으로 "구매"라고 보내보세요).`;
}

// ── SOS 트리거 기록 / 주간 회고: 어떤 명령어에도 안 걸리는 DM은
// "방금 보낸 질문에 대한 답"일 수 있으니 확인해서 저장합니다 ──────
async function handlePendingDmReply(message, content) {
  if (!content) return;

  // 30일 리부트 챌린지 체크인 답장이 최우선입니다 (SOS 키워드는 상위 라우터에서 이미 처리됨).
  const handledByReboot = await handleRebootCheckinReply(message, content).catch((e) => {
    console.error("[리부트 챌린지 답장 처리 오류]", e);
    return false;
  });
  if (handledByReboot) return;

  // 매달 30일 챌린지(금딸챌린지) 체크인 답장도 다른 파싱보다 먼저 확인합니다.
  const handledByMonthlyChallenge = await handleMonthlyChallengeCheckinReply(message, content).catch((e) => {
    console.error("[매달챌린지 답장 처리 오류]", e);
    return false;
  });
  if (handledByMonthlyChallenge) return;

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

  if (
    user.awaitingConfessionReply &&
    user.confessionPromptSentAt &&
    now - new Date(user.confessionPromptSentAt) <= CONFESSION_REPLY_WINDOW_MINUTES * 60 * 1000
  ) {
    await handleConfessionReply(message, content);
    return;
  }

  // 어느 쪽에도 해당하지 않는 DM은 조용히 무시합니다 (기존 동작과 동일).
}

// ── 데일리 스트릭 대시보드 (DM "!기록") ──────────────────────
async function handleStreakRequest(message) {
  const user = getUser(message.author.id);
  const monthKey = todayKST().slice(0, 7);
  const thisMonthCount = (user.monthlyCounts && user.monthlyCounts[monthKey]) || 0;
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  const member = guild ? await guild.members.fetch(message.author.id).catch(() => null) : null;
  await message.reply(
    `📊 **${message.author.username}**님의 기록\n` +
      `누적 인증: ${user.cumulativeCount}회\n` +
      `현재 등급: ${describeCurrentLevel(member, user)}\n` +
      `${describeNextLevelProgress(member, user)}\n` +
      `현재 연속: ${user.currentStreak || 0}일 🔥\n` +
      `최고 기록: ${user.longestStreak || 0}일\n` +
      `이번 달: ${thisMonthCount}회\n` +
      `🙏 도움 포인트: 이번 주 ${user.weeklyHelperPoints || 0}점 (누적 ${user.totalHelperPoints || 0}점)`
  );
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

// ── 전자책 구매(리부트-크루 승급) ────────────────────────────
async function handleEbookPurchaseRequest(message) {
  const user = getUser(message.author.id);

  if (user.ebookPurchased) {
    await message.reply("이미 전자책을 구매하고 리부트-크루로 승급하셨어요! 🎉");
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
        `1) 자동으로 리부트-크루로 승급되고\n` +
        `2) 전자책 다운로드 링크를 이 DM으로 바로 보내드려요.\n` +
        `별도로 다시 뭘 누르실 필요 없이, 결제만 하시면 끝이에요!\n\n⚠️ **환불 정책**: 전자책(디지털 콘텐츠) 특성상 결제 완료 후에는 단순 변심에 의한 환불이 불가능해요. 결제 오류·중복 결제 등 판매자 귀책 사유가 있는 경우에만 이 채널을 통해 문의해주시면 확인 후 조치해드려요.\n\n🔒 **민감정보 안내**: 절제·재발 기록처럼 건강·성생활과 관련된 민감한 이야기는 서버 멤버 전체가 볼 수 있는 공개 채널(오늘의-기록, 힘든날-나눔, 자유토론 등)에서 나누게 돼요. 어디까지 공유할지는 직접 조절하실 수 있고, 운영진이 이 내용을 따로 캡처하거나 서버 밖으로 유출하지 않아요. 결제를 진행하시면 이 안내에 동의하신 것으로 볼게요.`
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
      `📘 **${EBOOK_NAME}** 구매를 도와드릴게요! 아래 링크에서 바로 결제하시면 돼요 👇\n(본인 확인용 1회성 링크예요 — 다른 분과 공유하지 말아주세요)\n\n${payUrl}\n\n` +
        `결제가 완료되면 이렇게 진행돼요.\n` +
        `1️⃣ 자동으로 리부트-크루로 승급\n` +
        `2️⃣ 전자책 다운로드 링크를 이 DM으로 바로 발송\n\n` +
        `따로 누르실 것 없이, 결제만 완료하시면 끝이에요 🙂\n\n⚠️ 환불은 전자책(디지털 콘텐츠) 특성상 단순 변심 시엔 어려워요. 결제 오류·중복 결제처럼 저희 쪽 실수가 있었을 땐 언제든 이 채널로 말씀해주시면 바로 확인해드릴게요.\n\n🔒 절제·재발 같은 민감한 이야기는 서버 공개 채널(오늘의-기록, 힘든날-나눔, 자유토론 등)에서 나누게 돼요. 어디까지 나눌지는 항상 본인이 정하시고, 운영진이 따로 캡처하거나 유출하지 않아요. 결제를 진행하시면 이 내용에 동의하신 걸로 볼게요.`
    );
  } catch (e) {
    console.error("[구매링크 생성 오류]", e);
    await message.reply("결제 링크 생성 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.");
  }
}
// 무료 미리보기는 더 이상 파일을 DM으로 직접 보내지 않고, 구글폼(이메일 수집) 신청 페이지로 안내합니다.
// 신청서 제출 후 확인 화면에서 /preview-download 로 바로 연결되어 PDF를 받을 수 있어요.
const EBOOK_PREVIEW_FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLSeomkOO4-DNSXHDXR57csP2IDgNhGgYUHgJx12rMk815j06-Q/viewform";
async function handleEbookPreviewRequest(message) {
  try {
    await message.reply(
      `📖 **${EBOOK_NAME}** 무료 미리보기(프롤로그 + 1장 전체)는 아래 신청서 작성 후 바로 받으실 수 있어요!\n\n` +
      `1️⃣ 아래 링크 눌러서 30초짜리 신청서 작성\n\n` +
      `2️⃣ 이메일 남기고 안내 문구 확인 후 동의 체크\n\n` +
      `3️⃣ 제출하자마자 그 자리에서 바로 PDF 다운로드 링크가 떠요\n\n` +
      `👉 ${EBOOK_PREVIEW_FORM_URL}\n\n` +
      `(#공지-규칙 채널에도 같은 안내가 있어요)\n\n` +
      `전체 내용이 마음에 드시면 "${EBOOK_PURCHASE_COMMANDS[0]}"라고 보내주세요 🙂`
    );
  } catch (e) {
    console.error("[전자책 미리보기 안내 전송 오류]", e);
    await message.reply("미리보기 안내 전송 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.");
  }
}

// ── 운영진 전용: 전자책/워크북 원본 PDF 업로드/교체 (DM) ─────────────────
// 사용법: 서버 운영자(길드 소유자)가 봇 DM에 "!전자책원본업로드" 또는 "!워크북원본업로드"
// 메시지와 함께 PDF 파일을 첨부해서 보내면, 그 파일을 Railway 영구 볼륨에 저장합니다.
// 이 파일들은 git 저장소에는 절대 올라가지 않고, 결제 확인 시마다 구매자 워터마크를
// 새로 입혀서 DM으로 발송하는 데 쓰입니다.
async function handleMasterUpload(message, { masterPath, uploadCommand, label }) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild || guild.ownerId !== message.author.id) {
      await message.reply("이 명령어는 서버 운영자만 사용할 수 있어요.");
      return;
    }
    const pdfAttachment = message.attachments.find(
      (a) => (a.contentType || "").includes("pdf") || (a.name || "").toLowerCase().endsWith(".pdf")
    );
    if (!pdfAttachment) {
      await message.reply(`${label} 원본 PDF 파일을 이 메시지에 첨부해서 "${uploadCommand}"와 함께 다시 보내주세요.`);
      return;
    }
    const res = await fetch(pdfAttachment.url);
    if (!res.ok) throw new Error(`파일 다운로드 실패 (status ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(masterPath), { recursive: true });
    fs.writeFileSync(masterPath, buf);
    await message.reply(
      `✅ ${label} 원본 파일을 저장했어요 (${(buf.length / 1024 / 1024).toFixed(2)}MB). ` +
        `앞으로 결제가 확인되면 이 파일에 구매자 워터마크를 자동으로 입혀서 DM으로 보내드려요.`
    );
  } catch (e) {
    console.error(`[${label} 원본 업로드 오류]`, e);
    await message.reply(`${label} 원본 파일 저장에 실패했어요. 잠시 후 다시 시도해주세요.`);
  }
}

async function handleEbookMasterUpload(message) {
  return handleMasterUpload(message, {
    masterPath: EBOOK_MASTER_PATH,
    uploadCommand: EBOOK_UPLOAD_COMMAND,
    label: "전자책",
  });
}

async function handleWorkbookMasterUpload(message) {
  return handleMasterUpload(message, {
    masterPath: WORKBOOK_MASTER_PATH,
    uploadCommand: WORKBOOK_UPLOAD_COMMAND,
    label: "워크북",
  });
}

// "!구매초기화" — 서버 운영자 전용. 테스트/환불 등의 사유로 본인 계정의
// 전자책 구매 기록과 리부트-크루/마스터-크루 역할을 초기화해서, 처음 구매하는
// 것처럼 다시 결제~전자책 발급 흐름을 테스트할 수 있게 해줍니다.
async function handleEbookPurchaseReset(message) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild || guild.ownerId !== message.author.id) {
      await message.reply("이 명령어는 서버 운영자만 사용할 수 있어요.");
      return;
    }
    const member = await guild.members.fetch(message.author.id).catch(() => null);
    if (!member) {
      await message.reply("서버 멤버 정보를 찾을 수 없어요. 서버에 가입되어 있는지 확인해주세요.");
      return;
    }

    updateUser(message.author.id, { ebookPurchased: false, ebookPurchasedAt: null });

    const removedRoles = [];
    if (member.roles.cache.has(ROLE_ID_MASTER)) {
      await member.roles.remove(ROLE_ID_MASTER).catch((e) => console.error("[역할제거 실패] 마스터-크루", e));
      removedRoles.push("마스터-크루");
    }
    if (member.roles.cache.has(ROLE_ID_GROW)) {
      await member.roles.remove(ROLE_ID_GROW).catch((e) => console.error("[역할제거 실패] 리부트-크루", e));
      removedRoles.push("리부트-크루");
    }

    await message.reply(
      `✅ 구매 기록을 초기화했어요.${removedRoles.length ? ` (${removedRoles.join(", ")} 역할 제거됨)` : " (제거할 역할은 없었어요)"}\n` +
        `이제 "구매"라고 다시 보내시면 처음 구매하는 것처럼 결제 → 승급 → 전자책 발급 흐름을 처음부터 테스트하실 수 있어요.`
    );
  } catch (e) {
    console.error("[구매 초기화 오류]", e);
    await message.reply("초기화 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.");
  }
}

// "!구매기록삭제 @유저" (또는 "!구매기록삭제 유저ID") — 서버 운영자 전용.
// 환불/중복결제/오류 등의 사유로 특정 멤버의 전자책 구매 상태를 되돌리고,
// 리부트-크루/마스터-크루 역할을 제거합니다.
//
// 주의:
// - PayApp 등 결제 게이트웨이 쪽 실제 결제 취소/환불은 이 명령어로 처리되지 않아요.
//   돈이 오간 부분은 PayApp 관리자 페이지에서 별도로 처리해야 합니다.
// - processedPayments(결제 중복처리 방지 기록)는 mul_no(결제요청번호) 단위로만 저장되어
//   유저와 직접 연결돼 있지 않아서, 이 명령어로는 건드리지 않습니다. 같은 결제건으로
//   재구매를 다시 테스트하게 하려면 별도로 알려주세요.
// - 대상 멤버에게 자동으로 DM을 보내지 않습니다. 알려야 한다면 직접 연락해주세요.
async function handleEbookPurchaseDelete(message, content) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild || guild.ownerId !== message.author.id) {
      await message.reply("이 명령어는 서버 운영자만 사용할 수 있어요.");
      return;
    }

    const targetUser = await resolveMentionedUser(message, content, EBOOK_PURCHASE_DELETE_COMMAND, guild);
    if (!targetUser) {
      await message.reply(
        `대상 유저를 찾을 수 없어요. "${EBOOK_PURCHASE_DELETE_COMMAND} @유저" 형태로 멘션하거나, ` +
          `"${EBOOK_PURCHASE_DELETE_COMMAND} 유저ID"처럼 디스코드 유저 ID를 붙여서 다시 보내주세요. ` +
          `(DM에서는 유저네임 자동완성이 안 될 수 있어서, ID로 보내시는 게 제일 확실해요.)`
      );
      return;
    }

    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);

    updateUser(targetUser.id, { ebookPurchased: false, ebookPurchasedAt: null });

    const removedRoles = [];
    if (targetMember) {
      if (targetMember.roles.cache.has(ROLE_ID_MASTER)) {
        await targetMember.roles.remove(ROLE_ID_MASTER).catch((e) => console.error("[역할제거 실패] 마스터-크루", e));
        removedRoles.push("마스터-크루");
      }
      if (targetMember.roles.cache.has(ROLE_ID_GROW)) {
        await targetMember.roles.remove(ROLE_ID_GROW).catch((e) => console.error("[역할제거 실패] 리부트-크루", e));
        removedRoles.push("리부트-크루");
      }
    }

    await message.reply(
      `✅ ${targetUser.tag || targetUser.username}님의 구매 기록을 삭제했어요.` +
        `${
          removedRoles.length
            ? ` (${removedRoles.join(", ")} 역할 제거됨)`
            : targetMember
            ? " (제거할 역할은 없었어요)"
            : " (서버에서 멤버 정보를 찾지 못해 역할은 건드리지 않았어요)"
        }\n` +
        `⚠️ PayApp 등 실제 결제 취소는 이 명령어로 처리되지 않아요. 필요하면 결제 관리자 페이지에서 별도로 처리해주세요. 대상 유저에게는 DM을 보내지 않았어요.`
    );
  } catch (e) {
    console.error("[구매기록 삭제 오류]", e);
    await message.reply("구매 기록 삭제 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.");
  }
}

// 관리자 DM 명령어(!구매기록삭제, !승급축하 등) 뒤에 붙은 멘션(@유저) 또는 디스코드 유저 ID/
// 유저네임으로 대상 유저를 찾습니다. DM 안에서는 서버 멤버 멘션 자동완성이 안 될 수 있어서,
// <@ID>를 직접 타이핑했거나 순수 ID/유저네임을 붙여 보낸 경우까지 함께 지원합니다.
async function resolveMentionedUser(message, content, command, guild) {
  const mentioned = message.mentions.users.first();
  if (mentioned) return mentioned;

  const rest = content.slice(command.length).trim();
  if (!rest) return null;

  const mentionMatch = rest.match(/^<@!?(\d+)>$/);
  const rawId = mentionMatch ? mentionMatch[1] : /^\d{15,25}$/.test(rest) ? rest : null;
  if (rawId) {
    return await client.users.fetch(rawId).catch(() => null);
  }

  // 순수 ID/멘션이 아니면, 서버 멤버 중 유저네임이 일치하는 사람을 찾아봅니다.
  const members = await guild.members.fetch().catch(() => null);
  if (!members) return null;
  const needle = rest.replace(/^@/, "").toLowerCase();
  const found = members.find((m) => m.user.username.toLowerCase() === needle);
  return found ? found.user : null;
}

// "!승급축하 @유저" (또는 "!승급축하 유저ID") — 서버 운영자 전용.
// 결제/리액션 등 실제 이벤트를 다시 태우지 않고도, 봇이 평소 승급 때 쓰는 것과 똑같은
// 형식으로 공개 축하 메시지를 지금 바로 올리게 합니다. (예: 결제는 확인됐는데 이미 예전에
// 역할을 갖고 있어서 announcePromotion이 자동으로 스킵된 경우, 운영자가 수동으로 역할을
// 부여한 경우 등)
//
// 대상 유저의 등급은 describeCurrentLevel로 자동 판별하고(마스터-크루 > 리부트-크루),
// 그 유저가 "알림끄기"를 보내 공개 축하를 원치 않는다고 밝힌 상태라면 자동 발행 때와
// 똑같이 조용히 건너뜁니다 — 관리자 명령어라고 해서 본인 의사를 무시하지 않습니다.
async function handlePromotionAnnounce(message, content) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild || guild.ownerId !== message.author.id) {
      await message.reply("이 명령어는 서버 운영자만 사용할 수 있어요.");
      return;
    }

    const targetUser = await resolveMentionedUser(message, content, PROMOTION_ANNOUNCE_COMMAND, guild);
    if (!targetUser) {
      await message.reply(
        `대상 유저를 찾을 수 없어요. "${PROMOTION_ANNOUNCE_COMMAND} @유저" 형태로 멘션하거나, ` +
          `"${PROMOTION_ANNOUNCE_COMMAND} 유저ID"처럼 디스코드 유저 ID를 붙여서 다시 보내주세요.`
      );
      return;
    }

    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      await message.reply("서버에서 그 유저를 찾지 못했어요. 서버에 남아있는 멤버인지 확인해주세요.");
      return;
    }

    const u = getUser(targetUser.id);
    const roleLabel = describeCurrentLevel(targetMember, u);
    if (roleLabel === "무료멤버") {
      await message.reply(
        `${targetUser.tag || targetUser.username}님은 지금 리부트-크루/마스터-크루 역할이 없어서, 축하할 등급이 없어요. 역할을 먼저 부여한 뒤 다시 시도해주세요.`
      );
      return;
    }

    if (u.publicAnnounceOptOut) {
      await message.reply(
        `${targetUser.tag || targetUser.username}님은 "알림끄기" 상태라 공개 축하 메시지를 올리지 않았어요. 그래도 올리고 싶으면 먼저 본인에게 알림을 다시 켜달라고 요청해주세요.`
      );
      return;
    }

    const posted = await announcePromotion(guild, targetMember, roleLabel);
    if (posted) {
      await message.reply(
        `✅ 공개 채널에 ${targetUser.tag || targetUser.username}님의 ${roleLabel} 승급 축하 메시지를 올렸어요.`
      );
    } else {
      await message.reply(
        `⚠️ 공개 채널에 메시지를 올리지 못했어요. #명예의-전당(없으면 #자유수다) 채널이 실제로 있는지, ` +
          `봇이 그 채널에서 "메시지 보내기" 권한이 있는지 확인해주세요. 자세한 오류는 서버 로그에 남아있어요.`
      );
    }
  } catch (e) {
    console.error("[승급 축하 수동 발행 오류]", e);
    await message.reply("승급 축하 메시지를 올리는 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.");
  }
}

// ── 구매자 전용 워터마크가 삽입된 PDF 생성 (전자책/워크북 공용) ───────
// masterPath의 원본을 읽어, 모든 페이지 하단에 작은 텍스트로("LOGOUTLIFE" 브랜드 +
// 구매자 식별 정보), 중앙에는 큼직하고 옅은 대각선 텍스트로 "LOGOUTLIFE" 브랜드 워터마크를
// 새겨넣습니다. 파일이 유출되더라도 어느 구매자에게서 나갔는지, 그리고 어느 브랜드의
// 콘텐츠인지 바로 알아볼 수 있게 하기 위함입니다.
const WATERMARK_BRAND = process.env.WATERMARK_BRAND || "LOGOUTLIFE";

async function generateWatermarkedPdf(masterPath, buyerLabel) {
  const { PDFDocument } = require("pdf-lib");
  const { createCanvas } = require("@napi-rs/canvas");
  const masterBytes = fs.readFileSync(masterPath);
  const pdfDoc = await PDFDocument.load(masterBytes);
  const footerStamp = `${WATERMARK_BRAND} · ${buyerLabel} 전용 구매본 · 무단 배포·재판매 금지 · ${todayKST()}`;
  const centerStamp = `${WATERMARK_BRAND} · ${buyerLabel}`;

  // 페이지 크기(가로x세로)별로 워터마크 오버레이 이미지를 한 번만 만들어 재사용합니다.
  // (같은 이미지를 페이지마다 새로 embed하면 페이지 수만큼 파일 용량이 불어나기 때문에,
  // 임베드된 이미지 객체 자체를 캐시해서 여러 페이지가 같은 이미지를 참조하게 합니다.)
  const overlayImageCache = new Map();

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();
    const cacheKey = `${Math.round(width)}x${Math.round(height)}`;
    let overlayImage = overlayImageCache.get(cacheKey);
    if (!overlayImage) {
      const scale = 2; // 레티나 화질용 2배 렌더링
      const canvas = createCanvas(Math.round(width * scale), Math.round(height * scale));
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);

      // 하단 각주 워터마크
      ctx.font = `9px ${EBOOK_WATERMARK_FONT_FAMILY}`;
      ctx.fillStyle = "rgba(120,120,120,0.75)";
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(footerStamp, 20, height - 14);

      // 중앙 대각선 워터마크
      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.rotate((-35 * Math.PI) / 180);
      ctx.font = `bold 30px ${EBOOK_WATERMARK_FONT_FAMILY}`;
      ctx.fillStyle = "rgba(150,150,150,0.30)";
      ctx.textAlign = "center";
      ctx.fillText(centerStamp, 0, 0);
      ctx.restore();

      const pngBytes = canvas.toBuffer("image/png");
      overlayImage = await pdfDoc.embedPng(pngBytes);
      overlayImageCache.set(cacheKey, overlayImage);
    }
    page.drawImage(overlayImage, { x: 0, y: 0, width, height });
  }
  return Buffer.from(await pdfDoc.save());
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

// ── 대용량 워터마크 PDF 다운로드 링크 (Discord DM 첨부 용량 제한 우회) ──────
// Discord DM 첨부파일에는 용량 제한이 있어서, 원본 PDF에 이미지가 많으면 워터마크를
// 입힌 뒤에도 그 제한(DiscordAPIError 40005 "Request entity too large")을 넘을 수
// 있습니다. 그런 경우 파일을 직접 첨부하는 대신, 이 서버가 잠깐 호스팅해주는
// 구매자 전용(추측 불가능한 토큰) 다운로드 링크를 DM으로 보내드립니다.
const DISCORD_ATTACHMENT_SAFE_LIMIT = 7 * 1024 * 1024; // 7MB - Discord DM 첨부 제한보다 여유 있게 안전선으로 잡음
const downloadTokens = new Map(); // token -> { buffer, filename, createdAt }
const DOWNLOAD_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7일 후 자동 만료
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of downloadTokens.entries()) {
    if (now - entry.createdAt > DOWNLOAD_TOKEN_TTL_MS) downloadTokens.delete(token);
  }
}, 60 * 60 * 1000).unref();

// ── 구매자에게 전자책+워크북 전달 (워터마크 PDF 우선, 없으면 다운로드 링크로 대체) ──
// 판매 상품은 "전자책 + 30일 워크북" 두 파일 번들이라, 원본이 업로드된 파일들을 모두
// 워터마크 처리해서 한 DM에 같이 첨부해 보냅니다.
// (링크와 달리 복사해서 다른 사람에게 전달해도, 유출 시 워터마크로 누구 파일인지 바로 추적돼요.)
// 단, 워터마크 입힌 파일이 DISCORD_ATTACHMENT_SAFE_LIMIT보다 크면 Discord가 첨부를
// 거부하므로(40005 오류), 그런 파일은 대신 위 다운로드 링크로 보내드립니다.
// 아직 운영진이 원본 파일을 업로드하지 않은 항목이 있으면, 그 항목만 안내 문구로 대신합니다.
// 워크북은 용량이 커서(원본에 이미지/워크시트가 많음) 매번 크기 검사를 거치지 않고
// 항상 다운로드 링크로만 보내도록 alwaysLink로 고정했습니다.
const PURCHASED_ITEMS = [
  { name: EBOOK_NAME, masterPath: EBOOK_MASTER_PATH },
  { name: WORKBOOK_NAME, masterPath: WORKBOOK_MASTER_PATH, alwaysLink: true },
];

async function sendEbookToBuyer(member) {
  const buyerLabel = member.user.tag || member.user.username;
  const attachments = [];
  const downloadLinks = [];
  const notReadyItems = [];

  for (const item of PURCHASED_ITEMS) {
    if (!fs.existsSync(item.masterPath)) {
      notReadyItems.push(item.name);
      continue;
    }
    try {
      const watermarked = await generateWatermarkedPdf(item.masterPath, buyerLabel);
      if ((item.alwaysLink || watermarked.length > DISCORD_ATTACHMENT_SAFE_LIMIT) && PUBLIC_BASE_URL) {
        // 파일이 너무 커서 DM에 직접 첨부하면 Discord가 거부하므로, 다운로드 링크로 대체합니다.
        const token = crypto.randomUUID();
        downloadTokens.set(token, { buffer: watermarked, filename: `${item.name}.pdf`, createdAt: Date.now() });
        downloadLinks.push({ name: item.name, url: `${PUBLIC_BASE_URL}/dl/${token}` });
      } else {
        attachments.push(new AttachmentBuilder(watermarked, { name: `${item.name}.pdf` }));
      }
    } catch (e) {
      console.error(`[${item.name} 워터마크 파일 생성 오류]`, e);
      notReadyItems.push(item.name);
    }
  }

  if (attachments.length || downloadLinks.length) {
    const deliveredNames = [...attachments.map((a) => a.name.replace(/\.pdf$/, "")), ...downloadLinks.map((l) => l.name)];
    const linksNote = downloadLinks.length
      ? "\n\n" + downloadLinks.map((l) => `📥 ${l.name} 다운로드: ${l.url}\n(용량이 커서 파일 대신 다운로드 링크로 보내드려요. 본인만 사용해주세요.)`).join("\n")
      : "";
    const notReadyNote = notReadyItems.length
      ? `\n\n※ ${notReadyItems.join(", ")}는 준비되는 대로 곧 별도로 보내드릴게요.`
      : "";
    await member.send({
      content:
        `📘 구매하신 파일이에요! (${deliveredNames.join(" + ")})\n` +
        `이 파일들에는 **${buyerLabel}** 님 전용 워터마크가 삽입되어 있어요. 개인 소장용으로만 사용해주시고, ` +
        `무단 배포·재판매·공유는 삼가주세요 — 유출 시 구매자 추적이 가능해요 🙏` +
        linksNote +
        notReadyNote,
      files: attachments,
    });
    return;
  }

  // 원본이 하나도 준비되지 않았을 때만 기존 다운로드 링크(설정돼 있다면)로 대체합니다.
  if (EBOOK_DOWNLOAD_URL) {
    await safeDM(
      member,
      `📘 **${EBOOK_NAME}** 다운로드 링크예요 👇\n${EBOOK_DOWNLOAD_URL}\n\n` +
        `※ 이 링크는 본인만 사용해주시고, 다른 사람과 공유하지 말아주세요.`
    );
  } else {
    console.warn(`[전자책/워크북 전달 실패] 원본 파일도, EBOOK_DOWNLOAD_URL도 설정되어 있지 않아 ${member.user.tag}에게 파일을 전달하지 못했습니다.`);
    await safeDM(member, `구매하신 파일은 확인 후 곧 별도로 보내드릴게요. 잠시만 기다려주세요!`);
  }
}

async function promoteToGrowCrewByEbook(discordUserId) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordUserId).catch(() => null);
    if (!member) {
      console.error(`[전자책 승급 실패] 길드에서 멤버를 찾을 수 없음: ${discordUserId}`);
      return;
    }
    // 주의: 예전엔 "이미 리부트-크루 역할이 있으면" 여기서 그냥 return 해버려서,
    // (운영자가 테스트 등으로 역할을 미리 수동 부여해둔 경우) 실제 결제가 들어와도
    // 구매 확인 DM/전자책 다운로드 링크가 전혀 발송되지 않는 버그가 있었습니다.
    // 중복 웹훅 방지는 어차피 웹훅 단의 mul_no 기반 isPaymentProcessed()가 이미 담당하므로,
    // 여기서는 역할 유무와 상관없이 결제가 확인되면 항상 DM을 보내도록 수정했습니다.
    const alreadyHadGrowRole = member.roles.cache.has(ROLE_ID_GROW);

    if (!alreadyHadGrowRole) {
      await member.roles.add(ROLE_ID_GROW).catch((e) => console.error("[역할부여 실패] 리부트-크루(전자책)", e));
    }
    await safeDM(
      member,
      `전자책 구매가 확인됐어요! 리부트-크루로 승급했어요 🎉\n` +
        `SOS 요청이 올라오면 도움을 요청받는 헬퍼 알림 대상에도 포함됐어요.\n` +
        `#함께-만들기 채널에서 새로운 아이디어나 초안을 가장 먼저 보고 의견 남기실 수 있어요.`
    );

    await sendEbookToBuyer(member);
    if (!alreadyHadGrowRole) {
      await announcePromotion(guild, member, "리부트-크루");
    }

    // (예전엔 여기서 "구매 이전 누적 인증이 T_MASTER회를 넘으면 즉시 마스터-크루 승급"을
    // 처리했지만, 마스터-크루 승급 기준이 "30일 리부트 챌린지 최초 완주"로 바뀌면서 삭제했습니다.
    // 30일 리부트 챌린지는 이 함수가 끝난 뒤 별도로(D+1 자동 시작 스캔) 시작됩니다.)
  } catch (e) {
    console.error("[전자책 승급 처리 오류]", e);
  }
}

// ── PayApp 결제완료 웹훅 수신 서버 ────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("OK"));

// 대용량 워터마크 PDF 다운로드 링크 (구매자 전용, 추측 불가능한 토큰 기반).
// sendEbookToBuyer에서 파일이 Discord 첨부 용량 제한을 넘을 때만 이 링크를 만들어 보냅니다.
app.get("/dl/:token", (req, res) => {
  const entry = downloadTokens.get(req.params.token);
  if (!entry) {
    return res
      .status(404)
      .send("링크가 만료되었거나 존재하지 않는 파일이에요. 디스코드로 돌아가서 봇에게 문의해주세요.");
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(entry.filename)}"`);
  res.send(entry.buffer);
});

// 전자책 소개 랜딩페이지를 직접 서빙합니다 (외부 사이트 의존 없이,
// 로그인 없이 누구나 바로 볼 수 있어요). ?uid=디스코드유저ID를 붙이면
// 페이지 내 구매 버튼이 본인 전용 결제 링크로 자동 연결됩니다.
app.get("/landing", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});

// 무료 미리보기(프롤로그 + 1장) PDF를 로그인/DM 없이 누구나 받을 수 있게 공개 서빙합니다.
// 구글폼(이메일 수집) 제출 후 확인 화면에서 이 주소로 바로 연결하는 용도입니다.
// 디스코드 DM "미리보기" 명령어와 같은 파일을 그대로 내려주는 것뿐이라, 결제/워터마크
// 로직과는 완전히 무관합니다.
app.get("/preview-download", (req, res) => {
  if (!fs.existsSync(EBOOK_PREVIEW_PATH)) {
    res.status(404).send("미리보기 파일을 찾을 수 없어요. 운영자에게 문의해주세요.");
    return;
  }
  res.download(EBOOK_PREVIEW_PATH, "로그아웃라이프_REBOOT_미리보기.pdf");
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

    // 세금/장부 정리용 매출 자동 기록 - 닉네임은 best-effort로만 붙이고,
    // 이 기록이 실패하거나 늦어져도 결제 처리 응답(SUCCESS)에는 영향 없게 fire-and-forget으로 둡니다.
    (async () => {
      let label = discordUserId;
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(discordUserId).catch(() => null);
        if (member) label = member.displayName;
      } catch (e) {
        console.error("[매출 기록] 닉네임 조회 실패", e);
      }
      appendSalesEvent({
        discordUserId,
        label,
        goodName: body.goodname || EBOOK_NAME,
        price: body.price || EBOOK_PRICE,
        mulNo: mulNo || "",
      }).catch((e) => console.error("[매출 기록 오류]", e));
    })();

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
    // 결제 링크를 만들기 전에, 이 ID가 실제로 디스코드 서버에 있는 멤버인지 먼저 확인합니다.
    // 이 확인 없이 바로 결제 링크를 만들면, 존재하지 않거나 서버를 나간 ID로도 결제가
    // 진행돼버려서 "결제는 됐는데 파일도 승급도 안 가는" 사고로 이어질 수 있습니다.
    let member = null;
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      member = await guild.members.fetch(discordUserId).catch(() => null);
    } catch (e) {
      console.error("[/go 멤버 확인 오류]", e);
    }
    if (!member) {
      return res
        .status(403)
        .send(
          `이 링크는 디스코드 서버 멤버일 때만 사용할 수 있어요. 먼저 디스코드 서버에 참여하신 뒤, 봇에게 DM으로 "구매"라고 보내주세요 — 그러면 본인 전용 결제 링크를 새로 보내드려요.`
        );
    }

    const user = getUser(discordUserId);
    if (user.ebookPurchased) {
      return res
        .status(200)
        .send("이미 구매를 완료하고 리부트-크루로 승급하셨어요! 디스코드로 돌아가서 DM으로 받은 전자책·워크북을 확인해보세요.");
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

// ── 즉시반응 시스템: 최근 활동한 그로우/마스터-크루에게 조용히 알림 ──
// text를 넘기지 않으면 기존 SOS용 기본 문구를 사용합니다. (신규 멤버 환영 알림 등
// 다른 상황에서도 같은 헬퍼 풀/쿨다운 로직을 재사용하기 위해 문구를 인자로 뺐습니다.)
async function notifyHelpers(message, text) {
  const guild = message.guild;
  // 리부트-크루/마스터-크루가 SOS 도움 요청에 응답해줄 수 있는 헬퍼 풀입니다.
  const roleIds = [ROLE_ID_GROW, ROLE_ID_MASTER].filter(Boolean);
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

  const finalText =
    text ||
    `지금 #${SOS_CHANNEL_NAME}에 도움이 필요한 분이 있는 것 같아요. 시간 되실 때 한마디 남겨주실 수 있을까요?\n${message.url}`;

  for (const member of picked) {
    await safeDM(member, finalText);
    updateUser(member.id, { lastHelperPingAt: now.toISOString() });
  }
}

// ── 승급 알림 & 배지 시스템: 공개 채널 축하 메시지 ──────────
// 반환값(true/false)으로 실제로 메시지를 올렸는지 알려줍니다. 자동 승급 흐름
// (웹훅/리액션)에서는 이 값을 안 써도 되지만, !승급축하 같은 수동 명령어에서는
// "실패했는데도 성공했다고 답장하는" 상황을 막기 위해 꼭 필요합니다.
async function announcePromotion(guild, member, roleLabel) {
  try {
    const u = getUser(member.id);
    if (u.publicAnnounceOptOut) return false;
    const channel = findAnnounceChannel(guild);
    if (!channel) return false;
    await channel.send(`🎉 **${member.displayName}**님이 ${roleLabel}로 승급했어요! 축하해주세요 👏`);
    return true;
  } catch (e) {
    console.error("[승급 공개 알림 실패]", e);
    return false;
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
    // 도움은 등급과 무관하게 누구나 주고받을 수 있으므로, 감사 반응 집계도 특정 역할로 제한하지 않습니다.
    // (SOS 헬퍼 알림 대상은 별도 - notifyHelpers에서 그로우/마스터-크루/베테랑으로 그대로 유지됩니다.)

    const u = getUser(message.author.id);
    const updatedTotalHelperPoints = (u.totalHelperPoints || 0) + 1;
    updateUser(message.author.id, {
      weeklyHelperPoints: (u.weeklyHelperPoints || 0) + 1,
      totalHelperPoints: updatedTotalHelperPoints,
    });
    // 포인트가 실제로 반영됐다는 걸 바로 눈으로 확인할 수 있도록, 봇이 체크 표시를 남겨요.
    await safeReact(message, "✅");

    // 지킴이 배지: 누적 도움 포인트가 기준을 넘었고 아직 역할이 없으면 자동 부여 (멤버당 1회)
    if (
      ROLE_ID_GUARDIAN &&
      updatedTotalHelperPoints >= GUARDIAN_THRESHOLD &&
      !authorMember.roles.cache.has(ROLE_ID_GUARDIAN)
    ) {
      await authorMember.roles.add(ROLE_ID_GUARDIAN).catch((e) => console.error("[역할부여 실패] 지킴이", e));
      await safeDM(
        authorMember,
        `🛡️ 축하해요! 그동안 다른 분들을 도와주신 게 쌓여서 "지킴이" 역할을 받으셨어요. 로그아웃라이프가 저 혼자가 아니라 지킴이님 같은 분들 덕분에 굴러가고 있어요. 정말 감사해요 🙏`
      );
      await announcePromotion(message.guild, authorMember, "지킴이");
    }
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

    // 2) 온보딩 웰컴 DM (가입 D+1/3) - 가벼운 안내만, 결제 여부와 무관하게 모두 대상
    if (member.joinedAt) {
      const daysSinceJoin = daysBetween(member.joinedAt, now);
      if (daysSinceJoin === 1 && !user.dmFlags.o1) {
        await safeDM(
          member,
          `가입한 지 하루 됐어요! 아직이라면 #자기소개에 편하게 인사 한마디 남겨보세요.`
        );
        markDmSent(member.id, "o1");
      } else if (daysSinceJoin === 3 && !user.dmFlags.o3) {
        await safeDM(
          member,
          `벌써 3일째예요! 오늘은 #자유수다에 아무 얘기나 편하게 남겨보는 거 어때요? 혼자보다 같이가 훨씬 오래 갑니다.`
        );
        markDmSent(member.id, "o3");
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

    // 4) 결제전환 시퀀스 (D+25/32/40) - 아직 전자책을 구매하지 않은 사람만
    // 예전엔 D+25/27/29/30로 뒤로 갈수록 간격(2일→2일→1일)이 좁아져서 점점
    // 재촉하는 느낌을 줬습니다. 지금은 7일/8일 간격으로 고르게 벌렸고, "가입 N일
    // 축하" 같은 감정 표현과 구매 안내를 한 문장에 묶지 않도록 정리했습니다.
    if (user.ebookPurchased) continue;
    if (!member.joinedAt) continue;

    const daysSinceJoin = daysBetween(member.joinedAt, now);

    if (daysSinceJoin === 25 && !user.dmFlags.d25) {
      await safeDM(
        member,
        `지금까지 쌓은 기록을 정리해봤어요.\n누적 인증 ${user.cumulativeCount}회, 현재 등급: ${describeCurrentLevel(member, user)}.\n${describeNextLevelProgress(member, user)}\n꾸준히 잘 해오고 계세요!`
      );
      markDmSent(member.id, "d25");
    } else if (daysSinceJoin === 32 && !user.dmFlags.d32) {
      await safeDM(
        member,
        `전자책을 구매하면 바로 리부트-크루로 승급되고, 전자책·워크북을 바로 받아보실 수 있어요. DM으로 "구매"라고 보내시면 구매 링크를 받아보실 수 있어요. 지금까지의 기록이 아깝지 않게, 한번 둘러보세요.`
      );
      markDmSent(member.id, "d32");
    } else if (daysSinceJoin === 40 && !user.dmFlags.d40) {
      await safeDM(
        member,
        `지금까지 누적 인증 ${user.cumulativeCount}회, 현재 등급: ${describeCurrentLevel(member, user)}.\n` +
          `여기까지 꾸준히 잘 오셨어요. 리부트-크루로 승급하면 전자책·워크북을 바로 받아보실 수 있으니, 아직이시라면 한번 살펴보세요.` +
          (PAYMENT_LINK ? `\n더 알아보기 👉 ${PAYMENT_LINK}` : "")
      );
      markDmSent(member.id, "d40");
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
    const channel = findAnnounceChannel(guild);
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

// ── 채널 대화거리(먼저 말 걸기) 예약 발송 ──────────────────────
function scheduleConvoStarterJob() {
  cron.schedule(
    CONVO_STARTER_CRON,
    () => runConvoStarterJob().catch((e) => console.error("[대화거리 발송 오류]", e)),
    { timezone: TZ }
  );
  console.log(`[예약 등록] 채널 대화거리 cron: "${CONVO_STARTER_CRON}" (${TZ}) → #${CONVO_STARTER_CHANNEL_NAME}`);
}

async function runConvoStarterJob() {
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return;
  const channel = guild.channels.cache.find(
    (c) => typeof c.send === "function" && c.name.includes(CONVO_STARTER_CHANNEL_NAME)
  );
  if (!channel) {
    console.error(`[대화거리 발송] "${CONVO_STARTER_CHANNEL_NAME}"를 포함하는 채널을 찾지 못했어요.`);
    return;
  }

  const n = nextConvoStarterIndex(); // 0, 1, 2, 3 ... 영구 저장되는 순번
  const isLowTurn = n % 2 === 0; // 짝수번째는 가벼운 질문, 홀수번째는 깊은 질문 → 번갈아 나감
  const pool = isLowTurn ? CONVO_STARTER_LOW : CONVO_STARTER_HIGH;
  const question = pool[Math.floor(n / 2) % pool.length];
  // 질문만 뚝 던지면 채널에 뜬금없이 나타난 것처럼 보이기 쉬워서, 짧은 안내문을 앞에
  // 붙여 "봇이 대화거리로 올리는 것"이라는 맥락을 줍니다. 깊은 질문 쪽엔 "부담 없이,
  // 스킵해도 괜찮다"는 걸 명시해서 응답을 강요하는 느낌이 안 들게 했어요.
  const intro = isLowTurn
    ? "💬 오늘의 가벼운 질문이에요! 편하게 아무나 답해주세요 🙂"
    : "🌙 오늘은 조금 더 깊은 질문이에요. 답하고 싶은 만큼만, 부담 없이 남겨주세요.";

  await channel.send(`${intro}\n\n${question}`);
}

// ── 이주의 인사이트: sim에게만 매주 업로드 리마인더 DM ─────────
// 매주 월요일 아침, 서버 소유자(sim)에게만 "이번 주 인사이트 올려주세요" DM을 보냅니다.
// 형식은 자유(링크/짧은 생각/책 구절 등) — 봇은 리마인더만 담당하고 실제 게시는 sim이 수동으로 합니다.
function scheduleInsightReminderJob() {
  const expr = process.env.INSIGHT_REMINDER_CRON || "0 9 * * 1"; // 기본: 매주 월요일 오전 9시
  cron.schedule(
    expr,
    () => runInsightReminderJob().catch((e) => console.error("[주간 인사이트 리마인더 오류]", e)),
    { timezone: TZ }
  );
  console.log(`[예약 등록] 주간 인사이트 리마인더 cron: "${expr}" (${TZ})`);
}

async function runInsightReminderJob() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const owner = await guild.members.fetch(guild.ownerId).catch(() => null);
  if (!owner) {
    console.error("[주간 인사이트 리마인더 실패] 서버 소유자를 찾을 수 없습니다.");
    return;
  }
  await safeDM(
    owner,
    `📝 이번 주 #이주의-인사이트 올릴 차례예요.\n형식은 자유예요 — 링크 하나, 짧은 생각, 책 구절 뭐든 좋아요.`
  );
}

function markDmSent(userId, key) {
  const user = getUser(userId);
  user.dmFlags[key] = true;
  updateUser(userId, { dmFlags: user.dmFlags });
}

// ══════════════════════════════════════════════════════════════════════════
// ── 30일 리부트 챌린지: 상태 전이 / 다이제스트 / 크론 ────────────────────────
// ══════════════════════════════════════════════════════════════════════════

const REBOOT_EMOTION_KEYWORDS = ["외로움", "지루함", "스트레스", "분노", "공허함", "불안", "우울", "무기력"];
const WEEKDAY_LABELS_KO = ["일", "월", "화", "수", "목", "금", "토"];

function weekdayLabelForDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return "?";
  return WEEKDAY_LABELS_KO[d.getDay()];
}

// 답변 원문에서 1~5점 강도 숫자를 최대한 찾아봅니다. 엄격한 파싱이 아니라 다이제스트용
// 참고 신호일 뿐이고, 원문은 항상 그대로 함께 보내서 Claude가 직접 읽고 판단하게 합니다.
function extractIntensity(rawText) {
  const t = rawText || "";
  const m = t.match(/([1-5])\s*점/) || t.match(/(?:^|[^0-9])([1-5])(?:[^0-9]|$)/);
  return m ? Number(m[1]) : null;
}

function heuristicFormulaUsed(rawText) {
  const t = rawText || "";
  if (/(안\s*(씀|썼|사용)|사용\s*안|사용\s*못|0\s*번|안했)/.test(t)) return false;
  if (/(썼|사용|번)/.test(t)) return true;
  return null;
}

function formatEntryLine(day, entries) {
  const e = entries.find((x) => x.day === day);
  return `Day${day}: ${e ? e.rawText : "(결번)"}`;
}

function computeDiagnosisStats(entries) {
  const diag = entries.filter((e) => e.day >= 1 && e.day <= 7);
  const recordedDays = diag.length;
  const triggerDays = diag.filter((e) => !/^없음\s*$/.test((e.rawText || "").trim())).length;
  const intensities = diag.map((e) => extractIntensity(e.rawText)).filter((n) => n != null);
  const avgIntensity = intensities.length ? (intensities.reduce((a, b) => a + b, 0) / intensities.length).toFixed(1) : "N/A";
  const emotionCounts = {};
  for (const e of diag) {
    for (const kw of REBOOT_EMOTION_KEYWORDS) {
      if ((e.rawText || "").includes(kw)) emotionCounts[kw] = (emotionCounts[kw] || 0) + 1;
    }
  }
  const emotionText =
    Object.entries(emotionCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}(${v})`)
      .join(", ") || "특이 감정 언급 없음";
  return { recordedDays, triggerDays, avgIntensity, emotionText };
}

function computeExecutionStats(entries) {
  const exec = entries.filter((e) => e.day >= 9 && e.day <= 31).sort((a, b) => a.day - b.day);
  const recordedDays = exec.length;
  const intensities = exec.map((e) => extractIntensity(e.rawText)).filter((n) => n != null);
  const avgIntensity = intensities.length ? (intensities.reduce((a, b) => a + b, 0) / intensities.length).toFixed(1) : "N/A";
  let trendText = "N/A";
  if (intensities.length >= 4) {
    const half = Math.floor(intensities.length / 2);
    const firstAvg = intensities.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const secondAvg = intensities.slice(half).reduce((a, b) => a + b, 0) / (intensities.length - half);
    trendText = `전반부 평균 ${firstAvg.toFixed(1)} → 후반부 평균 ${secondAvg.toFixed(1)}`;
  }
  const usedDays = exec.filter((e) => heuristicFormulaUsed(e.rawText) === true);
  const notUsedDays = exec.filter((e) => heuristicFormulaUsed(e.rawText) === false);
  const relapseDays = exec.filter((e) => rebootReplyIndicatesRelapse(e.rawText));
  const relapseWeekdayCounts = {};
  for (const e of relapseDays) {
    const label = weekdayLabelForDate(e.date);
    relapseWeekdayCounts[label] = (relapseWeekdayCounts[label] || 0) + 1;
  }
  const relapseWeekdayText =
    Object.entries(relapseWeekdayCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}(${v})`)
      .join(", ") || "없음";
  const relapseRateUsed = usedDays.length
    ? Math.round((usedDays.filter((e) => rebootReplyIndicatesRelapse(e.rawText)).length / usedDays.length) * 100)
    : null;
  const relapseRateNotUsed = notUsedDays.length
    ? Math.round((notUsedDays.filter((e) => rebootReplyIndicatesRelapse(e.rawText)).length / notUsedDays.length) * 100)
    : null;
  return {
    recordedDays,
    avgIntensity,
    trendText,
    formulaUsedDays: usedDays.length,
    formulaTotalDays: exec.length,
    relapseCount: relapseDays.length,
    relapseWeekdayText,
    relapseRateUsed,
    relapseRateNotUsed,
  };
}

// 아래 세 함수는 "봇이 계산한 데이터 + 분석 지시문"을 한 메시지로 합쳐서, 운영자가
// 통째로 복사해 Claude 대화창에 붙여넣기만 하면 되게 만듭니다 (기획서 "분석 흐름" 참고).
function buildDay7Prompt(discordUserId, label) {
  const user = getUser(discordUserId);
  const entries = user.rebootChallenge.entries || [];
  const stats = computeDiagnosisStats(entries);
  const lines = [];
  for (let d = 1; d <= 7; d++) lines.push(formatEntryLine(d, entries));
  const instruction = `다음은 리부트 챌린지 참가자의 7일간 트리거 진단 기록이야. 아래 형식으로 분석해줘.

1. 이번 주 요약 (3줄 이내, 담백하게)
2. 반복되는 패턴 (시간대/장소/감정 중 실제로 반복된 것만, 없으면 "뚜렷한 반복 없음")
3. 다음 주(공식 확정)에 참고할 제안 1~2가지 — 확정할 If-Then 공식 아이디어로 이어지게
4. 참가자에게 그대로 보낼 격려 메시지 (2~3문장, 과장 없이)

[계산값] 기록 ${stats.recordedDays}/7일 · 트리거 있었던 날 ${stats.triggerDays}일 · 강도 평균 ${stats.avgIntensity} · 감정 빈도: ${stats.emotionText}

[기록]
${lines.join("\n")}`;
  return `📥 리부트 챌린지 Day7 분석 요청 — ${label} (ID: ${discordUserId})\n(아래 메시지를 통째로 복사해서 Claude에 붙여넣으세요)\n──────────────────────────\n${instruction}`;
}

function buildDay31Prompt(discordUserId, label) {
  const user = getUser(discordUserId);
  const rc = user.rebootChallenge;
  const entries = rc.entries || [];
  const diag = computeDiagnosisStats(entries);
  const exec = computeExecutionStats(entries);
  const diagLines = [];
  for (let d = 1; d <= 7; d++) diagLines.push(formatEntryLine(d, entries));
  const execLines = [];
  for (let d = 9; d <= 31; d++) execLines.push(formatEntryLine(d, entries));
  const formulasText = (rc.formulas || []).map((f, i) => `${i + 1}. ${f}`).join("\n") || "(기록 없음)";
  const instruction = `다음은 리부트 챌린지 참가자의 31일 전체 기록이야 (진단 7일 + 확정 1일 + 실행 23일). 아래 형식으로 마무리 분석을 써줘.

1. 30일 여정 요약 (5줄 이내)
2. 시작(진단 주간) 대비 달라진 점 (충동강도, 재발 빈도 등 수치 기반, 과장 없이)
3. 앞으로를 위한 제안 1~2가지
4. 참가자에게 그대로 보낼 수료 축하 메시지 (3~4문장, 담백하고 진심 어리게)

[진단 주간 계산값] 기록 ${diag.recordedDays}/7일 · 트리거 있었던 날 ${diag.triggerDays}일 · 강도 평균 ${diag.avgIntensity} · 감정 빈도: ${diag.emotionText}
[진단 주간 원문]
${diagLines.join("\n")}

[확정한 If-Then 공식]
${formulasText}

[실행 구간 계산값] 기록 ${exec.recordedDays}/23일 · 강도 평균 ${exec.avgIntensity} (${exec.trendText}) · 공식 사용 추정 ${exec.formulaUsedDays}/${exec.formulaTotalDays}일 · 재발 총 ${exec.relapseCount}회 · 재발 요일 분포: ${exec.relapseWeekdayText} · 공식 사용일 재발률 ${exec.relapseRateUsed ?? "N/A"}% vs 미사용일 재발률 ${exec.relapseRateNotUsed ?? "N/A"}%
[실행 구간 원문]
${execLines.join("\n")}`;
  return `📥 리부트 챌린지 Day31 최종 분석 요청 — ${label} (ID: ${discordUserId})\n(아래 메시지를 통째로 복사해서 Claude에 붙여넣으세요)\n──────────────────────────\n${instruction}`;
}

function buildStatusPrompt(discordUserId, label) {
  const user = getUser(discordUserId);
  const rc = user.rebootChallenge;
  const entries = rc.entries || [];
  const diag = computeDiagnosisStats(entries);
  const exec = computeExecutionStats(entries);
  const diagLines = [];
  for (let d = 1; d <= 7; d++) {
    if (entries.some((e) => e.day === d)) diagLines.push(formatEntryLine(d, entries));
  }
  const execLines = [];
  for (let d = 9; d <= 31; d++) {
    if (entries.some((e) => e.day === d)) execLines.push(formatEntryLine(d, entries));
  }
  const formulasText = (rc.formulas || []).map((f, i) => `${i + 1}. ${f}`).join("\n") || "(아직 없음)";
  const instruction = `다음은 리부트 챌린지 참가자의 지금까지(현재 Day ${rc.currentDay}) 중간 기록이야. 정식 분석이 아니라 가벼운 중간 점검이니, 눈에 띄는 패턴만 짧게 짚어줘.

[현재 상태] ${rc.status} · 진행 Day ${rc.currentDay} · 결번 ${(rc.missedDays || []).length}회

[진단 주간 계산값] 기록 ${diag.recordedDays}/7일 · 트리거 있었던 날 ${diag.triggerDays}일 · 강도 평균 ${diag.avgIntensity} · 감정 빈도: ${diag.emotionText}
[진단 주간 원문]
${diagLines.join("\n") || "(아직 없음)"}

[확정한 If-Then 공식]
${formulasText}

[실행 구간 계산값] 기록 ${exec.recordedDays}일 · 강도 평균 ${exec.avgIntensity} (${exec.trendText}) · 공식 사용 추정 ${exec.formulaUsedDays}/${exec.formulaTotalDays}일 · 재발 총 ${exec.relapseCount}회
[실행 구간 원문]
${execLines.join("\n") || "(아직 없음)"}`;
  return `📥 리부트 챌린지 현황 조회 — ${label} (ID: ${discordUserId})\n(아래 메시지를 통째로 복사해서 Claude에 붙여넣으세요)\n──────────────────────────\n${instruction}`;
}

// ── Day 0 시작 (D+1 자동 발송 또는 !챌린지시작 재도전) ─────────────────────
async function startRebootChallengeDay0(discordUserId, member, attemptNumber) {
  const prev = getUser(discordUserId).rebootChallenge;
  const today = todayKST();

  // 이전 도전에서 운영자가 아직 전달 안 한 Day7/Day31 분석이 있는 채로 재도전이 시작되면,
  // 아래에서 상태를 통째로 초기화하면서 그 사실이 조용히 사라질 수 있습니다(전달 리마인더가
  // 새 도전의 필드를 보게 되기 때문). 초기화 직전에 한 번 더 운영자에게 짚어줍니다.
  if (prev) {
    if (prev.day7DigestSentAt && !prev.day7AnalysisSentAt) {
      await notifyOwnerText(
        `⚠️ ${member ? member.displayName : discordUserId}님이 이전 도전의 Day7 분석을 전달받기 전에 챌린지를 재시작했어요. "!챌린지현황"으로 이전 기록을 확인해서 놓치지 않게 챙겨주세요.`
      ).catch(() => {});
    }
    if (prev.day31DigestSentAt && !prev.day31AnalysisSentAt) {
      await notifyOwnerText(
        `⚠️ ${member ? member.displayName : discordUserId}님이 이전 도전의 최종(Day31) 분석을 전달받기 전에 챌린지를 재시작했어요. 이전 기록을 확인해서 놓치지 않게 챙겨주세요.`
      ).catch(() => {});
    }
  }

  updateUser(discordUserId, {
    rebootChallenge: {
      active: true,
      status: "pending_day0",
      attemptNumber,
      startDate: today,
      currentDay: 0,
      selfCompassionNote: null,
      awaitingCheckinReply: true,
      checkinPromptSentAt: new Date().toISOString(),
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
      day7GraceGiven: false,
      masterCrewGrantedAt: prev.masterCrewGrantedAt || null, // 최초 완주 여부는 재도전해도 유지
      completedAt: null,
      failedAt: null,
      optedOutAt: null,
      cooldownUntil: null,
    },
  });
  await safeDM(member, rebootDay0Message());
}

// ── 참가자 명령어: !챌린지시작 (재도전 / 옵트아웃 후 재개용. 최초 시작은 D+1 자동) ──
async function handleRebootStartCommand(message) {
  const discordUserId = message.author.id;
  const user = getUser(discordUserId);
  if (!user.ebookPurchased) {
    await message.reply(`이 챌린지는 전자책 구매자 전용이에요. 먼저 "구매"라고 보내서 전자책을 구매해주세요.`);
    return;
  }
  const rc = user.rebootChallenge;
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  const member = guild ? await guild.members.fetch(discordUserId).catch(() => null) : null;
  if (!member) {
    await message.reply("서버 멤버 정보를 찾을 수 없어요. 서버에 남아있는지 확인해주세요.");
    return;
  }
  if (["pending_day0", "in_progress"].includes(rc.status)) {
    await message.reply("이미 리부트 챌린지를 진행 중이에요! 매일 저녁 8시에 보내드리는 질문에 답해주세요.");
    return;
  }
  if (rc.status === "failed" && rc.cooldownUntil && todayKST() < rc.cooldownUntil) {
    await message.reply(`재도전은 ${rc.cooldownUntil}부터 가능해요. 조금만 더 기다려주세요.`);
    return;
  }
  await message.reply("좋아요, 지금부터 리부트 챌린지를 시작할게요! 👇");
  await startRebootChallengeDay0(discordUserId, member, (rc.attemptNumber || 0) + 1);
}

// ── SOS 키워드: Day0 자기 문장 즉시 소환 (사적인 도구, 헬퍼 알림 없음) ──────
async function handleRebootSosKeyword(message) {
  const user = getUser(message.author.id);
  const note = user.rebootChallenge && user.rebootChallenge.selfCompassionNote;
  if (note) {
    await message.reply(`🛬 적어두신 문장이에요:\n\n"${note}"\n\n지금 이 순간, 이거 하나면 충분해요.`);
  } else {
    await message.reply(
      `아직 적어두신 문장이 없어요. 리부트 챌린지를 시작하면 Day 0에서 그 문장을 적을 수 있어요.\n지금 당장은 — 잠깐 숨 한 번 크게 쉬어보세요. 이 순간은 지나가요.`
    );
  }
  const sosTriggers = [...(user.sosTriggers || []), { date: todayKST(), note: "(SOS 키워드로 자기 문장 소환)" }];
  updateUser(message.author.id, { sosTriggers });
}

// ── 완료 처리: 마스터-크루 승급(최초 완주 1회만) + Day31 다이제스트 발송 ────
async function finalizeRebootCompletion(discordUserId, member) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    const m = member || (guild ? await guild.members.fetch(discordUserId).catch(() => null) : null);
    const label = m ? m.displayName : discordUserId;

    const rc1 = getUser(discordUserId).rebootChallenge;
    if (!rc1.masterCrewGrantedAt) {
      if (m && !m.roles.cache.has(ROLE_ID_MASTER)) {
        await m.roles.add(ROLE_ID_MASTER).catch((e) => console.error("[역할부여 실패] 마스터-크루(챌린지 완주)", e));
        await safeDM(m, `🏆 30일 리부트 챌린지 완주로 마스터-크루로 승급했어요! 정말 대단해요.`);
        if (guild) await announcePromotion(guild, m, "마스터-크루");
      }
      const rc2 = getUser(discordUserId).rebootChallenge;
      updateUser(discordUserId, { rebootChallenge: { ...rc2, masterCrewGrantedAt: new Date().toISOString() } });
    }

    const rc3 = getUser(discordUserId).rebootChallenge;
    if (!rc3.day31DigestSentAt) {
      const prompt = buildDay31Prompt(discordUserId, label);
      await notifyOwnerText(prompt);
      const rc4 = getUser(discordUserId).rebootChallenge;
      updateUser(discordUserId, { rebootChallenge: { ...rc4, day31DigestSentAt: new Date().toISOString() } });
    }
  } catch (e) {
    console.error("[챌린지 완료 처리 오류]", e);
  }
}

// ── 참가자 DM 답장 처리 (Day 0/8/1~7/9~31 공통 진입점) ─────────────────────
// handlePendingDmReply에서 가장 먼저 호출됩니다. true를 반환하면 처리 완료(다른 파싱 생략).
async function handleRebootCheckinReply(message, content) {
  const discordUserId = message.author.id;
  const user = getUser(discordUserId);
  const rc = user.rebootChallenge;
  if (!rc || !rc.awaitingCheckinReply) return false;

  if (REBOOT_OPT_OUT_PHRASES.includes(content.trim())) {
    updateUser(discordUserId, {
      rebootChallenge: { ...rc, status: "opted_out", active: false, awaitingCheckinReply: false, optedOutAt: new Date().toISOString() },
    });
    await message.reply(
      `알겠어요, 더 이상 리부트 챌린지 메시지를 보내지 않을게요. 나중에 다시 하고 싶으시면 "${REBOOT_START_COMMAND}"라고 보내주세요.`
    );
    return true;
  }

  const day = rc.currentDay;
  const today = todayKST();
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  const member = guild ? await guild.members.fetch(discordUserId).catch(() => null) : null;
  const crisisDetected = !!detectCrisisLevel(content);

  if (day === 0) {
    updateUser(discordUserId, {
      rebootChallenge: { ...rc, selfCompassionNote: content.trim(), status: "in_progress", currentDay: 1, awaitingCheckinReply: false },
    });
    await message.reply(`적어주셔서 고마워요. 오늘 저녁 8시부터 매일 짧은 질문을 하나씩 드릴게요.${crisisDetected ? CRISIS_HOTLINE_NOTE : ""}`);
    appendRebootEvent({
      discordUserId,
      label: member ? member.displayName : discordUserId,
      type: "Day0 자기연민문장",
      day: 0,
      date: today,
      text: content.trim(),
      crisisDetected,
    }).catch(() => {});
    return true;
  }

  if (day === 8) {
    const formulas = parseRebootFormulas(content);
    updateUser(discordUserId, {
      rebootChallenge: { ...rc, formulas, currentDay: 9, awaitingCheckinReply: false },
    });
    await message.reply(
      `공식을 저장했어요! 내일부터 23일간 실제로 이 공식을 써보면서 기록해봐요.${crisisDetected ? CRISIS_HOTLINE_NOTE : ""}`
    );
    appendRebootEvent({
      discordUserId,
      label: member ? member.displayName : discordUserId,
      type: "Day8 If-Then공식",
      day: 8,
      date: today,
      text: content.trim(),
      crisisDetected,
    }).catch(() => {});
    return true;
  }

  // 콘텐츠 데이 (1~7, 9~31)
  const entries = [...(rc.entries || [])];
  entries.push({ day, date: today, rawText: content.trim(), createdAt: new Date().toISOString() });
  const coveredDays = [day];
  let pendingCatchupDay = rc.pendingCatchupDay;
  if (pendingCatchupDay) {
    entries.push({
      day: pendingCatchupDay,
      date: addDaysKST(today, -1),
      rawText: `(Day ${day} 답변과 함께 작성됨)\n${content.trim()}`,
      catchup: true,
      createdAt: new Date().toISOString(),
    });
    coveredDays.push(pendingCatchupDay);
    pendingCatchupDay = null;
  }

  const patch = { entries, pendingCatchupDay, awaitingCheckinReply: false };
  let replyText = "기록해뒀어요. 내일 저녁에 또 봬요!";

  if (day >= 9 && day <= 31 && rebootReplyIndicatesRelapse(content)) {
    replyText = rc.selfCompassionNote
      ? `기록해뒀어요.\n\n🛬 적어두신 문장이에요:\n\n"${rc.selfCompassionNote}"\n\n지금 이 순간, 이거 하나면 충분해요.`
      : "기록해뒀어요. 괜찮아요, 재발은 실패가 아니라 데이터예요.";
  }

  if (coveredDays.includes(6) && !rc.day6NotifiedAt) {
    patch.day6NotifiedAt = new Date().toISOString();
    await notifyOwnerText(
      `🔔 유저 ${member ? member.displayName : discordUserId}님이 6일차 작성을 완료했습니다.\n(내일이 진단 마지막 날(Day7)이에요 — 내일 저녁 답장 오는 즉시 분석 요청 프롬프트를 보내드릴게요)`
    );
  }
  if (coveredDays.includes(29) && !rc.day29NotifiedAt) {
    patch.day29NotifiedAt = new Date().toISOString();
    await notifyOwnerText(
      `🔔 유저 ${member ? member.displayName : discordUserId}님이 29일차 작성을 완료했습니다.\n(이제 이틀 뒤면 챌린지가 끝나요 — 완료되면 최종 분석 데이터를 보내드릴게요)`
    );
  }

  if (day === 7) {
    patch.currentDay = 8;
  } else if (day === 31) {
    patch.currentDay = 32;
    patch.status = "completed";
    patch.completedAt = new Date().toISOString();
    replyText = `🎉 30일 리부트 챌린지를 완주하셨어요! 정말 대단해요.\n최종 분석은 운영자가 확인 후 곧 DM으로 보내드릴게요.`;
  } else {
    patch.currentDay = day + 1;
  }

  if (crisisDetected) replyText += CRISIS_HOTLINE_NOTE;

  updateUser(discordUserId, { rebootChallenge: { ...rc, ...patch } });
  await message.reply(replyText);

  const labelForSheet = member ? member.displayName : discordUserId;
  appendRebootEvent({
    discordUserId,
    label: labelForSheet,
    type: "일반기록",
    day,
    date: today,
    text: content.trim(),
    crisisDetected,
  }).catch(() => {});
  if (coveredDays.length > 1) {
    const catchupDay = coveredDays[1];
    appendRebootEvent({
      discordUserId,
      label: labelForSheet,
      type: "캐치업기록",
      day: catchupDay,
      date: addDaysKST(today, -1),
      text: content.trim(),
      crisisDetected,
    }).catch(() => {});
  }

  if (day === 7) {
    // Day7 데이터가 모두 모였으니 운영자 분석 요청 프롬프트를 실시간으로 바로 보냅니다.
    // (기존엔 다음날 아침 9시 크론에서 보냈는데, sim님 요청으로 실시간 발송으로 변경 - 2026-09-14.
    //  runRebootMorningJob의 동일 체크는 이 실시간 발송이 실패했을 때(DM 오류 등) 대비한 안전망으로 남겨둡니다.)
    const prompt = buildDay7Prompt(discordUserId, member ? member.displayName : discordUserId);
    await notifyOwnerText(prompt);
    const fresh = getUser(discordUserId).rebootChallenge;
    updateUser(discordUserId, { rebootChallenge: { ...fresh, day7DigestSentAt: new Date().toISOString() } });
  }

  if (day === 31) {
    await finalizeRebootCompletion(discordUserId, member);
  }
  return true;
}

// ── 결번/캐치업 처리: 전날 프롬프트에 답이 없었을 때 (매일 저녁 크론에서 호출) ──
async function handleRebootMissedAndAdvance(discordUserId, member) {
  const user = getUser(discordUserId);
  const rc = user.rebootChallenge;
  if (!rc || rc.status !== "in_progress") return;
  const overdueDay = rc.currentDay;
  let missedDays = [...(rc.missedDays || [])];
  if (rc.pendingCatchupDay && !missedDays.includes(rc.pendingCatchupDay)) {
    missedDays.push(rc.pendingCatchupDay);
  }
  let pendingCatchupDay = overdueDay;

  const fail = async () => {
    const cooldownUntil = addDaysKST(todayKST(), REBOOT_COOLDOWN_DAYS);
    updateUser(discordUserId, {
      rebootChallenge: {
        ...getUser(discordUserId).rebootChallenge,
        status: "failed",
        missedDays,
        pendingCatchupDay: null,
        awaitingCheckinReply: false,
        failedAt: new Date().toISOString(),
        cooldownUntil,
      },
    });
    await safeDM(
      member,
      `😔 리부트 챌린지 — 3일 이상 기록을 남기지 못해 이번 도전은 여기서 마무리할게요.\n` +
        `괜찮아요, 실패가 아니라 데이터예요. ${cooldownUntil}부터 "${REBOOT_START_COMMAND}"라고 보내시면 처음부터 다시 도전하실 수 있어요.`
    );
    await notifyOwnerText(
      `⚠️ ${member ? member.displayName : discordUserId}님이 리부트 챌린지에 실패했어요 (결번 3회 누적, ${cooldownUntil}부터 재도전 가능).`
    );
  };

  if (missedDays.length >= 3) {
    await fail();
    return;
  }

  if (overdueDay === 31) {
    updateUser(discordUserId, {
      rebootChallenge: {
        ...getUser(discordUserId).rebootChallenge,
        status: "completed",
        missedDays,
        pendingCatchupDay: null,
        awaitingCheckinReply: false,
        completedAt: new Date().toISOString(),
      },
    });
    await safeDM(
      member,
      `30일 리부트 챌린지 기간이 끝났어요. 며칠 결번이 있었지만 여기까지 오신 것만으로도 대단해요. 최종 분석은 운영자가 확인 후 곧 보내드릴게요.`
    );
    await finalizeRebootCompletion(discordUserId, member);
    return;
  }

  // Day7 → Day8(게이트)은 형식이 달라서 다른 날짜처럼 buildRebootNightlyPrompt로
  // 자연스럽게 합쳐 보낼 수 없습니다. 그래도 다른 날짜와 동일하게 "하루 유예"를 주기
  // 위해, 처음 놓친 저녁에는 결번 확정 없이 Day7 질문을 한 번 더 보내고 하루 더 기다립니다.
  // (유예 없이 바로 다음 로직으로 가면, phase가 다르다는 이유로 다른 날짜와 달리
  //  Day7만 첫날 저녁에 바로 결번 처리돼버립니다.)
  if (overdueDay === 7 && !rc.day7GraceGiven) {
    await safeDM(
      member,
      rebootDay1to7Message(7) +
        `\n\n(어제 답장이 없어서 다시 보내드려요 — 오늘 저녁까지 답장해주시면 결번 처리 안 돼요.)`
    );
    updateUser(discordUserId, {
      rebootChallenge: {
        ...getUser(discordUserId).rebootChallenge,
        missedDays,
        pendingCatchupDay: null,
        day7GraceGiven: true,
        awaitingCheckinReply: true,
        checkinPromptSentAt: new Date().toISOString(),
        reminderSentToday: false,
      },
    });
    return;
  }

  const nextDay = overdueDay === 7 ? 8 : overdueDay + 1;
  const nextPhase = rebootPhase(nextDay);
  let gateNote = "";

  // 다음 프롬프트가 형식이 다른 구간(특히 Day8 게이트)이면 캐치업을 더 들고 있을 수 없으니
  // 여기서 결번으로 확정합니다 (1일 유예는 같은 형식 구간 안에서만 의미가 있어요.
  // Day7은 위에서 이미 한 번 유예를 줬기 때문에 여기로 내려오면 확정 처리합니다).
  if (rebootPhase(pendingCatchupDay) !== nextPhase) {
    if (!missedDays.includes(pendingCatchupDay)) {
      missedDays.push(pendingCatchupDay);
      gateNote = `\n(참고: Day ${pendingCatchupDay} 기록이 없어서 결번 처리했어요)`;
    }
    pendingCatchupDay = null;
    if (missedDays.length >= 3) {
      await fail();
      return;
    }
  }

  const promptText = nextDay === 8 ? rebootDay8Message() + gateNote : buildRebootNightlyPrompt(nextDay, pendingCatchupDay);

  await safeDM(member, promptText);
  updateUser(discordUserId, {
    rebootChallenge: {
      ...getUser(discordUserId).rebootChallenge,
      missedDays,
      pendingCatchupDay,
      currentDay: nextDay,
      day7GraceGiven: false,
      awaitingCheckinReply: true,
      checkinPromptSentAt: new Date().toISOString(),
      reminderSentToday: false,
    },
  });
}

// ── 09시: D+1 자동 시작 스캔 + Day7→8 분석 다이제스트 발송 ─────────────────
async function runRebootMorningJob() {
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return;
  const members = await guild.members.fetch();
  const now = new Date();

  for (const member of members.values()) {
    if (member.user.bot) continue;
    const user = getUser(member.id);
    if (!user.ebookPurchased || !user.ebookPurchasedAt) continue;
    const rc = user.rebootChallenge;

    if (!rc.status) {
      const daysSincePurchase = daysBetween(new Date(user.ebookPurchasedAt), now);
      if (daysSincePurchase >= 1) {
        await startRebootChallengeDay0(member.id, member, (rc.attemptNumber || 0) + 1).catch((e) =>
          console.error("[챌린지 자동시작 오류]", e)
        );
      }
      continue;
    }

    // 원래 발송 지점은 여기(아침 9시)였는데, 이제는 handleRebootCheckinReply에서
    // Day7 답장이 오는 즉시 실시간으로 보냅니다. 이 블록은 그 실시간 발송이 어떤 이유로든
    // 실패했을 때(예: 그 순간 DM 전송 오류) 다음날 아침에 놓치지 않고 다시 시도하는 안전망입니다.
    if (rc.status === "in_progress" && rc.currentDay === 8 && !rc.day7DigestSentAt) {
      const prompt = buildDay7Prompt(member.id, member.displayName);
      await notifyOwnerText(prompt);
      const fresh = getUser(member.id).rebootChallenge;
      updateUser(member.id, { rebootChallenge: { ...fresh, day7DigestSentAt: new Date().toISOString() } });
    }
  }
}

// ── 20시: 매일 프롬프트 발송 (게이트 재알림 / 정상 발송 / 결번 처리) ──────────
async function runRebootEveningJob() {
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return;
  const members = await guild.members.fetch();

  for (const member of members.values()) {
    if (member.user.bot) continue;
    const user = getUser(member.id);
    const rc = user.rebootChallenge;
    if (!rc || !["pending_day0", "in_progress"].includes(rc.status)) continue;

    if (rc.currentDay === 0 || rc.currentDay === 8) {
      if (rc.awaitingCheckinReply) {
        const text = rc.currentDay === 0 ? rebootDay0Message() : rebootDay8Message();
        await safeDM(member, `(다시 안내드려요)\n\n${text}`);
        const fresh = getUser(member.id).rebootChallenge;
        updateUser(member.id, { rebootChallenge: { ...fresh, checkinPromptSentAt: new Date().toISOString(), reminderSentToday: false } });
      }
      continue;
    }

    if (!rc.awaitingCheckinReply) {
      const text = buildRebootNightlyPrompt(rc.currentDay, rc.pendingCatchupDay);
      await safeDM(member, text);
      const fresh = getUser(member.id).rebootChallenge;
      updateUser(member.id, {
        rebootChallenge: { ...fresh, awaitingCheckinReply: true, checkinPromptSentAt: new Date().toISOString(), reminderSentToday: false },
      });
    } else {
      await handleRebootMissedAndAdvance(member.id, member).catch((e) => console.error("[챌린지 결번처리 오류]", e));
    }
  }
}

// ── 22시: 오늘 프롬프트에 아직 답 안 한 사람에게 리마인더 1회 ────────────────
async function runRebootReminderJob() {
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return;
  const members = await guild.members.fetch();
  const today = todayKST();

  for (const member of members.values()) {
    if (member.user.bot) continue;
    const user = getUser(member.id);
    const rc = user.rebootChallenge;
    if (!rc || !["pending_day0", "in_progress"].includes(rc.status)) continue;
    if (!rc.awaitingCheckinReply || rc.reminderSentToday || !rc.checkinPromptSentAt) continue;
    const sentDate = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(rc.checkinPromptSentAt));
    if (sentDate !== today) continue;
    await safeDM(member, "⏰ 아직 오늘 리부트 챌린지 기록을 안 하셨어요. 2분이면 끝나요 — 위 형식대로 답장 주세요.");
    const fresh = getUser(member.id).rebootChallenge;
    updateUser(member.id, { rebootChallenge: { ...fresh, reminderSentToday: true } });
  }
}

// ── 운영자가 아직 참가자에게 전달 안 한 Day7/Day31 분석이 있으면 리마인드 ──────
// 디스코드 봇은 DM "읽음 여부"를 알 수 없어서, "!챌린지분석으로 아직 전달 안 함"을
// 기준으로 삼습니다. 새 크론을 따로 만들지 않고 기존 하루 3번 체크 타이밍
// (아침 9시 / 저녁 8시 / 밤 10시)에 끼워 넣어서, 해결될 때까지 계속 알림이 갑니다.
// (sim님 요청, 2026-09-14)
async function checkPendingRebootOwnerActions() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild) return;
    const ids = allUserIds();
    const pending = [];
    for (const id of ids) {
      const rc = getUser(id).rebootChallenge;
      if (!rc) continue;
      if (rc.day7DigestSentAt && !rc.day7AnalysisSentAt) pending.push({ id, phase: "Day7" });
      if (rc.day31DigestSentAt && !rc.day31AnalysisSentAt) pending.push({ id, phase: "Day31 최종" });
    }
    if (!pending.length) return;
    const lines = [];
    for (const p of pending) {
      const m = await guild.members.fetch(p.id).catch(() => null);
      const label = m ? m.displayName : p.id;
      lines.push(`- ${label} (${p.phase}) → ${REBOOT_ANALYSIS_COMMAND} ${p.id} <분석 내용>`);
    }
    await notifyOwnerText(
      `⏰ 아직 참가자에게 전달 안 된 챌린지 분석이 있어요:\n${lines.join("\n")}\n\n위 형식대로 봇에게 DM 보내시면 바로 전달돼요.`
    );
  } catch (e) {
    console.error("[챌린지 분석 리마인더 오류]", e);
  }
}

function scheduleRebootChallengeJobs() {
  cron.schedule(
    REBOOT_MORNING_CRON,
    () => {
      runRebootMorningJob().catch((e) => console.error("[리부트챌린지 아침 작업 오류]", e));
      checkPendingRebootOwnerActions().catch((e) => console.error("[챌린지 분석 리마인더 오류]", e));
    },
    { timezone: TZ }
  );
  cron.schedule(
    REBOOT_PROMPT_CRON,
    () => {
      runRebootEveningJob().catch((e) => console.error("[리부트챌린지 저녁 발송 오류]", e));
      checkPendingRebootOwnerActions().catch((e) => console.error("[챌린지 분석 리마인더 오류]", e));
    },
    { timezone: TZ }
  );
  cron.schedule(
    REBOOT_REMINDER_CRON,
    () => {
      runRebootReminderJob().catch((e) => console.error("[리부트챌린지 리마인더 오류]", e));
      checkPendingRebootOwnerActions().catch((e) => console.error("[챌린지 분석 리마인더 오류]", e));
    },
    { timezone: TZ }
  );
  console.log(
    `[예약 등록] 리부트 챌린지 cron: 아침 "${REBOOT_MORNING_CRON}" / 저녁 "${REBOOT_PROMPT_CRON}" / 리마인더 "${REBOOT_REMINDER_CRON}" (${TZ})`
  );
}

// ── 운영자 명령어: !챌린지분석 @유저 <내용> (참가자에게 최종 분석 전달) ──────
async function handleRebootAnalysisCommand(message, content) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild || guild.ownerId !== message.author.id) {
      await message.reply("이 명령어는 서버 운영자만 사용할 수 있어요.");
      return;
    }
    const mentioned = message.mentions.users.first();
    let rest = content.slice(REBOOT_ANALYSIS_COMMAND.length).trim();
    let targetUser = mentioned;
    if (mentioned) {
      rest = rest.replace(/^<@!?\d+>\s*/, "").trim();
    } else {
      const idMatch = rest.match(/^(\d{15,25})\s*/);
      if (idMatch) {
        targetUser = await client.users.fetch(idMatch[1]).catch(() => null);
        rest = rest.slice(idMatch[0].length).trim();
      }
    }
    if (!targetUser || !rest) {
      await message.reply(`사용법: ${REBOOT_ANALYSIS_COMMAND} @유저 <참가자에게 보낼 분석 내용>`);
      return;
    }
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      await message.reply("서버에서 그 유저를 찾지 못했어요.");
      return;
    }
    await safeDM(targetMember, `📊 리부트 챌린지 분석 결과예요\n\n${rest}`);
    const u = getUser(targetUser.id);
    const rc = u.rebootChallenge;
    // Day31(최종) 다이제스트가 이미 갔는데 아직 전달 전이면 이번 건 Day31로, 아니면 기존처럼 Day7로 기록합니다.
    // (리마인더 기능이 어느 항목이 처리됐는지 정확히 추적하려면 이 구분이 필요해요.)
    const isDay31 = !!(rc.day31DigestSentAt && !rc.day31AnalysisSentAt);
    const patch = isDay31
      ? { day31AnalysisSentAt: new Date().toISOString() }
      : { day7AnalysisSentAt: new Date().toISOString() };
    updateUser(targetUser.id, { rebootChallenge: { ...rc, ...patch } });
    await message.reply(`✅ ${targetMember.displayName}님에게 ${isDay31 ? "Day31 최종" : "Day7"} 분석 내용을 전달했어요.`);
  } catch (e) {
    console.error("[챌린지 분석 전달 오류]", e);
    await message.reply("분석 내용을 전달하는 중 오류가 발생했어요.");
  }
}

// ── 운영자 명령어: !챌린지현황 @유저 (언제든 즉시 복붙용 프롬프트로 조회) ────
async function handleRebootStatusCommand(message, content) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild || guild.ownerId !== message.author.id) {
      await message.reply("이 명령어는 서버 운영자만 사용할 수 있어요.");
      return;
    }
    const targetUser = await resolveMentionedUser(message, content, REBOOT_STATUS_COMMAND, guild);
    if (!targetUser) {
      await message.reply(`사용법: ${REBOOT_STATUS_COMMAND} @유저 (또는 유저ID)`);
      return;
    }
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
    const label = targetMember ? targetMember.displayName : targetUser.tag || targetUser.username;
    const prompt = buildStatusPrompt(targetUser.id, label);
    await message.reply(prompt);
  } catch (e) {
    console.error("[챌린지 현황 조회 오류]", e);
    await message.reply("현황 조회 중 오류가 발생했어요.");
  }
}

// ── 운영자 명령어: !챌린지통계 (완주율·Day7/Day31 분석 전달률을 한눈에) ─────────
// "가격만큼 가치를 실제로 전달하고 있는가"는 콘텐츠가 아니라 실행(=분석이 빠짐없이
// 전달됐는가)으로 확인해야 한다는 판단 하에 추가. 참가자별 rebootChallenge 상태를
// 전수 집계해서, 시작 대비 완주율과 Day7/Day31 분석 전달률(=약속한 사람 손길이
// 실제로 도달한 비율)을 바로 보여줍니다. 새 저장소를 만들지 않고 기존 data.json에
// 이미 있는 값만 집계하므로, 정확도는 lib/store.js의 rebootChallenge 필드에 그대로 의존합니다.
async function handleRebootStatsCommand(message) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild || guild.ownerId !== message.author.id) {
      await message.reply("이 명령어는 서버 운영자만 사용할 수 있어요.");
      return;
    }

    const ids = allUserIds();
    let started = 0;
    const byStatus = { pending_day0: 0, in_progress: 0, completed: 0, failed: 0, opted_out: 0, 기타: 0 };
    let day7DigestSent = 0,
      day7AnalysisSent = 0,
      day31DigestSent = 0,
      day31AnalysisSent = 0;
    const pendingList = [];

    for (const id of ids) {
      const rc = getUser(id).rebootChallenge;
      if (!rc || (!rc.attemptNumber && !rc.status)) continue;
      started++;
      if (rc.status && byStatus[rc.status] !== undefined) byStatus[rc.status]++;
      else byStatus["기타"]++;

      if (rc.day7DigestSentAt) day7DigestSent++;
      if (rc.day7AnalysisSentAt) day7AnalysisSent++;
      if (rc.day31DigestSentAt) day31DigestSent++;
      if (rc.day31AnalysisSentAt) day31AnalysisSent++;

      if (rc.day7DigestSentAt && !rc.day7AnalysisSentAt) pendingList.push({ id, phase: "Day7" });
      if (rc.day31DigestSentAt && !rc.day31AnalysisSentAt) pendingList.push({ id, phase: "Day31" });
    }

    const pct = (num, den) => (den > 0 ? `${((num / den) * 100).toFixed(0)}%` : "해당없음");

    const lines = [
      `📊 챌린지 통계 (전체 참가 이력 기준, 시작 ${started}명)`,
      "",
      `상태별 — 진행중 ${byStatus.in_progress} / 완주 ${byStatus.completed} / 실패(중단) ${byStatus.failed} / 대기(Day0) ${byStatus.pending_day0} / 스스로 중단 ${byStatus.opted_out}`,
      `완주율 = 완주 ${byStatus.completed} / 시작 ${started} = ${pct(byStatus.completed, started)}`,
      "",
      `Day7 분석 전달률 = 전달 ${day7AnalysisSent} / 대상 ${day7DigestSent} = ${pct(day7AnalysisSent, day7DigestSent)}`,
      `Day31 분석 전달률 = 전달 ${day31AnalysisSent} / 대상 ${day31DigestSent} = ${pct(day31AnalysisSent, day31DigestSent)}`,
    ];

    if (pendingList.length) {
      const detail = [];
      for (const p of pendingList) {
        const m = await guild.members.fetch(p.id).catch(() => null);
        detail.push(`- ${m ? m.displayName : p.id} (${p.phase})`);
      }
      lines.push("", `⏳ 아직 분석 못 받은 ${pendingList.length}명:`, ...detail);
    } else if (day7DigestSent + day31DigestSent > 0) {
      lines.push("", "✅ 밀린 분석 없음 — 대상자 전원에게 전달 완료된 상태예요.");
    }

    await message.reply(lines.join("\n"));
  } catch (e) {
    console.error("[챌린지 통계 조회 오류]", e);
    await message.reply("통계 집계 중 오류가 발생했어요.");
  }
}

// ── 운영자 명령어: !챌린지시트백필 (구글시트 연동이 안 되던 동안 쌓인 기록을 한 번에 채워넣기) ──
// 구글시트 연동 자체가 코드 버그로 계속 실패하고 있었지만, 참가자 기록은 항상 데이터
// 저장소(data.json)에 먼저 남고 그 다음에 시트 기록을 "덤으로" 시도하는 구조였어서,
// 이 명령어로 지금까지의 기록을 한 번에 시트로 다시 보낼 수 있습니다. 몇 번을 실행해도
// 안전하도록 매번 전체를 다시 보내는 방식이라, 시트에 중복 행이 쌓일 수 있는 점은 감안해주세요
// (필요하면 시트에서 중복 행만 걸러내면 됩니다).
async function handleRebootSheetBackfillCommand(message) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild || guild.ownerId !== message.author.id) {
      await message.reply("이 명령어는 서버 운영자만 사용할 수 있어요.");
      return;
    }
    if (!isSheetsConfigured()) {
      await message.reply(
        "구글시트 연동 환경변수(REBOOT_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)가 설정 안 돼 있어서 백필을 진행할 수 없어요."
      );
      return;
    }
    await message.reply("백필을 시작할게요. 기록량에 따라 시간이 좀 걸릴 수 있어요 — 끝나면 결과를 알려드릴게요.");

    const ids = allUserIds();
    let userCount = 0;
    let rowCount = 0;
    for (const id of ids) {
      const u = getUser(id);
      const rc = u.rebootChallenge;
      if (!rc || (!rc.selfCompassionNote && !(rc.entries && rc.entries.length) && !(rc.formulas && rc.formulas.length))) {
        continue;
      }
      const member = await guild.members.fetch(id).catch(() => null);
      const label = member ? member.displayName : id;
      let touched = false;

      if (rc.selfCompassionNote) {
        const text = rc.selfCompassionNote;
        await appendRebootEvent({
          discordUserId: id,
          label,
          type: "Day0 자기연민문장(백필)",
          day: 0,
          date: rc.startDate || "",
          text,
          crisisDetected: !!detectCrisisLevel(text),
        });
        rowCount++;
        touched = true;
      }

      for (const entry of rc.entries || []) {
        await appendRebootEvent({
          discordUserId: id,
          label,
          type: entry.catchup ? "캐치업기록(백필)" : "일반기록(백필)",
          day: entry.day,
          date: entry.date,
          text: entry.rawText,
          crisisDetected: !!detectCrisisLevel(entry.rawText),
        });
        rowCount++;
        touched = true;
      }

      if (rc.formulas && rc.formulas.length) {
        const text = rc.formulas.join("\n");
        await appendRebootEvent({
          discordUserId: id,
          label,
          type: "Day8 If-Then공식(백필, 재구성됨)",
          day: 8,
          date: rc.startDate ? addDaysKST(rc.startDate, 8) : "",
          text,
          crisisDetected: false,
        });
        rowCount++;
        touched = true;
      }

      if (touched) userCount++;
    }

    await message.reply(`✅ 백필 완료: 참가자 ${userCount}명, 총 ${rowCount}행을 시트에 다시 기록했어요.`);
  } catch (e) {
    console.error("[챌린지 시트 백필 오류]", e);
    await message.reply("백필 중 오류가 발생했어요. 로그를 확인해주세요.");
  }
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

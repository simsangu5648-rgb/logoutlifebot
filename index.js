require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} = require("discord.js");
const cron = require("node-cron");
const { getUser, updateUser, allUserIds } = require("./lib/store");

const {
  DISCORD_TOKEN,
  GUILD_ID,
  ROLE_ID_REBOOT,
  ROLE_ID_GROW,
  ROLE_ID_MASTER,
  ROLE_ID_FREE,
  TRACK_CHANNEL_NAMES,
  THRESHOLD_GROW,
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

const T_GROW = parseInt(THRESHOLD_GROW || "7", 10);
const T_MASTER = parseInt(THRESHOLD_MASTER || "30", 10);
const TZ = TIMEZONE || "Asia/Seoul";

// ── 즉시반응 시스템 (#충동-sos) ─────────────────────────────────
const SOS_CHANNEL_NAME = process.env.SOS_CHANNEL_NAME || "충동-sos";
const SOS_REACT_EMOJI = process.env.SOS_REACT_EMOJI || "🫂";
const HELPER_NOTIFY_COUNT = parseInt(process.env.HELPER_NOTIFY_COUNT || "3", 10);
const HELPER_ACTIVE_WITHIN_DAYS = parseInt(process.env.HELPER_ACTIVE_WITHIN_DAYS || "3", 10);
const HELPER_NOTIFY_COOLDOWN_HOURS = parseInt(process.env.HELPER_NOTIFY_COOLDOWN_HOURS || "6", 10);

// ── 데일리 스트릭 대시보드 ─────────────────────────────────
const STREAK_CHANNEL_NAME = process.env.STREAK_CHANNEL_NAME || "나의-그래프";
const STREAK_COMMAND = process.env.STREAK_COMMAND || "!기록";

// ── 승급 알림 & 배지 시스템 ────────────────────────────────
const ANNOUNCE_CHANNEL_NAME = process.env.ANNOUNCE_CHANNEL_NAME || "자유수다";

// ── 멘토 하이라이트 시스템 ─────────────────────────────────
const HELPER_THANKS_EMOJI = process.env.HELPER_THANKS_EMOJI || "🙏";
const HONOR_CHANNEL_NAME = process.env.HONOR_CHANNEL_NAME || "명예의-전당";

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
  scheduleDailyJob();
  scheduleStreakReminderJob();
  scheduleWeeklyHighlightJob();
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

    // DM 명령어 처리 (승급 공개 알림 옵트아웃/인)
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
      }
      return;
    }

    if (message.guild.id !== GUILD_ID) return;

    // 즉시반응 시스템: #충동-sos
    if (message.channel.name === SOS_CHANNEL_NAME) {
      await safeReact(message, SOS_REACT_EMOJI);
      notifyHelpers(message).catch((e) => console.error("[SOS 헬퍼 알림 오류]", e));
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

    // 데일리 스트릭 계산
    let newStreak;
    if (!user.lastCheckInDate) {
      newStreak = 1;
    } else {
      const last = new Date(user.lastCheckInDate + "T00:00:00+09:00");
      const gap = daysBetween(last, new Date(today + "T00:00:00+09:00"));
      newStreak = gap === 1 ? (user.currentStreak || 0) + 1 : 1;
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
    });
    await safeReact(message, "✅");

    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return;

    if (newCount >= T_GROW && !member.roles.cache.has(ROLE_ID_GROW)) {
      await member.roles.add(ROLE_ID_GROW).catch((e) => console.error("[역할부여 실패] 그로우-크루", e));
      await safeDM(
        member,
        `축하해요! 누적 ${newCount}회 기록을 달성해서 그로우-크루로 승급했어요. #그로우-라운지 채널이 열렸습니다.`
      );
      await announcePromotion(message.guild, member, "그로우-크루");
    }

    if (newCount >= T_MASTER && !member.roles.cache.has(ROLE_ID_MASTER)) {
      await member.roles.add(ROLE_ID_MASTER).catch((e) => console.error("[역할부여 실패] 마스터-크루", e));
      await safeDM(
        member,
        `축하해요! 누적 ${newCount}회 기록을 달성해서 마스터-크루로 승급했어요. #마스터-크루, #우선질문 채널이 열렸습니다.`
      );
      await announcePromotion(message.guild, member, "마스터-크루");
    }
  } catch (err) {
    console.error("[messageCreate 처리 오류]", err);
  }
});

// ── 즉시반응 시스템: 최근 활동한 그로우/마스터-크루에게 조용히 알림 ──
async function notifyHelpers(message) {
  const guild = message.guild;
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
          `가입한 지 일주일이에요. 지금까지 누적 인증 ${user.cumulativeCount}회 하셨어요. 이 페이스면 곧 그로우-크루예요, 계속 가봐요!`
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

    // 4) 결제전환 시퀀스 (D+25/27/29/30) - 아직 유료 등급이 아닌 사람만
    const isPaid = member.roles.cache.has(ROLE_ID_GROW) || member.roles.cache.has(ROLE_ID_MASTER);
    if (isPaid) continue;
    if (!member.joinedAt) continue;

    const daysSinceJoin = daysBetween(member.joinedAt, now);

    if (daysSinceJoin === 25 && !user.dmFlags.d25) {
      await safeDM(
        member,
        `지금까지 쌓은 기록을 정리해봤어요.\n누적 인증 ${user.cumulativeCount}회, 현재 등급: 무료멤버.\n꾸준히 잘 해오고 계세요!`
      );
      markDmSent(member.id, "d25");
    } else if (daysSinceJoin === 27 && !user.dmFlags.d27) {
      await safeDM(
        member,
        `그로우-크루/마스터-크루가 되면 #그로우-라운지, #마스터-크루 같은 전용 공간이 열려요. 지금까지의 기록이 아깝지 않게, 한번 둘러보세요.`
      );
      markDmSent(member.id, "d27");
    } else if (daysSinceJoin === 29 && !user.dmFlags.d29) {
      await safeDM(
        member,
        `내일이면 무료 체험 30일이 끝나요. 구독하지 않으면 지금까지 쌓아온 누적 기록과 등급이 초기화돼요.`
      );
      markDmSent(member.id, "d29");
    } else if (daysSinceJoin === 30 && !user.dmFlags.d30) {
      await safeDM(
        member,
        `지금까지의 기록을 이어가세요 👉 ${PAYMENT_LINK || "(결제 링크 미설정)"}`
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

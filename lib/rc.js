// REBOOT 30 — 전자책 구매자 전용 폼 기반 30일 챌린지의 서버 로직.
//  · 공용 비밀 링크(/join/<토큰>) → 디스코드 로그인(OAuth) → 서버 입장 + 리부트-크루 + 챌린지 즉시 시작
//  · 참가자별 개인 주소(/c/<토큰>)에서 하루 한 장씩 폼 작성 → 제출하면 운영자에게 전달
//  · 운영자는 /admin 웹페이지에서 확인하고 답장(→ 봇이 DM 전달), 하루 요약 DM만 받음(위기 신호는 즉시)
// index.js와는 hooks 객체로만 연결됩니다(디스코드 의존 코드는 index.js 쪽에 둡니다).

const crypto = require("crypto");
const store = require("./rc-store");
const R = require("./rc-render");
const { DAYS, BY_NUM, DAILY_FIELDS, MIN_FIELDS, SCREENING_SIGNS } = require("./rc-content");

const { esc, nl2br, layout } = R;

// ── 날짜 도우미 (한국 시간 기준 YYYY-MM-DD) ─────────────────────
function todayKST(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function addDays(ymd, n) {
  return new Date(Date.parse(ymd + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}
function diffDays(a, b) {
  return Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);
}
// 가입한 날이 Day 1입니다(Day 0은 날짜와 무관하게 먼저 하는 시작 전 체크).
function currentDay(p, today = todayKST()) {
  return Math.max(0, diffDays(today, p.startDate) + 1);
}

const sub = (p, n) => (p.days[n] && p.days[n].submittedAt ? p.days[n] : null);
const ansOf = (p, n, id) => {
  const e = sub(p, n);
  return e && e.answers ? e.answers[id] : undefined;
};
const str = (v) => (typeof v === "string" ? v.trim() : "");
const fmtFormula = (f) => (f && (str(f.if) || str(f.then)) ? `IF ${str(f.if)} → THEN ${str(f.then)}` : "");

// ── 답변 정리/검증 (서버는 클라이언트 값을 믿지 않습니다) ────────────
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const clip = (v, n) => (typeof v === "string" ? v.replace(CTRL, "").slice(0, n) : "");

function fieldsFor(day, mode) {
  if (mode === "min" && day.n >= 1) return MIN_FIELDS;
  return day.fields.concat(day.daily ? DAILY_FIELDS : []);
}

function sanitizeAnswers(day, mode, raw) {
  const out = {};
  const src = raw && typeof raw === "object" ? raw : {};
  for (const f of fieldsFor(day, mode)) {
    if (!f.id || f.type === "note" || f.type === "auto") continue;
    const v = src[f.id];
    switch (f.type) {
      case "text":
        out[f.id] = clip(v, 500);
        break;
      case "textarea":
        out[f.id] = clip(v, 8000);
        break;
      case "number": {
        const d = clip(String(v == null ? "" : v), 6).replace(/[^\d]/g, "").slice(0, 3);
        out[f.id] = d;
        break;
      }
      case "radio":
        out[f.id] = typeof v === "string" && f.options.includes(v) ? v : "";
        break;
      case "scale":
        out[f.id] = typeof v === "string" && /^(10|[0-9])$/.test(v) ? v : "";
        break;
      case "checks":
        out[f.id] = Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string" && f.options.includes(x)))] : [];
        break;
      case "table": {
        const tb = {};
        const sv = v && typeof v === "object" ? v : {};
        for (const rl of f.rows) {
          const row = sv[rl] && typeof sv[rl] === "object" ? sv[rl] : {};
          const o = {};
          for (const c of f.cols) {
            const cv = row[c.key];
            if (c.type === "select") o[c.key] = typeof cv === "string" && c.options.includes(cv) ? cv : "";
            else o[c.key] = clip(cv, 500);
          }
          tb[rl] = o;
        }
        out[f.id] = tb;
        break;
      }
      case "formula": {
        const sv = v && typeof v === "object" ? v : {};
        out[f.id] = { if: clip(sv.if, 500), then: clip(sv.then, 500) };
        break;
      }
      default:
        break;
    }
  }
  if (day.n === 0) out.__consent = src.__consent === true;
  return out;
}

function isEmptyVal(v) {
  if (v == null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.values(v).every(isEmptyVal);
  return false;
}
function hasContent(a) {
  return Object.keys(a).some((k) => k !== "__consent" && !isEmptyVal(a[k]));
}

// 사람이 읽을 수 있는 모든 자유 입력 텍스트(위기 키워드 검사용)
function freeTexts(a) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) return; // 선택지 값은 검사하지 않음
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  Object.values(a).forEach(walk);
  return out;
}

const CRISIS_WORDS = [
  "죽고싶", "죽을래", "죽어버", "죽는게나", "죽을것같", "자살", "자해", "극단적선택", "살기싫",
  "살고싶지않", "사라지고싶", "없어지고싶", "다끝내고싶", "다포기하고싶", "더는못버티", "뛰어내렸",
];
function findCrisis(a, day) {
  const hits = [];
  for (const t of freeTexts(a)) {
    const s = t.replace(/\s+/g, "");
    if (CRISIS_WORDS.some((w) => s.includes(w))) hits.push(t.slice(0, 200));
  }
  // Day 0 안전 체크: 2~4번째 항목(우울·자해 관련)에 체크하면 위기 신호로 봅니다.
  if (day.n === 0) {
    const chosen = Array.isArray(a.screening) ? a.screening : [];
    SCREENING_SIGNS.forEach((sg, i) => {
      if ([1, 2, 3].includes(i) && chosen.includes(sg)) hits.push("[안전 체크] " + sg);
    });
  }
  return hits;
}

// ── 자동 모아보기 계산 ────────────────────────────────────────
function submittedDays(p, from = 1, to = 30) {
  const out = [];
  for (let n = from; n <= to; n++) if (sub(p, n)) out.push(n);
  return out;
}

function countsOf(p, from, to) {
  const c = { recorded: 0, ifCame: 0, noticed: 0, started: 0, done: 0, fell: 0, missedAfter: 0 };
  for (let n = from; n <= to; n++) {
    const e = sub(p, n);
    if (!e) continue;
    c.recorded++;
    const a = e.answers || {};
    if (a.d_fell === "있었다" || a.m_fell === "있었다") c.fell++;
    if (e.mode === "min") continue;
    if (a.d_if === "왔다" || a.d_if === "지나가고 나서 알았다") c.ifCame++;
    if (a.d_if === "왔다") c.noticed++;
    if (a.d_if === "지나가고 나서 알았다") c.missedAfter++;
    if (a.d_then === "끝까지" || a.d_then === "일부") c.started++;
    if (a.d_then === "끝까지") c.done++;
  }
  return c;
}

// 돌아온 횟수 = 하루 이상 쉬었다가 기록하러 온 횟수 + 무너진 날 다음에 기록하러 온 횟수
function returnsOf(p, upToDay = 30) {
  const list = [];
  for (let n = 1; n <= upToDay; n++) {
    const e = sub(p, n);
    if (!e) continue;
    const a = e.answers || {};
    list.push({ n, date: e.date || e.submittedAt.slice(0, 10), fell: a.d_fell === "있었다" || a.m_fell === "있었다" });
  }
  list.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.n - y.n));
  let r = 0;
  for (let i = 1; i < list.length; i++) {
    const gap = diffDays(list[i].date, list[i - 1].date);
    if (gap >= 2 || (gap >= 1 && list[i - 1].fell)) r++;
  }
  return r;
}

// 지금 쓰고 있는 공식들(Day 8 확정 → Day 11 조정 → Day 13/19/20 추가, Day 23 교체 반영)
function currentFormulas(p) {
  const list = [];
  const base = fmtFormula(ansOf(p, 11, "formula")) || fmtFormula(ansOf(p, 8, "formula"));
  if (base) list.push(base);
  const d15 = sub(p, 15);
  if (d15 && (str(d15.answers.if) || str(d15.answers.then1))) {
    const s = `IF ${str(d15.answers.if)} → THEN ${str(d15.answers.then1)}${str(d15.answers.then2) ? ` (백업: ${str(d15.answers.then2)})` : ""}`;
    if (!list.length) list.push(s);
    else list[0] = s;
  }
  for (const n of [13, 19, 20]) {
    const f = fmtFormula(ansOf(p, n, "formula"));
    if (f) list.push(f);
  }
  const n23 = str(ansOf(p, 23, "oneline"));
  if (n23) list.push(n23);
  return list;
}

function daySummary(p, n) {
  const e = sub(p, n);
  if (!e) return "";
  const a = e.answers || {};
  if (e.mode === "min") {
    return `(한 줄 기록) 충동 ${a.m_urge || "-"}${str(a.m_when) ? " · " + str(a.m_when) : ""}`;
  }
  const j = (...xs) => xs.filter(Boolean).join(" · ");
  switch (n) {
    case 1:
      return j(a.urge === "있음" ? `충동 있음${str(a.urge_time) ? "(" + str(a.urge_time) + ")" : ""}` : a.urge === "없음" ? "충동 없음" : "", str(a.oneline));
    case 2: {
      const t = a.times && typeof a.times === "object" ? Object.keys(a.times).filter((k) => a.times[k] && a.times[k].urge === "있음").map((k) => k.split(" ")[0]) : [];
      return j(t.length ? "충동 시간대: " + t.join(", ") : "", str(a.oneline));
    }
    case 3:
      return j(str(a.place), str(a.app), str(a.oneline));
    case 4:
      return j(Array.isArray(a.feelings) ? a.feelings.join(", ") : "", str(a.oneline));
    case 5:
      return j(str(a.words), str(a.oneline));
    case 6: {
      const sc = a.urges && typeof a.urges === "object" ? Object.values(a.urges).map((r) => str(r.score)).filter(Boolean) : [];
      return j(sc.length ? "점수: " + sc.join(", ") : "", str(a.oneline));
    }
    default:
      return str(a.oneline);
  }
}

function recapHtml(p, upTo) {
  const items = [];
  for (let n = 1; n <= upTo; n++) {
    const s = daySummary(p, n);
    const t = BY_NUM[n].title;
    items.push(`<li><b>Day ${n} ${esc(t)}</b> ${s ? esc(s) : '<span class="sub">(기록 없음)</span>'}</li>`);
  }
  return `<ul>${items.join("")}</ul>`;
}

function countsHtml(p, to, extraNote) {
  const c = countsOf(p, 1, to);
  const c9 = countsOf(p, 9, to);
  const r = returnsOf(p, to);
  const rows = [
    ["기록한 날", `${c.recorded}일`],
    ["돌아온 횟수", `${r}번`],
  ];
  if (c9.recorded) {
    rows.push(["공식(THEN)을 시작한 날", `${c9.started}일 (끝까지 ${c9.done}일)`]);
    rows.push(["IF를 제때 알아챈 횟수", `${c9.noticed}번`]);
    if (c9.missedAfter) rows.push(["지나가고 나서 알았다고 적은 날", `${c9.missedAfter}일`]);
  }
  if (c.fell) rows.push(["무너진 순간을 적은 날", `${c.fell}일`]);
  return `<table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>${extraNote ? `<p class="sub">${esc(extraNote)}</p>` : ""}`;
}

function autoBlocks(p, day) {
  const out = {};
  const kinds = day.fields.filter((f) => f.type === "auto").map((f) => f.kind);
  const to = day.n - 1;
  for (const k of kinds) {
    switch (k) {
      case "recap_1_5":
        out[k] = recapHtml(p, 5);
        break;
      case "recap_1_6":
        out[k] = recapHtml(p, 6);
        break;
      case "day7_map": {
        const a = (sub(p, 7) && sub(p, 7).answers) || {};
        const rows = [
          ["시간대", a.t_time], ["장소·기기", a.t_place], ["시작점 앱", a.t_app],
          ["직전 감정", a.t_feel], ["작은 허락", a.t_words], ["가장 센 순간", a.t_peak],
        ].filter(([, v]) => str(v));
        out[k] = rows.length
          ? `<table>${rows.map(([x, v]) => `<tr><th>${esc(x)}</th><td>${esc(str(v))}</td></tr>`).join("")}</table>${str(a.oneline) ? `<p><b>한 줄</b> ${esc(str(a.oneline))}</p>` : ""}`
          : "";
        break;
      }
      case "formula_now": {
        const fs = currentFormulas(p);
        out[k] = fs.length ? `<ul>${fs.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : "";
        break;
      }
      case "counts_9":
        out[k] = sub(p, 9) ? countsHtml(p, 9) : "";
        break;
      case "counts_all":
        out[k] = countsHtml(p, Math.min(to, 29) || 1, day.n === 30 ? "오늘 Day 30을 제출하면 기록한 날이 하루 늘어요." : "");
        break;
      case "day2_times": {
        const a = (sub(p, 2) && sub(p, 2).answers) || {};
        const t = a.times && typeof a.times === "object" ? Object.keys(a.times).filter((x) => a.times[x] && a.times[x].urge === "있음") : [];
        out[k] = t.length || str(a.oneline)
          ? `<ul>${t.map((x) => `<li>${esc(x)}${str(a.times[x].doing) ? " — " + esc(str(a.times[x].doing)) : ""}</li>`).join("")}</ul>${str(a.oneline) ? `<p><b>가장 자주 오는 시간대</b> ${esc(str(a.oneline))}</p>` : ""}`
          : "";
        break;
      }
      case "missed_if": {
        const days = [];
        for (let n = 9; n < day.n; n++) {
          const e = sub(p, n);
          if (e && e.answers && e.answers.d_if === "지나가고 나서 알았다") days.push(n);
        }
        out[k] = days.length ? `<p>Day ${days.join(", Day ")}</p>` : `<p class="sub">그렇게 적은 날이 아직 없어요. 그래도 괜찮아요. 새 트리거는 환경 점검으로 찾을 수도 있어요.</p>`;
        break;
      }
      case "facts_line": {
        const c = countsOf(p, 1, 25);
        const r = returnsOf(p, 25);
        out[k] = c.recorded
          ? `<p>"지금까지 ${c.recorded}일 기록했어요. 공식을 시작한 날이 ${countsOf(p, 9, 25).started}일이고, ${r}번 돌아왔어요."</p><p class="sub">이 숫자를 편지 첫 줄에 써도 좋아요.</p>`
          : "";
        break;
      }
      case "letter_now": {
        const l = str(ansOf(p, 26, "letter"));
        const where = str(ansOf(p, 26, "place"));
        out[k] = l ? `<p>${nl2br(l)}</p>${where ? `<p class="sub">보관한 곳: ${esc(where)}</p>` : ""}` : "";
        break;
      }
      case "system_draft": {
        const rows = [];
        const add = (k2, v) => str(v) && rows.push([k2, v]);
        add("트리거", ansOf(p, 7, "oneline"));
        add("작은 허락", ansOf(p, 7, "t_words"));
        add("공식", currentFormulas(p).join("\n"));
        add("환경", ansOf(p, 12, "env"));
        add("빈 시간에 대신 할 것", planAfter(p));
        add("무너졌을 때", comebackText(p));
        add("연락처", ansOf(p, 27, "contact"));
        out[k] = rows.length ? `<table>${rows.map(([x, v]) => `<tr><th>${esc(x)}</th><td>${nl2br(v)}</td></tr>`).join("")}</table>` : "";
        break;
      }
      case "baseline": {
        const a = (sub(p, 1) && sub(p, 1).answers) || {};
        const rows = [
          ["충동", a.urge ? `${a.urge}${str(a.urge_time) ? " (" + str(a.urge_time) + ")" : ""}` : ""],
          ["그래서", a.did], ["결과", a.result], ["사실 한 줄", a.oneline],
        ].filter(([, v]) => str(v));
        out[k] = rows.length ? `<table>${rows.map(([x, v]) => `<tr><th>${esc(x)}</th><td>${nl2br(str(v))}</td></tr>`).join("")}</table>` : "";
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function planAfter(p) {
  const pl = ansOf(p, 16, "plan");
  if (!pl || typeof pl !== "object") return "";
  return Object.values(pl).map((r) => str(r && r.after)).filter(Boolean).join(" / ");
}
function comebackText(p) {
  const a = (sub(p, 27) && sub(p, 27).answers) || {};
  return [str(a.min1) && `첫 1분: ${str(a.min1)}`, str(a.hour1) && `첫 1시간: ${str(a.hour1)}`, str(a.day1) && `첫 24시간: ${str(a.day1)}`]
    .filter(Boolean)
    .join("\n");
}

// 처음 열 때 미리 채워둘 값(이미 적은 내용이 있으면 쓰이지 않음)
function defaultsFor(p, n) {
  const d = {};
  const fs = currentFormulas(p);
  const base = ansOf(p, 11, "formula") || ansOf(p, 8, "formula");
  if (n === 11 && base) d.formula = { if: str(base.if), then: str(base.then) };
  if (n === 15 && base) {
    d.if = str(base.if);
    d.then1 = str(base.then);
  }
  if (n === 28) {
    d.s_trigger = str(ansOf(p, 7, "oneline"));
    d.s_permission = str(ansOf(p, 7, "t_words"));
    d.s_formulas = fs.join("\n");
    d.s_env = str(ansOf(p, 12, "env"));
    d.s_substitute = planAfter(p);
    d.s_comeback = comebackText(p);
    d.s_contact = str(ansOf(p, 27, "contact"));
  }
  if (n === 30) {
    const c = countsOf(p, 1, 29);
    d.d_recorded = String(c.recorded + 1);
    d.d_formula = String(countsOf(p, 9, 29).started);
    d.d_returns = String(returnsOf(p, 29));
  }
  return d;
}

// ── 간단한 속도 제한 ─────────────────────────────────────────
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  }
  return arr.length > max;
}

const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "")
    .split(";")
    .forEach((c) => {
      const i = c.indexOf("=");
      if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
    });
  return out;
}

// ── 초기화 ────────────────────────────────────────────────────
function init({ app, hooks, config }) {
  const cfg = {
    baseUrl: (config.baseUrl || "").replace(/\/+$/, ""),
    getClientId: typeof config.clientId === "function" ? config.clientId : () => config.clientId || "",
    clientSecret: config.clientSecret || "",
    inviteUrl: config.inviteUrl || "",
    secure: /^https:/i.test(config.baseUrl || ""),
  };
  const P = store.state.participants;
  app.set("trust proxy", 1); // Railway 프록시 뒤에서 실제 접속 IP로 속도 제한을 하기 위해
  const h = {
    notifyOwner: async () => {},
    dmUser: async () => false,
    joinGuild: async () => ({ ok: false }),
    onBuyer: async () => {},
    onComplete: async () => {},
    canStart: async () => true, // 예전 챌린지를 이미 마친 사람 등을 index.js에서 막을 수 있는 훅
    ...hooks,
  };

  const personalUrl = (p) => `${cfg.baseUrl}/c/${p.token}`;
  const joinUrl = () => `${cfg.baseUrl}/join/${store.state.config.joinToken}`;
  const adminUrl = () => `${cfg.baseUrl}/admin?key=${store.state.config.adminKey}`;
  const adminHash = () => crypto.createHash("sha256").update("rc-admin:" + store.state.config.adminKey).digest("hex");

  // 공통 보안 헤더
  const secureHeaders = (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  };
  for (const pre of ["/c", "/join", "/oauth", "/admin"]) app.use(pre, secureHeaders);

  const html = (res, status, body) => res.status(status).type("html").send(body);
  const msg = (res, status, title, text, extra) => html(res, status, R.renderMessage(title, text, extra));

  // ── 참가자 생성/재개 ───────────────────────────────────────
  async function onBuyerJoin(uid, name) {
    let p = store.getParticipant(uid);
    const isNew = !p;
    // 완주 전에는 기록을 지우거나 그만뒀어도 다시 시작할 수 있어요. 완주한 사람만 새로 시작할 수 없어요(완주는 1인 1회).
    if (isNew && (store.hasCompleted(uid) || !(await h.canStart(uid).catch(() => true)))) {
      return { p: null, isNew: false, used: true };
    }
    if (isNew) p = store.createParticipant(uid, name, todayKST());
    else if (name && p.name !== name) {
      p.name = name;
      store.save();
    }
    await h.onBuyer(uid, p.name, isNew).catch((e) => console.error("[rc] onBuyer 훅 오류", e));
    if (isNew) {
      await h
        .dmUser(
          uid,
          `🌱 **REBOOT 30**에 오신 걸 환영해요, ${p.name}님!\n\n오늘이 Day 1이에요. 먼저 **시작 전 체크(Day 0)**를 하고 오늘 기록까지 이어서 해보세요. 폼에 적고 제출만 하면 돼요.\n👉 ${personalUrl(p)}\n\n※ 이 주소는 나만의 주소예요. 다른 사람에게 보내지 마세요. 링크를 잃어버렸다면 봇에게 DM으로 "!챌린지시작"이라고 보내세요.\n※ 매일 저녁 8시에 그날의 링크를 DM으로 보내드려요. 그만두고 싶으면 "챌린지그만"이라고 보내주세요.`
        )
        .catch(() => false);
      await h
        .notifyOwner(`🆕 리부트 챌린지 새 참가자: ${p.name} (${uid}) — 구매 링크로 입장했어요.`)
        .catch(() => {});
    }
    return { p, isNew };
  }

  function resume(p) {
    const done = submittedDays(p, 1, 30);
    const last = done.length ? done[done.length - 1] : 0;
    p.startDate = addDays(todayKST(), -Math.min(last, 29)); // 오늘이 (마지막 기록 다음 날)이 되도록
    p.status = p.completedAt ? "completed" : "active";
    p.careDmDate = null;
    store.save();
    return p;
  }
  function pause(uid) {
    const p = store.getParticipant(uid);
    if (!p || p.status === "completed") return false;
    p.status = "paused";
    store.save();
    return true;
  }

  // ── 구매 링크 → 디스코드 로그인 ────────────────────────────
  const oauthStates = new Map(); // state -> expiresAt
  const oauthOn = () => !!(cfg.getClientId() && cfg.clientSecret && cfg.baseUrl);

  app.get("/join/:t", (req, res) => {
    if (limited("join:" + req.ip, 60, 60000)) return msg(res, 429, "잠시만요", "요청이 너무 많아요. 잠시 후 다시 시도해주세요.");
    if (!safeEq(req.params.t, store.state.config.joinToken)) {
      return msg(res, 404, "링크를 확인해주세요", "이 링크는 더 이상 유효하지 않아요. 구매 안내 페이지에서 최신 링크를 다시 받아주세요.");
    }
    if (!oauthOn()) {
      const inv = cfg.inviteUrl ? `<p><a class="btn" href="${esc(cfg.inviteUrl)}" rel="noopener">디스코드 서버 입장하기</a></p>` : "";
      return msg(
        res,
        200,
        "REBOOT 30 시작하기",
        "서버에 들어온 뒤 봇에게 DM으로 아래 한 줄을 보내면 바로 시작돼요.",
        `${inv}<div class="card"><code>!구매확인 ${esc(req.params.t)}</code></div>`
      );
    }
    const state = crypto.randomBytes(16).toString("hex");
    oauthStates.set(state, Date.now() + 10 * 60 * 1000);
    for (const [s, exp] of oauthStates) if (exp < Date.now()) oauthStates.delete(s);
    res.setHeader("Set-Cookie", `rc_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${cfg.secure ? "; Secure" : ""}`);
    const url =
      "https://discord.com/api/oauth2/authorize?" +
      new URLSearchParams({
        client_id: cfg.getClientId(),
        redirect_uri: `${cfg.baseUrl}/oauth/callback`,
        response_type: "code",
        scope: "identify guilds.join",
        state,
      }).toString();
    html(
      res,
      200,
      layout({
        title: "REBOOT 30 시작하기",
        body: `<p class="eyebrow">REBOOT 30</p><h1>전자책 구매자 전용 30일 챌린지</h1>
<p>디스코드로 로그인하면 바로 시작돼요. 서버에 들어와 있지 않다면 자동으로 입장하고, 리부트-크루 등급이 부여됩니다.</p>
<p class="sub">디스코드 아이디와 이름만 확인해요. 비밀번호는 이 사이트에 전달되지 않아요.</p>
<p><a class="btn" href="${esc(url)}">디스코드로 시작하기</a></p>`,
      })
    );
  });

  app.get("/oauth/callback", async (req, res) => {
    try {
      if (limited("oauth:" + req.ip, 30, 60000)) return msg(res, 429, "잠시만요", "요청이 너무 많아요.");
      const { code, state, error } = req.query;
      if (error) return msg(res, 200, "로그인을 취소했어요", "원하시면 구매 링크를 다시 눌러 시작할 수 있어요.");
      const ck = parseCookies(req).rc_state;
      if (!code || !state || typeof state !== "string" || !ck || !safeEq(ck, state) || !oauthStates.has(state) || oauthStates.get(state) < Date.now()) {
        return msg(res, 400, "다시 시도해주세요", "로그인 확인에 실패했어요. 구매 링크를 다시 눌러 처음부터 시작해주세요.");
      }
      oauthStates.delete(state);
      const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: cfg.getClientId(),
          client_secret: cfg.clientSecret,
          grant_type: "authorization_code",
          code: String(code),
          redirect_uri: `${cfg.baseUrl}/oauth/callback`,
        }),
      });
      if (!tokenRes.ok) {
        console.error("[rc] 토큰 교환 실패", tokenRes.status);
        return msg(res, 502, "로그인에 실패했어요", "잠시 후 다시 시도하거나, 서버 운영자에게 알려주세요.");
      }
      const tok = await tokenRes.json();
      const meRes = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${tok.access_token}` } });
      if (!meRes.ok) return msg(res, 502, "로그인에 실패했어요", "디스코드 계정 정보를 확인하지 못했어요. 다시 시도해주세요.");
      const me = await meRes.json();
      const name = me.global_name || me.username || String(me.id);

      const joined = await h.joinGuild(me.id, tok.access_token).catch((e) => {
        console.error("[rc] 서버 입장 처리 오류", e);
        return { ok: false };
      });
      const { p, isNew, used } = await onBuyerJoin(me.id, name);
      if (used) {
        res.setHeader("Set-Cookie", `rc_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${cfg.secure ? "; Secure" : ""}`);
        return msg(res, 200, "이미 완주한 계정이에요", "이 챌린지는 완주까지 몇 번이든 다시 시작할 수 있지만, 완주한 뒤에는 다시 시작할 수 없어요. 쌓은 기록은 계속 쓸 수 있어요. 궁금한 점은 서버에서 운영자에게 말해주세요.");
      }
      res.setHeader("Set-Cookie", `rc_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${cfg.secure ? "; Secure" : ""}`);
      const warn = joined && joined.ok === false
        ? `<div class="alert"><b>서버 입장을 자동으로 못 했어요.</b> ${cfg.inviteUrl ? `<a href="${esc(cfg.inviteUrl)}">여기서 직접 입장</a>해주세요.` : "서버 운영자에게 알려주세요."} 챌린지 기록은 지금 바로 시작할 수 있어요.</div>`
        : "";
      html(
        res,
        200,
        layout({
          title: "REBOOT 30 시작",
          body: `<p class="eyebrow">환영해요</p><h1>${esc(name)}님, 시작할 준비가 됐어요</h1>
${warn}
<p>${isNew ? "리부트-크루 등급이 부여됐고, 오늘이 Day 1이에요." : "이미 참여 중이에요. 이어서 하시면 돼요."} 먼저 시작 전 체크(Day 0)부터 해요.</p>
<p><a class="btn" href="/c/${esc(p.token)}">내 챌린지 열기</a></p>
<p class="sub">이 주소는 나만의 주소예요. 즐겨찾기에 저장해두세요. 디스코드 DM으로도 링크를 보내드렸어요.</p>`,
        })
      );
    } catch (e) {
      console.error("[rc] oauth 콜백 오류", e);
      msg(res, 500, "문제가 생겼어요", "잠시 후 다시 시도해주세요.");
    }
  });

  // ── 참가자 페이지 (/c/:token) ──────────────────────────────
  const findP = (req, res) => {
    const t = String(req.params.token || "");
    if (!/^[a-f0-9]{20,64}$/.test(t) || limited("c:" + req.ip, 240, 60000)) {
      msg(res, 404, "찾을 수 없는 페이지예요", "주소를 다시 확인하거나, 봇에게 DM으로 \"!챌린지시작\"이라고 보내 새 링크를 받아주세요.");
      return null;
    }
    const p = store.getByToken(t);
    if (!p) {
      msg(res, 404, "찾을 수 없는 페이지예요", "주소를 다시 확인하거나, 봇에게 DM으로 \"!챌린지시작\"이라고 보내 새 링크를 받아주세요.");
      return null;
    }
    return p;
  };
  const baseOf = (p) => `/c/${p.token}`;
  const day0Done = (p) => !!sub(p, 0);
  const visibleCur = (p) => (day0Done(p) ? currentDay(p) : 0);
  const submittedSet = (p) => new Set(Object.keys(p.days).filter((k) => p.days[k].submittedAt).map(Number));

  app.get("/c/:token", (req, res) => {
    const p = findP(req, res);
    if (!p) return;
    const cur = visibleCur(p);
    let page = R.renderHome({ p, DAYS, cur, base: baseOf(p), submittedSet: submittedSet(p), completed: p.status === "completed" || !!p.completedAt });
    // 쉬었다 돌아온 경우: 날짜가 아니라 내가 멈춘 곳부터 이어갈 수 있게 해줍니다.
    const done = submittedDays(p, 1, 30);
    const last = done.length ? done[done.length - 1] : 0;
    if (day0Done(p) && !p.completedAt && last >= 1 && last < 30 && currentDay(p) > last + 1) {
      const banner = `<div class="card"><b>쉬었다 오셨네요. 괜찮아요.</b><p class="sub">날짜를 따라잡지 않아도 돼요. Day ${last + 1}부터 이어서 할 수 있어요. 쌓인 기록은 그대로 있어요.</p>
<form method="post" action="${baseOf(p)}/resume"><button class="btn" type="submit">Day ${last + 1}부터 이어서 하기</button></form></div>`;
      page = page.replace("<h2>내 것</h2>", banner + "<h2>내 것</h2>");
    }
    html(res, 200, page);
  });

  app.post("/c/:token/resume", (req, res) => {
    const p = findP(req, res);
    if (!p) return;
    resume(p);
    res.redirect(baseOf(p));
  });

  app.get("/c/:token/d/:n", (req, res) => {
    const p = findP(req, res);
    if (!p) return;
    const n = parseInt(req.params.n, 10);
    const day = BY_NUM[n];
    if (!day) return msg(res, 404, "없는 날이에요", "Day 0~30만 있어요.", `<p><a href="${baseOf(p)}">돌아가기</a></p>`);
    if (n >= 1 && !day0Done(p)) return res.redirect(`${baseOf(p)}/d/0`);
    const cur = currentDay(p);
    if (n >= 1 && n > cur) {
      return msg(res, 403, "아직 열리지 않았어요", `Day ${n}은 ${addDays(p.startDate, n - 1)}에 열려요.`, `<p><a href="${baseOf(p)}">돌아가기</a></p>`);
    }
    const e = p.days[n] || {};
    let answers = e.draft ? e.draft.answers : e.answers;
    let mode = e.draft ? e.draft.mode : e.mode;
    if (!answers) answers = defaultsFor(p, n);
    if (n === 0 || !mode) mode = "full";
    const late = n >= 1 && n < cur && !e.submittedAt;
    html(
      res,
      200,
      R.renderDayPage({
        p,
        day,
        answers,
        mode,
        autos: autoBlocks(p, day),
        submitted: !!e.submittedAt,
        lateNote: late ? "지난 날짜의 기록이에요. 지금 써도 괜찮아요. 쉬어간 날은 비워두고 오늘부터 이어가도 돼요." : "",
        base: baseOf(p),
      })
    );
  });

  const jsonBody = (req) => (req.body && typeof req.body === "object" ? req.body : {});

  app.post("/c/:token/d/:n/draft", (req, res) => {
    const p = store.getByToken(String(req.params.token || ""));
    const n = parseInt(req.params.n, 10);
    const day = BY_NUM[n];
    if (!p || !day || limited("d:" + req.ip, 120, 60000)) return res.status(404).json({ ok: false });
    if (n >= 1 && (!day0Done(p) || n > currentDay(p))) return res.status(403).json({ ok: false });
    const body = jsonBody(req);
    const mode = body.mode === "min" && n >= 1 ? "min" : "full";
    const entry = (p.days[n] = p.days[n] || {});
    entry.draft = { mode, answers: sanitizeAnswers(day, mode, body.answers), at: new Date().toISOString() };
    store.save();
    res.json({ ok: true });
  });

  app.post("/c/:token/d/:n/submit", async (req, res) => {
    try {
      const p = store.getByToken(String(req.params.token || ""));
      const n = parseInt(req.params.n, 10);
      const day = BY_NUM[n];
      if (!p || !day || limited("s:" + req.ip, 60, 60000)) return res.status(404).json({ ok: false, error: "페이지를 찾을 수 없어요." });
      const cur = currentDay(p);
      if (n >= 1 && !day0Done(p)) return res.status(403).json({ ok: false, error: "먼저 시작 전 체크(Day 0)를 제출해주세요." });
      if (n > cur) return res.status(403).json({ ok: false, error: "아직 열리지 않은 날이에요." });
      const body = jsonBody(req);
      const mode = body.mode === "min" && n >= 1 ? "min" : "full";
      const answers = sanitizeAnswers(day, mode, body.answers);
      if (n === 0 && !answers.__consent) return res.json({ ok: false, error: "동의에 체크해야 시작할 수 있어요." });
      if (!hasContent(answers)) return res.json({ ok: false, error: "비어 있어요. 한 칸이라도 적어주세요. 한 줄이면 충분해요." });

      const entry = (p.days[n] = p.days[n] || {});
      const first = !entry.submittedAt;
      const prevFlags = entry.flags || [];
      const crisisHits = findCrisis(answers, day);
      const fell = answers.d_fell === "있었다" || answers.m_fell === "있었다";
      const flags = [];
      if (crisisHits.length) flags.push("crisis");
      if (fell) flags.push("fell");
      if (n === 0 && Array.isArray(answers.screening) && answers.screening.length) flags.push("screening");

      entry.answers = answers;
      entry.mode = mode;
      entry.submittedAt = new Date().toISOString();
      if (first) {
        entry.date = todayKST();
        entry.late = n >= 1 && n < cur;
      }
      entry.flags = flags;
      entry.readAt = null;
      delete entry.draft;
      if (p.status === "paused") {
        p.status = "active";
      }
      let completedNow = false;
      if (n === 30 && !p.completedAt) {
        p.completedAt = new Date().toISOString();
        p.status = "completed";
        store.markCompleted(p.uid);
        completedNow = true;
      }
      store.save();

      // 운영자 즉시 알림: 위기 신호 / 무너짐 / Day 0 안전 체크 (새로 생긴 경우에만)
      const label = n === 0 ? "시작 전 체크" : `Day ${n}`;
      if (flags.includes("crisis") && !prevFlags.includes("crisis")) {
        h.notifyOwner(
          `🚨 **챌린지 위기 신호** — ${p.name} (${p.uid}) · ${label}\n${crisisHits.slice(0, 3).map((t) => "• " + t.replace(/\s+/g, " ")).join("\n")}\n직접 연락해 주세요 → ${adminUrl().replace(/\?key=.*/, "")}/p/${p.uid} (관리 페이지)`
        ).catch(() => {});
      } else if (flags.includes("screening") && !prevFlags.includes("screening")) {
        h.notifyOwner(`⚠️ ${p.name} (${p.uid}) 님이 시작 전 체크에서 해당 신호를 골랐어요. 관리 페이지에서 확인해 주세요.`).catch(() => {});
      }
      if (flags.includes("fell") && !prevFlags.includes("fell")) {
        h.notifyOwner(`🫂 ${p.name} (${p.uid}) 님이 ${label}에 "무너진 순간이 있었다"고 기록했어요. (돌아와서 기록한 것 자체가 좋은 신호예요)`).catch(() => {});
      }
      if (completedNow) {
        h.onComplete(p.uid, p.name).catch((e) => console.error("[rc] onComplete 훅 오류", e));
        h.notifyOwner(`🏆 ${p.name} (${p.uid}) 님이 30일을 완주했어요! (기록한 날 ${countsOf(p, 1, 30).recorded}일)`).catch(() => {});
      }
      res.json({ ok: true, redirect: `${baseOf(p)}/d/${n}/done` });
    } catch (e) {
      console.error("[rc] 제출 처리 오류", e);
      res.status(500).json({ ok: false, error: "서버에 문제가 생겼어요. 입력한 내용은 화면에 남아 있으니 잠시 후 다시 눌러주세요." });
    }
  });

  app.get("/c/:token/d/:n/done", (req, res) => {
    const p = findP(req, res);
    if (!p) return;
    const n = parseInt(req.params.n, 10);
    const day = BY_NUM[n];
    const e = day && sub(p, n);
    if (!e) return res.redirect(baseOf(p));
    const a27 = (sub(p, 27) && sub(p, 27).answers) || {};
    html(
      res,
      200,
      R.renderDone({
        p,
        day,
        next: BY_NUM[n + 1] || null,
        flags: e.flags || [],
        base: baseOf(p),
        comeback: { min1: str(a27.min1), hour1: str(a27.hour1) },
        completedNow: n === 30,
      })
    );
  });

  app.get("/c/:token/records", (req, res) => {
    const p = findP(req, res);
    if (!p) return;
    html(res, 200, R.renderRecords({ p, DAYS, base: baseOf(p) }));
  });

  app.get("/c/:token/system", (req, res) => {
    const p = findP(req, res);
    if (!p) return;
    const e = sub(p, 28);
    if (!e) return msg(res, 200, "아직 만들어지지 않았어요", "Day 28에서 '나의 시스템 1페이지'를 제출하면 여기서 한 장으로 볼 수 있어요.", `<p><a href="${baseOf(p)}">돌아가기</a></p>`);
    const a = e.answers || {};
    const row = (k, v) => (str(v) ? `<div class="card"><b>${esc(k)}</b><p>${nl2br(str(v))}</p></div>` : "");
    html(
      res,
      200,
      layout({
        title: "나의 시스템 1페이지",
        body: `<p class="eyebrow">REBOOT 30</p><h1>나의 시스템 1페이지</h1><p class="sub">${esc(p.name)} · ${esc(e.submittedAt.slice(0, 10))}</p>
${row("내 트리거", a.s_trigger)}${row("내 작은 허락", a.s_permission)}${row("내 공식", a.s_formulas)}${row("내 환경", a.s_env)}${row("빈 시간에 대신 할 것", a.s_substitute)}${row("무너졌을 때 계획", a.s_comeback)}${row("연락처", a.s_contact)}${row("붙일 곳", a.s_where)}
<p class="noprint"><button class="btn" onclick="window.print()">인쇄하기 / PDF로 저장</button> <a class="btn ghost" href="${baseOf(p)}">돌아가기</a></p>`,
      })
    );
  });

  app.get("/c/:token/complete", (req, res) => {
    const p = findP(req, res);
    if (!p) return;
    const e = sub(p, 30);
    if (!e) return msg(res, 200, "아직이에요", "Day 30을 제출하면 완주 기록이 열려요.", `<p><a href="${baseOf(p)}">돌아가기</a></p>`);
    const a = e.answers || {};
    const rec = str(a.d_recorded) || String(countsOf(p, 1, 30).recorded);
    html(
      res,
      200,
      layout({
        title: "완주 기록",
        body: `<p class="eyebrow">REBOOT 30</p><h1>${esc(p.name)}님의 완주 기록</h1>
<div class="goal">나는 30일 동안 ${esc(rec)}일을 기록했고, 공식을 쓴 날은 ${esc(str(a.d_formula) || "-")}일이며, ${esc(str(a.d_returns) || "0")}번 돌아왔다.</div>
<p>완주는 30일 연속이 아니라, 기록하고 돌아온 날 수예요.</p>
${str(a.d_best) ? `<div class="card"><b>가장 도움이 된 공식</b><p>${nl2br(str(a.d_best))}</p></div>` : ""}
${str(a.keep3) ? `<div class="card"><b>다음 30일 · 유지할 것</b><p>${nl2br(str(a.keep3))}</p></div>` : ""}
${str(a.try1) ? `<div class="card"><b>다음 30일 · 새로 시도할 것</b><p>${nl2br(str(a.try1))}</p></div>` : ""}
${str(a.recheck) ? `<div class="card"><b>다시 점검할 날</b><p>${esc(str(a.recheck))}</p></div>` : ""}
${str(a.oneline) ? `<div class="quote">${esc(str(a.oneline))}</div>` : ""}
<p class="noprint"><button class="btn" onclick="window.print()">인쇄하기</button> <a class="btn ghost" href="${baseOf(p)}">돌아가기</a></p>`,
      })
    );
  });

  app.post("/c/:token/delete", async (req, res) => {
    const p = findP(req, res);
    if (!p) return;
    const { uid, name } = p;
    store.deleteParticipantData(uid);
    h.notifyOwner(`🗑️ ${name} (${uid}) 님이 챌린지 기록을 직접 삭제했어요. (내용은 모두 지워졌어요. 완주 전이라 다시 시작할 수 있어요.)`).catch(() => {});
    msg(res, 200, "삭제했어요", "모든 기록과 이 페이지 주소가 삭제됐어요. 다시 시작하고 싶으면 구매 링크로 들어오면 돼요.");
  });

  // ── 운영자 관리 페이지 (/admin) ────────────────────────────
  const isAdmin = (req) => {
    const c = parseCookies(req).rc_admin;
    return !!c && safeEq(c, adminHash());
  };
  app.use("/admin", (req, res, next) => {
    if (limited("a:" + req.ip, 300, 60000)) return msg(res, 429, "잠시만요", "요청이 너무 많아요.");
    if (req.path === "/" && req.query.key) {
      if (safeEq(String(req.query.key), store.state.config.adminKey)) {
        res.setHeader("Set-Cookie", `rc_admin=${adminHash()}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${60 * 60 * 24 * 14}${cfg.secure ? "; Secure" : ""}`);
        return res.redirect("/admin");
      }
      return msg(res, 403, "접근할 수 없어요", "키가 맞지 않아요.");
    }
    if (!isAdmin(req)) return msg(res, 403, "접근할 수 없어요", "봇에게 DM으로 \"!챌린지관리\"를 보내 관리 주소를 받아주세요.");
    next();
  });

  const dayLabel = (n) => (n === 0 ? "시작 전" : "Day " + n);
  const flagBadges = (p) => {
    const f = new Set();
    for (const k of Object.keys(p.days)) (p.days[k].flags || []).forEach((x) => f.add(x));
    return [...f].map((x) => (x === "crisis" ? '<span class="badge red">위기 신호</span>' : x === "fell" ? '<span class="badge warm">무너짐 기록</span>' : '<span class="badge warm">안전 체크 해당</span>')).join(" ");
  };
  const unreadOf = (p) => Object.keys(p.days).filter((k) => p.days[k].submittedAt && !p.days[k].readAt).length;
  const lastDate = (p) => {
    const ds = Object.keys(p.days).map((k) => (p.days[k].submittedAt || "").slice(0, 10)).filter(Boolean).sort();
    return ds.length ? ds[ds.length - 1] : "-";
  };
  const stBadge = (p) =>
    p.status === "completed" ? '<span class="badge green">완주</span>' : p.status === "paused" ? '<span class="badge">쉬는 중</span>' : '<span class="badge green">진행 중</span>';

  app.get("/admin", (req, res) => {
    const list = Object.values(P).sort((a, b) => {
      const ca = Object.values(a.days).some((d) => (d.flags || []).includes("crisis") && !d.readAt) ? 1 : 0;
      const cb = Object.values(b.days).some((d) => (d.flags || []).includes("crisis") && !d.readAt) ? 1 : 0;
      return cb - ca || unreadOf(b) - unreadOf(a) || (lastDate(b) > lastDate(a) ? 1 : -1);
    });
    const rows = list
      .map(
        (p) => `<tr><td><a href="/admin/p/${esc(p.uid)}"><b>${esc(p.name)}</b></a><br><span class="sub">${esc(p.uid)}</span></td>
<td>${stBadge(p)} ${flagBadges(p)}</td><td>Day ${Math.min(currentDay(p), 30)}</td><td>${submittedDays(p, 1, 30).length}일</td>
<td>${unreadOf(p) ? `<span class="badge red">${unreadOf(p)}건</span>` : "-"}</td><td>${esc(lastDate(p))}</td></tr>`
      )
      .join("");
    const total = list.length;
    const active = list.filter((p) => p.status === "active").length;
    const done = list.filter((p) => p.status === "completed").length;
    html(
      res,
      200,
      layout({
        title: "챌린지 관리",
        wide: true,
        body: `<p class="eyebrow">REBOOT 30 · 운영자 전용</p><h1>챌린지 관리</h1>
<p class="sub">참가자 ${total}명 · 진행 중 ${active}명 · 완주 ${done}명</p>
<div class="card"><b>구매자 입장 링크</b><p style="word-break:break-all"><code>${esc(joinUrl())}</code></p>
<p class="sub">랜딩페이지의 구매 완료 버튼/안내에 이 링크를 넣으세요. 새는 것 같으면 재발급하세요(이미 들어온 사람은 그대로 유지돼요).</p>
<form method="post" action="/admin/rotate-join" onsubmit="return confirm('입장 링크를 재발급할까요? 기존 링크는 바로 쓸 수 없게 돼요.')"><button class="btn ghost" type="submit">입장 링크 재발급</button></form></div>
<table class="adm"><thead><tr><th>참가자</th><th>상태</th><th>오늘</th><th>기록한 날</th><th>안 읽음</th><th>마지막 제출</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="sub">아직 참가자가 없어요.</td></tr>'}</tbody></table>
<div class="card"><b>완주 후 다시 시작 허용</b><p class="sub">완주 전에는 누구나 다시 시작할 수 있어요. 완주한 사람(기록을 지운 경우 포함)에게 예외로 한 번 더 열어주려면 디스코드 ID를 넣어주세요.</p>
<form method="post" action="/admin/allow" class="row"><input type="text" name="uid" inputmode="numeric" pattern="\\d{15,25}" placeholder="디스코드 ID" style="max-width:260px" required><button class="btn ghost" type="submit">허용</button></form></div>
<p><a href="/admin/export.json" class="btn ghost">전체 내보내기(JSON)</a></p>`,
      })
    );
  });

  app.post("/admin/allow", (req, res) => {
    const uid = String((req.body && req.body.uid) || "").trim();
    if (/^\d{15,25}$/.test(uid)) store.allowRestart(uid);
    res.redirect("/admin");
  });

  app.post("/admin/rotate-join", (req, res) => {
    store.rotateJoinToken();
    res.redirect("/admin");
  });

  app.get("/admin/export.json", (req, res) => {
    res.setHeader("Content-Disposition", 'attachment; filename="reboot30-export.json"');
    res.type("json").send(JSON.stringify({ exportedAt: new Date().toISOString(), participants: P }, null, 2));
  });

  app.get("/admin/p/:uid.json", (req, res) => {
    const p = P[req.params.uid];
    if (!p) return msg(res, 404, "없는 참가자예요", "");
    res.setHeader("Content-Disposition", `attachment; filename="reboot30-${esc(p.uid)}.json"`);
    res.type("json").send(JSON.stringify(p, null, 2));
  });

  app.get("/admin/p/:uid", (req, res) => {
    const p = P[req.params.uid];
    if (!p) return msg(res, 404, "없는 참가자예요", "", `<p><a href="/admin">목록으로</a></p>`);
    const blocks = DAYS.filter((d) => sub(p, d.n))
      .reverse()
      .map((d) => {
        const e = p.days[d.n];
        const fl = (e.flags || []).map((x) => (x === "crisis" ? '<span class="badge red">위기 신호</span>' : x === "fell" ? '<span class="badge warm">무너짐</span>' : '<span class="badge warm">안전 체크</span>')).join(" ");
        const wasUnread = !e.readAt;
        return `<div class="card"><b>${esc(dayLabel(d.n))} · ${esc(d.title)}</b> <span class="sub">${esc(e.submittedAt.slice(0, 16).replace("T", " "))} UTC${e.mode === "min" ? " · 한 줄" : ""}${e.late ? " · 늦게 작성" : ""}</span> ${wasUnread ? '<span class="badge red">새 글</span>' : ""} ${fl}${R.renderAnswers(d, e)}</div>`;
      })
      .join("");
    // 열람 처리
    let changed = false;
    for (const k of Object.keys(p.days)) if (p.days[k].submittedAt && !p.days[k].readAt) { p.days[k].readAt = new Date().toISOString(); changed = true; }
    if (changed) store.save();
    const replies = (p.ownerReplies || [])
      .slice()
      .reverse()
      .map((r) => `<div class="note"><span class="sub">${esc(r.at.slice(0, 16).replace("T", " "))} UTC · ${r.sent ? "DM 전달됨" : "DM 전달 실패"}</span><br>${nl2br(r.text)}</div>`)
      .join("");
    html(
      res,
      200,
      layout({
        title: p.name + " · 챌린지",
        wide: true,
        body: `<p><a href="/admin">← 목록</a></p><h1>${esc(p.name)} ${stBadge(p)} ${flagBadges(p)}</h1>
<p class="sub">디스코드 ID ${esc(p.uid)} · 시작 ${esc(p.startDate)} · 오늘 Day ${Math.min(currentDay(p), 30)} · 기록한 날 ${submittedDays(p, 1, 30).length}일 · <a href="/admin/p/${esc(p.uid)}.json">JSON</a></p>
<div class="card"><b>답장 보내기 (봇이 DM으로 전달해요)</b>
<form method="post" action="/admin/p/${esc(p.uid)}/reply"><textarea name="text" rows="4" maxlength="1800" required placeholder="따뜻하게, 짧게. 지시나 훈계보다 사실과 격려가 좋아요."></textarea>
<p><button class="btn" type="submit">DM으로 보내기</button></p></form>${replies}</div>
${blocks || '<p class="sub">제출한 기록이 아직 없어요.</p>'}`,
      })
    );
  });

  app.post("/admin/p/:uid/reply", async (req, res) => {
    const p = P[req.params.uid];
    if (!p) return msg(res, 404, "없는 참가자예요", "");
    const text = clip(String((req.body && req.body.text) || ""), 1800).trim();
    if (!text) return res.redirect(`/admin/p/${encodeURIComponent(p.uid)}`);
    const ok = await h.dmUser(p.uid, `💌 운영자가 남긴 말이에요\n\n${text}\n\n(이 메시지에 답장하고 싶다면 봇이 아니라 서버에서 운영자에게 직접 말해주세요.)`).catch(() => false);
    p.ownerReplies.push({ at: new Date().toISOString(), text, sent: !!ok });
    store.save();
    res.redirect(`/admin/p/${encodeURIComponent(p.uid)}`);
  });

  // ── 예약 작업 ──────────────────────────────────────────────
  // 매일 저녁: 오늘의 링크 DM (이미 제출했거나, 쉬는 중이면 보내지 않음)
  async function sendDailyLinks() {
    const today = todayKST();
    for (const p of Object.values(P)) {
      try {
        if (p.status !== "active" || p.lastDmDate === today) continue;
        const cur = currentDay(p);
        if (!day0Done(p)) {
          if (cur >= 1 && cur <= 3) {
            p.lastDmDate = today;
            await h.dmUser(p.uid, `아직 시작 전 체크(Day 0)가 남아 있어요. 5~10분이면 돼요 👉 ${personalUrl(p)}/d/0`);
          }
          continue;
        }
        const lastD = lastDate(p);
        const gap = lastD === "-" ? 0 : diffDays(today, lastD);
        if (gap >= 3 && gap <= 30) {
          if (!p.careDmDate || diffDays(today, p.careDmDate) >= 7) {
            p.careDmDate = today;
            p.lastDmDate = today;
            await h.dmUser(
              p.uid,
              `며칠 못 오셨네요. 괜찮아요. 이 챌린지는 30일 연속이 아니라 '기록하고 돌아온 날 수'를 세요. 쌓인 기록은 그대로 있고, 일수가 0으로 돌아가지 않아요.\n오늘은 한 줄만 적어도 기록한 날이에요 👉 ${personalUrl(p)}`
            );
          }
          continue;
        }
        if (gap > 30) continue;
        if (cur < 1 || (cur <= 30 && sub(p, cur)) || (cur > 30 && sub(p, 30))) continue;
        const doneDays = submittedDays(p, 1, 30);
        const lastDone = doneDays.length ? doneDays[doneDays.length - 1] : 0;
        const dn = Math.min(cur, 30);
        const behind = dn > lastDone + 1; // 날짜보다 뒤처졌다면 멈춘 곳부터 이어갈 수 있는 홈으로 안내
        const d = BY_NUM[behind ? Math.min(lastDone + 1, 30) : dn];
        p.lastDmDate = today;
        await h.dmUser(
          p.uid,
          `📘 오늘의 REBOOT 30 — Day ${d.n}. ${d.title} (약 ${d.minutes}분)\n오늘의 목표: ${d.goal}\n👉 ${behind ? personalUrl(p) : personalUrl(p) + "/d/" + d.n}\n\n바쁜 날은 '오늘은 한 줄만'으로 충분해요.${behind ? "\n(날짜를 따라잡지 않아도 돼요. 링크를 열면 멈춘 곳부터 이어갈 수 있어요.)" : ""}`
        );
      } catch (e) {
        console.error("[rc] 일일 링크 발송 오류", p.uid, e);
      }
    }
    store.save();
  }

  // 매일 아침: 운영자 하루 요약
  async function sendOwnerSummary() {
    const today = todayKST();
    const yesterday = addDays(today, -1);
    const all = Object.values(P);
    if (!all.length) return;
    const newbies = all.filter((p) => (p.joinedAt || "").slice(0, 10) === yesterday);
    let subs = 0;
    const who = new Set();
    const flagged = [];
    let unread = 0;
    for (const p of all) {
      for (const k of Object.keys(p.days)) {
        const e = p.days[k];
        if (!e.submittedAt) continue;
        if (!e.readAt) unread++;
        if ((e.date || e.submittedAt.slice(0, 10)) === yesterday) {
          subs++;
          who.add(p.uid);
          if ((e.flags || []).includes("fell")) flagged.push(`${p.name}(${dayLabel(Number(k))})`);
        }
      }
    }
    const silent = all.filter((p) => p.status === "active" && day0Done(p) && lastDate(p) !== "-" && diffDays(today, lastDate(p)) >= 3 && diffDays(today, lastDate(p)) <= 14);
    if (!subs && !newbies.length && !silent.length && !unread) return;
    const lines = [
      `☀️ **리부트 챌린지 어제 요약** (${yesterday})`,
      `• 새 참가자 ${newbies.length}명 · 제출 ${subs}건(${who.size}명) · 안 읽은 기록 ${unread}건`,
    ];
    if (flagged.length) lines.push(`• 무너짐을 기록한 날: ${flagged.slice(0, 10).join(", ")}${flagged.length > 10 ? " 외" : ""}`);
    if (silent.length) lines.push(`• 3일 이상 조용한 참가자: ${silent.slice(0, 10).map((p) => p.name).join(", ")}${silent.length > 10 ? " 외" : ""}`);
    lines.push(`👉 ${cfg.baseUrl}/admin  (처음이면 \"!챌린지관리\"로 주소를 받으세요)`);
    await h.notifyOwner(lines.join("\n"));
  }

  return {
    joinUrl,
    adminUrl,
    personalUrl,
    getParticipant: (uid) => store.getParticipant(uid),
    isBuyer: (uid) => !!store.getParticipant(uid),
    onBuyerJoin,
    verifyJoinToken: (t) => safeEq(String(t || ""), store.state.config.joinToken),
    rotateJoinToken: () => store.rotateJoinToken(),
    allowRestart: (uid) => store.allowRestart(uid),
    resume: (uid) => {
      const p = store.getParticipant(uid);
      return p ? resume(p) : null;
    },
    pause,
    sendDailyLinks,
    sendOwnerSummary,
    currentDay,
    markMasterGranted: (uid) => {
      const p = store.getParticipant(uid);
      if (!p || p.masterGrantedAt) return false;
      p.masterGrantedAt = new Date().toISOString();
      store.save();
      return true;
    },
    progress: (uid) => {
      const p = store.getParticipant(uid);
      if (!p) return null;
      const done = submittedDays(p, 1, 30);
      return { status: p.status, recorded: done.length, cur: Math.min(currentDay(p), 30), last: done.length ? done[done.length - 1] : 0, url: personalUrl(p), masterGrantedAt: p.masterGrantedAt };
    },
    comebackPlan: (uid) => {
      const p = store.getParticipant(uid);
      if (!p) return null;
      const a27 = (sub(p, 27) && sub(p, 27).answers) || {};
      const letter = str(ansOf(p, 26, "letter"));
      return { letter, min1: str(a27.min1), hour1: str(a27.hour1), day1: str(a27.day1), contact: str(a27.contact) };
    },
    stats: () => {
      const all = Object.values(P);
      return {
        total: all.length,
        active: all.filter((p) => p.status === "active").length,
        paused: all.filter((p) => p.status === "paused").length,
        completed: all.filter((p) => p.status === "completed").length,
        unread: all.reduce((s, p) => s + unreadOf(p), 0),
      };
    },
  };
}

module.exports = { init, todayKST, addDays, diffDays, currentDay, sanitizeAnswers, countsOf, returnsOf, findCrisis, autoBlocks, defaultsFor, currentFormulas };

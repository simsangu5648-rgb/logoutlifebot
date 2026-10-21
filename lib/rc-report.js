// 7일·30일 분석 리포트: 통계 계산 + 붙여넣은 분석 글 파싱 + 통계 대시보드(HTML/SVG) 렌더링.
// 참가자 기록(p.days)만 읽는 순수 함수들이라 디스코드/서버 의존성이 없습니다.
// 운영자가 Claude로 만든 분석 글을 관리 페이지에 붙여넣으면, 정해진 형식("## 제목" + 목록)을 섹션 카드로
// 자동 정리하고, 같은 페이지에 기록에서 계산한 숫자·차트를 함께 보여줍니다.

const { BY_NUM } = require("./rc-content");

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const subOf = (p, n) => {
  const e = p.days && p.days[n];
  return e && e.submittedAt ? e : null;
};
const ansOf = (p, n) => (subOf(p, n) && subOf(p, n).answers) || {};
const str = (v) => (v == null ? "" : String(v).trim());
const isFell = (a) => a.d_fell === "있었다" || a.m_fell === "있었다";

// "7", "7점", "6~7" → 첫 숫자만, 0~10 범위만 인정
function parseScore(v) {
  const m = /(\d+(?:\.\d+)?)/.exec(str(v));
  if (!m) return null;
  const x = parseFloat(m[1]);
  return x >= 0 && x <= 10 ? x : null;
}
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// ── 통계 계산 ────────────────────────────────────────────────
// helpers: { returns: 돌아온 횟수, counts: countsOf(p,1,n), formulas: 지금 쓰는 공식 목록 }
function computeStats(p, n, helpers = {}) {
  const counts = helpers.counts || {};
  const days = [];
  for (let d = 1; d <= n; d++) {
    const e = subOf(p, d);
    const a = (e && e.answers) || {};
    days.push({ n: d, state: !e ? "miss" : e.mode === "min" ? "min" : "done", late: !!(e && e.late), fell: !!(e && isFell(a)) });
  }
  const recorded = days.filter((d) => d.state !== "miss").length;
  const stats = {
    n,
    total: n,
    recorded,
    returns: helpers.returns != null ? helpers.returns : 0,
    fell: days.filter((d) => d.fell).length,
    late: days.filter((d) => d.late).length,
    minDays: days.filter((d) => d.state === "min").length,
    days,
  };

  // Day 6 "충동 점수" 표 (관찰기)
  const urges = ansOf(p, 6).urges;
  const moments = [];
  if (urges && typeof urges === "object") {
    for (const k of Object.keys(urges)) {
      const r = urges[k] || {};
      const label = str(r.when) || str(r.where) || str(r.feel);
      const score = parseScore(r.score);
      if (!label && score == null) continue;
      moments.push({ label: label || `순간 ${k}`, where: str(r.where), feel: str(r.feel), score });
    }
  }
  const scored = moments.filter((m) => m.score != null).map((m) => m.score);
  stats.moments = moments;
  stats.momentAvg = r1(avg(scored));
  stats.momentMax = scored.length ? Math.max(...scored) : null;

  if (n >= 7) {
    // 시간대 지도(Day 2), 장소·기기(Day 3), 감정(Day 4), 자동적 사고(Day 5), 내가 정리한 트리거(Day 7)
    const times = ansOf(p, 2).times;
    stats.slots = [];
    if (times && typeof times === "object") {
      for (const k of Object.keys(times)) {
        const r = times[k] || {};
        const m = /^(\S+)\s*(?:\((.*)\))?/.exec(k);
        stats.slots.push({ label: m ? m[1] : k, range: m && m[2] ? m[2] : "", urge: r.urge === "있음" ? true : r.urge === "없음" ? false : null, doing: str(r.doing) });
      }
    }
    const d3 = ansOf(p, 3);
    stats.place = str(d3.place);
    stats.devices = Array.isArray(d3.devices) ? d3.devices : Array.isArray(d3.device) ? d3.device : [];
    stats.app = str(d3.app);
    const d4 = ansOf(p, 4);
    stats.feelings = (Array.isArray(d4.feelings) ? d4.feelings : []).concat(str(d4.feelings_other) ? [str(d4.feelings_other)] : []);
    const d5 = ansOf(p, 5);
    stats.thoughtKind = str(d5.kind);
    stats.thoughtWords = str(d5.words);
    const d7 = ansOf(p, 7);
    stats.map7 = {
      "자주 오는 시간대": str(d7.t_time),
      "장소 · 기기": str(d7.t_place),
      "시작점이 되는 앱": str(d7.t_app),
      "직전 감정": str(d7.t_feel),
      "작은 허락": str(d7.t_words),
      "가장 센 순간의 공통점": str(d7.t_peak),
    };
    stats.trigger7 = str(d7.oneline);
  }

  if (n >= 30) {
    // 실행기(Day 9~30) 일별 수치
    const series = [];
    const then = { 끝까지: 0, 일부: 0, "못 했다": 0, "해당 없음": 0 };
    const ifs = { 왔다: 0, "지나가고 나서 알았다": 0, "안 왔다": 0 };
    for (let d = 9; d <= 30; d++) {
      const e = subOf(p, d);
      if (!e || e.mode === "min") continue;
      const a = e.answers || {};
      if (a.d_then === "끝까지") then["끝까지"]++;
      else if (a.d_then === "일부") then["일부"]++;
      else if (a.d_then === "못 했다") then["못 했다"]++;
      else if (a.d_then) then["해당 없음"]++;
      if (a.d_if && ifs[a.d_if] != null) ifs[a.d_if]++;
      const b = parseScore(a.d_before);
      const af = parseScore(a.d_after);
      if (b != null || af != null) series.push({ n: d, before: b, after: af });
    }
    stats.then = then;
    stats.ifs = ifs;
    stats.series = series;
    const pairs = series.filter((s) => s.before != null && s.after != null);
    stats.avgBefore = r1(avg(pairs.map((s) => s.before)));
    stats.avgAfter = r1(avg(pairs.map((s) => s.after)));
    stats.pairDays = pairs.length;
    stats.started = counts.started != null ? counts.started : then["끝까지"] + then["일부"];
    stats.doneAll = counts.done != null ? counts.done : then["끝까지"];
    // 1주차 평균 강도 → 마지막 주(Day 24~30) THEN 전 점수
    const lastWk = series.filter((s) => s.n >= 24 && s.before != null).map((s) => s.before);
    stats.firstAvg = stats.momentAvg;
    stats.lastAvg = r1(avg(lastWk));
    const weeks = [[1, 7], [8, 14], [15, 21], [22, 28], [29, 30]];
    stats.weeks = weeks.map(([a, b], i) => {
      const slice = days.filter((d) => d.n >= a && d.n <= b);
      return { label: `${i + 1}주차`, from: a, to: b, recorded: slice.filter((d) => d.state !== "miss").length, total: slice.length };
    });
    stats.formulas = (helpers.formulas || []).slice(0, 4);
    const d29 = ansOf(p, 29);
    const d30 = ansOf(p, 30);
    stats.words = {
      changed: str(d29.changed),
      same: str(d29.same),
      best: str(d30.d_best),
      keep3: str(d30.keep3),
      try1: str(d30.try1),
      oneline: str(d30.oneline),
    };
  }
  return stats;
}

// ── 분석 글 파싱 ──────────────────────────────────────────────
// 기대 형식: "## 한눈에 보기" 같은 제목 줄 + 문단/목록. 형식이 달라도(제목 없음 등) 깨지지 않고 한 장의 글로 보여줍니다.
const KIND_RULES = [
  ["summary", /한\s*눈|요약|핵심/],
  ["next", /다음|제안|한\s*걸음|앞으로|이어/],
  ["closing", /마무리|격려|응원/],
  ["care", /조심|주의|무너|위험|살펴|방심/],
  ["good", /잘하|잘한|잘 하|효과|강점|좋았|도움/],
  ["pattern", /패턴|변화|달라|발견|트리거|지도/],
];
const KIND_LABEL = { summary: "한눈에 보기", pattern: "패턴", good: "잘하고 있는 것", care: "살펴볼 것", next: "다음 한 걸음", closing: "마무리", other: "" };

function kindOf(title) {
  const t = str(title);
  for (const [k, re] of KIND_RULES) if (re.test(t)) return k;
  return "other";
}

const HEADING_RE = /^\s{0,3}#{1,4}\s+(.+?)\s*#*\s*$/;
const BOLD_LINE_RE = /^\s*\*\*([^*]{1,40})\*\*\s*[:：]?\s*$/;
const NUM_HEAD_RE = /^\s*(?:\d{1,2}[.)]|[①-⑩])\s+(.{2,40})$/;

function stripMd(s) {
  return String(s).replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/`([^`]+)`/g, "$1");
}

// 한 줄 안의 **굵게**만 지원하고 나머지는 전부 이스케이프합니다.
function inline(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/__(.+?)__/g, "<b>$1</b>");
}

function parseBlocks(lines) {
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) blocks.push({ type: "p", text: para.join("\n") });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const ul = /^\s*[-*•·]\s+(.*)$/.exec(line);
    const ol = /^\s*\d{1,2}[.)]\s+(.*)$/.exec(line);
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const type = ul ? "ul" : "ol";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((ul || ol)[1]);
    } else if (q) {
      flushPara();
      flushList();
      blocks.push({ type: "quote", text: q[1] });
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += " " + line.trim(); // 목록 항목의 이어지는 줄
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks;
}

function parseAnalysis(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const sections = [];
  let cur = { title: "", lines: [] };
  const push = () => {
    if (cur.title || cur.lines.some((l) => l.trim())) sections.push(cur);
  };
  // 번호 제목("1. ○○")은 목록과 구분하기 어려워서, 제목(#) 형식이 하나도 없을 때만 보조로 인정합니다.
  const hasHash = lines.some((l) => HEADING_RE.test(l) || BOLD_LINE_RE.test(l));
  for (const line of lines) {
    const m = HEADING_RE.exec(line) || BOLD_LINE_RE.exec(line) || (!hasHash ? NUM_HEAD_RE.exec(line) : null);
    if (m && (HEADING_RE.test(line) || BOLD_LINE_RE.test(line) || /^\s*\d/.test(line))) {
      push();
      cur = { title: stripMd(m[1]).replace(/[:：]\s*$/, "").trim(), lines: [] };
    } else cur.lines.push(line);
  }
  push();
  const out = sections.map((s) => {
    const kind = s.title ? kindOf(s.title) : "other";
    return { title: s.title, kind, blocks: parseBlocks(s.lines) };
  });
  const intro = out.length && !out[0].title ? out.shift() : null;
  return { intro: intro ? intro.blocks : [], sections: out };
}

function blocksToText(blocks, max = 700) {
  const t = blocks
    .map((b) => (b.type === "ul" || b.type === "ol" ? b.items.map((i) => "• " + stripMd(i)).join("\n") : stripMd(b.text)))
    .join("\n\n")
    .trim();
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, "") + "…" : t;
}

// DM·이미지 카드의 한 줄 요약: "한눈에 보기" 섹션 → 없으면 서두 → 없으면 첫 문단
function summaryOf(parsed, max = 600) {
  const s = parsed.sections.find((x) => x.kind === "summary");
  if (s) return blocksToText(s.blocks, max);
  if (parsed.intro.length) return blocksToText(parsed.intro, max);
  const first = parsed.sections.find((x) => x.blocks.length);
  return first ? blocksToText(first.blocks, max) : "";
}

// ── 렌더링: 차트(SVG) ────────────────────────────────────────
// 색은 전부 페이지의 CSS 변수(--sys, --warm …)를 따라가서 라이트/다크가 자동으로 맞습니다.
const f1 = (x) => (Math.round(x * 10) / 10).toString();

function stripSvg(days) {
  const per = days.length > 14 ? 10 : days.length;
  const rows = Math.ceil(days.length / per);
  const cell = 28;
  const gap = 6;
  const W = per * cell + (per - 1) * gap;
  const H = rows * cell + (rows - 1) * gap;
  const cells = days
    .map((d, i) => {
      const x = (i % per) * (cell + gap);
      const y = Math.floor(i / per) * (cell + gap);
      const cls = d.state === "done" ? "c-done" : d.state === "min" ? "c-min" : "c-miss";
      const label = `Day ${d.n}${d.state === "miss" ? " 기록 없음" : d.state === "min" ? " 한 줄 기록" : " 기록"}${d.late ? " (늦게)" : ""}${d.fell ? " · 무너짐" : ""}`;
      return `<g><title>${esc(label)}</title><rect class="${cls}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="7"/><text class="t-day${d.state === "miss" ? "" : d.state === "min" ? " min" : " on"}" x="${x + cell / 2}" y="${y + cell / 2 + 4}" text-anchor="middle">${d.n}</text>${d.fell ? `<circle class="c-fell" cx="${x + cell - 4}" cy="${y + 4}" r="4"/>` : ""}</g>`;
    })
    .join("");
  return `<svg class="svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="일별 기록 현황" style="max-width:${W}px">${cells}</svg>`;
}

function scoreClass(s) {
  return s >= 7 ? "hi" : s >= 4 ? "mid" : "lo";
}

function momentBarsHtml(moments) {
  const rows = moments.filter((m) => m.score != null);
  if (!rows.length) return "";
  return `<div class="bars">${rows
    .map(
      (m) =>
        `<div class="brow"><div class="blabel"><b>${esc(m.label)}</b>${m.where || m.feel ? `<span class="sub">${esc([m.where, m.feel].filter(Boolean).join(" · "))}</span>` : ""}</div><div class="btrack" role="img" aria-label="${esc(m.label)} 강도 ${f1(m.score)}점"><i class="${scoreClass(m.score)}" style="width:${(m.score / 10) * 100}%"></i></div><div class="bval">${f1(m.score)}</div></div>`
    )
    .join("")}</div><p class="axis"><span>0 약함</span><span>10 아주 강함</span></p>`;
}

function slotsHtml(slots) {
  if (!slots || !slots.length) return "";
  return `<div class="slots">${slots
    .map(
      (s) =>
        `<div class="slot ${s.urge === true ? "yes" : s.urge === false ? "no" : "na"}"><b>${esc(s.label)}</b><span class="sub">${esc(s.range)}</span><em>${s.urge === true ? "충동 있음" : s.urge === false ? "없음" : "기록 없음"}</em></div>`
    )
    .join("")}</div>`;
}

function chipsHtml(items, cls = "") {
  const xs = items.filter(Boolean);
  return xs.length ? `<div class="chips">${xs.map((x) => `<span class="chip ${cls}">${esc(x)}</span>`).join("")}</div>` : "";
}

function lineChartSvg(series) {
  const pts = series.filter((s) => s.before != null || s.after != null);
  if (pts.length < 2) return "";
  const W = 640;
  const H = 230;
  const L = 34;
  const R = 24;
  const T = 14;
  const B = 30;
  const x = (d) => L + ((d - 9) / 21) * (W - L - R);
  const y = (v) => T + (1 - v / 10) * (H - T - B);
  const grid = [0, 2.5, 5, 7.5, 10]
    .map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="t-ax" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`)
    .join("");
  const ticks = [9, 14, 21, 30].map((d) => `<text class="t-ax" x="${x(d)}" y="${H - 8}" text-anchor="middle">Day ${d}</text>`).join("");
  const path = (key) => {
    const arr = pts.filter((s) => s[key] != null);
    if (!arr.length) return "";
    const d = arr.map((s, i) => `${i ? "L" : "M"}${x(s.n).toFixed(1)} ${y(s[key]).toFixed(1)}`).join("");
    const last = arr[arr.length - 1];
    return `<path class="ln ${key}" d="${d}"/>${arr.map((s) => `<circle class="pt ${key}" cx="${x(s.n).toFixed(1)}" cy="${y(s[key]).toFixed(1)}" r="3"><title>Day ${s.n} · ${key === "before" ? "THEN 전" : "THEN 후"} ${f1(s[key])}</title></circle>`).join("")}<circle class="pt-end ${key}" cx="${x(last.n).toFixed(1)}" cy="${y(last[key]).toFixed(1)}" r="5.5"/>`;
  };
  return `<svg class="svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="날짜별 충동 점수 변화(THEN 전과 후)">${grid}${ticks}${path("before")}${path("after")}</svg>
<p class="legend"><span class="li"><span class="lg before"></span>THEN 하기 전</span><span class="li"><span class="lg after"></span>THEN 한 뒤</span></p>`;
}

function segBarHtml(parts, aria) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return "";
  return `<div class="seg" role="img" aria-label="${esc(aria)}">${parts
    .filter((p) => p.value > 0)
    .map((p) => `<i class="${p.cls}" style="flex:${p.value}" title="${esc(p.label)} ${p.value}일"><span>${p.value}</span></i>`)
    .join("")}</div><p class="legend">${parts.map((p) => `<span class="li"><span class="lg ${p.cls}"></span>${esc(p.label)} <b>${p.value}</b>일</span>`).join("")}</p>`;
}

function weeksHtml(weeks) {
  return `<div class="wks">${weeks
    .map((w) => {
      const h = w.total ? Math.round((w.recorded / w.total) * 100) : 0;
      return `<div class="wk"><div class="wcol" role="img" aria-label="${esc(w.label)} ${w.recorded}/${w.total}일"><i style="height:${h}%"></i></div><b>${w.recorded}<small>/${w.total}</small></b><span class="sub">${esc(w.label)}</span></div>`;
    })
    .join("")}</div>`;
}

function kpiHtml(items) {
  return `<div class="kpis">${items
    .map((k) => `<div class="kpi"><span class="kl">${esc(k.label)}</span><b class="kv">${esc(k.value)}${k.unit ? `<small>${esc(k.unit)}</small>` : ""}</b>${k.note ? `<span class="kn">${esc(k.note)}</span>` : ""}</div>`)
    .join("")}</div>`;
}

const dash = "—";
function kpiItems(st) {
  if (st.n === 7) {
    return [
      { label: "기록한 날", value: `${st.recorded}`, unit: ` / ${st.total}일`, note: st.minDays ? `한 줄 기록 ${st.minDays}일 포함` : "" },
      { label: "충동 순간 기록", value: st.moments.length ? `${st.moments.length}` : dash, unit: st.moments.length ? "개" : "", note: "Day 6 강도 표" },
      { label: "평균 강도", value: st.momentAvg != null ? f1(st.momentAvg) : dash, unit: st.momentAvg != null ? " / 10" : "", note: st.momentMax != null ? `가장 센 순간 ${f1(st.momentMax)}점` : "" },
      { label: "돌아온 횟수", value: `${st.returns}`, unit: "번", note: "쉬었다 다시 기록한 횟수" },
    ];
  }
  return [
    { label: "기록한 날", value: `${st.recorded}`, unit: ` / ${st.total}일`, note: st.minDays ? `한 줄 기록 ${st.minDays}일 포함` : "" },
    { label: "돌아온 횟수", value: `${st.returns}`, unit: "번", note: "쉬었다 다시 기록한 횟수" },
    { label: "THEN 시작한 날", value: `${st.started}`, unit: "일", note: st.doneAll ? `끝까지 한 날 ${st.doneAll}일` : "" },
    st.avgBefore != null && st.avgAfter != null
      ? { label: "충동 점수 변화", value: `${f1(st.avgBefore)} → ${f1(st.avgAfter)}`, unit: "", note: `THEN 전→후 평균 (${st.pairDays}일)` }
      : { label: "무너진 날", value: `${st.fell}`, unit: "일", note: "돌아와서 기록한 날 포함" },
  ];
}

// ── 렌더링: 페이지 본문 ──────────────────────────────────────
function blockHtml(b) {
  if (b.type === "ul") return `<ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`;
  if (b.type === "ol") return `<ol>${b.items.map((i) => `<li>${inline(i)}</li>`).join("")}</ol>`;
  if (b.type === "quote") return `<blockquote>${inline(b.text)}</blockquote>`;
  return `<p>${inline(b.text).replace(/\n/g, "<br>")}</p>`;
}

function sectionHtml(s) {
  const title = s.title || "";
  const label = KIND_LABEL[s.kind] && KIND_LABEL[s.kind] !== title ? `<span class="tag">${esc(KIND_LABEL[s.kind])}</span>` : "";
  return `<section class="rsec k-${s.kind}">${title ? `<h3>${esc(title)}${label}</h3>` : ""}${s.blocks.map(blockHtml).join("")}</section>`;
}

function observationHtml(st) {
  const parts = [];
  if (st.moments.some((m) => m.score != null)) parts.push(`<div class="panel"><h3>충동 순간별 강도</h3><p class="sub">Day 6에 직접 매긴 점수예요.</p>${momentBarsHtml(st.moments)}</div>`);
  if (st.slots && st.slots.some((s) => s.urge != null)) parts.push(`<div class="panel"><h3>충동이 오는 시간대</h3><p class="sub">Day 2 표에서 "있음"으로 고른 시간대예요.</p>${slotsHtml(st.slots)}</div>`);
  const chipBlocks = [];
  if (st.place || (st.devices && st.devices.length) || st.app) chipBlocks.push(`<div><h4>장소 · 기기 · 앱</h4>${chipsHtml([st.place, ...(st.devices || []), st.app ? "앱: " + st.app : ""])}</div>`);
  if (st.feelings && st.feelings.length) chipBlocks.push(`<div><h4>충동 직전의 기분</h4>${chipsHtml(st.feelings, "warm")}</div>`);
  if (st.thoughtKind || st.thoughtWords) chipBlocks.push(`<div><h4>머릿속에서 나온 말</h4>${chipsHtml([st.thoughtKind], "soft")}${st.thoughtWords ? `<blockquote>${esc(st.thoughtWords)}</blockquote>` : ""}</div>`);
  if (chipBlocks.length) parts.push(`<div class="panel"><h3>내 트리거 지도</h3><div class="cols2">${chipBlocks.join("")}</div></div>`);
  const mapRows = Object.entries(st.map7 || {}).filter(([, v]) => v);
  if (mapRows.length) parts.push(`<div class="panel"><h3>Day 7에 내가 정리한 것</h3><dl class="dl">${mapRows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>${st.trigger7 ? `<blockquote>${esc(st.trigger7)}</blockquote>` : ""}</div>`);
  return parts.join("");
}

function completionHtml(st) {
  const parts = [];
  const line = lineChartSvg(st.series || []);
  if (line) {
    const delta = st.avgBefore != null && st.avgAfter != null ? st.avgBefore - st.avgAfter : null;
    parts.push(`<div class="panel"><h3>충동 점수, THEN 전과 후</h3><p class="sub">${delta != null && delta > 0 ? `THEN을 하고 나면 평균 ${f1(delta)}점 내려갔어요. ` : ""}Day 9~30에 적은 점수예요.</p>${line}</div>`);
  }
  const t = st.then || {};
  const i = st.ifs || {};
  const thenBar = segBarHtml(
    [
      { cls: "s1", label: "끝까지", value: t["끝까지"] || 0 },
      { cls: "s2", label: "일부", value: t["일부"] || 0 },
      { cls: "s3", label: "못 했다", value: t["못 했다"] || 0 },
      { cls: "s4", label: "해당 없음", value: t["해당 없음"] || 0 },
    ],
    "THEN 실행 현황"
  );
  const ifBar = segBarHtml(
    [
      { cls: "s1", label: "왔을 때 알아챔", value: i["왔다"] || 0 },
      { cls: "s2", label: "지나고 나서 알았다", value: i["지나가고 나서 알았다"] || 0 },
      { cls: "s4", label: "안 왔다", value: i["안 왔다"] || 0 },
    ],
    "IF 도착 현황"
  );
  if (thenBar || ifBar) parts.push(`<div class="panel"><h3>공식을 쓴 기록</h3>${ifBar ? `<h4>IF(충동 신호)는 어땠나</h4>${ifBar}` : ""}${thenBar ? `<h4>THEN(내 행동)은 어땠나</h4>${thenBar}` : ""}</div>`);
  parts.push(`<div class="panel"><h3>주차별 기록한 날</h3>${weeksHtml(st.weeks)}</div>`);
  if (st.firstAvg != null && st.lastAvg != null) {
    parts.push(`<div class="panel"><h3>1주차와 마지막 주</h3><div class="cmp"><div><span class="sub">1주차 평균 강도</span><b>${f1(st.firstAvg)}</b></div><i aria-hidden="true">→</i><div><span class="sub">마지막 주 THEN 전 점수</span><b>${f1(st.lastAvg)}</b></div></div><p class="sub">Day 6의 강도 점수와 Day 24~30의 충동 점수를 비교했어요. 점수를 매기는 날의 상황이 달라서 참고용이에요.</p></div>`);
  }
  if (st.formulas && st.formulas.length) parts.push(`<div class="panel"><h3>지금 쓰고 있는 공식</h3><ul class="fl">${st.formulas.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>`);
  const w = st.words || {};
  const quotes = [["가장 도움이 된 공식", w.best], ["30일 사이 가장 달라진 것", w.changed], ["아직 달라지지 않은 것", w.same], ["다음 30일 · 유지할 것", w.keep3], ["다음 30일 · 새로 시도할 것", w.try1]].filter(([, v]) => v);
  if (quotes.length) parts.push(`<div class="panel"><h3>내가 직접 쓴 말</h3><dl class="dl">${quotes.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>${w.oneline ? `<blockquote>${esc(w.oneline)}</blockquote>` : ""}</div>`);
  return parts.join("");
}

function renderReportBody({ p, n, stats, parsed, sentDate, base, period, embedded }) {
  const summary = parsed.sections.find((s) => s.kind === "summary");
  const rest = parsed.sections.filter((s) => s !== summary);
  const headBlocks = summary ? summary.blocks : parsed.intro;
  const head = headBlocks.length
    ? `<section class="hero"><span class="tag">${esc(KIND_LABEL.summary)}</span>${headBlocks.map(blockHtml).join("")}</section>`
    : "";
  const introNote = summary && parsed.intro.length ? `<section class="rsec">${parsed.intro.map(blockHtml).join("")}</section>` : "";
  const headTag = embedded ? "h2" : "h1";
  return `<header class="rhead"><p class="eyebrow">REBOOT 30 · ${n}일 분석 리포트</p><${headTag}>${esc(p.name)}님의 ${n === 7 ? "첫 일주일" : "30일"}</${headTag}>
<p class="sub">${esc(period)}${sentDate ? ` · ${esc(sentDate)}에 정리했어요` : ""}</p></header>
${head}${introNote}
${kpiHtml(kpiItems(stats))}
<div class="panel"><h3>일별 기록 현황</h3>${stripSvg(stats.days)}<p class="legend"><span class="li"><span class="lg s1"></span>기록</span><span class="li"><span class="lg s5"></span>한 줄 기록</span><span class="li"><span class="lg s4"></span>기록 없음</span><span class="li"><span class="lg fell"></span>무너짐 기록</span></p></div>
${n === 7 ? observationHtml(stats) : completionHtml(stats)}
<div class="analysis"><p class="eyebrow">운영자의 분석</p>${rest.map(sectionHtml).join("") || (head ? "" : '<p class="sub">분석 글이 아직 없어요.</p>')}</div>
<div class="note">이 리포트는 내가 쓴 기록을 바탕으로 한 관찰과 제안이에요. 진단이나 치료가 아니에요. 많이 힘들다면 정신건강 위기상담전화 1577-0199(24시간)로 바로 연락할 수 있어요.</div>
${embedded ? "" : `<p class="noprint" style="margin-top:18px"><button class="btn" onclick="window.print()">인쇄하기</button> <a class="btn ghost" href="${esc(base)}">← 돌아가기</a></p>`}`;
}

const REPORT_CSS = `<style>
.wrap.report{max-width:760px}
.rhead h1,.rhead h2{font-size:1.7rem;margin:.1em 0 .15em;border:0;padding:0}
.embed-report{margin:18px 0 26px;padding-bottom:22px;border-bottom:2px dashed var(--line)}
.tag{display:inline-block;margin-left:8px;padding:1px 9px;border-radius:999px;background:var(--sys-soft);color:var(--sys);font-size:.72rem;font-weight:700;vertical-align:middle;letter-spacing:.02em}
.hero{background:var(--sys);color:var(--bg);border-radius:16px;padding:18px 20px;margin:16px 0}
.hero .tag{margin:0 0 8px;background:rgba(255,255,255,.18);color:inherit}
.hero p,.hero li{font-size:1.06rem;line-height:1.7;margin:.35em 0}
.hero ul,.hero ol{margin:.3em 0;padding-left:20px}
.hero b{font-weight:800}
.kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:14px 0}
@media(min-width:640px){.kpis{grid-template-columns:repeat(4,1fr)}}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:2px;min-width:0}
.kl{font-size:.78rem;color:var(--sub);font-weight:700}
.kv{font-size:1.7rem;line-height:1.2;font-variant-numeric:tabular-nums;white-space:nowrap}
.kv small{font-size:.8rem;color:var(--sub);font-weight:600;margin-left:1px}
.kn{font-size:.74rem;color:var(--sub);line-height:1.4}
.panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:14px 0;overflow:hidden}
.panel h3{margin:0 0 2px;font-size:1rem}
.panel h4{margin:14px 0 6px;font-size:.84rem;color:var(--sub)}
.panel>.sub{margin:0 0 10px}
.svg{display:block;width:100%;height:auto;margin:8px auto 4px}
.svg .c-done{fill:var(--sys-bright)}.svg .c-min{fill:var(--sys-soft);stroke:var(--sys-bright);stroke-width:1.5}
.svg .c-miss{fill:var(--soft);stroke:var(--line)}
.svg .c-fell{fill:var(--warm);stroke:var(--card);stroke-width:1.5}
.svg .t-day{font-size:11px;fill:var(--sub);font-variant-numeric:tabular-nums}.svg .t-day.on{fill:#14200a;font-weight:700}
.svg .t-day.min{fill:var(--ink);font-weight:700}
@media(prefers-color-scheme:dark){.svg .t-day.on{fill:#10180a}}
.svg .grid{stroke:var(--line);stroke-width:1;stroke-dasharray:3 4}
.svg .t-ax{font-size:11px;fill:var(--sub);font-variant-numeric:tabular-nums}
.svg .ln{fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.svg .ln.before{stroke:var(--warm)}.svg .ln.after{stroke:var(--sys)}
.svg .pt{fill:var(--card);stroke-width:2}.svg .pt.before{stroke:var(--warm)}.svg .pt.after{stroke:var(--sys)}
.svg .pt-end.before{fill:var(--warm)}.svg .pt-end.after{fill:var(--sys)}
.legend{display:flex;gap:6px 14px;flex-wrap:wrap;align-items:center;font-size:.8rem;color:var(--sub);margin:6px 0 0}
.li{display:inline-flex;align-items:center;gap:6px}
.lg{display:inline-block;width:12px;height:12px;border-radius:4px;flex:none;background:var(--soft);border:1px solid var(--line)}
.lg.before{background:var(--warm);border-color:var(--warm)}.lg.after{background:var(--sys);border-color:var(--sys)}.lg.s1{background:var(--sys-bright);border-color:var(--sys-bright)}
.lg.s2{background:var(--sys);border-color:var(--sys)}.lg.s3{background:var(--danger);border-color:var(--danger)}
.lg.s4{background:var(--soft)}.lg.s5{background:var(--sys-soft);border-color:var(--sys-bright)}
.lg.fell{background:var(--warm);border-radius:50%;border-color:var(--card)}
.bars{display:grid;gap:10px;margin-top:8px}
.brow{display:grid;grid-template-columns:minmax(90px,34%) 1fr 34px;gap:10px;align-items:center}
.blabel{display:flex;flex-direction:column;min-width:0;line-height:1.3;font-size:.88rem}
.blabel .sub{font-size:.74rem;overflow-wrap:anywhere}
.btrack{height:14px;background:var(--soft);border-radius:999px;overflow:hidden}
.btrack i{display:block;height:100%;border-radius:999px}
.btrack i.lo{background:var(--sys-bright)}.btrack i.mid{background:var(--warm)}.btrack i.hi{background:var(--danger)}
.bval{font-weight:800;text-align:right;font-variant-numeric:tabular-nums}
.axis{display:flex;justify-content:space-between;font-size:.72rem;color:var(--sub);margin:4px 44px 0 calc(34% + 10px)}
@media(max-width:480px){.axis{margin-left:0;margin-right:44px}}
.slots{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:6px}
@media(min-width:560px){.slots{grid-template-columns:repeat(4,1fr)}}
.slot{border:1px solid var(--line);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:1px;background:var(--soft)}
.slot em{font-style:normal;font-size:.8rem;font-weight:700;margin-top:4px;color:var(--sub)}
.slot.yes{background:var(--warm-soft);border-color:var(--warm)}.slot.yes em{color:var(--warm)}
.slot.no{background:var(--sys-soft);border-color:var(--sys-bright)}.slot.no em{color:var(--sys)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{border-radius:999px;padding:3px 12px;font-size:.86rem;background:var(--sys-soft);color:var(--sys);font-weight:600}
.chip.warm{background:var(--warm-soft);color:var(--warm)}.chip.soft{background:var(--soft);color:var(--ink)}
.cols2{display:grid;gap:4px 24px}@media(min-width:640px){.cols2{grid-template-columns:1fr 1fr}}
.seg{display:flex;height:30px;border-radius:10px;overflow:hidden;gap:2px;margin:4px 0 2px}
.seg i{display:grid;place-items:center;font-style:normal;font-size:.78rem;font-weight:800;min-width:22px;color:#14200a}
.seg i.s1{background:var(--sys-bright)}.seg i.s2{background:var(--sys);color:var(--bg)}.seg i.s3{background:var(--danger);color:#fff}.seg i.s4{background:var(--soft);color:var(--sub)}
.wks{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;align-items:end;margin-top:10px;text-align:center}
.wk{display:flex;flex-direction:column;gap:2px;align-items:center}
.wcol{width:100%;max-width:56px;height:96px;background:var(--soft);border-radius:10px;display:flex;align-items:flex-end;overflow:hidden}
.wcol i{display:block;width:100%;background:var(--sys-bright);border-radius:10px 10px 0 0}
.wk b{font-variant-numeric:tabular-nums}.wk small{color:var(--sub);font-weight:600}
.cmp{display:flex;gap:14px;align-items:center;margin:8px 0}
.cmp div{display:flex;flex-direction:column;flex:1;background:var(--soft);border-radius:12px;padding:10px 12px}
.cmp b{font-size:1.6rem;font-variant-numeric:tabular-nums}.cmp i{font-style:normal;color:var(--sub);font-size:1.3rem}
.dl{margin:6px 0 0}.dl dt{font-size:.78rem;font-weight:700;color:var(--sub);margin-top:10px}.dl dd{margin:2px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.panel blockquote,.rsec blockquote{margin:10px 0 0;border-left:4px solid var(--sys-bright);padding:4px 12px;font-weight:600;overflow-wrap:anywhere}
.fl{margin:6px 0 0;padding-left:20px}.fl li{margin:4px 0;overflow-wrap:anywhere}
.analysis{margin-top:26px}
.rsec{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:12px 0}
.rsec h3{margin:0 0 6px;font-size:1.02rem;line-height:1.4}
.rsec p,.rsec li{margin:.4em 0;line-height:1.7;overflow-wrap:anywhere}
.rsec ul,.rsec ol{margin:.3em 0;padding-left:20px}
.rsec.k-next{background:var(--warm-soft);border-color:var(--warm)}
.rsec.k-next .tag{background:var(--warm);color:var(--card)}
.rsec.k-care .tag{background:var(--warm-soft);color:var(--warm)}
.rsec.k-closing{background:var(--soft);border-style:dashed}
@media print{.hero{background:#fff;color:#000;border:1px solid #999}.panel,.rsec,.kpi{break-inside:avoid}}
</style>`;

module.exports = { computeStats, parseAnalysis, summaryOf, renderReportBody, REPORT_CSS, parseScore, KIND_LABEL, blocksToText, kpiItems, stripMd };

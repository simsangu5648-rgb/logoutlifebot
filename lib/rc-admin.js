// REBOOT 30 운영자 관리 화면(구글 폼 느낌의 대시보드)을 그리는 렌더러.
// 데이터 계산은 rc.js가 하고, 여기서는 미리 계산된 값(view model)만 받아 HTML로 만듭니다.

const { esc, nl2br, layout } = require("./rc-render");

const ADMIN_CSS = `
:root{
  --bg:#f0ebf8; --card:#ffffff; --ink:#202124; --sub:#5f6368; --line:#dadce0; --soft:#f1f3f4;
  --sys:#673ab7; --sys-soft:#ede7f6; --sys-bright:#b39ddb; --warm:#a05a00; --warm-soft:#fef3d9;
  --danger:#c5221f; --danger-soft:#fce8e6; --focus:#673ab7; --shadow:0 1px 2px rgba(60,64,67,.25),0 1px 3px 1px rgba(60,64,67,.12);
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#1d1a27; --card:#292535; --ink:#ebe9f2; --sub:#aaa5ba; --line:#413b54; --soft:#342f44;
    --sys:#b39ddb; --sys-soft:#3a3150; --sys-bright:#8a6fd1; --warm:#f0b45b; --warm-soft:#3d3220;
    --danger:#f28b82; --danger-soft:#4a2523; --focus:#b39ddb; --shadow:0 1px 2px rgba(0,0,0,.5);
  }
}
[hidden]{display:none!important}
.wrap.wide{max-width:1040px}
.top{background:var(--card);border-radius:8px;border-top:10px solid var(--sys);box-shadow:var(--shadow);padding:20px 22px;margin:8px 0 14px}
.top h1{margin:0 0 4px;font-size:1.6rem}
.top .sub{margin:0}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 0}
.stat{background:var(--soft);border-radius:999px;padding:5px 14px;font-size:.88rem;color:var(--sub)}
.stat b{color:var(--ink);font-size:1rem;margin-right:4px}
.stat.hot{background:var(--danger-soft);color:var(--danger)}
.stat.hot b{color:var(--danger)}
.card{border:0;border-radius:8px;box-shadow:var(--shadow);padding:18px 22px;margin:12px 0}
.card>b:first-child,.card>.ct{display:block;font-size:1.02rem;margin-bottom:6px}
.btn{border-radius:6px;padding:10px 20px;font-size:.95rem}
.btn.sm{padding:6px 14px;font-size:.85rem}
.btn.ghost{border-color:var(--line)}
.todo{list-style:none;margin:6px 0 0;padding:0}
.todo li{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:9px 0;border-top:1px solid var(--line)}
.todo li:first-child{border-top:0}
.todo .grow{flex:1;min-width:180px}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:18px 0 6px;position:sticky;top:0;z-index:5;background:var(--bg);padding:8px 0}
.fchip{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:999px;padding:6px 14px;font:inherit;font-size:.88rem;cursor:pointer}
.fchip.on{background:var(--sys);border-color:var(--sys);color:#fff;font-weight:700}
.fchip small{opacity:.75;margin-left:4px}
#q{max-width:200px;margin-left:auto;border-radius:999px;padding:7px 14px;font-size:.9rem}
.stage{margin:22px 0 0}
.stage h2{margin:0 0 8px;font-size:1.05rem;display:flex;gap:10px;align-items:baseline}
.stage h2 small{color:var(--sub);font-weight:400}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.pc{position:relative;background:var(--card);border-radius:8px;box-shadow:var(--shadow);padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.pc:hover{box-shadow:0 1px 3px rgba(60,64,67,.3),0 4px 8px 3px rgba(60,64,67,.15)}
.pc.hot{outline:2px solid var(--danger)}
.pc .nm{font-weight:700;font-size:1.02rem;color:var(--ink);text-decoration:none}
.pc .nm::after{content:"";position:absolute;inset:0}
.pc .day{font-size:.9rem;color:var(--sub)}
.pc .day b{color:var(--sys)}
.prog{height:6px;border-radius:3px;background:var(--soft);overflow:hidden}
.prog i{display:block;height:100%;background:var(--sys-bright)}
.pc .meta{font-size:.82rem;color:var(--sub)}
.pc .bd{display:flex;gap:6px;flex-wrap:wrap;align-items:center;position:relative;z-index:1}
.ch{display:inline-block;border-radius:6px;padding:2px 9px;font-size:.78rem;font-weight:600;background:var(--soft);color:var(--sub);text-decoration:none;position:relative;z-index:1}
.ch.red{background:var(--danger-soft);color:var(--danger)}
.ch.ok{background:var(--sys-soft);color:var(--sys)}
.ch.warm{background:var(--warm-soft);color:var(--warm)}
.empty{color:var(--sub);padding:30px 0;text-align:center}
.pbar{display:flex;gap:4px;flex-wrap:wrap;margin:12px 0 2px}
.pbar a{width:26px;height:26px;border-radius:6px;background:var(--soft);display:grid;place-items:center;font-size:.7rem;color:var(--sub);text-decoration:none;border:1px solid var(--line)}
.pbar a.done{background:var(--sys-bright);border-color:var(--sys-bright);color:#fff}
.pbar a.new{background:var(--sys);border-color:var(--sys);color:#fff;font-weight:700}
.pbar a.crisis{background:var(--danger);border-color:var(--danger);color:#fff}
.pbar a.cur{outline:2px solid var(--sys);outline-offset:1px}
details.ana,details.day{border:1px solid var(--line);border-radius:8px;padding:0;margin:10px 0;background:var(--card)}
details.ana>summary,details.day>summary{cursor:pointer;padding:12px 16px;font-weight:600;list-style:none;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
details.ana>summary::-webkit-details-marker,details.day>summary::-webkit-details-marker{display:none}
details.ana>summary::before,details.day>summary::before{content:"▸";color:var(--sub);transition:transform .15s}
details[open].ana>summary::before,details[open].day>summary::before{transform:rotate(90deg)}
details.ana .body,details.day .body{padding:0 16px 16px}
.step{margin:12px 0}
.step>b{display:block;margin-bottom:6px}
.step textarea{font-size:.85rem}
.pbar a:focus-visible,.fchip:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
@media(max-width:560px){#q{max-width:none;flex:1 1 100%;margin-left:0}.top{padding:16px}.card{padding:16px}}
`;

const STAGES = [
  { k: "pre", t: "시작 전", d: "Day 0 체크 전" },
  { k: "w1", t: "Day 1–7", d: "관찰기" },
  { k: "w2", t: "Day 8–14" },
  { k: "w3", t: "Day 15–21" },
  { k: "w4", t: "Day 22–30" },
  { k: "done", t: "완주", d: "30일을 마친 분들" },
];

const adminLayout = (title, body) => layout({ title, wide: true, body, head: `<style>${ADMIN_CSS}</style>` });

const stBadge = (v) =>
  v.status === "completed" ? '<span class="ch ok">완주</span>' : v.status === "paused" ? '<span class="ch">쉬는 중</span>' : '<span class="ch ok">진행 중</span>';

const flagChips = (v) =>
  [
    v.flags.crisis ? '<span class="ch red">위기 신호</span>' : "",
    v.flags.screening ? '<span class="ch warm">안전 체크 해당</span>' : "",
    v.flags.fell ? '<span class="ch warm">무너짐 기록</span>' : "",
  ].join("");

const anaChip = (v, n) => {
  const a = v.ana[n];
  const href = `/admin/p/${esc(v.uid)}?open=${n}#ana-${n}`;
  if (a.state === "sent") return `<a class="ch ok" href="${href}">${n}일 분석 ✓</a>`;
  if (a.state === "wait") return `<a class="ch red" href="${href}">${n}일 분석 대기</a>`;
  return `<a class="ch" href="${href}">${n}일 ${esc(a.md)} 예정</a>`;
};

function personCard(v) {
  const pct = Math.round((v.recorded / 30) * 100);
  const dayText =
    v.stage === "done"
      ? "<b>30일 완주</b>"
      : v.stage === "pre"
      ? "<b>시작 전 체크</b>를 하는 중"
      : `<b>Day ${v.workDay}</b> 하는 중`;
  const quiet = v.silentDays != null ? ` · <span style="color:var(--warm)">${v.silentDays}일째 조용해요</span>` : "";
  return `<div class="pc${v.hot ? " hot" : ""}" data-stage="${esc(v.stage)}" data-name="${esc(v.name.toLowerCase())}">
<a class="nm" href="/admin/p/${esc(v.uid)}">${esc(v.name)}</a>
<div class="bd">${stBadge(v)}${flagChips(v)}${v.unread ? `<span class="ch red">새 글 ${v.unread}</span>` : ""}</div>
<div class="day">${dayText} · 기록 ${v.recorded}/30일</div>
<div class="prog" aria-hidden="true"><i style="width:${pct}%"></i></div>
<div class="meta">시작 ${esc(v.startDate)} · 마지막 제출 ${esc(v.lastDate)}${quiet}</div>
<div class="bd">${anaChip(v, 7)}${anaChip(v, 30)}</div>
</div>`;
}

function renderDashboard({ list, stats, attention, settings }) {
  const counts = {};
  for (const v of list) counts[v.stage] = (counts[v.stage] || 0) + 1;
  const chips =
    `<button type="button" class="fchip on" data-f="all">전체<small>${list.length}</small></button>` +
    STAGES.filter((s) => counts[s.k])
      .map((s) => `<button type="button" class="fchip" data-f="${s.k}">${esc(s.t)}<small>${counts[s.k]}</small></button>`)
      .join("");
  const sections = STAGES.filter((s) => counts[s.k])
    .map(
      (s) =>
        `<section class="stage" data-sec="${s.k}"><h2>${esc(s.t)} <small>${counts[s.k]}명${s.d ? " · " + esc(s.d) : ""}</small></h2><div class="grid">${list
          .filter((v) => v.stage === s.k)
          .map(personCard)
          .join("")}</div></section>`
    )
    .join("");

  const li = [];
  for (const c of attention.crisis)
    li.push(`<li><span class="ch red">위기 신호</span><span class="grow"><b>${esc(c.name)}</b> <span class="sub">${esc(c.label)} · 확인하지 않은 기록</span></span><a class="btn sm" href="/admin/p/${esc(c.uid)}">열어보기</a></li>`);
  for (const a of attention.pending)
    li.push(`<li><span class="ch red">분석 대기</span><span class="grow"><b>${esc(a.name)}</b> <span class="sub">${a.n}일차 기록을 제출했어요</span></span><a class="btn sm" href="/admin/p/${esc(a.uid)}?open=${a.n}#ana-${a.n}">분석 보내기</a></li>`);
  for (const u of attention.upcoming)
    li.push(`<li><span class="ch warm">${u.inDays === 0 ? "오늘" : u.inDays + "일 뒤"}</span><span class="grow"><b>${esc(u.name)}</b> <span class="sub">${u.n}일차 예정 · ${esc(u.md)}</span></span></li>`);
  for (const s of attention.silent)
    li.push(`<li><span class="ch">조용함</span><span class="grow"><b>${esc(s.name)}</b> <span class="sub">${s.days}일째 기록이 없어요</span></span><a class="btn sm ghost" href="/admin/p/${esc(s.uid)}">보기</a></li>`);
  const todo = li.length
    ? `<div class="card"><span class="ct">지금 챙길 것</span><ul class="todo">${li.join("")}</ul></div>`
    : `<div class="card"><span class="ct">지금 챙길 것</span><p class="sub">지금은 확인할 게 없어요. 👍</p></div>`;

  const body = `
<div class="top"><p class="eyebrow">REBOOT 30 · 운영자 전용</p><h1>챌린지 관리</h1>
<p class="sub">몇 일차에 있는 사람이 누구인지 한눈에 보고, 기록 확인과 분석 전송까지 여기서 해요.</p>
<div class="chips">
<span class="stat"><b>${stats.total}</b>전체</span><span class="stat"><b>${stats.active}</b>진행 중</span><span class="stat"><b>${stats.paused}</b>쉬는 중</span><span class="stat"><b>${stats.completed}</b>완주</span>
${stats.unread ? `<span class="stat hot"><b>${stats.unread}</b>안 읽은 기록</span>` : ""}${stats.pendingAnalysis ? `<span class="stat hot"><b>${stats.pendingAnalysis}</b>분석 대기</span>` : ""}
</div></div>
${todo}
<div class="filters" role="toolbar" aria-label="일차별 보기">${chips}<input type="text" id="q" placeholder="이름 검색" aria-label="이름 검색"></div>
${sections || '<p class="empty">아직 참가자가 없어요. 구매자가 입장 링크로 들어오면 여기에 나타나요.</p>'}
<details class="tip" style="margin-top:28px"><summary>설정 (입장 링크 · 캘린더 · 내보내기)</summary>
<div class="card"><span class="ct">구매자 입장 링크</span><p style="word-break:break-all"><code>${esc(settings.joinUrl)}</code></p>
<p class="sub">랜딩페이지의 결제 완료 화면에서만 보이게 하세요. 새는 것 같으면 재발급하세요(이미 들어온 사람은 그대로 유지돼요).</p>
<form method="post" action="/admin/rotate-join" onsubmit="return confirm('입장 링크를 재발급할까요? 기존 링크는 바로 쓸 수 없게 돼요.')"><button class="btn ghost sm" type="submit">입장 링크 재발급</button></form></div>
<div class="card"><span class="ct">분석 일정 캘린더 구독</span><p style="word-break:break-all"><code>${esc(settings.calUrl)}</code></p>
<p class="sub">구글 캘린더 → 다른 캘린더 + → URL로 추가. 새 참가자의 7일차·30일차가 자동으로 들어가요(반영에 몇 시간~하루 걸릴 수 있어요).</p>
<form method="post" action="/admin/rotate-cal" onsubmit="return confirm('캘린더 주소를 재발급할까요? 기존 구독은 끊겨요.')"><button class="btn ghost sm" type="submit">캘린더 주소 재발급</button></form></div>
<div class="card"><span class="ct">완주 후 다시 시작 허용</span><p class="sub">완주 전에는 누구나 다시 시작할 수 있어요. 완주한 사람에게 예외로 한 번 더 열어주려면 디스코드 ID를 넣어주세요.</p>
<form method="post" action="/admin/allow" class="row"><input type="text" name="uid" inputmode="numeric" pattern="\\d{15,25}" placeholder="디스코드 ID" style="max-width:260px" required><button class="btn ghost sm" type="submit">허용</button></form></div>
<p><a href="/admin/export.json" class="btn ghost sm">전체 내보내기(JSON)</a></p>
</details>
<script>
(function(){var chips=document.querySelectorAll('[data-f]'),cards=document.querySelectorAll('.pc'),secs=document.querySelectorAll('.stage'),q=document.getElementById('q'),cur='all';
function apply(){var s=(q.value||'').trim().toLowerCase();cards.forEach(function(c){c.hidden=!((cur==='all'||c.dataset.stage===cur)&&(!s||c.dataset.name.indexOf(s)>-1));});secs.forEach(function(sec){sec.hidden=!sec.querySelectorAll('.pc:not([hidden])').length;});}
chips.forEach(function(b){b.addEventListener('click',function(){cur=b.dataset.f;chips.forEach(function(x){x.classList.toggle('on',x===b)});apply();});});
q.addEventListener('input',apply);})();
</script>`;
  return adminLayout("챌린지 관리", body);
}

// 분석 한 건(프롬프트 복사 → 결과 붙여넣기 → 보내기)
function analysisBlock({ v, n, prompt, result, sentAt, open, flash }) {
  const a = v.ana[n];
  const status =
    a.state === "sent"
      ? `<span class="ch ok">전송됨 ${esc((sentAt || "").slice(0, 10))}</span>`
      : a.state === "wait"
      ? '<span class="ch red">분석 대기</span>'
      : `<span class="ch">${esc(a.md)} 예정</span>`;
  const note = !v.submitted[n] ? `<p class="note">아직 Day ${n}을 제출하지 않았어요. 지금까지의 기록으로 만든 프롬프트예요.</p>` : "";
  return `<details class="ana" id="ana-${n}"${open ? " open" : ""}>
<summary>${n}일차 분석 ${status}</summary>
<div class="body">
${flash || ""}${note}
<div class="step"><b>① 프롬프트 복사 → Claude에 붙여넣기</b>
<textarea id="pr${n}" rows="7" readonly>${esc(prompt)}</textarea>
<p><button class="btn sm" type="button" onclick="copyPr('pr${n}',this)">프롬프트 복사</button> <span class="sub">${prompt.length.toLocaleString()}자 · 이름과 기록이 들어 있어요. Claude 대화창에만 붙여넣으세요.</span></p></div>
<form method="post" action="/admin/p/${esc(v.uid)}/analysis/${n}" data-name="${esc(v.name)}" onsubmit="return confirm(this.dataset.name+'님께 이 분석을 DM으로 보낼까요?')">
<div class="step"><b>② 분석 결과 붙여넣기 → 보내기</b>
<textarea name="text" rows="12" maxlength="6000" required placeholder="Claude가 쓴 분석문을 그대로 붙여넣으세요. 보내기 전에 한 번 읽어보고 고쳐도 좋아요.">${esc(result || "")}</textarea>
<p><button class="btn" type="submit">${result ? "수정해서 다시 보내기" : "DM으로 보내기"}</button> <span class="sub">디스코드 DM으로 바로 전달되고, 챌린저의 개인 페이지에도 올라가요.</span></p></div>
</form>
</div></details>`;
}

function renderParticipant({ v, days, replies, analysis, flash }) {
  const dots = days
    .map((d) => {
      const cls = [d.done ? "done" : "", d.unread ? "new" : "", d.crisis ? "crisis" : "", d.cur ? "cur" : ""].filter(Boolean).join(" ");
      return d.done ? `<a class="${cls}" href="#day-${d.n}" title="${esc(d.label)}">${d.n}</a>` : `<a class="${cls}" href="#" onclick="return false" title="${esc(d.label)} · 아직 없음" style="opacity:.55">${d.n}</a>`;
    })
    .join("");
  const dayBlocks = days
    .filter((d) => d.done)
    .reverse()
    .map(
      (d) =>
        `<details class="day" id="day-${d.n}"${d.unread || d.crisis ? " open" : ""}><summary><span>${esc(d.label)}</span><span class="sub">${esc(d.when)}${d.min ? " · 한 줄" : ""}${d.late ? " · 늦게 작성" : ""}</span>${d.unread ? '<span class="ch red">새 글</span>' : ""}${d.flags}</summary><div class="body">${d.html}</div></details>`
    )
    .join("");
  const body = `
<p><a href="/admin">← 전체 목록</a></p>
<div class="top"><p class="eyebrow">참가자</p><h1>${esc(v.name)} ${stBadge(v)} ${flagChips(v)}</h1>
<p class="sub">디스코드 ID ${esc(v.uid)} · 시작 ${esc(v.startDate)} · 오늘 Day ${v.cur} · 기록한 날 ${v.recorded}일 · <a href="/admin/p/${esc(v.uid)}.json">JSON</a></p>
<div class="pbar" role="navigation" aria-label="일차별 기록">${dots}</div></div>
${flash || ""}
<div class="card"><span class="ct">분석 리포트</span><p class="sub">프롬프트를 복사해 Claude에서 분석한 뒤, 결과를 붙여넣고 보내면 바로 DM으로 전달돼요.</p>${analysis}</div>
<div class="card"><span class="ct">답장 보내기 (봇이 DM으로 전달해요)</span>
<form method="post" action="/admin/p/${esc(v.uid)}/reply"><textarea name="text" rows="4" maxlength="1800" required placeholder="따뜻하게, 짧게. 지시나 훈계보다 사실과 격려가 좋아요."></textarea>
<p><button class="btn" type="submit">DM으로 보내기</button></p></form>${replies}</div>
<div class="card"><span class="ct">제출한 기록</span>${dayBlocks || '<p class="sub">제출한 기록이 아직 없어요.</p>'}</div>
<script>
function copyPr(id,btn){var t=document.getElementById(id);t.focus();t.select();var done=function(){btn.textContent='복사됨 ✓'};
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t.value).then(done,function(){document.execCommand('copy');done()})}else{document.execCommand('copy');done()}}
if(location.hash){var el=document.querySelector(location.hash);if(el&&el.tagName==='DETAILS')el.open=true}
</script>`;
  return adminLayout(v.name + " · 챌린지", body);
}

module.exports = { renderDashboard, renderParticipant, analysisBlock, STAGES, ADMIN_CSS, nl2br };

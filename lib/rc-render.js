// 챌린지 폼/관리 페이지의 HTML 렌더러. 외부 라이브러리·외부 폰트 없이 한 페이지씩 자급자족으로 만듭니다.
// 사용자 입력은 전부 esc()를 거쳐서 출력합니다 (관리자 화면에서 XSS가 생기지 않도록).

const { DAILY_FIELDS, MIN_FIELDS } = require("./rc-content");

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nl2br(s) {
  return esc(s).replace(/\n/g, "<br>");
}

const CSS = `
:root{
  --bg:#faf6ef; --card:#fffdf8; --ink:#221f19; --sub:#6d6757; --line:#e4ddcb; --soft:#f2eee1;
  --sys:#43661c; --sys-soft:#e9f0da; --sys-bright:#8fb84a; --warm:#8a4f2c; --warm-soft:#f3e3d5;
  --danger:#a3392b; --danger-soft:#f8e1dc; --focus:#43661c;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#15130f; --card:#1c1a14; --ink:#efe9d9; --sub:#a29d88; --line:#33301f; --soft:#242116;
    --sys:#a9d15f; --sys-soft:#232d14; --sys-bright:#8fb84a; --warm:#e0a37e; --warm-soft:#33241a;
    --danger:#ee8f7f; --danger-soft:#3a1f1b; --focus:#a9d15f;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Noto Sans KR","Malgun Gothic",sans-serif;line-height:1.65;font-size:16px}
.wrap{max-width:680px;margin:0 auto;padding:20px 16px 80px}
.wrap.wide{max-width:980px}
h1{font-size:1.45rem;line-height:1.35;margin:.2em 0 .35em;text-wrap:balance}
h2{font-size:1.1rem;margin:1.6em 0 .5em}
p{margin:.5em 0}
a{color:var(--sys)}
.eyebrow{font-size:.78rem;letter-spacing:.06em;color:var(--sub);text-transform:uppercase}
.sub{color:var(--sub);font-size:.92rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 16px;margin:14px 0}
.goal{background:var(--sys-soft);border-radius:12px;padding:12px 14px;margin:12px 0;font-weight:600}
.btn{display:inline-block;border:0;border-radius:12px;padding:13px 20px;font-size:1rem;font-weight:700;background:var(--sys);color:var(--bg);cursor:pointer;text-decoration:none;text-align:center}
.btn.ghost{background:transparent;color:var(--sys);border:1px solid var(--line)}
.btn.danger{background:var(--danger);color:#fff}
.btn:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.btn[disabled]{opacity:.55;cursor:default}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.bar{display:flex;gap:3px;flex-wrap:wrap;margin:10px 0 4px}
.dot{width:20px;height:20px;border-radius:6px;background:var(--soft);border:1px solid var(--line);font-size:.62rem;display:grid;place-items:center;color:var(--sub);text-decoration:none}
.dot.done{background:var(--sys-bright);border-color:var(--sys-bright);color:#14200a}
.dot.today{outline:2px solid var(--sys);outline-offset:1px}
.dot.locked{opacity:.4}
.part{display:inline-block;background:var(--warm-soft);color:var(--warm);border-radius:999px;padding:2px 10px;font-size:.78rem;font-weight:700}
.f{display:block;margin:18px 0}
.f>.l{display:block;font-weight:700;margin-bottom:6px}
.opt{font-weight:400;color:var(--sub);font-size:.82rem;margin-left:6px}
.hint{display:block;color:var(--sub);font-size:.85rem;margin-top:4px}
input[type=text],input[type=number],textarea,select{width:100%;font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 12px}
textarea{resize:vertical;min-height:84px}
.pills{display:flex;flex-direction:column;gap:8px}
.pill{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--line);background:var(--card);border-radius:10px;padding:10px 12px;cursor:pointer}
.pill input{margin-top:4px;accent-color:var(--sys)}
.pill:has(input:checked){border-color:var(--sys);background:var(--sys-soft)}
.scale{display:grid;grid-template-columns:repeat(11,1fr);gap:4px}
.scale label{border:1px solid var(--line);background:var(--card);border-radius:8px;text-align:center;padding:9px 0;cursor:pointer;font-size:.92rem}
.scale input{position:absolute;opacity:0;pointer-events:none}
.scale label:has(input:checked){background:var(--sys);color:var(--bg);border-color:var(--sys);font-weight:700}
.scale label:has(input:focus-visible){outline:3px solid var(--focus)}
.rowcard{border:1px solid var(--line);background:var(--card);border-radius:12px;padding:12px;margin:8px 0}
.rowcard .rl{font-weight:700;margin-bottom:6px;font-size:.95rem}
.cols{display:grid;gap:8px}
@media(min-width:560px){.cols.c2{grid-template-columns:1fr 1fr}.cols.c3{grid-template-columns:1fr 1fr 1fr}.cols.c4{grid-template-columns:1fr 1fr 1fr 1fr}}
.cols label span{display:block;font-size:.8rem;color:var(--sub);margin-bottom:2px}
.formula{display:grid;gap:8px}
.formula .tag{display:inline-block;min-width:44px;font-weight:800;color:var(--sys)}
.note{background:var(--soft);border-radius:10px;padding:10px 12px;color:var(--sub);font-size:.93rem}
.auto{background:var(--soft);border:1px dashed var(--line);border-radius:12px;padding:12px 14px;font-size:.93rem}
.auto b.t{display:block;margin-bottom:6px}
.auto table{border-collapse:collapse;width:100%;font-size:.88rem}
.auto td,.auto th{border-bottom:1px solid var(--line);padding:5px 6px;text-align:left;vertical-align:top}
.auto ul{margin:4px 0 4px 18px;padding:0}
.quote{border-left:4px solid var(--sys-bright);padding:6px 14px;margin:22px 0;font-weight:600}
.sticky{position:sticky;bottom:0;background:linear-gradient(to top,var(--bg) 70%,transparent);padding:14px 0 6px;margin-top:24px}
.status{font-size:.82rem;color:var(--sub)}
.alert{background:var(--danger-soft);color:var(--ink);border:1px solid var(--danger);border-radius:12px;padding:12px 14px;margin:14px 0}
.alert b{color:var(--danger)}
.ok{background:var(--sys-soft);border-radius:12px;padding:12px 14px;margin:14px 0}
details.tip{border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:8px 0;background:var(--card)}
details.tip summary{cursor:pointer;font-weight:600}
ol.steps{padding-left:20px}
ol.steps li{margin:4px 0}
.mode{display:flex;gap:8px;margin:12px 0}
.mode button{flex:1}
table.adm{border-collapse:collapse;width:100%;font-size:.9rem}
table.adm th,table.adm td{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left;vertical-align:top}
.badge{display:inline-block;border-radius:999px;padding:1px 9px;font-size:.75rem;font-weight:700;background:var(--soft);color:var(--sub)}
.badge.red{background:var(--danger-soft);color:var(--danger)}
.badge.green{background:var(--sys-soft);color:var(--sys)}
.badge.warm{background:var(--warm-soft);color:var(--warm)}
.ans{margin:6px 0 0}
.ans dt{font-weight:700;font-size:.88rem;color:var(--sub);margin-top:8px}
.ans dd{margin:2px 0 0;white-space:pre-wrap;word-break:break-word}
@media print{
  body{background:#fff;color:#000}
  .noprint{display:none!important}
  .card{border-color:#999}
}
`;

function layout({ title, body, wide = false, head = "" }) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${CSS}</style>
${head}
</head>
<body>
<div class="wrap${wide ? " wide" : ""}">
${body}
</div>
</body>
</html>`;
}

const optTag = (f) => (f.optional ? `<span class="opt">(선택)</span>` : "");
const hintHtml = (f) => (f.hint ? `<span class="hint">${esc(f.hint)}</span>` : "");

function val(answers, id) {
  const v = answers && answers[id];
  return v == null ? "" : v;
}

// ── 필드 렌더링 ─────────────────────────────────────────────────
function renderField(f, answers, autos) {
  const wrapOpen = (extra = "") => `data-fid="${esc(f.id || "")}" data-type="${esc(f.type)}"${extra}`;
  switch (f.type) {
    case "note":
      return `<p class="note">${esc(f.text)}</p>`;
    case "auto":
      return `<div class="auto"><b class="t">${esc(f.label)}</b>${(autos && autos[f.kind]) || '<span class="sub">아직 모아볼 기록이 없어요.</span>'}</div>`;
    case "text":
      return `<label class="f" ${wrapOpen()}><span class="l">${esc(f.label)}${optTag(f)}</span><input type="text" name="${esc(f.id)}" maxlength="500" value="${esc(val(answers, f.id))}" placeholder="${esc(f.placeholder || "")}">${hintHtml(f)}</label>`;
    case "number":
      return `<label class="f" ${wrapOpen()}><span class="l">${esc(f.label)}${optTag(f)}</span><input type="number" inputmode="numeric" min="0" max="999" name="${esc(f.id)}" value="${esc(val(answers, f.id))}" placeholder="${esc(f.placeholder || "")}">${hintHtml(f)}</label>`;
    case "textarea":
      return `<label class="f" ${wrapOpen()}><span class="l">${esc(f.label)}${optTag(f)}</span><textarea name="${esc(f.id)}" rows="${f.rows || 3}" maxlength="8000" placeholder="${esc(f.placeholder || "")}">${esc(val(answers, f.id))}</textarea>${hintHtml(f)}</label>`;
    case "radio": {
      const cur = val(answers, f.id);
      const items = f.options
        .map((o, i) => `<label class="pill"><input type="radio" name="${esc(f.id)}" value="${esc(o)}"${cur === o ? " checked" : ""}><span>${esc(o)}</span></label>`)
        .join("");
      return `<fieldset class="f" style="border:0;padding:0;margin:18px 0" ${wrapOpen()}><legend class="l" style="font-weight:700;margin-bottom:6px;padding:0">${esc(f.label)}${optTag(f)}</legend><div class="pills">${items}</div>${hintHtml(f)}</fieldset>`;
    }
    case "checks": {
      const cur = Array.isArray(val(answers, f.id)) ? val(answers, f.id) : [];
      const items = f.options
        .map((o) => `<label class="pill"><input type="checkbox" name="${esc(f.id)}" value="${esc(o)}"${cur.includes(o) ? " checked" : ""}><span>${esc(o)}</span></label>`)
        .join("");
      return `<fieldset class="f" style="border:0;padding:0;margin:18px 0" ${wrapOpen()}><legend class="l" style="font-weight:700;margin-bottom:6px;padding:0">${esc(f.label)}${optTag(f)}</legend><div class="pills">${items}</div>${hintHtml(f)}</fieldset>`;
    }
    case "scale": {
      const cur = String(val(answers, f.id));
      let items = "";
      for (let i = 0; i <= 10; i++) {
        items += `<label><input type="radio" name="${esc(f.id)}" value="${i}"${cur === String(i) ? " checked" : ""}>${i}</label>`;
      }
      return `<fieldset class="f" style="border:0;padding:0;margin:18px 0" ${wrapOpen()}><legend class="l" style="font-weight:700;margin-bottom:6px;padding:0">${esc(f.label)}${optTag(f)}</legend><div class="scale">${items}</div><span class="hint">0 = 없음 · 10 = 거의 못 참을 정도</span></fieldset>`;
    }
    case "table": {
      const cur = (answers && answers[f.id]) || {};
      const n = f.cols.length;
      const rowsHtml = f.rows
        .map((rl) => {
          const rv = cur[rl] || {};
          const cells = f.cols
            .map((c) => {
              const v = rv[c.key] || "";
              let input;
              if (c.type === "select") {
                input = `<select data-col="${esc(c.key)}">${c.options.map((o) => `<option value="${esc(o)}"${v === o ? " selected" : ""}>${esc(o || "선택")}</option>`).join("")}</select>`;
              } else {
                input = `<input type="text" data-col="${esc(c.key)}" maxlength="500" value="${esc(v)}">`;
              }
              return `<label><span>${esc(c.label)}</span>${input}</label>`;
            })
            .join("");
          const showLabel = !/^\d+$/.test(rl);
          return `<div class="rowcard" data-row="${esc(rl)}">${showLabel ? `<div class="rl">${esc(rl)}</div>` : ""}<div class="cols c${Math.min(n, 4)}">${cells}</div></div>`;
        })
        .join("");
      return `<div class="f" ${wrapOpen()}><span class="l">${esc(f.label)}${optTag(f)}</span>${rowsHtml}</div>`;
    }
    case "formula": {
      const cur = (answers && answers[f.id]) || {};
      return `<div class="f" ${wrapOpen()}><span class="l">${esc(f.label)}${optTag(f)}</span><div class="formula">
        <label><span class="tag">IF</span><input type="text" data-part="if" maxlength="500" value="${esc(cur.if || "")}" placeholder="${esc(f.ifHint || "만약 ~하면")}"></label>
        <label><span class="tag">THEN</span><input type="text" data-part="then" maxlength="500" value="${esc(cur.then || "")}" placeholder="${esc(f.thenHint || "~한다")}"></label>
      </div></div>`;
    }
    default:
      return "";
  }
}

// ── 일일 폼 페이지 ──────────────────────────────────────────────
function renderDayPage({ p, day, answers, mode, autos, submitted, lateNote, base }) {
  const dailyOn = !!day.daily;
  const fullFields = day.fields.concat(dailyOn ? DAILY_FIELDS : []);
  const isMin = mode === "min";
  const fieldsHtml = fullFields.map((f) => renderField(f, answers, autos)).join("\n");
  const minHtml = MIN_FIELDS.map((f) => renderField(f, answers, autos)).join("\n");

  const steps = (day.steps || []).map((s) => `<li>${esc(s)}</li>`).join("");
  const tips = (day.tips || [])
    .map(([q, a]) => `<details class="tip"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`)
    .join("");

  const minToggle =
    day.n >= 1
      ? `<div class="mode noprint">
      <button type="button" class="btn ghost" id="modeFull"${!isMin ? ' aria-pressed="true"' : ""}>전체 기록</button>
      <button type="button" class="btn ghost" id="modeMin"${isMin ? ' aria-pressed="true"' : ""}>오늘은 한 줄만</button>
    </div>
    <p class="sub" id="minNote" style="display:${isMin ? "block" : "none"}">한 줄만 적어도 오늘은 기록한 날이에요. (책 Part 6)</p>`
      : "";

  const consent =
    day.n === 0
      ? `<div class="card" data-fid="consent" data-type="consent">
      <b>개인정보·민감정보 수집 안내</b>
      <p class="sub">이 폼에 적는 내용(성적 습관, 감정, 정신건강에 관한 기록)은 민감한 정보예요. 아래 내용에 동의하셔야 시작할 수 있어요.</p>
      <ul class="sub">
        <li>목적: 30일 챌린지 진행, 운영자(서버 소유자)의 확인과 피드백.</li>
        <li>누가 보나: 운영자만 볼 수 있어요. 다른 멤버에게는 절대 공개되지 않아요.</li>
        <li>보관: 챌린지 기간과 완주 후 사후 점검을 위해 보관하며, 아래 "내 기록 삭제"로 언제든 삭제할 수 있어요.</li>
        <li>위기 신호(스스로를 해치려는 표현 등)가 보이면 운영자에게 즉시 알림이 가요.</li>
      </ul>
      <label class="pill"><input type="checkbox" id="consentBox"${answers && answers.__consent ? " checked" : ""}><span>위 내용을 확인했고 동의합니다</span></label>
    </div>`
      : "";

  const doneNote = submitted
    ? `<div class="ok noprint">이미 제출한 기록이에요. 내용을 고쳐서 다시 제출하면 덮어써요.</div>`
    : "";

  const quote = day.quote ? `<div class="quote">오늘 기억할 한 문장<br>${esc(day.quote)}</div>` : "";

  const dataJson = JSON.stringify({
    day: day.n,
    mode: mode || "full",
    needConsent: day.n === 0,
  }).replace(/</g, "\\u003c");

  const bodyHtml = `
<p class="eyebrow">REBOOT 30 · ${day.n === 0 ? "출발선" : "Day " + day.n}</p>
<p><span class="part">${esc(day.part)}</span> <span class="sub">약 ${esc(day.minutes)}분 · 책 p.${esc(day.page)}</span></p>
<h1>${day.n === 0 ? "" : "Day " + day.n + ". "}${esc(day.title)}</h1>
${lateNote ? `<div class="ok noprint">${esc(lateNote)}</div>` : ""}
<div class="goal">오늘의 목표 · ${esc(day.goal)}</div>
<p>${esc(day.why)}</p>
${steps ? `<h2>오늘 할 일</h2><ol class="steps">${steps}</ol>` : ""}
${tips}
${doneNote}
${minToggle}
<form id="f" autocomplete="off" onsubmit="return false">
  ${consent}
  <div id="fullFields" style="display:${isMin ? "none" : "block"}">
  ${fieldsHtml}
  </div>
  <div id="minFields" style="display:${isMin ? "block" : "none"}">
  ${minHtml}
  </div>
  ${quote}
  <div class="sticky noprint">
    <div class="row">
      <button class="btn" type="button" id="submitBtn">${submitted ? "다시 제출하기" : "제출하기"}</button>
      <a class="btn ghost" href="${base}">처음으로</a>
    </div>
    <p class="status" id="status" role="status" aria-live="polite">쓰는 동안 자동으로 임시저장돼요.</p>
  </div>
</form>
<script>
(function(){
  var CFG=${dataJson};
  var base=${JSON.stringify(base)};
  var form=document.getElementById('f');
  var statusEl=document.getElementById('status');
  var mode=CFG.mode;
  function q(sel,root){return Array.prototype.slice.call((root||form).querySelectorAll(sel));}
  function collect(){
    var out={};
    var scope=document.getElementById(mode==='min'?'minFields':'fullFields');
    q('[data-fid]',scope).forEach(function(w){
      var id=w.getAttribute('data-fid'), t=w.getAttribute('data-type');
      if(!id) return;
      if(t==='text'||t==='number'||t==='textarea'){ out[id]=w.querySelector('input,textarea').value; }
      else if(t==='radio'||t==='scale'){ var c=w.querySelector('input:checked'); out[id]=c?c.value:''; }
      else if(t==='checks'){ out[id]=q('input:checked',w).map(function(i){return i.value;}); }
      else if(t==='table'){ var tb={}; q('[data-row]',w).forEach(function(r){ var o={}; q('[data-col]',r).forEach(function(i){o[i.getAttribute('data-col')]=i.value;}); tb[r.getAttribute('data-row')]=o; }); out[id]=tb; }
      else if(t==='formula'){ out[id]={if:w.querySelector('[data-part=if]').value, then:w.querySelector('[data-part=then]').value}; }
    });
    if(CFG.needConsent){ out.__consent=document.getElementById('consentBox').checked; }
    return out;
  }
  var timer=null, dirty=false;
  function post(path,body){
    return fetch(base+'/d/'+CFG.day+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json();});
  }
  function saveDraft(){
    if(!dirty) return; dirty=false;
    post('/draft',{mode:mode,answers:collect()}).then(function(r){
      if(r&&r.ok){ var d=new Date(); statusEl.textContent='임시저장됨 '+('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); }
    }).catch(function(){ statusEl.textContent='임시저장에 실패했어요. 제출 전에 내용을 따로 복사해 두세요.'; });
  }
  function onChange(){ dirty=true; statusEl.textContent='입력 중…'; clearTimeout(timer); timer=setTimeout(saveDraft,1500); }
  form.addEventListener('input',onChange); form.addEventListener('change',onChange);
  function setMode(m){
    mode=m;
    document.getElementById('fullFields').style.display=m==='min'?'none':'block';
    document.getElementById('minFields').style.display=m==='min'?'block':'none';
    var mn=document.getElementById('minNote'); if(mn) mn.style.display=m==='min'?'block':'none';
    var a=document.getElementById('modeFull'), b=document.getElementById('modeMin');
    if(a&&b){ a.setAttribute('aria-pressed',m==='full'); b.setAttribute('aria-pressed',m==='min'); }
    onChange();
  }
  var mf=document.getElementById('modeFull'), mm=document.getElementById('modeMin');
  if(mf) mf.addEventListener('click',function(){setMode('full');});
  if(mm) mm.addEventListener('click',function(){setMode('min');});
  document.getElementById('submitBtn').addEventListener('click',function(){
    var btn=this;
    var answers=collect();
    if(CFG.needConsent && !answers.__consent){ statusEl.textContent='동의에 체크해야 시작할 수 있어요.'; return; }
    btn.disabled=true; statusEl.textContent='제출하는 중…';
    post('/submit',{mode:mode,answers:answers}).then(function(r){
      if(r&&r.ok){ location.href=r.redirect; }
      else { btn.disabled=false; statusEl.textContent=(r&&r.error)||'제출에 실패했어요. 잠시 후 다시 시도해주세요.'; }
    }).catch(function(){ btn.disabled=false; statusEl.textContent='네트워크 오류예요. 입력한 내용은 이 화면에 그대로 있으니 잠시 후 다시 눌러주세요.'; });
  });
  window.addEventListener('beforeunload',function(){ if(dirty){ try{ navigator.sendBeacon(base+'/d/'+CFG.day+'/draft',new Blob([JSON.stringify({mode:mode,answers:collect()})],{type:'application/json'})); }catch(e){} } });
})();
</script>`;
  return layout({ title: `${day.n === 0 ? "시작 전 체크" : "Day " + day.n} · ${day.title}`, body: bodyHtml });
}

// ── 홈(진행 현황) ───────────────────────────────────────────────
function renderHome({ p, DAYS, cur, base, submittedSet, completed }) {
  const dots = DAYS.map((d) => {
    const done = submittedSet.has(d.n);
    const open = d.n <= cur;
    const cls = ["dot", done ? "done" : "", d.n === cur ? "today" : "", !open ? "locked" : ""].filter(Boolean).join(" ");
    const label = d.n === 0 ? "0" : String(d.n);
    return open
      ? `<a class="${cls}" href="${base}/d/${d.n}" aria-label="${d.n === 0 ? "시작 전 체크" : "Day " + d.n}${done ? " 제출함" : ""}">${label}</a>`
      : `<span class="${cls}" aria-label="Day ${d.n} 아직 열리지 않음">${label}</span>`;
  }).join("");
  const todayDay = DAYS.find((d) => d.n === Math.min(cur, 30));
  const rec = DAYS.filter((d) => d.n >= 1 && submittedSet.has(d.n)).length;
  const dayCard = completed
    ? `<div class="ok"><b>30일을 마치셨어요.</b> 기록한 날 ${rec}일. <a href="${base}/complete">완주 기록 보기</a></div>`
    : todayDay
    ? `<div class="card"><p class="eyebrow">오늘${cur > 30 ? " (마지막 날이 남아 있어요)" : ""}</p><h1 style="margin-top:0">${todayDay.n === 0 ? "" : "Day " + todayDay.n + ". "}${esc(todayDay.title)}</h1><p class="sub">${esc(todayDay.goal)}</p><p><a class="btn" href="${base}/d/${todayDay.n}">${submittedSet.has(todayDay.n) ? "다시 보기·고치기" : "기록하러 가기"}</a></p></div>`
    : "";
  const body = `
<p class="eyebrow">REBOOT 30</p>
<h1>${esc(p.name)}님의 30일</h1>
<p class="sub">책 「REBOOT 30」을 하루 한 장씩 따라가는 기록 공간이에요. 이 페이지 주소는 나만의 주소예요. 다른 사람에게 보내지 마세요.</p>
<div class="bar" role="navigation" aria-label="일별 진행">${dots}</div>
<p class="sub">초록 = 제출한 날 · 테두리 = 오늘. 빈 칸은 빈 칸으로 두고 오늘부터 이어가면 돼요. 30일 연속이 아니라 돌아온 날 수를 세요.</p>
${dayCard}
<h2>내 것</h2>
<p><a href="${base}/records">내가 쓴 기록 모아보기</a></p>
${submittedSet.has(28) ? `<p><a href="${base}/system">나의 시스템 1페이지</a></p>` : ""}
<details class="tip"><summary>내 기록 삭제하기</summary>
<p class="sub">제출한 모든 기록과 이 페이지 주소가 삭제돼요. 되돌릴 수 없어요. (완주 전이라면 나중에 처음부터 다시 시작할 수 있어요.)</p>
<form method="post" action="${base}/delete" onsubmit="return confirm('정말 모든 기록을 삭제할까요? 되돌릴 수 없어요.')"><button class="btn danger" type="submit">모든 기록 삭제</button></form></details>
<div class="note" style="margin-top:20px">지금 스스로를 해칠 위험이 있다면 112 · 119. 정신건강 위기상담전화 1577-0199 · 자살예방 상담전화 109 (24시간)</div>`;
  return layout({ title: "REBOOT 30", body });
}

// ── 제출 완료 ───────────────────────────────────────────────────
function renderDone({ p, day, next, flags, base, comeback, completedNow, reportNote }) {
  const crisis = flags.includes("crisis")
    ? `<div class="alert"><b>지금 많이 힘드시다면</b><br>정신건강 위기상담전화 <b>1577-0199</b>(24시간), 자살예방 상담전화 <b>109</b>로 바로 연락할 수 있어요. 위급하면 112·119예요. 챌린지는 나중에 해도 돼요. 이 기록은 운영자에게도 알려졌어요.</div>`
    : "";
  const fell = flags.includes("fell")
    ? `<div class="card"><b>무너진 날에도 기록하러 와주셨어요.</b>
      <p>이 책에서는 무너짐이 전부를 지우지 않아요. 기록한 날은 그대로 쌓여 있고, 일수를 0으로 되돌리지 않아요.</p>
      <p><b>첫 1분:</b> ${comeback && comeback.min1 ? esc(comeback.min1) : "화면을 끄고, 자리에서 일어나기. 자책은 지금 하지 않아요."}<br>
      <b>첫 1시간:</b> ${comeback && comeback.hour1 ? esc(comeback.hour1) : "물 마시기, 세수, 밖에서 5분 서 있기."}<br>
      <b>내일:</b> 오늘의 사실 한 줄만 적고 돌아오기.</p></div>`
    : "";
  const done = completedNow
    ? `<div class="ok"><b>30일 완주를 축하해요.</b> <a href="${base}/complete">완주 기록 보기</a></div>`
    : "";
  const body = `
<p class="eyebrow">제출 완료</p>
<h1>${day.n === 0 ? "시작 준비가 끝났어요" : "Day " + day.n + " 기록을 받았어요"}</h1>
${crisis}${fell}${done}
${reportNote ? `<div class="card"><b>🔍 분석 리포트</b><p>${esc(reportNote)}</p></div>` : ""}
${day.quote ? `<div class="quote">${esc(day.quote)}</div>` : ""}
${next ? `<p class="sub">다음: ${next.n === 0 ? "" : "Day " + next.n + ". "}${esc(next.title)} · 약 ${esc(next.minutes)}분. 날짜가 되면 DM으로 링크가 가요.</p>` : ""}
<p class="row"><a class="btn" href="${base}">내 진행 현황</a> <a class="btn ghost" href="${base}/d/${day.n}">방금 쓴 기록 고치기</a></p>`;
  return layout({ title: "제출 완료", body });
}

function renderMessage(title, text, extra = "") {
  return layout({ title, body: `<h1>${esc(title)}</h1><p>${esc(text)}</p>${extra}` });
}

// ── 기록 모아보기 (본인/관리자 공용 읽기 전용) ────────────────────
function answerHtml(f, a) {
  if (!f || f.type === "note" || f.type === "auto") return "";
  const v = a && a[f.id];
  if (v == null || v === "" || (Array.isArray(v) && !v.length)) return "";
  let out = "";
  if (f.type === "checks") out = esc(v.join(", "));
  else if (f.type === "table") {
    const lines = Object.keys(v)
      .map((rl) => {
        const cells = Object.keys(v[rl] || {})
          .map((ck) => {
            const col = f.cols.find((c) => c.key === ck);
            return v[rl][ck] ? `${col ? col.label : ck}: ${v[rl][ck]}` : "";
          })
          .filter(Boolean)
          .join(" / ");
        return cells ? `${/^\d+$/.test(rl) ? "#" + rl : rl} — ${cells}` : "";
      })
      .filter(Boolean);
    if (!lines.length) return "";
    out = esc(lines.join("\n"));
  } else if (f.type === "formula") {
    if (!v.if && !v.then) return "";
    out = esc(`IF ${v.if || ""}\nTHEN ${v.then || ""}`);
  } else out = esc(String(v));
  return `<dt>${esc(f.label)}</dt><dd>${out}</dd>`;
}

function renderAnswers(day, entry) {
  const a = entry.answers || {};
  const fields = (entry.mode === "min" ? MIN_FIELDS : day.fields.concat(day.daily ? DAILY_FIELDS : []));
  const html = fields.map((f) => answerHtml(f, a)).join("");
  return html ? `<dl class="ans">${html}</dl>` : `<p class="sub">(내용 없음)</p>`;
}

function renderRecords({ p, DAYS, base }) {
  const items = DAYS.filter((d) => p.days[d.n] && p.days[d.n].submittedAt)
    .map((d) => {
      const e = p.days[d.n];
      return `<div class="card"><b>${d.n === 0 ? "시작 전 체크" : "Day " + d.n + ". " + esc(d.title)}</b> <span class="sub">${esc(e.submittedAt.slice(0, 10))}${e.mode === "min" ? " · 한 줄 기록" : ""}</span>${renderAnswers(d, e)}</div>`;
    })
    .join("");
  const body = `<p class="eyebrow">REBOOT 30</p><h1>내가 쓴 기록</h1><p class="sub">나만 볼 수 있는 페이지예요(운영자는 제출된 기록을 볼 수 있어요).</p>${items || '<p class="sub">아직 제출한 기록이 없어요.</p>'}<p><a href="${base}">← 돌아가기</a></p>`;
  return layout({ title: "내 기록", body });
}

module.exports = {
  esc,
  nl2br,
  layout,
  renderField,
  renderDayPage,
  renderHome,
  renderDone,
  renderMessage,
  renderRecords,
  renderAnswers,
  answerHtml,
  CSS,
};

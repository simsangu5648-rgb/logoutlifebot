// 폼 기반 30일 챌린지 전용 저장소.
// 기존 data.json(store.js)과 분리된 challenge.json에 저장합니다 — 기록 본문처럼
// 민감한 데이터를 일반 사용자 데이터와 섞지 않고, 삭제/내보내기도 따로 다루기 위함입니다.
// (같은 DATA_DIR/영구 볼륨을 쓰므로 재배포해도 유지됩니다.)

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR || "/data";
const FILE = fs.existsSync(DATA_DIR)
  ? path.join(DATA_DIR, "challenge.json")
  : path.join(__dirname, "..", "challenge.json");

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

function load() {
  let s = null;
  try {
    if (fs.existsSync(FILE)) s = JSON.parse(fs.readFileSync(FILE, "utf-8"));
  } catch (e) {
    console.error("[rc-store] challenge.json 파싱 실패 — 백업 후 새로 시작합니다.", e);
    try {
      fs.copyFileSync(FILE, FILE + ".broken-" + Date.now());
    } catch (_) {
      /* ignore */
    }
  }
  if (!s) s = {};
  if (!s.config) s.config = {};
  if (!s.config.joinToken) s.config.joinToken = randomToken(16);
  if (!s.config.adminKey) s.config.adminKey = randomToken(20);
  if (!s.config.calToken) s.config.calToken = randomToken(16); // 운영자 캘린더 구독 주소용 비밀 토큰
  if (!s.participants) s.participants = {};
  if (!s.tokenIndex) s.tokenIndex = {};
  if (!s.used) s.used = {}; // 챌린지를 완주한 사람 표시(기록을 지워도 남음) — 완주는 1인 1회, 완주 전에는 계속 다시 시작 가능
  // 구매자별 1회용 입장 링크(랜딩 서버가 결제 확인 후 발급). orderNo가 유일한 연결 키이며 이메일·전화번호 등은 저장하지 않습니다.
  if (!s.orders) s.orders = {}; // orderNo -> { orderNo, token, createdAt, status: issued|claimed|revoked, uid, claimedAt, revokedAt, reason }
  if (!s.orderTokens) s.orderTokens = {}; // 1회용 토큰 -> orderNo
  if (!s.revokedUids) s.revokedUids = {}; // 환불로 회수된 디스코드 계정 -> { at, orderNo } (예전 공용 링크로 되돌아오는 것을 막음)
  if (!s.revokedTokens) s.revokedTokens = {}; // 환불로 삭제된 개인 주소 토큰 -> { at } ("환불된 구매" 안내용 묘비)
  return s;
}

const state = load();

function save() {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}
save();

function getParticipant(uid) {
  return state.participants[uid] || null;
}

function getByToken(token) {
  const uid = state.tokenIndex[token];
  return uid ? state.participants[uid] || null : null;
}

function createParticipant(uid, name, startDate) {
  const existing = state.participants[uid];
  if (existing) return existing;
  const token = randomToken(18);
  const p = {
    uid,
    name: name || String(uid),
    token,
    joinedAt: new Date().toISOString(),
    startDate, // Day 1이 열리는 날짜 (YYYY-MM-DD, KST)
    status: "active", // active | paused | completed
    days: {}, // { "0": { answers, draft, mode, submittedAt, late, flags, readAt } }
    ownerReplies: [],
    lastDmDate: null,
    careDmDate: null,
    completedAt: null,
    masterGrantedAt: null,
  };
  state.participants[uid] = p;
  state.tokenIndex[token] = uid;
  if (!state.used[uid]) state.used[uid] = { at: p.joinedAt };
  save();
  return p;
}

function deleteParticipantData(uid) {
  const p = state.participants[uid];
  if (!p) return false;
  delete state.tokenIndex[p.token];
  delete state.participants[uid];
  save();
  return true;
}

// 완주한 적이 있는지(기록을 지운 뒤에도 유지)
function hasCompleted(uid) {
  const p = state.participants[uid];
  return !!(p && p.completedAt) || !!(state.used[uid] && state.used[uid].completedAt);
}

function markCompleted(uid) {
  state.used[uid] = { ...(state.used[uid] || {}), completedAt: new Date().toISOString() };
  save();
}

function allowRestart(uid) {
  if (state.participants[uid]) return false; // 기록이 남아 있으면 해당 없음
  const had = !!(state.used[uid] && state.used[uid].completedAt);
  delete state.used[uid];
  save();
  return had;
}

// ── 구매자별 1회용 입장 링크 ─────────────────────────────────
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const ORDER_NO_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const validOrderNo = (v) => typeof v === "string" && ORDER_NO_RE.test(v);

function getOrder(orderNo) {
  return has(state.orders, orderNo) ? state.orders[orderNo] : null;
}
function getOrderByToken(token) {
  if (typeof token !== "string" || !TOKEN_RE.test(token) || !has(state.orderTokens, token)) return null;
  return getOrder(state.orderTokens[token]);
}
// 같은 orderNo로 다시 호출하면 같은 링크를 돌려줍니다(멱등). 환불된 주문은 다시 발급하지 않아요.
function issueOrder(orderNo) {
  const ex = getOrder(orderNo);
  if (ex) return { order: ex, created: false };
  const order = { orderNo, token: randomToken(32), createdAt: new Date().toISOString(), status: "issued", uid: null, claimedAt: null, revokedAt: null, reason: null };
  state.orders[orderNo] = order;
  state.orderTokens[order.token] = orderNo;
  save();
  return { order, created: true };
}
// 디스코드 계정을 주문에 연결합니다. 이미 다른 계정이 쓴 링크면 거절.
function claimOrder(orderNo, uid) {
  const o = getOrder(orderNo);
  if (!o) return { ok: false, reason: "unknown" };
  if (o.status === "revoked") return { ok: false, reason: "revoked" };
  if (o.status === "claimed") return o.uid === uid ? { ok: true, same: true, order: o } : { ok: false, reason: "used" };
  o.status = "claimed";
  o.uid = uid;
  o.claimedAt = new Date().toISOString();
  save();
  return { ok: true, same: false, order: o };
}
// 입장 처리 중 실패했을 때 방금 한 연결을 되돌립니다.
function releaseOrder(orderNo, uid) {
  const o = getOrder(orderNo);
  if (o && o.status === "claimed" && o.uid === uid) {
    o.status = "issued";
    o.uid = null;
    o.claimedAt = null;
    save();
  }
}
function ordersOfUid(uid) {
  return Object.values(state.orders).filter((o) => o.uid === uid && o.status !== "issued").map((o) => o.orderNo);
}
// 환불: 토큰을 무효화합니다. 주문이 아직 없어도 묘비를 남겨, 나중에 발급 요청이 와도 살아나지 않게 합니다.
function revokeOrder(orderNo, reason) {
  let o = getOrder(orderNo);
  const known = !!o;
  if (!o) {
    o = { orderNo, token: null, createdAt: new Date().toISOString(), status: "revoked", uid: null, claimedAt: null, revokedAt: null, reason: null };
    state.orders[orderNo] = o;
  }
  const already = o.status === "revoked" && !!o.revokedAt;
  const uid = o.uid;
  if (!already) {
    o.status = "revoked";
    o.revokedAt = new Date().toISOString();
    o.reason = reason ? String(reason).slice(0, 200) : null;
    if (o.token && has(state.orderTokens, o.token)) delete state.orderTokens[o.token];
    o.token = null;
    save();
  }
  return { order: o, uid, already, known };
}
function markRevoked(uid, orderNo) {
  state.revokedUids[uid] = { at: new Date().toISOString(), orderNo };
  save();
}
function isRevokedUid(uid) {
  return has(state.revokedUids, uid);
}
function clearRevoked(uid) {
  if (has(state.revokedUids, uid)) {
    delete state.revokedUids[uid];
    save();
  }
}
function isRevokedToken(token) {
  return has(state.revokedTokens, token);
}
// 환불 시: 개인 기록과 개인 주소를 지우고, 주소에는 묘비를 남깁니다. 완주 표시(used)는 환불 계정이 다시 들어와도 되돌려지지 않게 그대로 둡니다.
function purgeParticipantForRefund(uid) {
  const p = state.participants[uid];
  if (!p) return false;
  state.revokedTokens[p.token] = { at: new Date().toISOString() };
  delete state.tokenIndex[p.token];
  delete state.participants[uid];
  save();
  return true;
}

function rotateJoinToken() {
  state.config.joinToken = randomToken(16);
  save();
  return state.config.joinToken;
}

function rotateCalToken() {
  state.config.calToken = randomToken(16);
  save();
  return state.config.calToken;
}

module.exports = {
  state,
  rotateCalToken,
  save,
  randomToken,
  getParticipant,
  getByToken,
  createParticipant,
  deleteParticipantData,
  rotateJoinToken,
  validOrderNo,
  getOrder,
  getOrderByToken,
  issueOrder,
  claimOrder,
  releaseOrder,
  ordersOfUid,
  revokeOrder,
  markRevoked,
  isRevokedUid,
  clearRevoked,
  isRevokedToken,
  purgeParticipantForRefund,
  hasCompleted,
  markCompleted,
  allowRestart,
};

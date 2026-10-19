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
  hasCompleted,
  markCompleted,
  allowRestart,
};

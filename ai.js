'use strict';

// coloro の CPU。Worker として読み込む（main.js の askCpu）。
// 完全情報ゲームなので、αβ 探索＋置換表の反復深化で読む。終盤は最後まで読み切り、勝てる局面は必ず勝つ。
// 読み切れない深さでは評価関数（山の高さ）で打ち切る。
//
// 入力: { board: 6×6（色 0〜5 か null）, arrow: {r,c,orientation} | null, current: 1|2,
//         stacks: {1: [{color,count}], 2: [...]}, setup: bool, timeMs }
// 出力: setup なら { r, c, orientation }、それ以外は { r, c, side: 'left'|'right' }

const N = 6, CELLS = 36;
const WIN = 1e6;

// 盤: cells[i] = 色 or -1。矢印: pos・ori（0 = 縦, 1 = 横）。山: order[p] = 色の並び、cnt[p][色] = 段数。
let cells, pos, ori, toMove, order, cnt;
let tt, nodes, deadline, cutoff;

// 置換表のキー用（32bit 2 本 → 53bit の数値）
function rnd() { return (Math.random() * 2 ** 32) >>> 0; }
const Z = () => [rnd(), rnd()];
const zCell = Array.from({ length: CELLS }, Z);
const zPos = Array.from({ length: CELLS * 2 }, Z);
const zMove = Z();
const zCnt = Array.from({ length: 2 * 6 * 7 }, Z);
const zOrd = Array.from({ length: 2 * 6 * 6 }, Z);

function key() {
  let a = 0, b = 0;
  for (let i = 0; i < CELLS; i++) if (cells[i] < 0) { a ^= zCell[i][0]; b ^= zCell[i][1]; }
  a ^= zPos[pos * 2 + ori][0]; b ^= zPos[pos * 2 + ori][1];
  if (toMove) { a ^= zMove[0]; b ^= zMove[1]; }
  for (let p = 0; p < 2; p++) {
    for (let c = 0; c < 6; c++) { const z = zCnt[(p * 6 + c) * 7 + cnt[p][c]]; a ^= z[0]; b ^= z[1]; }
    const o = order[p];
    for (let i = 0; i < o.length; i++) { const z = zOrd[(p * 6 + i) * 6 + o[i]]; a ^= z[0]; b ^= z[1]; }
  }
  return (a >>> 0) * 2097152 + (b & 2097151);
}

// 着手 = マス * 2 + side（0 = 右/そのまま, 1 = 左）
function genMoves() {
  const moves = [];
  const r = (pos / N) | 0, c = pos % N, p = toMove;
  for (let k = 0; k < N; k++) {
    const i = ori === 0 ? k * N + c : r * N + k;
    if (i === pos || cells[i] < 0) continue;
    moves.push(i * 2);
    if (cnt[p][cells[i]] === 0 && order[p].length > 0) moves.push(i * 2 + 1);
  }
  return moves;
}

function play(m) {
  const i = m >> 1, color = cells[i], p = toMove;
  const undo = { i, color, pos, ori, how: 0 };
  cells[i] = -1; pos = i; ori ^= 1;
  if (cnt[p][color]++ === 0) {
    if (m & 1) { order[p].unshift(color); undo.how = 2; } else { order[p].push(color); undo.how = 1; }
  }
  toMove ^= 1;
  return undo;
}

function unplay(u) {
  toMove ^= 1;
  const p = toMove;
  cnt[p][u.color]--;
  if (u.how === 1) order[p].pop(); else if (u.how === 2) order[p].shift();
  cells[u.i] = u.color; pos = u.pos; ori = u.ori;
}

function maxOf(p) { let m = 0; for (let c = 0; c < 6; c++) if (cnt[p][c] > m) m = cnt[p][c]; return m; }

// 終局の勝ち負け（手番側から見て +1 / 0 / -1）。judge() と同じ比べ方
function outcome() {
  const p = toMove, q = p ^ 1;
  const mp = maxOf(p), mq = maxOf(q);
  if (mp !== mq) return mp > mq ? 1 : -1;
  const len = Math.max(order[p].length, order[q].length);
  for (let k = 0; k < len; k++) {
    const hp = k < order[p].length ? cnt[p][order[p][k]] : 0;
    const hq = k < order[q].length ? cnt[q][order[q][k]] : 0;
    if (hp !== hq) return hp > hq ? 1 : -1;
  }
  return 0;
}

// 山の良さ（手番側 − 相手）。一番高い山を重く、ほかの山も少し見る
function material() {
  let s = 0;
  for (let p = 0; p < 2; p++) {
    let v = maxOf(p) * 100;
    for (let c = 0; c < 6; c++) v += cnt[p][c] * cnt[p][c];
    s += p === toMove ? v : -v;
  }
  return s;
}

function negamax(depth, alpha, beta) {
  if ((++nodes & 4095) === 0 && Date.now() > deadline) throw 'time';
  const moves = genMoves();
  if (moves.length === 0) {
    const o = outcome();
    return o === 0 ? 0 : o * WIN + material(); // 勝ちは大きく、負けは小さく
  }
  if (depth === 0) { cutoff = true; return material(); }

  const k = key();
  const e = tt.get(k);
  let first = -1;
  if (e) {
    if (e.depth >= depth) {
      if (e.flag === 0) { if (!e.solved) cutoff = true; return e.value; }
      if (e.flag === 1 && e.value >= beta) { if (!e.solved) cutoff = true; return e.value; }
      if (e.flag === -1 && e.value <= alpha) { if (!e.solved) cutoff = true; return e.value; }
    }
    first = e.move;
  }
  if (first >= 0) { const j = moves.indexOf(first); if (j > 0) { moves[j] = moves[0]; moves[0] = first; } }

  const alpha0 = alpha;
  const cut0 = cutoff;
  cutoff = false;
  let best = -Infinity, bestMove = moves[0];
  for (const m of moves) {
    const u = play(m);
    const v = -negamax(depth - 1, -beta, -alpha);
    unplay(u);
    if (v > best) { best = v; bestMove = m; }
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  const solved = !cutoff;
  cutoff = cut0 || cutoff;
  if (tt.size > 3e6) tt.clear();
  tt.set(k, {
    depth: solved ? 99 : depth, value: best, move: bestMove, solved,
    flag: best <= alpha0 ? -1 : best >= beta ? 1 : 0,
  });
  return best;
}

// ルートの候補: 準備なら（取るマス, 向き）、それ以外は着手
function rootMoves(setup) {
  if (!setup) return genMoves().map((m) => ({ m }));
  const list = [];
  for (let i = 0; i < CELLS; i++) if (cells[i] >= 0) list.push({ i, o: 0 }, { i, o: 1 });
  return list;
}

function playRoot(rm) {
  if (rm.m !== undefined) return play(rm.m);
  // 準備: 手番は player2（p=1）。駒を取り、そこに矢印を置いて向きを決め、player1 の番へ
  const color = cells[rm.i];
  const u = { setup: true, i: rm.i, color, pos, ori };
  cells[rm.i] = -1; cnt[1][color]++; order[1].push(color);
  pos = rm.i; ori = rm.o; toMove = 0;
  return u;
}

function unplayRoot(u) {
  if (!u.setup) { unplay(u); return; }
  toMove = 1; pos = u.pos; ori = u.ori;
  order[1].pop(); cnt[1][u.color]--; cells[u.i] = u.color;
}

function think(msg) {
  cells = new Int8Array(CELLS);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) cells[r * N + c] = msg.board[r][c] == null ? -1 : msg.board[r][c];
  pos = msg.arrow ? msg.arrow.r * N + msg.arrow.c : 0;
  ori = msg.arrow && msg.arrow.orientation === 'h' ? 1 : 0;
  toMove = msg.current - 1;
  order = [1, 2].map((n) => msg.stacks[n].map((s) => s.color));
  cnt = [1, 2].map((n) => { const a = new Int8Array(6); for (const s of msg.stacks[n]) a[s.color] = s.count; return a; });
  tt = new Map(); nodes = 0;
  deadline = Date.now() + (msg.timeMs || 1500);

  const roots = rootMoves(msg.setup);
  let best = roots[0];
  for (let depth = 1; depth <= CELLS; depth++) {
    cutoff = false;
    let alpha = -Infinity, iterBest = null, anyCut = false;
    try {
      // 前の深さの最善手から読む（αβ がよく効く）
      for (const rm of [best, ...roots.filter((x) => x !== best)]) {
        const u = playRoot(rm);
        cutoff = false;
        let v;
        try { v = -negamax(depth - 1, -Infinity, -alpha); } finally { unplayRoot(u); }
        anyCut = anyCut || cutoff;
        if (v > alpha) { alpha = v; iterBest = rm; }
      }
    } catch (err) {
      if (err !== 'time') throw err;
      break; // 時間切れ: 読み終えた深さの最善手を使う
    }
    best = iterBest || best;
    if (!anyCut || alpha >= WIN / 2) break; // 読み切った、または勝ちを見つけた
  }

  if (msg.setup) return { r: (best.i / N) | 0, c: best.i % N, orientation: best.o ? 'h' : 'v' };
  const i = best.m >> 1;
  return { r: (i / N) | 0, c: i % N, side: best.m & 1 ? 'left' : 'right' };
}

if (typeof module !== 'undefined') module.exports = { think };
else self.onmessage = (e) => self.postMessage(think(e.data));

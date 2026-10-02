'use strict';

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。
// キーは必ず 'coloro.' で始める。
const STORE = 'coloro.';

function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}

WebAppKit.init({ title: 'coloro', text: '6色の駒を取り合って一番高い山を作る対戦ゲーム。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// 音を使うときは、鳴らす前と音の設定を切り替えたときにこれを呼ぶ（RULES.md §5「音」）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}

// ---- ここからアプリ本体 ----
//
// coloro: 6×6 の盤に 6 色×6 枚の駒を並べ、矢印コマを縦横に飛ばして駒を取り合う 2 人用ゲーム。
// ルールの詳細は README.md「遊び方」を参照。

const SIZE = 6;
const COLORS = [
  { hex: '#E53935', shape: 'triangle' }, // 赤
  { hex: '#1E88E5', shape: 'square' },   // 青
  { hex: '#FDD835', shape: 'pentagon' }, // 黄
  { hex: '#43A047', shape: 'hexagon' },  // 緑
  { hex: '#8E24AA', shape: 'octagon' },  // 紫
  { hex: '#FB8C00', shape: 'star' },     // オレンジ
];

// 正多角形の頂点を作る（マークの形はすべてこれで統一。星だけ三角形 2 枚を重ねる）
function polygonPoints(cx, cy, r, sides, rotateDeg) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = (Math.PI * 2 * i) / sides + (rotateDeg * Math.PI) / 180;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

function shapeSVG(shape) {
  const cx = 12, cy = 12, r = 8;
  let inner = '';
  switch (shape) {
    case 'triangle': inner = `<polygon points="${polygonPoints(cx, cy, r, 3, -90)}" fill="#fff"/>`; break;
    case 'square': inner = `<polygon points="${polygonPoints(cx, cy, r, 4, 45)}" fill="#fff"/>`; break;
    case 'pentagon': inner = `<polygon points="${polygonPoints(cx, cy, r, 5, -90)}" fill="#fff"/>`; break;
    case 'hexagon': inner = `<polygon points="${polygonPoints(cx, cy, r, 6, 0)}" fill="#fff"/>`; break;
    case 'octagon': inner = `<polygon points="${polygonPoints(cx, cy, r, 8, 22.5)}" fill="#fff"/>`; break;
    case 'star':
      inner = `<polygon points="${polygonPoints(cx, cy, r, 3, -90)}" fill="#fff"/>` +
              `<polygon points="${polygonPoints(cx, cy, r, 3, 90)}" fill="#fff"/>`;
      break;
  }
  return `<svg viewBox="0 0 24 24">${inner}</svg>`;
}

function arrowSVG(orientation) {
  // 両向き矢印。縦なら上下、横なら左右。
  const v = `<path d="M12 2 L7 8 L10 8 L10 16 L7 16 L12 22 L17 16 L14 16 L14 8 L17 8 Z" fill="#fff"/>`;
  const h = `<path d="M2 12 L8 7 L8 10 L16 10 L16 7 L22 12 L16 17 L16 14 L8 14 L8 17 Z" fill="#fff"/>`;
  return `<svg viewBox="0 0 24 24">${orientation === 'v' ? v : h}</svg>`;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** @type {any} */
let state;

function newGame() {
  const pool = shuffle(COLORS.flatMap((_, ci) => Array(6).fill(ci)));
  const board = Array.from({ length: SIZE }, (_, r) => pool.slice(r * SIZE, r * SIZE + SIZE));
  state = {
    board,
    arrow: null,           // { r, c, orientation }
    current: 2,            // 準備はプレイヤー2 から
    phase: 'setup-pick',   // setup-pick → setup-orient → play → place-choice → over
    players: { 1: { stacks: [] }, 2: { stacks: [] } },
    pending: null,         // { color } 色の置き場所待ち
    result: null,
  };
  render();
}

// そのマスから、矢印の向きに沿って取れる駒のマス一覧（飛び越え可、空きマスには止まれない）
function reachableCells(board, r, c, orientation) {
  const cells = [];
  if (orientation === 'v') {
    for (let rr = 0; rr < SIZE; rr++) if (rr !== r && board[rr][c] != null) cells.push([rr, c]);
  } else {
    for (let cc = 0; cc < SIZE; cc++) if (cc !== c && board[r][cc] != null) cells.push([r, cc]);
  }
  return cells;
}

function addPieceToPlayer(playerNum, color) {
  const stacks = state.players[playerNum].stacks;
  const idx = stacks.findIndex((s) => s.color === color);
  if (idx >= 0) { stacks[idx].count++; return; }
  if (stacks.length === 0) { stacks.push({ color, count: 1 }); return; }
  state.phase = 'place-choice';
  state.pending = { color, player: playerNum };
}

function afterMoveSettled() {
  state.current = state.current === 1 ? 2 : 1;
  const [r, c] = [state.arrow.r, state.arrow.c];
  if (reachableCells(state.board, r, c, state.arrow.orientation).length === 0) {
    endGame();
  } else {
    state.phase = 'play';
  }
  render();
}

function endGame() {
  state.phase = 'over';
  state.result = judge();
}

function maxStack(stacks) { return stacks.reduce((m, s) => Math.max(m, s.count), 0); }

function judge() {
  const s1 = state.players[1].stacks, s2 = state.players[2].stacks;
  const m1 = maxStack(s1), m2 = maxStack(s2);
  if (m1 !== m2) {
    const winner = m1 > m2 ? 1 : 2;
    return { winner, reason: `一番高い山: プレイヤー1 ${m1} 段 / プレイヤー2 ${m2} 段` };
  }
  const len = Math.max(s1.length, s2.length);
  for (let i = 0; i < len; i++) {
    const h1 = s1[i] ? s1[i].count : 0;
    const h2 = s2[i] ? s2[i].count : 0;
    if (h1 !== h2) {
      const winner = h1 > h2 ? 1 : 2;
      return { winner, reason: `左から ${i + 1} 番目の山: プレイヤー1 ${h1} 段 / プレイヤー2 ${h2} 段` };
    }
  }
  return { winner: 0, reason: '山の高さがすべて同じ' };
}

// ---- 操作 ----

function onSetupPick(r, c) {
  if (state.board[r][c] == null) return;
  const color = state.board[r][c];
  state.board[r][c] = null;
  addPieceToPlayer(2, color); // 最初の 1 山は選ばずそのまま積む
  state.arrow = { r, c, orientation: null };
  state.phase = 'setup-orient';
  render();
}

function onSetupOrient(orientation) {
  state.arrow.orientation = orientation;
  state.current = 1;
  if (reachableCells(state.board, state.arrow.r, state.arrow.c, orientation).length === 0) {
    endGame();
  } else {
    state.phase = 'play';
  }
  render();
}

function onMove(r, c) {
  const color = state.board[r][c];
  state.board[r][c] = null;
  const prevOrientation = state.arrow.orientation;
  state.arrow = { r, c, orientation: prevOrientation === 'v' ? 'h' : 'v' };
  const mover = state.current;
  addPieceToPlayer(mover, color);
  if (state.phase === 'place-choice') { render(); return; }
  afterMoveSettled();
}

function onPlaceChoice(side) {
  const { color, player } = state.pending;
  const stacks = state.players[player].stacks;
  const entry = { color, count: 1 };
  if (side === 'left') stacks.unshift(entry); else stacks.push(entry);
  state.pending = null;
  afterMoveSettled();
}

// ---- 描画 ----

function render() {
  renderStatus();
  renderBoard();
  renderRow(1);
  renderRow(2);
  renderOverlay();
}

function renderStatus() {
  const el = document.getElementById('status');
  if (state.phase === 'setup-pick') { el.textContent = 'プレイヤー2: 好きな駒を選んでください'; return; }
  if (state.phase === 'setup-orient') { el.textContent = 'プレイヤー2: 矢印の向きを選んでください'; return; }
  if (state.phase === 'over') { el.textContent = ''; return; }
  const icon = state.arrow.orientation === 'v' ? '↕' : '↔';
  const label = state.phase === 'place-choice'
    ? `プレイヤー${state.pending.player}: 新しい色の山をどちらに置く？`
    : `プレイヤー${state.current} の番`;
  el.innerHTML = '';
  const span = document.createElement('span');
  span.className = 'arrow-icon';
  span.textContent = state.phase === 'place-choice' ? '' : icon;
  el.appendChild(span);
  el.appendChild(document.createTextNode(label));
}

function renderBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  const reach = state.phase === 'play' && state.arrow
    ? reachableCells(state.board, state.arrow.r, state.arrow.c, state.arrow.orientation)
    : [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const color = state.board[r][c];
      const isArrowHere = state.arrow && state.arrow.r === r && state.arrow.c === c;
      if (isArrowHere && state.phase !== 'setup-orient') {
        const token = document.createElement('div');
        token.className = 'arrow-token';
        token.innerHTML = arrowSVG(state.arrow.orientation);
        cell.appendChild(token);
      } else if (isArrowHere) {
        const token = document.createElement('div');
        token.className = 'arrow-token';
        cell.appendChild(token);
      } else if (color != null) {
        const piece = document.createElement('div');
        piece.className = 'piece';
        piece.style.background = COLORS[color].hex;
        piece.innerHTML = shapeSVG(COLORS[color].shape);
        cell.appendChild(piece);
      }
      if (state.phase === 'setup-pick' && color != null) {
        cell.classList.add('pickable');
        cell.addEventListener('click', () => onSetupPick(r, c));
      }
      if (reach.some(([rr, cc]) => rr === r && cc === c)) {
        cell.classList.add('reachable');
        cell.addEventListener('click', () => onMove(r, c));
      }
      board.appendChild(cell);
    }
  }
}

function renderRow(playerNum) {
  const row = document.getElementById(`row-p${playerNum}`);
  row.innerHTML = '';
  row.classList.toggle('current', state.phase === 'play' && state.current === playerNum);

  if (state.phase === 'setup-orient' && playerNum === 2) {
    for (const [label, val] of [['↕ 縦', 'v'], ['↔ 横', 'h']]) {
      const btn = document.createElement('button');
      btn.className = 'pill';
      btn.textContent = label;
      btn.addEventListener('click', () => onSetupOrient(val));
      row.appendChild(btn);
    }
    return;
  }

  const stacks = state.players[playerNum].stacks;
  const showSlots = state.phase === 'place-choice' && state.pending.player === playerNum;
  if (showSlots) {
    const left = document.createElement('button');
    left.className = 'slot';
    left.textContent = 'ここに置く';
    left.addEventListener('click', () => onPlaceChoice('left'));
    row.appendChild(left);
  }
  for (const s of stacks) {
    const el = document.createElement('div');
    el.className = 'stack';
    el.style.background = COLORS[s.color].hex;
    el.innerHTML = shapeSVG(COLORS[s.color].shape);
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(s.count);
    el.appendChild(count);
    row.appendChild(el);
  }
  if (showSlots) {
    const right = document.createElement('button');
    right.className = 'slot';
    right.textContent = 'ここに置く';
    right.addEventListener('click', () => onPlaceChoice('right'));
    row.appendChild(right);
  }
}

function renderOverlay() {
  const overlay = document.getElementById('overlay');
  if (state.phase !== 'over') { overlay.hidden = true; return; }
  overlay.hidden = false;
  const r = state.result;
  document.getElementById('overlay-title').textContent =
    r.winner === 0 ? '引き分け' : `プレイヤー${r.winner} の勝ち`;
  document.getElementById('overlay-reason').textContent = r.reason;
}

// ---- ホームと遊び方 ----

function showScreen(name) {
  const inGame = name === 'game';
  document.getElementById('home').hidden = inGame;
  document.getElementById('stage').hidden = !inGame;
  document.getElementById('to-home').hidden = !inGame;
  document.getElementById('bar-title').hidden = !inGame;
  if (!inGame) {
    document.getElementById('overlay').hidden = true;
    // 途中のゲームがあれば「つづきから」を一番目に出す
    document.getElementById('resume').hidden = !state || state.phase === 'over';
  }
}

document.getElementById('home-pieces').innerHTML = COLORS
  .map((c) => `<span class="piece" style="background:${c.hex}">${shapeSVG(c.shape)}</span>`).join('');

document.getElementById('start').addEventListener('click', () => { showScreen('game'); newGame(); });
document.getElementById('resume').addEventListener('click', () => { showScreen('game'); render(); });
document.getElementById('to-home').addEventListener('click', () => showScreen('home'));
document.getElementById('over-home').addEventListener('click', () => showScreen('home'));
document.getElementById('open-rules').addEventListener('click', () => document.getElementById('rules').showModal());
document.getElementById('again').addEventListener('click', newGame);

showScreen('home');

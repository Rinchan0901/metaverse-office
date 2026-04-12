const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { createClient } = require('redis');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ===== バージョン管理 =====
let LOCAL_VERSION = '1.2.0';
const REPO_RAW_BASE = 'https://raw.githubusercontent.com/Rinchan0901/metaverse-office/main';
const VERSION_CHECK_URL = `${REPO_RAW_BASE}/version.json`;
let latestVersionInfo = null;
let updateInProgress = false;

// アップデート対象ファイル
const UPDATE_FILES = [
  { remote: 'public/index.html',           local: 'public/index.html' },
  { remote: 'public/avatar-data.js',       local: 'public/avatar-data.js' },
  { remote: 'public/furniture-sprites.js',  local: 'public/furniture-sprites.js' },
  { remote: 'public/manual.html',          local: 'public/manual.html' },
  { remote: 'public/demo.html',            local: 'public/demo.html' },
  { remote: 'public/sw.js',                local: 'public/sw.js' },
  { remote: 'server.js',                   local: 'server.js' },
  { remote: 'version.json',                local: 'version.json' },
];

async function checkForUpdates() {
  try {
    const res = await fetch(VERSION_CHECK_URL);
    if (!res.ok) return;
    const data = await res.json();
    if (data.version !== LOCAL_VERSION) {
      const isNew = !latestVersionInfo || latestVersionInfo.version !== data.version;
      latestVersionInfo = data;
      console.log(`[UPDATE] 新しいバージョン v${data.version} が利用可能です (現在: v${LOCAL_VERSION})`);
      // 新バージョン検出時、全クライアントに即時通知
      if (isNew && io) {
        io.emit('updateAvailable', {
          version: data.version,
          current: LOCAL_VERSION,
          changelog: data.changelog || [],
          date: data.date || ''
        });
        console.log(`[UPDATE] 全クライアントにアップデート通知を送信しました`);
      }
    } else {
      latestVersionInfo = null;
      console.log(`[VERSION] v${LOCAL_VERSION} は最新です`);
    }
  } catch (e) { /* ネットワークエラーは無視 */ }
}
checkForUpdates();
setInterval(checkForUpdates, 30 * 60 * 1000); // 30分ごとにチェック

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ===== レート制限 =====
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分
  max: 20, // 15分あたり20回まで
  message: { error: '試行回数が多すぎます。しばらく待ってから再試行してください' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ===== セッショントークン管理 =====
const sessions = {}; // token -> { username, createdAt }

// ===== データ永続化 (Redis優先、なければファイルフォールバック) =====
let redis = null;
const useRedis = !!process.env.REDIS_URL;

const DATA_KEYS = {
  accounts: path.join(__dirname, 'accounts.json'),
  furniture: path.join(__dirname, 'furniture.json'),
  coins: path.join(__dirname, 'coins.json'),
  roomThemes: path.join(__dirname, 'room-themes.json'),
  customRooms: path.join(__dirname, 'custom-rooms.json'),
};

async function dataGet(key, fallback) {
  if (redis) {
    try {
      const val = await redis.get(key);
      return val ? JSON.parse(val) : fallback;
    } catch (e) { /* fall through to file */ }
  }
  // ファイルフォールバック
  try {
    const filePath = DATA_KEYS[key];
    if (filePath && fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return fallback;
}

async function dataSet(key, data) {
  if (redis) {
    try { await redis.set(key, JSON.stringify(data)); return; } catch (e) { /* fall through */ }
  }
  // ファイルフォールバック
  const filePath = DATA_KEYS[key];
  if (filePath) {
    try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); } catch (e) { /* ignore */ }
  }
}

// ===== アカウントシステム =====
let accounts = {};

function saveAccounts() {
  dataSet('accounts', accounts);
}

const BCRYPT_ROUNDS = 10;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 旧SHA256ハッシュ (既存アカウント移行用)
function legacyHash(password) {
  return crypto.createHash('sha256').update(password + 'metaverse-salt').digest('hex');
}

// セッション検証API
app.post('/api/verify', (req, res) => {
  const { token } = req.body;
  if (!token || !sessions[token]) return res.status(401).json({ error: 'invalid' });
  const s = sessions[token];
  // 30日でトークン期限切れ
  if (Date.now() - s.createdAt > 30 * 24 * 60 * 60 * 1000) {
    delete sessions[token];
    return res.status(401).json({ error: 'expired' });
  }
  const acc = accounts[s.username];
  if (!acc) return res.status(401).json({ error: 'invalid' });
  res.json({ ok: true, username: s.username, avatar: acc.avatar, role: acc.role || 'user', token });
});

// アカウント登録
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'ユーザー名とパスワードが必要です' });
    const name = String(username).slice(0, 12).replace(/[<>&"']/g, '');
    if (name.length < 2) return res.status(400).json({ error: '名前は2文字以上' });
    if (String(password).length < 4) return res.status(400).json({ error: 'パスワードは4文字以上' });
    if (accounts[name]) return res.status(400).json({ error: 'この名前は既に使われています' });
    const hashed = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    // 最初のアカウントを自動的にadminにする
    const isFirstAccount = Object.keys(accounts).length === 0;
    accounts[name] = {
      password: hashed,
      avatar: { hair: 0, body: 0, pants: 0, acc: -1 },
      createdAt: Date.now(),
      ...(isFirstAccount ? { role: 'admin' } : {}),
    };
    if (isFirstAccount) console.log(`[ADMIN] 最初のアカウント "${name}" を管理者に設定しました`);
    saveAccounts();
    getPlayerCoins(name);
    const token = generateToken();
    sessions[token] = { username: name, createdAt: Date.now() };
    const role = accounts[name].role || 'user';
    res.json({ ok: true, username: name, role, token });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ログイン
app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'ユーザー名とパスワードが必要です' });
    const name = String(username).slice(0, 12).replace(/[<>&"']/g, '');
    const acc = accounts[name];
    if (!acc) return res.status(401).json({ error: 'アカウントが見つかりません' });

    // bcryptハッシュか旧SHA256ハッシュかを判定して検証
    let valid = false;
    if (acc.password.startsWith('$2')) {
      valid = await bcrypt.compare(String(password), acc.password);
    } else {
      // 旧ハッシュ形式 → 検証後にbcryptへ移行
      valid = (acc.password === legacyHash(String(password)));
      if (valid) {
        acc.password = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
        saveAccounts();
      }
    }
    if (!valid) return res.status(401).json({ error: 'パスワードが違います' });

    const token = generateToken();
    sessions[token] = { username: name, createdAt: Date.now() };
    res.json({ ok: true, username: name, avatar: acc.avatar, role: acc.role || 'user', token });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ===== YouTube プレイリストAPI =====
let ytApiKey = process.env.YOUTUBE_API_KEY || '';

app.get('/api/youtube/playlist/:playlistId', async (req, res) => {
  if (!ytApiKey) return res.status(500).json({ error: 'YouTube API Key が設定されていません。管理者パネルから設定してください。' });
  const playlistId = String(req.params.playlistId).slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, '');
  const pageToken = req.query.pageToken ? String(req.query.pageToken).slice(0, 64) : '';
  try {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=25&playlistId=${playlistId}&key=${ytApiKey}${pageToken ? '&pageToken=' + pageToken : ''}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.error) return res.status(400).json({ error: data.error.message || 'プレイリストの取得に失敗しました' });
    const items = (data.items || []).map(item => ({
      videoId: item.snippet?.resourceId?.videoId,
      title: item.snippet?.title,
      thumbnail: item.snippet?.thumbnails?.default?.url,
      channel: item.snippet?.videoOwnerChannelTitle,
    })).filter(i => i.videoId && i.title !== 'Private video' && i.title !== 'Deleted video');
    res.json({ items, nextPageToken: data.nextPageToken || null, total: data.pageInfo?.totalResults || 0 });
  } catch (e) {
    console.error('YouTube API error:', e);
    res.status(500).json({ error: 'YouTube APIの取得に失敗しました' });
  }
});

// YouTube API Key 管理者設定
app.post('/api/admin/youtube-key', (req, res) => {
  const { key, token } = req.body;
  if (!token || !sessions[token]) return res.status(401).json({ error: '認証が必要です' });
  const username = sessions[token].username;
  // isAdmin はこの下で定義されるため、ここではaccountsを直接チェック
  const acc = accounts[username];
  const adminNames = (process.env.ADMIN_USERS || '').split(',').filter(Boolean);
  if (!adminNames.includes(username) && (!acc || acc.role !== 'admin')) {
    return res.status(403).json({ error: '管理者権限が必要です' });
  }
  if (!key || typeof key !== 'string' || key.length > 64) {
    return res.status(400).json({ error: '無効なAPIキーです' });
  }
  ytApiKey = key.trim();
  console.log(`YouTube API Key set by ${username}`);
  res.json({ ok: true });
});

// 管理者設定（最初に登録されたアカウントを管理者にする、または環境変数で指定）
const ADMIN_NAMES = (process.env.ADMIN_USERS || 'Rin').split(',').filter(Boolean);

function isAdmin(name) {
  if (ADMIN_NAMES.includes(name)) return true;
  const acc = accounts[name];
  return acc && acc.role === 'admin';
}

// プロフィール取得
app.get('/api/profile/:name', (req, res) => {
  const name = req.params.name;
  const acc = accounts[name];
  const coins = coinData[name];
  const isOnline = Object.values(players).some(p => p.name === name);
  res.json({
    name,
    hasAccount: !!acc,
    role: acc?.role || 'user',
    createdAt: acc?.createdAt || null,
    coins: coins?.coins || 0,
    totalEarned: coins?.totalEarned || 0,
    workMinutes: coins?.workMinutes || 0,
    purchasedItems: coins?.purchasedItems?.length || 0,
    level: coins?.level || 1,
    xp: coins?.xp || 0,
    xpNext: xpForNextLevel(coins?.level || 1),
    totalXp: coins?.totalXp || 0,
    isOnline,
    isAdmin: isAdmin(name),
  });
});

// バージョンチェックAPI
app.get('/api/version', (req, res) => {
  res.json({
    current: LOCAL_VERSION,
    latest: latestVersionInfo ? latestVersionInfo.version : LOCAL_VERSION,
    updateAvailable: !!latestVersionInfo,
    changelog: latestVersionInfo ? latestVersionInfo.changelog : [],
    date: latestVersionInfo ? latestVersionInfo.date : null
  });
});

// ワンクリック自動アップデート
app.post('/api/admin/update', async (req, res) => {
  const { token } = req.body;
  if (!token || !sessions[token]) return res.status(401).json({ error: '認証が必要です' });
  const username = sessions[token].username;
  const adminNames = (process.env.ADMIN_USERS || '').split(',').filter(Boolean);
  const acc = accounts[username];
  if (!adminNames.includes(username) && (!acc || acc.role !== 'admin')) {
    return res.status(403).json({ error: '管理者権限が必要です' });
  }
  if (!latestVersionInfo) return res.json({ error: 'アップデートはありません', ok: false });
  if (updateInProgress) return res.json({ error: 'アップデート中です。しばらくお待ちください。', ok: false });

  updateInProgress = true;
  const targetVersion = latestVersionInfo.version;
  console.log(`[UPDATE] v${targetVersion} へのアップデートを開始 (by ${username})`);

  const results = [];
  let success = true;

  for (const file of UPDATE_FILES) {
    try {
      const url = `${REPO_RAW_BASE}/${file.remote}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        results.push({ file: file.local, status: 'skip', reason: `HTTP ${resp.status}` });
        continue;
      }
      const content = await resp.text();
      const localPath = path.join(__dirname, file.local);
      // バックアップ
      if (fs.existsSync(localPath)) {
        fs.copyFileSync(localPath, localPath + '.bak');
      }
      // ディレクトリが存在しない場合は作成
      const dir = path.dirname(localPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(localPath, content, 'utf8');
      results.push({ file: file.local, status: 'ok' });
    } catch (e) {
      results.push({ file: file.local, status: 'error', reason: e.message });
      success = false;
    }
  }

  if (success) {
    LOCAL_VERSION = targetVersion;
    latestVersionInfo = null;
    console.log(`[UPDATE] v${targetVersion} へのアップデート完了`);
    // 全クライアントに通知
    io.emit('systemMessage', `🔄 サーバーが v${targetVersion} にアップデートされました。ページを再読み込みしてください。`);
  }

  updateInProgress = false;
  res.json({
    ok: success,
    version: targetVersion,
    results,
    needRestart: success,
    message: success
      ? `v${targetVersion} にアップデート完了。サーバーを再起動してください。`
      : 'アップデート中にエラーが発生しました。'
  });
});

// 管理者: ユーザーにコイン付与
app.post('/api/admin/give-coins', (req, res) => {
  const { adminName, targetName, amount } = req.body;
  if (!isAdmin(adminName)) return res.status(403).json({ error: '権限がありません' });
  const newBal = addCoins(targetName, Number(amount) || 0, '管理者付与');
  // オンラインなら通知
  for (const [sid, p] of Object.entries(players)) {
    if (p.name === targetName) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit('coinUpdate', { coins: newBal, earned: Number(amount), reason: '管理者からのギフト' });
    }
  }
  res.json({ ok: true, coins: newBal });
});

// ===== 部屋BGMシステム =====
const roomBgm = { lobby: null, work: null, meeting: null, japanese: null };
// { videoId, title, setBy }

// ===== 天気システム =====
const WEATHER_TYPES = ['sunny', 'rain', 'snow', 'cloudy'];
let currentWeather = 'sunny';
setInterval(() => {
  currentWeather = WEATHER_TYPES[Math.floor(Math.random() * WEATHER_TYPES.length)];
  io.emit('weatherUpdate', currentWeather);
}, 15 * 60 * 1000);

// プレイヤー管理
const players = {};

// 家具管理（部屋ごと）
let furniture = { lobby: [], work: [], meeting: [], japanese: [] };

function saveFurniture() {
  dataSet('furniture', furniture);
}

// ===== コインシステム =====
let coinData = {};

function saveCoins() {
  dataSet('coins', coinData);
}

function getPlayerCoins(name) {
  if (!coinData[name]) {
    coinData[name] = { coins: 10, totalEarned: 10, purchasedItems: [], workMinutes: 0, xp: 0, level: 1, totalXp: 0 };
  }
  // 既存データにXPフィールドがない場合の互換対応
  const d = coinData[name];
  if (d.level === undefined) { d.level = 1; d.xp = 0; d.totalXp = 0; }
  return d;
}

// レベル計算: レベルL→L+1に必要なXP = L * 100
function xpForNextLevel(level) { return level * 100; }

// XPを加算し、レベルアップがあればコインを付与。戻り値: { leveled, newLevel, coinReward }
function addXP(name, amount, socket) {
  const data = getPlayerCoins(name);
  data.xp += amount;
  data.totalXp += amount;
  let leveled = false;
  let totalCoinReward = 0;
  while (data.xp >= xpForNextLevel(data.level)) {
    data.xp -= xpForNextLevel(data.level);
    data.level++;
    const coinReward = 10 + data.level * 5;
    data.coins += coinReward;
    data.totalEarned += coinReward;
    totalCoinReward += coinReward;
    leveled = true;
    if (socket) {
      socket.emit('levelUp', { level: data.level, coinReward, xp: data.xp, xpNext: xpForNextLevel(data.level) });
      io.emit('chatMessage', { id: 'system', name: 'システム', message: `⬆️ ${name} がレベル ${data.level} に到達！ (+${coinReward}コイン)`, msgId: Date.now() + '_lvl' });
    }
  }
  saveCoins();
  if (socket) {
    socket.emit('xpUpdate', { xp: data.xp, level: data.level, totalXp: data.totalXp, xpNext: xpForNextLevel(data.level), coins: data.coins });
  }
  return { leveled, newLevel: data.level, totalCoinReward };
}

function addCoins(name, amount, reason) {
  const data = getPlayerCoins(name);
  data.coins += amount;
  data.totalEarned += amount;
  saveCoins();
  return data.coins;
}

// 作業部屋の滞在時間追跡
const workTimers = {}; // socketId -> { startTime, name }

function startWorkTimer(socketId, name) {
  workTimers[socketId] = { startTime: Date.now(), name, lastTick: Date.now() };
}

function stopWorkTimer(socketId) {
  if (!workTimers[socketId]) return 0;
  const elapsed = Date.now() - workTimers[socketId].startTime;
  delete workTimers[socketId];
  return elapsed;
}

// 毎分XP付与チェック
const XP_PER_MINUTE = 2;
setInterval(() => {
  const now = Date.now();
  for (const [socketId, timer] of Object.entries(workTimers)) {
    const elapsed = now - timer.lastTick;
    if (elapsed >= 60000) { // 1分経過
      const minutes = Math.floor(elapsed / 60000);
      timer.lastTick = now;
      const data = getPlayerCoins(timer.name);
      data.workMinutes += minutes;
      const sock = io.sockets.sockets.get(socketId);
      addXP(timer.name, XP_PER_MINUTE * minutes, sock);
      if (minutes % 10 === 0) checkAchievements(timer.name, sock);
    }
  }
}, 10000); // 10秒ごとにチェック

// ショップアイテム定義
const SHOP_ITEMS = [
  // ===== 髪型 (10) =====
  { id: 'hs_short', name: 'ショートヘア', price: 30, type: 'hair_shape', value: 1, icon: '💇', category: 'hair' },
  { id: 'hs_medium', name: 'ミディアムヘア', price: 40, type: 'hair_shape', value: 2, icon: '💇', category: 'hair' },
  { id: 'hs_long', name: 'ロングヘア', price: 50, type: 'hair_shape', value: 3, icon: '💇', category: 'hair' },
  { id: 'hs_ponytail', name: 'ポニーテール', price: 40, type: 'hair_shape', value: 4, icon: '🎀', category: 'hair' },
  { id: 'hs_twintail', name: 'ツインテール', price: 50, type: 'hair_shape', value: 5, icon: '🎀', category: 'hair' },
  { id: 'hs_bob', name: 'ボブヘア', price: 40, type: 'hair_shape', value: 6, icon: '💇', category: 'hair' },
  { id: 'hs_mohawk', name: 'モヒカン', price: 60, type: 'hair_shape', value: 7, icon: '🔥', category: 'hair' },
  { id: 'hs_afro', name: 'アフロヘア', price: 60, type: 'hair_shape', value: 8, icon: '🌀', category: 'hair' },
  { id: 'hs_sidetail', name: 'サイドテール', price: 45, type: 'hair_shape', value: 10, icon: '💇', category: 'hair' },
  { id: 'hs_braid', name: '三つ編み', price: 55, type: 'hair_shape', value: 11, icon: '🎀', category: 'hair' },
  // ===== ヘアカラー (10) =====
  { id: 'hc_purple', name: 'パープルヘア', price: 30, type: 'hair_color', value: 8, icon: '💜', category: 'hair_color' },
  { id: 'hc_hotpink', name: 'ホットピンク', price: 35, type: 'hair_color', value: 9, icon: '💗', category: 'hair_color' },
  { id: 'hc_teal', name: 'ティールヘア', price: 35, type: 'hair_color', value: 10, icon: '🩵', category: 'hair_color' },
  { id: 'hc_lime', name: 'ライムグリーン', price: 40, type: 'hair_color', value: 11, icon: '💚', category: 'hair_color' },
  { id: 'hc_gold', name: 'ゴールドヘア', price: 50, type: 'hair_color', value: 12, icon: '🌟', category: 'hair_color' },
  { id: 'hc_tomato', name: 'トマトレッド', price: 35, type: 'hair_color', value: 13, icon: '❤️', category: 'hair_color' },
  { id: 'hc_lavender', name: 'ラベンダー', price: 40, type: 'hair_color', value: 14, icon: '💜', category: 'hair_color' },
  { id: 'hc_crimson', name: 'クリムゾン', price: 45, type: 'hair_color', value: 15, icon: '🔴', category: 'hair_color' },
  { id: 'hair_rainbow', name: '虹色ヘア', price: 50, type: 'hair_color', value: 8, icon: '🌈', category: 'hair_color' },
  { id: 'hair_silver', name: 'シルバーヘア', price: 30, type: 'hair_color', value: 4, icon: '🤍', category: 'hair_color' },
  // ===== ふく・うえ (15) =====
  { id: 'body_gold', name: 'ゴールドスーツ', price: 80, type: 'body_color', value: 8, icon: '✨', category: 'body' },
  { id: 'body_galaxy', name: 'ギャラクシー服', price: 100, type: 'body_color', value: 9, icon: '🌌', category: 'body' },
  { id: 'bc_wine', name: 'ワインレッド', price: 60, type: 'body_color', value: 10, icon: '🍷', category: 'body' },
  { id: 'bc_sunset', name: 'サンセット', price: 70, type: 'body_color', value: 11, icon: '🌅', category: 'body' },
  { id: 'bc_lavender', name: 'ラベンダーシャツ', price: 55, type: 'body_color', value: 12, icon: '💜', category: 'body' },
  { id: 'bc_forest', name: 'フォレストグリーン', price: 50, type: 'body_color', value: 13, icon: '🌲', category: 'body' },
  { id: 'bc_cherry', name: 'チェリーレッド', price: 65, type: 'body_color', value: 14, icon: '🍒', category: 'body' },
  { id: 'bc_ocean', name: 'オーシャンブルー', price: 55, type: 'body_color', value: 15, icon: '🌊', category: 'body' },
  { id: 'bc_rust', name: 'ラストオレンジ', price: 60, type: 'body_color', value: 8, icon: '🧡', category: 'body' },
  { id: 'bc_mint', name: 'ミントグリーン', price: 50, type: 'body_color', value: 9, icon: '🌿', category: 'body' },
  { id: 'bc_coral', name: 'コーラルピンク', price: 55, type: 'body_color', value: 10, icon: '🪸', category: 'body' },
  { id: 'bc_storm', name: 'ストームグレー', price: 45, type: 'body_color', value: 11, icon: '🌩️', category: 'body' },
  { id: 'bc_honey', name: 'ハニーイエロー', price: 50, type: 'body_color', value: 12, icon: '🍯', category: 'body' },
  { id: 'bc_blush', name: 'ブラッシュ', price: 65, type: 'body_color', value: 13, icon: '🌸', category: 'body' },
  { id: 'bc_titanium', name: 'チタンシルバー', price: 90, type: 'body_color', value: 15, icon: '⚙️', category: 'body' },
  // ===== ふく・した (10) =====
  { id: 'pants_white', name: 'ホワイトパンツ', price: 40, type: 'pants_color', value: 8, icon: '👖', category: 'pants' },
  { id: 'pants_stripe', name: 'ストライプ', price: 60, type: 'pants_color', value: 9, icon: '📏', category: 'pants' },
  { id: 'pc_navy', name: 'ネイビーパンツ', price: 50, type: 'pants_color', value: 10, icon: '👖', category: 'pants' },
  { id: 'pc_burgundy', name: 'バーガンディ', price: 55, type: 'pants_color', value: 11, icon: '🟤', category: 'pants' },
  { id: 'pc_olive', name: 'オリーブ', price: 45, type: 'pants_color', value: 12, icon: '🫒', category: 'pants' },
  { id: 'pc_charcoal', name: 'チャコール', price: 40, type: 'pants_color', value: 13, icon: '⬛', category: 'pants' },
  { id: 'pc_sand', name: 'サンドベージュ', price: 50, type: 'pants_color', value: 14, icon: '🏖️', category: 'pants' },
  { id: 'pc_ink', name: 'インクブラック', price: 55, type: 'pants_color', value: 8, icon: '🖊️', category: 'pants' },
  { id: 'pc_denim', name: 'デニムブルー', price: 45, type: 'pants_color', value: 9, icon: '👖', category: 'pants' },
  { id: 'pc_khaki', name: 'カーキ', price: 40, type: 'pants_color', value: 15, icon: '🟫', category: 'pants' },
  // ===== アクセサリー (15) =====
  { id: 'acc_sunglasses', name: 'サングラス', price: 50, type: 'acc', value: 5, icon: '🕶️', category: 'acc' },
  { id: 'acc_mask', name: 'マスク', price: 30, type: 'acc', value: 6, icon: '😷', category: 'acc' },
  { id: 'acc_tiara', name: 'ティアラ', price: 100, type: 'acc', value: 7, icon: '👸', category: 'acc' },
  { id: 'acc_necktie', name: 'ネクタイ', price: 40, type: 'acc', value: 8, icon: '👔', category: 'acc' },
  { id: 'acc_bowtie', name: '蝶ネクタイ', price: 50, type: 'acc', value: 9, icon: '🎀', category: 'acc' },
  { id: 'acc_earring', name: 'イヤリング', price: 60, type: 'acc', value: 10, icon: '💎', category: 'acc' },
  { id: 'acc_beret', name: 'ベレー帽', price: 70, type: 'acc', value: 11, icon: '🎨', category: 'acc' },
  { id: 'acc_cap', name: 'キャップ', price: 50, type: 'acc', value: 12, icon: '🧢', category: 'acc' },
  { id: 'acc_cat_ears', name: 'ネコ耳', price: 90, type: 'acc', value: 13, icon: '🐱', category: 'acc' },
  { id: 'acc_halo', name: '天使の輪', price: 120, type: 'acc', value: 14, icon: '😇', category: 'acc' },
  { id: 'acc_flower', name: 'お花', price: 40, type: 'acc', value: 2, icon: '🌸', category: 'acc' },
  { id: 'acc_bandana', name: 'バンダナ', price: 45, type: 'acc', value: 0, icon: '🏴‍☠️', category: 'acc' },
  { id: 'acc_monocle', name: 'モノクル', price: 80, type: 'acc', value: 1, icon: '🧐', category: 'acc' },
  { id: 'acc_crown_gold', name: '黄金の王冠', price: 200, type: 'acc', value: 4, icon: '👑', category: 'acc' },
  { id: 'acc_headband', name: 'ヘアバンド', price: 35, type: 'acc', value: 3, icon: '🎽', category: 'acc' },
  // ===== スキン (5) =====
  { id: 'skin_tan', name: '小麦肌', price: 40, type: 'skin', value: 2, icon: '🧑', category: 'skin' },
  { id: 'skin_mocha', name: 'モカ', price: 40, type: 'skin', value: 3, icon: '🧑', category: 'skin' },
  { id: 'skin_caramel', name: 'キャラメル', price: 40, type: 'skin', value: 4, icon: '🧑', category: 'skin' },
  { id: 'skin_cocoa', name: 'ココア', price: 40, type: 'skin', value: 5, icon: '🧑', category: 'skin' },
  { id: 'skin_espresso', name: 'エスプレッソ', price: 40, type: 'skin', value: 6, icon: '🧑', category: 'skin' },
  // ===== エモート (15) =====
  { id: 'emote_dance', name: 'ダンスエモート', price: 50, type: 'emote', value: 'dance', icon: '💃', category: 'emote' },
  { id: 'emote_sparkle', name: 'キラキラ', price: 30, type: 'emote', value: 'sparkle', icon: '✨', category: 'emote' },
  { id: 'emote_heart', name: 'ハートエモート', price: 40, type: 'emote', value: 'heart', icon: '❤️', category: 'emote' },
  { id: 'emote_fire', name: 'ファイヤー', price: 45, type: 'emote', value: 'fire', icon: '🔥', category: 'emote' },
  { id: 'emote_clap', name: '拍手', price: 30, type: 'emote', value: 'clap', icon: '👏', category: 'emote' },
  { id: 'emote_wave', name: '手を振る', price: 25, type: 'emote', value: 'wave', icon: '👋', category: 'emote' },
  { id: 'emote_laugh', name: '大笑い', price: 35, type: 'emote', value: 'laugh', icon: '😂', category: 'emote' },
  { id: 'emote_cry', name: '泣く', price: 35, type: 'emote', value: 'cry', icon: '😢', category: 'emote' },
  { id: 'emote_angry', name: '怒り', price: 30, type: 'emote', value: 'angry', icon: '😡', category: 'emote' },
  { id: 'emote_sleep', name: '居眠り', price: 40, type: 'emote', value: 'sleep', icon: '😴', category: 'emote' },
  { id: 'emote_music', name: '音楽', price: 35, type: 'emote', value: 'music', icon: '🎵', category: 'emote' },
  { id: 'emote_confetti', name: '紙吹雪', price: 60, type: 'emote', value: 'confetti', icon: '🎊', category: 'emote' },
  { id: 'emote_shock', name: 'びっくり', price: 30, type: 'emote', value: 'shock', icon: '😱', category: 'emote' },
  { id: 'emote_think', name: '考え中', price: 30, type: 'emote', value: 'think', icon: '🤔', category: 'emote' },
  { id: 'emote_rainbow', name: 'レインボー', price: 80, type: 'emote', value: 'rainbow', icon: '🌈', category: 'emote' },
  // ===== ペット (12) =====
  { id: 'pet_cat', name: 'ネコ', price: 150, type: 'pet', value: 'cat', icon: '🐱', category: 'pet' },
  { id: 'pet_dog', name: 'イヌ', price: 150, type: 'pet', value: 'dog', icon: '🐶', category: 'pet' },
  { id: 'pet_bird', name: 'トリ', price: 100, type: 'pet', value: 'bird', icon: '🐦', category: 'pet' },
  { id: 'pet_slime', name: 'スライム', price: 200, type: 'pet', value: 'slime', icon: '🟢', category: 'pet' },
  { id: 'pet_rabbit', name: 'ウサギ', price: 120, type: 'pet', value: 'rabbit', icon: '🐰', category: 'pet' },
  { id: 'pet_hamster', name: 'ハムスター', price: 130, type: 'pet', value: 'hamster', icon: '🐹', category: 'pet' },
  { id: 'pet_turtle', name: 'カメ', price: 100, type: 'pet', value: 'turtle', icon: '🐢', category: 'pet' },
  { id: 'pet_dragon', name: 'ドラゴン', price: 500, type: 'pet', value: 'dragon', icon: '🐉', category: 'pet' },
  { id: 'pet_robot', name: 'ロボット', price: 300, type: 'pet', value: 'robot', icon: '🤖', category: 'pet' },
  { id: 'pet_fairy', name: '妖精', price: 250, type: 'pet', value: 'fairy', icon: '🧚', category: 'pet' },
  { id: 'pet_ghost', name: 'おばけ', price: 180, type: 'pet', value: 'ghost', icon: '👻', category: 'pet' },
  { id: 'pet_fox', name: 'キツネ', price: 200, type: 'pet', value: 'fox', icon: '🦊', category: 'pet' },
  // ===== 称号 (10) =====
  { id: 'title_newbie', name: '新人さん', price: 100, type: 'title', value: '🔰 新人さん', icon: '🔰', category: 'title' },
  { id: 'title_pro', name: 'プロフェッショナル', price: 200, type: 'title', value: '💼 プロ', icon: '💼', category: 'title' },
  { id: 'title_legend', name: '伝説のプレイヤー', price: 500, type: 'title', value: '🏆 伝説', icon: '🏆', category: 'title' },
  { id: 'title_ninja', name: '忍者', price: 150, type: 'title', value: '🥷 忍者', icon: '🥷', category: 'title' },
  { id: 'title_star', name: 'スター', price: 250, type: 'title', value: '⭐ スター', icon: '⭐', category: 'title' },
  { id: 'title_wizard', name: '魔法使い', price: 200, type: 'title', value: '🧙 魔法使い', icon: '🧙', category: 'title' },
  { id: 'title_king', name: '王様', price: 400, type: 'title', value: '👑 王様', icon: '👑', category: 'title' },
  { id: 'title_angel', name: '天使', price: 300, type: 'title', value: '😇 天使', icon: '😇', category: 'title' },
  { id: 'title_hero', name: 'ヒーロー', price: 350, type: 'title', value: '🦸 ヒーロー', icon: '🦸', category: 'title' },
  { id: 'title_artist', name: 'アーティスト', price: 180, type: 'title', value: '🎨 芸術家', icon: '🎨', category: 'title' },
  // ===== エフェクト (6) =====
  { id: 'effect_sparkle', name: 'キラキラオーラ', price: 300, type: 'effect', value: 'sparkle', icon: '✨', category: 'effect' },
  { id: 'effect_fire', name: '炎オーラ', price: 400, type: 'effect', value: 'fire', icon: '🔥', category: 'effect' },
  { id: 'effect_snow', name: '雪オーラ', price: 350, type: 'effect', value: 'snow', icon: '❄️', category: 'effect' },
  { id: 'effect_sakura', name: '桜オーラ', price: 350, type: 'effect', value: 'sakura', icon: '🌸', category: 'effect' },
  { id: 'effect_thunder', name: '雷オーラ', price: 500, type: 'effect', value: 'thunder', icon: '⚡', category: 'effect' },
  { id: 'effect_heart', name: 'ハートオーラ', price: 300, type: 'effect', value: 'heart', icon: '💖', category: 'effect' },
];

// ===== 実績システム =====
const ACHIEVEMENTS = [
  { id: 'first_login', name: '初ログイン', desc: '初めてログイン', icon: '🎉', condition: (d) => true },
  { id: 'work_1h', name: '作業1時間', desc: '累計1時間作業', icon: '⏰', condition: (d) => d.workMinutes >= 60 },
  { id: 'work_10h', name: '作業10時間', desc: '累計10時間作業', icon: '🏆', condition: (d) => d.workMinutes >= 600 },
  { id: 'work_100h', name: '作業マスター', desc: '累計100時間作業', icon: '👑', condition: (d) => d.workMinutes >= 6000 },
  { id: 'coins_100', name: 'お金持ち', desc: '100コイン獲得', icon: '💰', condition: (d) => d.totalEarned >= 100 },
  { id: 'coins_1000', name: '大富豪', desc: '1000コイン獲得', icon: '💎', condition: (d) => d.totalEarned >= 1000 },
  { id: 'items_3', name: 'コレクター', desc: '3個アイテム購入', icon: '🛍️', condition: (d) => d.purchasedItems.length >= 3 },
  { id: 'items_10', name: 'ショッピング王', desc: '10個アイテム購入', icon: '👜', condition: (d) => d.purchasedItems.length >= 10 },
  { id: 'chat_50', name: 'おしゃべり', desc: '50回チャット', icon: '💬', condition: (d) => (d.chatCount || 0) >= 50 },
  { id: 'pet_owner', name: 'ペットオーナー', desc: 'ペットを購入', icon: '🐾', condition: (d) => d.purchasedItems.some(i => i.startsWith('pet_')) },
  { id: 'level_5', name: 'レベル5', desc: 'レベル5に到達', icon: '⭐', condition: (d) => (d.level || 1) >= 5 },
  { id: 'level_10', name: 'レベル10', desc: 'レベル10に到達', icon: '🌟', condition: (d) => (d.level || 1) >= 10 },
  { id: 'level_25', name: 'ベテラン', desc: 'レベル25に到達', icon: '💫', condition: (d) => (d.level || 1) >= 25 },
];

function checkAchievements(name, socket) {
  const data = getPlayerCoins(name);
  if (!data.achievements) data.achievements = [];
  let newAch = false;
  for (const ach of ACHIEVEMENTS) {
    if (!data.achievements.includes(ach.id) && ach.condition(data)) {
      data.achievements.push(ach.id);
      newAch = true;
      if (socket) {
        socket.emit('achievementUnlocked', ach);
        io.emit('chatMessage', { id: 'system', name: 'システム', message: `🏅 ${name} が実績「${ach.name}」を解除！` });
      }
    }
  }
  if (newAch) saveCoins();
}

// ===== 部屋テーマ =====
let roomThemes = { lobby: { floor: 0, wall: 0 }, work: { floor: 0, wall: 0 }, meeting: { floor: 0, wall: 0 }, japanese: { floor: 0, wall: 0 } };
function saveRoomThemes() { dataSet('roomThemes', roomThemes); }

// ===== カスタム部屋 =====
let customRooms = {};
function saveCustomRooms() { dataSet('customRooms', customRooms); }

// ===== ミニゲーム =====
let wordWolfGame = { active: false, phase: 'idle', players: {} };
let speedQuizGame = { active: false, phase: 'idle', scores: {} };

function broadcastWordWolf() {
  const ids = Object.keys(wordWolfGame.players);
  for (const id of ids) {
    const sock = io.sockets.sockets.get(id);
    if (!sock) continue;
    const myPlayer = wordWolfGame.players[id];
    const state = {
      active: wordWolfGame.active, phase: wordWolfGame.phase,
      adminId: wordWolfGame.adminId, timerEnd: wordWolfGame.timerEnd,
      discussionMinutes: wordWolfGame.discussionMinutes,
      myWord: myPlayer?.word || null, players: {},
    };
    for (const [pid, p] of Object.entries(wordWolfGame.players)) {
      state.players[pid] = {
        name: p.name,
        votedFor: wordWolfGame.phase === 'reveal' ? p.votedFor : (pid === id ? p.votedFor : null),
        isWolf: wordWolfGame.phase === 'reveal' ? p.isWolf : undefined,
        word: wordWolfGame.phase === 'reveal' ? p.word : undefined,
      };
    }
    if (wordWolfGame.result && wordWolfGame.phase === 'reveal') {
      state.result = wordWolfGame.result;
      state.majorityWord = wordWolfGame.majorityWord;
      state.wolfWord = wordWolfGame.wolfWord;
    }
    sock.emit('wordWolfUpdate', state);
  }
  io.emit('wordWolfStatus', { active: wordWolfGame.active, phase: wordWolfGame.phase, playerCount: ids.length });
}

function broadcastQuiz() {
  const q = speedQuizGame;
  const currentQuestion = q.currentQ >= 0 && q.currentQ < q.questions.length ? q.questions[q.currentQ] : null;
  const state = {
    active: q.active, phase: q.phase, adminId: q.adminId,
    currentQ: q.currentQ, totalQ: q.questions?.length || 0,
    question: currentQuestion ? currentQuestion.q : null,
    answer: (q.phase === 'result' || q.phase === 'finished') && currentQuestion ? currentQuestion.a : null,
    buzzedBy: q.buzzedBy,
    buzzedName: q.buzzedBy && q.scores[q.buzzedBy] ? q.scores[q.buzzedBy].name : null,
    submittedAnswer: q.submittedAnswer || null,
    lastCorrect: q.lastCorrect, timerEnd: q.timerEnd, scores: q.scores,
  };
  io.emit('speedQuizUpdate', state);
}

// ===== ホワイトボード =====
let whiteboardStrokes = []; // [{tool,color,size,points:[{x,y}]}]
let whiteboardActiveStrokes = {}; // socketId -> current stroke being drawn

// ===== 会議システム =====
let meeting = {
  active: false,
  topic: '',
  topics: [],       // { id, text, author, votes: { yes:[], no:[] }, status:'pending'|'voting'|'done' }
  hands: [],         // socketId[]
  timer: null,
  timerEnd: 0,
  startedBy: '',
};

function getMeetingState() {
  return {
    active: meeting.active,
    topic: meeting.topic,
    topics: meeting.topics,
    hands: meeting.hands.map(sid => players[sid]?.name || '???'),
    timerEnd: meeting.timerEnd,
    startedBy: meeting.startedBy,
  };
}

function broadcastMeeting() {
  io.emit('meetingUpdate', getMeetingState());
}

// 家具の種類定義（112種）
const VALID_FURNITURE_SET = new Set([
  // 座席
  'sofa','office_chair','armchair','bench','stool','beanbag','rocking_chair','barstool','zaisu','hammock','swing_chair','throne',
  // デスク
  'table','desk_l','standing_desk','coffee_table','round_table','kotatsu','workbench','counter_table','bar_counter',
  // 収納
  'bookshelf','cabinet','locker','shelf_wall','drawer','shoe_rack','wardrobe','filing_cabinet','crate','treasure_chest',
  // 照明
  'lamp','chandelier','desk_lamp','lantern','neon_sign','candle','lava_lamp','spotlight',
  // 植物
  'plant_big','plant_small','cactus','bonsai','flower_pot','bamboo','ivy_wall','sakura_tree','sunflower','mushroom',
  // 壁飾り
  'poster','clock','painting','mirror','banner','calendar','map_world','photo_frame','dart_board','flag',
  // 電子機器
  'tv','monitor','arcade_machine','jukebox','radio','projector','speaker','computer','console_game','drone_display',
  // キッチン
  'vending','fridge','microwave','coffee_machine','water_cooler','toaster','rice_cooker','sushi_bar',
  // 床
  'rug_small','rug_large','rug_circle','tatami_mat','yoga_mat','welcome_mat','carpet_red','stone_tile',
  // お楽しみ
  'trophy','aquarium','piano','guitar','pool_table','ping_pong','punching_bag','telescope','globe','slot_machine',
  // 季節
  'christmas_tree','snowman','jack_o_lantern','tanabata','kadomatsu','fireworks_box','campfire','fountain',
  // アウトドア
  'tent','bbq_grill','picnic_basket','mailbox','park_bench','street_lamp','signpost','bicycle',
]);

// ===== Discord Webhook連携 =====
const DISCORD_WEBHOOK_LOG = process.env.DISCORD_WEBHOOK_LOG || '';   // 入退室ログ用
const DISCORD_WEBHOOK_STATUS = process.env.DISCORD_WEBHOOK_STATUS || ''; // オンライン一覧用
let discordStatusMessageId = null;
const ROOM_NAMES_JP = { lobby: 'ロビー', work: '作業部屋', meeting: '会議室', japanese: '和室' };

async function discordWebhook(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) { console.error('Discord webhook error:', e.message); }
}

function discordLogJoin(name) {
  discordWebhook(DISCORD_WEBHOOK_LOG, {
    embeds: [{
      color: 0x4caf50,
      description: `🟢 **${name}** がオフィスに入りました`,
      timestamp: new Date().toISOString(),
    }]
  });
}

function discordLogLeave(name, duration) {
  const durStr = duration > 0 ? ` (滞在: ${Math.floor(duration / 60000)}分)` : '';
  discordWebhook(DISCORD_WEBHOOK_LOG, {
    embeds: [{
      color: 0xf44336,
      description: `🔴 **${name}** がオフィスを離れました${durStr}`,
      timestamp: new Date().toISOString(),
    }]
  });
}

function discordLogMove(name, room) {
  discordWebhook(DISCORD_WEBHOOK_LOG, {
    embeds: [{
      color: 0x2196f3,
      description: `🔄 **${name}** が **${ROOM_NAMES_JP[room] || room}** に移動しました`,
      timestamp: new Date().toISOString(),
    }]
  });
}

// オンライン一覧を定期更新 (30秒ごと)
async function updateDiscordStatus() {
  if (!DISCORD_WEBHOOK_STATUS) return;
  const online = Object.values(players).filter(p => p.name && !p.name.startsWith('Player'));
  const rooms = {};
  for (const p of online) {
    const rn = ROOM_NAMES_JP[p.room] || p.room || 'ロビー';
    if (!rooms[rn]) rooms[rn] = [];
    rooms[rn].push(p.name);
  }

  let desc = '';
  if (online.length === 0) {
    desc = '現在オフィスに誰もいません';
  } else {
    for (const [room, names] of Object.entries(rooms)) {
      desc += `**${room}**\n${names.map(n => `> 🟢 ${n}`).join('\n')}\n\n`;
    }
  }

  const embed = {
    title: '🏢 オフィス在席状況',
    description: desc.trim(),
    color: 0x7c8aff,
    footer: { text: `${online.length}人がオンライン` },
    timestamp: new Date().toISOString(),
  };

  try {
    if (discordStatusMessageId) {
      // 既存メッセージを編集
      const editUrl = `${DISCORD_WEBHOOK_STATUS}/messages/${discordStatusMessageId}`;
      const res = await fetch(editUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
      if (!res.ok) discordStatusMessageId = null; // 編集失敗なら再作成
    }
    if (!discordStatusMessageId) {
      // 新規メッセージ作成
      const res = await fetch(`${DISCORD_WEBHOOK_STATUS}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
      if (res.ok) {
        const data = await res.json();
        discordStatusMessageId = data.id;
      }
    }
  } catch (e) { console.error('Discord status update error:', e.message); }
}

setInterval(updateDiscordStatus, 30000);

// ===== Discord Bot連携用 REST API =====

// Discord Botからコイン付与
app.post('/api/coins/add', (req, res) => {
  const { playerName, amount, reason, secret } = req.body;
  if (secret !== (process.env.API_SECRET || 'metaverse-secret')) {
    return res.status(403).json({ error: 'Invalid secret' });
  }
  if (!playerName || !amount) {
    return res.status(400).json({ error: 'playerName and amount required' });
  }
  const newBalance = addCoins(playerName, Number(amount), reason || 'Discord');
  // オンラインプレイヤーに通知
  for (const [sid, p] of Object.entries(players)) {
    if (p.name === playerName) {
      const socket = io.sockets.sockets.get(sid);
      if (socket) {
        socket.emit('coinUpdate', { coins: newBalance, earned: Number(amount), reason: reason || 'Discord報酬' });
      }
    }
  }
  res.json({ playerName, coins: newBalance });
});

// コイン残高確認
app.get('/api/coins/:playerName', (req, res) => {
  const data = getPlayerCoins(req.params.playerName);
  res.json({ playerName: req.params.playerName, ...data });
});

// Socket.io認証ミドルウェア
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token && sessions[token]) {
    socket.authUser = sessions[token].username;
  }
  // 認証なしでも接続は許可（ゲスト・ログイン前）
  next();
});

io.on('connection', (socket) => {
  console.log(`接続: ${socket.id}${socket.authUser ? ` (${socket.authUser})` : ''}`);

  // 接続時にアップデートがあれば通知
  if (latestVersionInfo) {
    socket.emit('updateAvailable', {
      version: latestVersionInfo.version,
      current: LOCAL_VERSION,
      changelog: latestVersionInfo.changelog || [],
      date: latestVersionInfo.date || ''
    });
  }

  // 新規プレイヤー追加
  players[socket.id] = {
    id: socket.id,
    name: `Player${Math.floor(Math.random() * 999)}`,
    x: 5 + Math.floor(Math.random() * 4),
    y: 5 + Math.floor(Math.random() * 4),
    direction: 'down',
    sprite: Math.floor(Math.random() * 4),
    room: 'lobby',
    avatar: { hair: 0, body: 0, pants: 0, acc: -1 },
    status: 'online',
    statusMsg: '',
    pomodoro: null, // { endTime, type: 'work'|'break' }
    pet: null, // 'cat'|'dog'|'bird'|'slime'
    emote: null, // { type, startTime }
  };

  // 既存プレイヤー一覧を送信
  socket.emit('currentPlayers', players);
  socket.emit('currentFurniture', furniture);
  socket.emit('shopItems', SHOP_ITEMS);
  socket.emit('roomThemes', roomThemes);
  socket.emit('customRoomsList', customRooms);
  socket.emit('achievementsList', ACHIEVEMENTS);

  // 他プレイヤーに通知
  socket.broadcast.emit('playerJoined', players[socket.id]);

  // 名前変更
  socket.on('setName', (name) => {
    if (players[socket.id]) {
      const sanitized = String(name).slice(0, 12).replace(/[<>&"']/g, '');
      const isNewJoin = players[socket.id].name.startsWith('Player');
      players[socket.id].name = sanitized;
      players[socket.id].joinedAt = Date.now();
      io.emit('playerMoved', players[socket.id]);
      if (isNewJoin && !sanitized.startsWith('Guest')) discordLogJoin(sanitized);
      updateDiscordStatus();
      // コインデータ送信
      const data = getPlayerCoins(sanitized);
      socket.emit('coinInit', { coins: data.coins, totalEarned: data.totalEarned, purchasedItems: data.purchasedItems, workMinutes: data.workMinutes, achievements: data.achievements || [], xp: data.xp, level: data.level, totalXp: data.totalXp, xpNext: xpForNextLevel(data.level) });
      // ログインXPボーナス
      addXP(sanitized, 10, socket);
      // 実績チェック
      checkAchievements(sanitized, socket);
      // ペット復元
      const activePet = (data.purchasedItems || []).find(i => i.startsWith('pet_') && i === data.activePet);
      if (activePet) {
        const petType = SHOP_ITEMS.find(si => si.id === activePet)?.value;
        if (petType) { players[socket.id].pet = petType; io.emit('playerPetChanged', { id: socket.id, pet: petType }); }
      }
    }
  });

  // 移動
  socket.on('move', (data) => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      players[socket.id].direction = data.direction;
      socket.broadcast.emit('playerMoved', players[socket.id]);
    }
  });

  // 部屋移動
  socket.on('enterRoom', (room) => {
    const valid = ['lobby', 'work', 'meeting', 'japanese', ...Object.keys(customRooms)];
    if (players[socket.id] && valid.includes(room)) {
      const prevRoom = players[socket.id].room;
      players[socket.id].room = room;
      io.emit('playerRoomChanged', { id: socket.id, room });
      if (players[socket.id].name && !players[socket.id].name.startsWith('Player')) {
        discordLogMove(players[socket.id].name, room);
        updateDiscordStatus();
      }

      // 作業部屋のコイン計測
      if (prevRoom === 'work' && room !== 'work') {
        stopWorkTimer(socket.id);
      }
      if (room === 'work' && prevRoom !== 'work') {
        startWorkTimer(socket.id, players[socket.id].name);
        socket.emit('coinNotify', { message: '作業部屋でコインが貯まります！(2コイン/分)' });
      }
    }
  });

  // ステータス変更
  socket.on('setStatus', (status) => {
    const valid = ['online', 'working', 'meeting', 'break', 'away'];
    if (players[socket.id] && valid.includes(status)) {
      players[socket.id].status = status;
      io.emit('playerStatusChanged', { id: socket.id, status, statusMsg: players[socket.id].statusMsg });
    }
  });

  // 称号・エフェクト設定
  socket.on('setTitle', (title) => {
    if (!players[socket.id]) return;
    players[socket.id].title = String(title || '').slice(0, 20);
    io.emit('playerTitleChanged', { id: socket.id, title: players[socket.id].title });
  });
  socket.on('setEffect', (effect) => {
    if (!players[socket.id]) return;
    players[socket.id].effect = String(effect || '').slice(0, 20);
    io.emit('playerEffectChanged', { id: socket.id, effect: players[socket.id].effect });
  });

  // カスタムステータスメッセージ
  socket.on('setStatusMsg', (msg) => {
    if (!players[socket.id]) return;
    players[socket.id].statusMsg = String(msg || '').slice(0, 30).replace(/[<>&"']/g, '');
    io.emit('playerStatusChanged', { id: socket.id, status: players[socket.id].status, statusMsg: players[socket.id].statusMsg });
  });

  // DM（ダイレクトメッセージ）
  socket.on('dm', ({ to, message }) => {
    if (!players[socket.id]) return;
    const msg = String(message).slice(0, 200).replace(/[<>&"']/g, '');
    if (!msg) return;
    // toは相手のプレイヤー名
    const fromName = players[socket.id].name;
    // 送信先を探す
    for (const [sid, p] of Object.entries(players)) {
      if (p.name === to) {
        const targetSocket = io.sockets.sockets.get(sid);
        if (targetSocket) {
          targetSocket.emit('dmReceived', { from: fromName, message: msg, timestamp: Date.now() });
        }
        break;
      }
    }
    // 送信者にも確認
    socket.emit('dmSent', { to, message: msg, timestamp: Date.now() });
  });

  // ポモドーロタイマー
  socket.on('pomodoroStart', (type) => {
    if (!players[socket.id]) return;
    const t = type === 'break' ? 'break' : 'work';
    const duration = t === 'work' ? 25 * 60000 : 5 * 60000;
    players[socket.id].pomodoro = { endTime: Date.now() + duration, type: t };
    socket.emit('pomodoroUpdate', players[socket.id].pomodoro);
    // 作業開始なら自動ステータス変更
    if (t === 'work') {
      players[socket.id].status = 'working';
      io.emit('playerStatusChanged', { id: socket.id, status: 'working', statusMsg: players[socket.id].statusMsg });
    }
  });

  socket.on('pomodoroStop', () => {
    if (!players[socket.id]) return;
    const pomo = players[socket.id].pomodoro;
    players[socket.id].pomodoro = null;
    socket.emit('pomodoroUpdate', null);
    // 作業完了XPボーナス
    if (pomo && pomo.type === 'work' && Date.now() >= pomo.endTime) {
      addXP(players[socket.id].name, 25, socket);
      checkAchievements(players[socket.id].name, socket);
    }
  });

  // アバター変更
  socket.on('updateAvatar', (avatar) => {
    if (players[socket.id]) {
      // 新旧フォーマット両対応
      players[socket.id].avatar = {
        hairShape: Number(avatar.hairShape) || 0,
        hairColor: Number(avatar.hairColor) || Number(avatar.hair) || 0,
        bodyType: Number(avatar.bodyType) || 0,
        bodyColor: Number(avatar.bodyColor) || Number(avatar.body) || 0,
        pantsColor: Number(avatar.pantsColor) || Number(avatar.pants) || 0,
        skinColor: Number(avatar.skinColor) || 0,
        acc: avatar.acc != null ? Number(avatar.acc) : -1,
      };
      io.emit('playerAvatarChanged', { id: socket.id, avatar: players[socket.id].avatar });
    }
  });

  // ショップ購入
  socket.on('buyItem', (itemId) => {
    const player = players[socket.id];
    if (!player) return;
    const item = SHOP_ITEMS.find(i => i.id === itemId);
    if (!item) return socket.emit('shopError', 'アイテムが見つかりません');

    const data = getPlayerCoins(player.name);
    if (data.purchasedItems.includes(itemId)) {
      return socket.emit('shopError', 'すでに購入済みです');
    }
    if (data.coins < item.price) {
      return socket.emit('shopError', 'コインが足りません');
    }

    data.coins -= item.price;
    data.purchasedItems.push(itemId);
    saveCoins();

    socket.emit('shopBought', { itemId, coins: data.coins, item });
    socket.emit('coinUpdate', { coins: data.coins, earned: -item.price, reason: `${item.name} 購入` });
    checkAchievements(player.name, socket);
  });

  // 家具配置
  socket.on('placeFurniture', (data) => {
    const { room, type, x, y } = data;
    if (!furniture[room]) return;
    if (!VALID_FURNITURE_SET.has(type)) return;
    if (typeof x !== 'number' || typeof y !== 'number') return;
    if (furniture[room].length >= 100) return;

    const item = { id: Date.now() + '_' + Math.random().toString(36).slice(2, 6), type, x, y };
    furniture[room].push(item);
    saveFurniture();
    io.emit('furniturePlaced', { room, item });
  });

  // 家具削除
  socket.on('removeFurniture', (data) => {
    const { room, id } = data;
    if (!furniture[room]) return;
    const idx = furniture[room].findIndex(f => f.id === id);
    if (idx !== -1) {
      furniture[room].splice(idx, 1);
      saveFurniture();
      io.emit('furnitureRemoved', { room, id });
    }
  });

  // チャット（チャットでもコイン付与: 10発言ごとに1コイン）
  let chatCount = 0;
  socket.on('chat', (message) => {
    if (players[socket.id]) {
      // /weather コマンド
      const weatherMatch = String(message).match(/^\/weather\s+(sunny|rain|snow|cloudy)$/);
      if (weatherMatch && isAdmin(players[socket.id].name)) {
        currentWeather = weatherMatch[1];
        io.emit('weatherUpdate', currentWeather);
        socket.emit('chatMessage', { id: 'system', name: 'System', message: `天気を ${currentWeather} に変更しました`, msgId: Date.now() + '_sys' });
        return;
      }
      const sanitized = String(message).slice(0, 200).replace(/[<>&"']/g, '');
      const msgId = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      io.emit('chatMessage', {
        id: socket.id,
        name: players[socket.id].name,
        message: sanitized,
        msgId,
      });
      chatCount++;
      // チャットカウントをcoinDataに保存
      const data = getPlayerCoins(players[socket.id].name);
      data.chatCount = (data.chatCount || 0) + 1;
      if (data.chatCount % 10 === 0) {
        addXP(players[socket.id].name, 5, socket);
      }
      // 実績チェック
      if (data.chatCount % 10 === 0) checkAchievements(players[socket.id].name, socket);
      if (chatCount % 50 === 0) saveCoins();
    }
  });

  // チャットリアクション
  socket.on('chatReaction', ({ msgId, emoji }) => {
    if (!players[socket.id]) return;
    const validEmoji = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👏', '🎉'];
    if (!validEmoji.includes(emoji)) return;
    io.emit('chatReactionUpdate', { msgId, emoji, from: players[socket.id].name });
  });

  // エモートアニメーション
  socket.on('playEmote', (emoteType) => {
    if (!players[socket.id]) return;
    const validEmotes = ['dance', 'sparkle', 'heart', 'fire', 'wave', 'clap'];
    // 無料エモート: wave, clap / 有料: それ以外は購入チェック
    const freeEmotes = ['wave', 'clap'];
    if (!validEmotes.includes(emoteType)) return;
    if (!freeEmotes.includes(emoteType)) {
      const data = getPlayerCoins(players[socket.id].name);
      const itemId = `emote_${emoteType}`;
      if (!data.purchasedItems.includes(itemId)) return;
    }
    players[socket.id].emote = { type: emoteType, startTime: Date.now() };
    io.emit('playerEmote', { id: socket.id, emote: emoteType });
    // 3秒後にクリア
    setTimeout(() => {
      if (players[socket.id]) { players[socket.id].emote = null; }
    }, 3000);
  });

  // ペット設定
  socket.on('setPet', (petItemId) => {
    if (!players[socket.id]) return;
    const data = getPlayerCoins(players[socket.id].name);
    if (!petItemId) {
      players[socket.id].pet = null;
      data.activePet = null;
      saveCoins();
      io.emit('playerPetChanged', { id: socket.id, pet: null });
      return;
    }
    if (!data.purchasedItems.includes(petItemId)) return;
    const item = SHOP_ITEMS.find(i => i.id === petItemId && i.type === 'pet');
    if (!item) return;
    players[socket.id].pet = item.value;
    data.activePet = petItemId;
    saveCoins();
    io.emit('playerPetChanged', { id: socket.id, pet: item.value });
  });

  // 部屋テーマ変更
  socket.on('setRoomTheme', ({ room, floor, wall }) => {
    if (!players[socket.id]) return;
    if (!isAdmin(players[socket.id].name)) return;
    if (roomThemes[room]) {
      roomThemes[room] = { floor: Number(floor) || 0, wall: Number(wall) || 0 };
      saveRoomThemes();
      io.emit('roomThemeChanged', { room, theme: roomThemes[room] });
    }
  });

  // カスタム部屋作成
  socket.on('createRoom', ({ name: roomName }) => {
    if (!players[socket.id]) return;
    const pName = players[socket.id].name;
    const rName = String(roomName).slice(0, 12).replace(/[<>&"']/g, '');
    if (!rName || rName.length < 2) return;
    // 部屋数制限
    const owned = Object.values(customRooms).filter(r => r.owner === pName).length;
    if (owned >= 3) return socket.emit('roomError', '部屋は最大3つまで');
    const roomId = 'custom_' + Date.now().toString(36);
    customRooms[roomId] = { name: rName, owner: pName, theme: { floor: 0, wall: 0 }, cols: 10, rows: 8 };
    furniture[roomId] = [];
    saveCustomRooms();
    saveFurniture();
    io.emit('customRoomsList', customRooms);
    io.emit('chatMessage', { id: 'system', name: 'システム', message: `🏠 ${pName} が部屋「${rName}」を作成！` });
  });

  // カスタム部屋削除
  socket.on('deleteRoom', (roomId) => {
    if (!players[socket.id]) return;
    const room = customRooms[roomId];
    if (!room) return;
    if (room.owner !== players[socket.id].name && !isAdmin(players[socket.id].name)) return;
    delete customRooms[roomId];
    delete furniture[roomId];
    saveCustomRooms();
    saveFurniture();
    // 部屋にいるプレイヤーをロビーに移動
    for (const [sid, p] of Object.entries(players)) {
      if (p.room === roomId) { p.room = 'lobby'; p.x = 5; p.y = 5; io.emit('playerRoomChanged', { id: sid, room: 'lobby' }); }
    }
    io.emit('customRoomsList', customRooms);
  });

  // ===== WebRTC シグナリング（音声通話・画面共有） =====
  socket.on('rtcJoin', (room) => {
    // 会議室にいるプレイヤーに参加を通知
    socket.join('rtc-' + room);
    const clients = Array.from(io.sockets.adapter.rooms.get('rtc-' + room) || []);
    // 既存メンバーに新規参加を通知
    socket.to('rtc-' + room).emit('rtcPeerJoined', { peerId: socket.id, name: players[socket.id]?.name || '???' });
    // 新規参加者に既存メンバーを通知
    const existing = clients.filter(id => id !== socket.id).map(id => ({ peerId: id, name: players[id]?.name || '???' }));
    socket.emit('rtcExistingPeers', existing);
  });

  socket.on('rtcLeave', (room) => {
    socket.leave('rtc-' + room);
    socket.to('rtc-' + room).emit('rtcPeerLeft', { peerId: socket.id });
  });

  socket.on('rtcOffer', ({ to, offer, type }) => {
    io.to(to).emit('rtcOffer', { from: socket.id, offer, type, name: players[socket.id]?.name || '???' });
  });

  socket.on('rtcAnswer', ({ to, answer }) => {
    io.to(to).emit('rtcAnswer', { from: socket.id, answer });
  });

  socket.on('rtcIceCandidate', ({ to, candidate }) => {
    io.to(to).emit('rtcIceCandidate', { from: socket.id, candidate });
  });

  // ===== 天気システム =====
  socket.on('getWeather', () => { socket.emit('weatherUpdate', currentWeather); });
  socket.on('setWeather', (type) => {
    if (!players[socket.id] || !isAdmin(players[socket.id].name)) return;
    if (WEATHER_TYPES.includes(type)) {
      currentWeather = type;
      io.emit('weatherUpdate', currentWeather);
    }
  });

  // ===== 会議システム =====
  // 会議室入室時に会議状態を送信
  socket.on('getMeeting', () => {
    socket.emit('meetingUpdate', getMeetingState());
  });

  // 会議開始
  socket.on('meetingStart', (topic) => {
    if (!players[socket.id] || players[socket.id].room !== 'meeting') return;
    meeting.active = true;
    meeting.topic = String(topic || '').slice(0, 50) || '会議';
    meeting.topics = [];
    meeting.hands = [];
    meeting.startedBy = players[socket.id].name;
    meeting.timerEnd = 0;
    broadcastMeeting();
    io.emit('chatMessage', { id: 'system', name: 'システム', message: `📋 会議「${meeting.topic}」が開始されました (by ${meeting.startedBy})` });
  });

  // 会議終了
  socket.on('meetingEnd', () => {
    if (!players[socket.id] || !meeting.active) return;
    if (meeting.timer) { clearTimeout(meeting.timer); meeting.timer = null; }
    const summary = meeting.topics.map(t => {
      const yes = t.votes.yes.length, no = t.votes.no.length;
      return `${t.text}: 賛成${yes} 反対${no}`;
    }).join(' / ');
    meeting.active = false;
    meeting.topics = [];
    meeting.hands = [];
    meeting.timerEnd = 0;
    broadcastMeeting();
    io.emit('chatMessage', { id: 'system', name: 'システム', message: `📋 会議終了${summary ? ' - ' + summary : ''}` });
  });

  // 議題追加
  socket.on('meetingAddTopic', (text) => {
    if (!players[socket.id] || !meeting.active) return;
    const sanitized = String(text).slice(0, 80).replace(/[<>&"']/g, '');
    if (!sanitized) return;
    meeting.topics.push({
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      text: sanitized,
      author: players[socket.id].name,
      votes: { yes: [], no: [] },
      status: 'pending',
    });
    broadcastMeeting();
  });

  // 投票開始（議題をvoting状態に）
  socket.on('meetingStartVote', (topicId) => {
    if (!players[socket.id] || !meeting.active) return;
    const topic = meeting.topics.find(t => t.id === topicId);
    if (!topic || topic.status !== 'pending') return;
    // 他の投票中を終了
    meeting.topics.forEach(t => { if (t.status === 'voting') t.status = 'done'; });
    topic.status = 'voting';
    topic.votes = { yes: [], no: [] };
    broadcastMeeting();
    io.emit('chatMessage', { id: 'system', name: 'システム', message: `🗳️ 投票開始:「${topic.text}」` });
  });

  // 投票
  socket.on('meetingVote', ({ topicId, vote }) => {
    if (!players[socket.id] || !meeting.active) return;
    const topic = meeting.topics.find(t => t.id === topicId);
    if (!topic || topic.status !== 'voting') return;
    const name = players[socket.id].name;
    // 既存投票を削除
    topic.votes.yes = topic.votes.yes.filter(n => n !== name);
    topic.votes.no = topic.votes.no.filter(n => n !== name);
    if (vote === 'yes') topic.votes.yes.push(name);
    else if (vote === 'no') topic.votes.no.push(name);
    broadcastMeeting();
  });

  // 投票締め切り
  socket.on('meetingEndVote', (topicId) => {
    if (!players[socket.id] || !meeting.active) return;
    const topic = meeting.topics.find(t => t.id === topicId);
    if (!topic || topic.status !== 'voting') return;
    topic.status = 'done';
    const yes = topic.votes.yes.length, no = topic.votes.no.length;
    broadcastMeeting();
    io.emit('chatMessage', { id: 'system', name: 'システム', message: `🗳️ 投票結果:「${topic.text}」→ 賛成${yes} / 反対${no} ${yes > no ? '✅可決' : yes < no ? '❌否決' : '➖同数'}` });
  });

  // 挙手
  socket.on('meetingHand', (raised) => {
    if (!players[socket.id] || !meeting.active) return;
    if (raised && !meeting.hands.includes(socket.id)) {
      meeting.hands.push(socket.id);
    } else if (!raised) {
      meeting.hands = meeting.hands.filter(id => id !== socket.id);
    }
    broadcastMeeting();
  });

  // タイマー設定（分）
  socket.on('meetingTimer', (minutes) => {
    if (!players[socket.id] || !meeting.active) return;
    const mins = Math.min(Math.max(1, Number(minutes) || 5), 60);
    if (meeting.timer) clearTimeout(meeting.timer);
    meeting.timerEnd = Date.now() + mins * 60000;
    meeting.timer = setTimeout(() => {
      meeting.timerEnd = 0;
      meeting.timer = null;
      broadcastMeeting();
      io.emit('chatMessage', { id: 'system', name: 'システム', message: '⏰ 会議タイマー終了！' });
    }, mins * 60000);
    broadcastMeeting();
    io.emit('chatMessage', { id: 'system', name: 'システム', message: `⏱️ タイマー: ${mins}分 設定` });
  });

  // ===== ホワイトボード =====
  socket.on('getWhiteboard', () => {
    socket.emit('wbFullState', whiteboardStrokes);
  });

  socket.on('wbStrokeStart', (data) => {
    if (!players[socket.id] || players[socket.id].room !== 'meeting') return;
    const stroke = {
      tool: data.tool === 'eraser' ? 'eraser' : 'pen',
      color: String(data.color || '#222').slice(0, 9),
      size: Math.min(80, Math.max(1, Number(data.size) || 3)),
      points: [data.point]
    };
    whiteboardActiveStrokes[socket.id] = stroke;
    socket.broadcast.emit('wbStrokeStart', { from: socket.id, tool: stroke.tool, color: stroke.color, size: stroke.size, point: data.point });
  });

  socket.on('wbStrokeMove', (point) => {
    const stroke = whiteboardActiveStrokes[socket.id];
    if (!stroke) return;
    stroke.points.push(point);
    socket.broadcast.emit('wbStrokeMove', { from: socket.id, point });
  });

  socket.on('wbStrokeEnd', () => {
    const stroke = whiteboardActiveStrokes[socket.id];
    if (stroke) {
      whiteboardStrokes.push(stroke);
      delete whiteboardActiveStrokes[socket.id];
      socket.broadcast.emit('wbStrokeEnd', { from: socket.id });
    }
  });

  socket.on('wbClear', () => {
    if (!players[socket.id] || players[socket.id].room !== 'meeting') return;
    whiteboardStrokes = [];
    whiteboardActiveStrokes = {};
    io.emit('wbClear');
    io.emit('chatMessage', { id: 'system', name: 'システム', message: `🖊️ ${players[socket.id].name} がホワイトボードをクリアしました` });
  });

  // ===== 部屋BGM =====
  socket.on('getBgm', (room) => {
    if (roomBgm[room]) {
      socket.emit('bgmUpdate', { room, bgm: roomBgm[room] });
    }
  });

  socket.on('setBgm', ({ room, videoId, title }) => {
    if (!players[socket.id] || players[socket.id].room !== room) return;
    if (!videoId) {
      roomBgm[room] = null;
      io.emit('bgmUpdate', { room, bgm: null });
      io.emit('chatMessage', { id: 'system', name: 'システム', message: `🎵 ${players[socket.id].name} がBGMを停止しました` });
      return;
    }
    roomBgm[room] = { videoId: String(videoId).slice(0, 20), title: String(title || '').slice(0, 80), setBy: players[socket.id].name };
    io.emit('bgmUpdate', { room, bgm: roomBgm[room] });
    io.emit('chatMessage', { id: 'system', name: 'システム', message: `🎵 ${players[socket.id].name} がBGMを設定: ${roomBgm[room].title || videoId}` });
  });

  // アバター保存（アカウント連携）
  socket.on('saveAvatar', () => {
    const p = players[socket.id];
    if (!p || !accounts[p.name]) return;
    accounts[p.name].avatar = { ...p.avatar };
    saveAccounts();
  });

  // ===== 管理者機能 =====
  // アナウンス
  socket.on('adminAnnounce', (message) => {
    const p = players[socket.id];
    if (!p || !isAdmin(p.name)) return;
    const msg = String(message).slice(0, 200).replace(/[<>&"']/g, '');
    io.emit('chatMessage', { id: 'system', name: '📢 アナウンス', message: msg });
  });

  // キック
  socket.on('adminKick', (targetId) => {
    const p = players[socket.id];
    if (!p || !isAdmin(p.name)) return;
    const target = players[targetId];
    if (!target) return;
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.emit('kicked', '管理者によりキックされました');
      targetSocket.disconnect(true);
    }
    io.emit('chatMessage', { id: 'system', name: 'システム', message: `${target.name} がキックされました` });
  });

  // 管理者権限付与
  socket.on('adminSetRole', ({ targetName, role }) => {
    const p = players[socket.id];
    if (!p || !isAdmin(p.name)) return;
    if (accounts[targetName]) {
      accounts[targetName].role = role;
      saveAccounts();
    }
  });

  // 管理者: オンラインユーザーリスト取得
  socket.on('adminGetUsers', () => {
    const p = players[socket.id];
    if (!p || !isAdmin(p.name)) return;
    const list = Object.entries(players).map(([sid, pl]) => ({
      id: sid, name: pl.name, room: pl.room, status: pl.status,
      isAdmin: isAdmin(pl.name),
    }));
    const stats = {
      totalAccounts: Object.keys(accounts).length,
      onlineUsers: Object.keys(players).length,
      totalCoins: Object.values(coinData).reduce((s, d) => s + (d.coins || 0), 0),
    };
    socket.emit('adminUserList', { users: list, stats });
  });

  // ===== ミニゲーム: ワードウルフ =====
  socket.on('wordWolfStart', (data) => {
    if (wordWolfGame.active) return socket.emit('gameError', 'ワードウルフは既に進行中です');
    const { majorityWord, wolfWord } = data;
    if (!majorityWord || !wolfWord) return;
    wordWolfGame = {
      active: true, phase: 'waiting', adminId: socket.id,
      majorityWord: majorityWord.trim(), wolfWord: wolfWord.trim(),
      players: {}, timerEnd: null, discussionMinutes: data.minutes || 3
    };
    wordWolfGame.players[socket.id] = { name: players[socket.id]?.name || '???', word: null, isWolf: false, votedFor: null };
    broadcastWordWolf();
    io.emit('chatMessage', { id: 'system', name: 'システム', message: `🐺 ワードウルフが開始されました！参加するには「🎮 ゲーム」から参加してください`, msgId: Date.now() + '_ww' });
  });

  socket.on('wordWolfJoin', () => {
    if (!wordWolfGame.active || wordWolfGame.phase !== 'waiting') return;
    if (wordWolfGame.players[socket.id]) return;
    wordWolfGame.players[socket.id] = { name: players[socket.id]?.name || '???', word: null, isWolf: false, votedFor: null };
    broadcastWordWolf();
  });

  socket.on('wordWolfBeginRound', () => {
    if (!wordWolfGame.active || socket.id !== wordWolfGame.adminId) return;
    const ids = Object.keys(wordWolfGame.players);
    if (ids.length < 3) return socket.emit('gameError', '3人以上必要です');
    // Pick random wolf
    const wolfIdx = Math.floor(Math.random() * ids.length);
    ids.forEach((id, i) => {
      const p = wordWolfGame.players[id];
      p.isWolf = (i === wolfIdx);
      p.word = p.isWolf ? wordWolfGame.wolfWord : wordWolfGame.majorityWord;
      p.votedFor = null;
    });
    wordWolfGame.phase = 'discuss';
    wordWolfGame.timerEnd = Date.now() + wordWolfGame.discussionMinutes * 60000;
    broadcastWordWolf();
    // Auto-transition to vote after timer
    setTimeout(() => {
      if (wordWolfGame.active && wordWolfGame.phase === 'discuss') {
        wordWolfGame.phase = 'vote';
        broadcastWordWolf();
      }
    }, wordWolfGame.discussionMinutes * 60000);
  });

  socket.on('wordWolfVote', (data) => {
    if (!wordWolfGame.active || wordWolfGame.phase !== 'vote') return;
    if (!wordWolfGame.players[socket.id]) return;
    if (!wordWolfGame.players[data.targetId]) return;
    if (data.targetId === socket.id) return; // can't vote self
    wordWolfGame.players[socket.id].votedFor = data.targetId;
    broadcastWordWolf();
    // Check if all voted
    const allVoted = Object.values(wordWolfGame.players).every(p => p.votedFor !== null);
    if (allVoted) {
      wordWolfGame.phase = 'reveal';
      // Calculate votes
      const voteCounts = {};
      Object.values(wordWolfGame.players).forEach(p => {
        voteCounts[p.votedFor] = (voteCounts[p.votedFor] || 0) + 1;
      });
      // Find most voted
      let maxVotes = 0, mostVotedId = null;
      for (const [id, count] of Object.entries(voteCounts)) {
        if (count > maxVotes) { maxVotes = count; mostVotedId = id; }
      }
      wordWolfGame.result = { mostVotedId, voteCounts };
      // XP rewards
      const wolf = Object.entries(wordWolfGame.players).find(([, p]) => p.isWolf);
      if (wolf) {
        const wolfCaught = mostVotedId === wolf[0];
        if (wolfCaught) {
          // Villagers win
          Object.entries(wordWolfGame.players).forEach(([id, p]) => {
            if (!p.isWolf && players[id]?.name) addXP(players[id].name, 30, io.sockets.sockets.get(id));
          });
        } else {
          // Wolf wins
          if (players[wolf[0]]?.name) addXP(players[wolf[0]].name, 50, io.sockets.sockets.get(wolf[0]));
        }
      }
      broadcastWordWolf();
    }
  });

  socket.on('wordWolfEnd', () => {
    if (!wordWolfGame.active) return;
    if (socket.id !== wordWolfGame.adminId) return;
    wordWolfGame = { active: false, phase: 'idle', players: {} };
    io.emit('wordWolfUpdate', { active: false, phase: 'idle' });
  });

  // ===== ミニゲーム: 早押しクイズ =====
  socket.on('quizStart', (data) => {
    if (speedQuizGame.active) return socket.emit('gameError', '早押しクイズは既に進行中です');
    const questions = (data.questions || []).filter(q => q.q && q.a);
    if (questions.length === 0) return socket.emit('gameError', '問題が必要です');
    speedQuizGame = {
      active: true, phase: 'waiting', adminId: socket.id,
      questions, currentQ: -1, buzzedBy: null,
      scores: {}, timerEnd: null
    };
    speedQuizGame.scores[socket.id] = { name: players[socket.id]?.name || '???', score: 0 };
    broadcastQuiz();
    io.emit('chatMessage', { id: 'system', name: 'システム', message: `⚡ 早押しクイズが開始されました！参加するには「🎮 ゲーム」から参加してください`, msgId: Date.now() + '_quiz' });
  });

  socket.on('quizJoin', () => {
    if (!speedQuizGame.active) return;
    if (speedQuizGame.scores[socket.id]) return;
    speedQuizGame.scores[socket.id] = { name: players[socket.id]?.name || '???', score: 0 };
    broadcastQuiz();
  });

  socket.on('quizNext', () => {
    if (!speedQuizGame.active || socket.id !== speedQuizGame.adminId) return;
    speedQuizGame.currentQ++;
    if (speedQuizGame.currentQ >= speedQuizGame.questions.length) {
      // End - give XP
      speedQuizGame.phase = 'finished';
      const sorted = Object.entries(speedQuizGame.scores).sort((a, b) => b[1].score - a[1].score);
      if (sorted.length > 0 && sorted[0][1].score > 0) {
        const winnerId = sorted[0][0];
        if (players[winnerId]?.name) addXP(players[winnerId].name, 50, io.sockets.sockets.get(winnerId));
      }
      Object.entries(speedQuizGame.scores).forEach(([id, s]) => {
        if (s.score > 0 && players[id]?.name) addXP(players[id].name, 10, io.sockets.sockets.get(id));
      });
      broadcastQuiz();
      return;
    }
    speedQuizGame.phase = 'question';
    speedQuizGame.buzzedBy = null;
    speedQuizGame.timerEnd = Date.now() + 15000;
    broadcastQuiz();
  });

  socket.on('quizBuzz', () => {
    if (!speedQuizGame.active || speedQuizGame.phase !== 'question') return;
    if (speedQuizGame.buzzedBy) return; // already buzzed
    if (!speedQuizGame.scores[socket.id]) return;
    speedQuizGame.buzzedBy = socket.id;
    speedQuizGame.phase = 'buzzed';
    broadcastQuiz();
  });

  socket.on('quizAnswer', (data) => {
    if (!speedQuizGame.active || speedQuizGame.phase !== 'buzzed') return;
    if (socket.id !== speedQuizGame.buzzedBy) return;
    speedQuizGame.submittedAnswer = data.answer || '';
    broadcastQuiz();
  });

  socket.on('quizJudge', (data) => {
    if (!speedQuizGame.active || socket.id !== speedQuizGame.adminId) return;
    if (data.correct && speedQuizGame.buzzedBy) {
      speedQuizGame.scores[speedQuizGame.buzzedBy].score++;
    }
    speedQuizGame.phase = 'result';
    speedQuizGame.lastCorrect = data.correct;
    broadcastQuiz();
  });

  socket.on('quizEnd', () => {
    if (!speedQuizGame.active) return;
    if (socket.id !== speedQuizGame.adminId) return;
    speedQuizGame = { active: false, phase: 'idle', scores: {} };
    io.emit('speedQuizUpdate', { active: false, phase: 'idle' });
  });

  // 切断
  socket.on('disconnect', () => {
    console.log(`切断: ${socket.id}`);
    const p = players[socket.id];
    if (p && p.name && !p.name.startsWith('Player') && !p.name.startsWith('Guest')) {
      const duration = p.joinedAt ? Date.now() - p.joinedAt : 0;
      discordLogLeave(p.name, duration);
      setTimeout(updateDiscordStatus, 1000);
    }
    stopWorkTimer(socket.id);
    // 会議の挙手から削除
    meeting.hands = meeting.hands.filter(id => id !== socket.id);
    if (meeting.active) broadcastMeeting();
    // ホワイトボード描画中ストロークをクリーンアップ
    delete whiteboardActiveStrokes[socket.id];
    // ミニゲーム離脱処理
    if (wordWolfGame.active && wordWolfGame.players[socket.id]) {
      delete wordWolfGame.players[socket.id];
      if (socket.id === wordWolfGame.adminId) {
        wordWolfGame = { active: false, phase: 'idle', players: {} };
        io.emit('wordWolfUpdate', { active: false, phase: 'idle' });
      } else { broadcastWordWolf(); }
    }
    if (speedQuizGame.active && speedQuizGame.scores[socket.id]) {
      delete speedQuizGame.scores[socket.id];
      if (socket.id === speedQuizGame.adminId) {
        speedQuizGame = { active: false, phase: 'idle', scores: {} };
        io.emit('speedQuizUpdate', { active: false, phase: 'idle' });
      } else { broadcastQuiz(); }
    }
    // WebRTC通知
    io.emit('rtcPeerLeft', { peerId: socket.id });
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

const PORT = process.env.PORT || 3000;

// データ読み込み → サーバー起動
(async () => {
  // Redis接続（REDIS_URLがある場合のみ）
  if (useRedis) {
    try {
      console.log('Redis接続開始:', process.env.REDIS_URL?.replace(/\/\/.*@/, '//***@'));
      redis = createClient({
        url: process.env.REDIS_URL,
        socket: { connectTimeout: 10000 },
      });
      redis.on('error', (err) => console.log('Redis Error:', err.message));
      await redis.connect();
      await redis.ping();
      console.log('Redis接続完了・PING成功');
    } catch (e) {
      console.log('Redis接続失敗、ファイルモードで起動:', e.message);
      redis = null;
    }
  } else {
    console.log('REDIS_URL未設定、ファイルモードで起動');
  }

  // データ読み込み
  accounts = await dataGet('accounts', {});
  furniture = await dataGet('furniture', { lobby: [], work: [], meeting: [], japanese: [] });
  coinData = await dataGet('coins', {});
  roomThemes = await dataGet('roomThemes', { lobby: { floor: 0, wall: 0 }, work: { floor: 0, wall: 0 }, meeting: { floor: 0, wall: 0 }, japanese: { floor: 0, wall: 0 } });
  customRooms = await dataGet('customRooms', {});

  // カスタム部屋用家具初期化
  for (const rid of Object.keys(customRooms)) {
    if (!furniture[rid]) furniture[rid] = [];
  }

  console.log(`データ読み込み完了: アカウント${Object.keys(accounts).length}件, 家具${Object.keys(furniture).length}部屋`);

  server.listen(PORT, () => {
    console.log(`サーバー起動: http://localhost:${PORT}`);
  });
})();

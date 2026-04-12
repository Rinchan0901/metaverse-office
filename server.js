const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ===== アカウントシステム =====
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
// { "username": { password (hashed), avatar, createdAt } }
let accounts = {};
try {
  if (fs.existsSync(ACCOUNTS_FILE)) {
    accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  }
} catch (e) { /* ignore */ }

function saveAccounts() {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

function hashPass(password) {
  return crypto.createHash('sha256').update(password + 'metaverse-salt').digest('hex');
}

// アカウント登録
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'ユーザー名とパスワードが必要です' });
  const name = String(username).slice(0, 12).replace(/[<>&"']/g, '');
  if (name.length < 2) return res.status(400).json({ error: '名前は2文字以上' });
  if (String(password).length < 4) return res.status(400).json({ error: 'パスワードは4文字以上' });
  if (accounts[name]) return res.status(400).json({ error: 'この名前は既に使われています' });
  accounts[name] = {
    password: hashPass(String(password)),
    avatar: { hair: 0, body: 0, pants: 0, acc: -1 },
    createdAt: Date.now(),
  };
  saveAccounts();
  // コインデータも初期化
  getPlayerCoins(name);
  res.json({ ok: true, username: name });
});

// ログイン
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'ユーザー名とパスワードが必要です' });
  const name = String(username).slice(0, 12).replace(/[<>&"']/g, '');
  const acc = accounts[name];
  if (!acc) return res.status(401).json({ error: 'アカウントが見つかりません' });
  if (acc.password !== hashPass(String(password))) return res.status(401).json({ error: 'パスワードが違います' });
  res.json({ ok: true, username: name, avatar: acc.avatar });
});

// ===== 部屋BGMシステム =====
const roomBgm = { lobby: null, work: null, meeting: null };
// { videoId, title, setBy }

// プレイヤー管理
const players = {};

// 家具管理（部屋ごと）
const FURNITURE_FILE = path.join(__dirname, 'furniture.json');
let furniture = { lobby: [], work: [], meeting: [] };
try {
  if (fs.existsSync(FURNITURE_FILE)) {
    furniture = JSON.parse(fs.readFileSync(FURNITURE_FILE, 'utf8'));
  }
} catch (e) { /* ignore */ }

function saveFurniture() {
  fs.writeFileSync(FURNITURE_FILE, JSON.stringify(furniture, null, 2));
}

// ===== コインシステム =====
const COINS_FILE = path.join(__dirname, 'coins.json');
// { "playerName": { coins: 100, totalEarned: 200, purchasedItems: ["crown_gold", ...], workMinutes: 50 } }
let coinData = {};
try {
  if (fs.existsSync(COINS_FILE)) {
    coinData = JSON.parse(fs.readFileSync(COINS_FILE, 'utf8'));
  }
} catch (e) { /* ignore */ }

function saveCoins() {
  fs.writeFileSync(COINS_FILE, JSON.stringify(coinData, null, 2));
}

function getPlayerCoins(name) {
  if (!coinData[name]) {
    coinData[name] = { coins: 10, totalEarned: 10, purchasedItems: [], workMinutes: 0 };
  }
  return coinData[name];
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

// 毎分コイン付与チェック
const COIN_PER_MINUTE = 2;
setInterval(() => {
  const now = Date.now();
  for (const [socketId, timer] of Object.entries(workTimers)) {
    const elapsed = now - timer.lastTick;
    if (elapsed >= 60000) { // 1分経過
      const minutes = Math.floor(elapsed / 60000);
      timer.lastTick = now;
      const data = getPlayerCoins(timer.name);
      data.coins += COIN_PER_MINUTE * minutes;
      data.totalEarned += COIN_PER_MINUTE * minutes;
      data.workMinutes += minutes;
      saveCoins();
      // プレイヤーにコイン更新を通知
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('coinUpdate', {
          coins: data.coins,
          earned: COIN_PER_MINUTE * minutes,
          reason: `作業 ${minutes}分`,
        });
      }
    }
  }
}, 10000); // 10秒ごとにチェック

// ショップアイテム定義
const SHOP_ITEMS = [
  // プレミアム髪色
  { id: 'hair_rainbow', name: '虹色ヘア', price: 50, type: 'hair', value: 8, icon: '🌈' },
  { id: 'hair_silver', name: 'シルバーヘア', price: 30, type: 'hair', value: 9, icon: '🤍' },
  // プレミアム服
  { id: 'body_gold', name: 'ゴールドスーツ', price: 80, type: 'body', value: 8, icon: '✨' },
  { id: 'body_galaxy', name: 'ギャラクシー服', price: 100, type: 'body', value: 9, icon: '🌌' },
  // プレミアムズボン
  { id: 'pants_white', name: 'ホワイトパンツ', price: 40, type: 'pants', value: 8, icon: '👖' },
  { id: 'pants_stripe', name: 'ストライプ', price: 60, type: 'pants', value: 9, icon: '📏' },
  // プレミアムアクセサリー
  { id: 'acc_halo', name: '天使の輪', price: 120, type: 'acc', value: 5, icon: '😇' },
  { id: 'acc_star', name: 'スターバッジ', price: 70, type: 'acc', value: 6, icon: '⭐' },
  { id: 'acc_cat_ears', name: 'ネコ耳', price: 90, type: 'acc', value: 7, icon: '🐱' },
  // エモート
  { id: 'emote_dance', name: 'ダンスエモート', price: 50, type: 'emote', value: 'dance', icon: '💃' },
  { id: 'emote_sparkle', name: 'キラキラ', price: 30, type: 'emote', value: 'sparkle', icon: '✨' },
];

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

// 家具の種類定義
const VALID_FURNITURE = [
  'sofa','table','lamp','bookshelf','rug_small','plant_big',
  'vending','poster','clock','trophy','tv','aquarium',
];

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

io.on('connection', (socket) => {
  console.log(`接続: ${socket.id}`);

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
  };

  // 既存プレイヤー一覧を送信
  socket.emit('currentPlayers', players);
  socket.emit('currentFurniture', furniture);
  socket.emit('shopItems', SHOP_ITEMS);

  // 他プレイヤーに通知
  socket.broadcast.emit('playerJoined', players[socket.id]);

  // 名前変更
  socket.on('setName', (name) => {
    if (players[socket.id]) {
      const sanitized = String(name).slice(0, 12).replace(/[<>&"']/g, '');
      players[socket.id].name = sanitized;
      io.emit('playerMoved', players[socket.id]);
      // コインデータ送信
      const data = getPlayerCoins(sanitized);
      socket.emit('coinInit', { coins: data.coins, totalEarned: data.totalEarned, purchasedItems: data.purchasedItems, workMinutes: data.workMinutes });
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
    const valid = ['lobby', 'work', 'meeting'];
    if (players[socket.id] && valid.includes(room)) {
      const prevRoom = players[socket.id].room;
      players[socket.id].room = room;
      io.emit('playerRoomChanged', { id: socket.id, room });

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
      io.emit('playerStatusChanged', { id: socket.id, status });
    }
  });

  // アバター変更
  socket.on('updateAvatar', (avatar) => {
    if (players[socket.id]) {
      players[socket.id].avatar = {
        hair: Number(avatar.hair) || 0,
        body: Number(avatar.body) || 0,
        pants: Number(avatar.pants) || 0,
        acc: Number(avatar.acc) ?? -1,
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
  });

  // 家具配置
  socket.on('placeFurniture', (data) => {
    const { room, type, x, y } = data;
    if (!furniture[room]) return;
    if (!VALID_FURNITURE.includes(type)) return;
    if (typeof x !== 'number' || typeof y !== 'number') return;
    if (furniture[room].length >= 30) return;

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
      const sanitized = String(message).slice(0, 200).replace(/[<>&"']/g, '');
      io.emit('chatMessage', {
        id: socket.id,
        name: players[socket.id].name,
        message: sanitized,
      });
      chatCount++;
      if (chatCount % 10 === 0) {
        const newBal = addCoins(players[socket.id].name, 1, 'チャット');
        socket.emit('coinUpdate', { coins: newBal, earned: 1, reason: 'チャット報酬' });
      }
    }
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

  // 切断
  socket.on('disconnect', () => {
    console.log(`切断: ${socket.id}`);
    stopWorkTimer(socket.id);
    // 会議の挙手から削除
    meeting.hands = meeting.hands.filter(id => id !== socket.id);
    if (meeting.active) broadcastMeeting();
    // WebRTC通知
    io.emit('rtcPeerLeft', { peerId: socket.id });
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);
});

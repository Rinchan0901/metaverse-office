const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

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

// 家具の種類定義
const VALID_FURNITURE = [
  'sofa','table','lamp','bookshelf','rug_small','plant_big',
  'vending','poster','clock','trophy','tv','aquarium',
];

// ===== Discord Bot連携用 REST API =====
app.use(express.json());

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

  // 切断
  socket.on('disconnect', () => {
    console.log(`切断: ${socket.id}`);
    stopWorkTimer(socket.id);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);
});

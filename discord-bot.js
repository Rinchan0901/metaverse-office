/**
 * Discord Bot - メタバースオフィス連携
 *
 * 機能:
 * - Discordでのメッセージ数をカウントし、コインを付与
 * - !coins コマンドで残高確認
 * - !rank コマンドでランキング表示
 *
 * 設定:
 * 1. npm install discord.js
 * 2. 環境変数を設定:
 *    DISCORD_TOKEN=your_bot_token
 *    METAVERSE_API=http://localhost:3000
 *    API_SECRET=metaverse-secret
 * 3. node discord-bot.js
 */

const { Client, GatewayIntentBits } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const METAVERSE_API = process.env.METAVERSE_API || 'http://localhost:3000';
const API_SECRET = process.env.API_SECRET || 'metaverse-secret';
const COINS_PER_MESSAGES = 1;  // 1メッセージごとに
const COIN_REWARD = 1;          // 1コイン付与

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN 環境変数を設定してください');
  console.log('例: DISCORD_TOKEN=your_token node discord-bot.js');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ユーザーごとのメッセージカウント（メモリ内、再起動でリセット）
const messageCounts = {};

// メタバースAPIにコイン付与
async function addCoins(playerName, amount, reason) {
  try {
    const res = await fetch(`${METAVERSE_API}/api/coins/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerName, amount, reason, secret: API_SECRET }),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error('コイン付与エラー:', e.message);
    return null;
  }
}

// コイン残高確認
async function getCoins(playerName) {
  try {
    const res = await fetch(`${METAVERSE_API}/api/coins/${encodeURIComponent(playerName)}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error('残高確認エラー:', e.message);
    return null;
  }
}

client.on('ready', () => {
  console.log(`Discord Bot起動: ${client.user.tag}`);
  console.log(`メタバースAPI: ${METAVERSE_API}`);
  console.log(`${COINS_PER_MESSAGES}メッセージごとに${COIN_REWARD}コイン付与`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const username = message.author.username;

  // コマンド処理
  if (message.content === '!coins' || message.content === '!コイン') {
    const data = await getCoins(username);
    if (data) {
      message.reply(
        `**${username}** のコイン情報:\n` +
        `> 残高: **${data.coins}** コイン\n` +
        `> 累計獲得: **${data.totalEarned}** コイン\n` +
        `> 作業時間: **${data.workMinutes}** 分\n` +
        `> 購入アイテム: **${data.purchasedItems.length}** 個`
      );
    } else {
      message.reply('コイン情報を取得できませんでした。メタバースサーバーが起動しているか確認してください。');
    }
    return;
  }

  if (message.content === '!help' || message.content === '!ヘルプ') {
    message.reply(
      '**メタバースオフィス Bot コマンド:**\n' +
      '> `!coins` / `!コイン` - コイン残高を確認\n' +
      '> `!help` / `!ヘルプ` - このヘルプを表示\n\n' +
      '**コインの貯め方:**\n' +
      `> - Discordで発言（1発言ごとに1コイン）\n` +
      '> - メタバースの作業部屋に滞在（2コイン/分）\n' +
      '> - メタバースでチャット（10発言ごとに1コイン）'
    );
    return;
  }

  // メッセージカウント＆コイン付与
  if (!messageCounts[username]) messageCounts[username] = 0;
  messageCounts[username]++;

  if (messageCounts[username] >= COINS_PER_MESSAGES) {
    messageCounts[username] = 0;
    const result = await addCoins(username, COIN_REWARD, 'Discord発言報酬');
    if (result) {
      // リアクションでコイン獲得を通知
      message.react('🪙').catch(() => {});
    }
  }
});

client.login(DISCORD_TOKEN);

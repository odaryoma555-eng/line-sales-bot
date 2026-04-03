const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

// ---- 設定 ----
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const client = new line.Client(lineConfig);
const app = express();

// ---- Webhook ----
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

app.get('/', (_, res) => res.send('LINE Bot is running!'));

// ---- イベントハンドラ ----
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  if (event.type === 'follow') return handleFollow(event);

  const userId = event.source.userId;
  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  const cmd = parse(text);
  const reply = await respond(cmd, userId);

  return client.replyMessage(replyToken, {
    type: 'text',
    text: reply,
  });
}

async function handleFollow(event) {
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: 'こんにちは！💚 売上・経費ボットです。\n\n毎日の売上や経費を送るだけで利益を自動集計します。\n\n【登録】\n売上 15000 案件名\n経費 3200 交通費\n\n【確認】\n今日 → 本日の集計\n今月 → 月次集計\n\n【修正】\n取消 → 直前の1件を削除\n\n「ヘルプ」でいつでも確認できます！',
  });
}

// ---- コマンドパーサー ----
function parse(text) {
  // 売上
  const uriMatch = text.match(/^売上\s+([0-9０-９,，]+)\s*(.*)/);
  if (uriMatch) {
    const amount = toNumber(uriMatch[1]);
    if (!amount) return { type: 'error', msg: '⚠️ 金額は正しい数字で入力してください。\n例：売上 15000 デザイン案件' };
    return { type: 'uri', amount, memo: uriMatch[2].trim() };
  }

  // 経費
  const expMatch = text.match(/^経費\s+([0-9０-９,，]+)\s*(.*)/);
  if (expMatch) {
    const amount = toNumber(expMatch[1]);
    if (!amount) return { type: 'error', msg: '⚠️ 金額は正しい数字で入力してください。\n例：経費 3200 交通費' };
    return { type: 'exp', amount, memo: expMatch[2].trim() };
  }

  if (/^(今日|きょう)$/.test(text)) return { type: 'today' };
  if (/^(今月|こんげつ)$/.test(text)) return { type: 'month' };
  if (/^(取消|取り消し|とりけし)$/.test(text)) return { type: 'undo' };
  if (/^(ヘルプ|help|HELP|使い方)$/i.test(text)) return { type: 'help' };

  return { type: 'unknown' };
}

function toNumber(str) {
  const n = parseInt(
    str
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[,，]/g, '')
  );
  return isNaN(n) || n <= 0 ? null : n;
}

// ---- ボット応答 ----
async function respond(cmd, userId) {
  const now = new Date();

  // 売上登録
  if (cmd.type === 'uri') {
    const { error } = await supabase.from('transactions').insert({
      user_id: userId,
      type: 'uri',
      amount: cmd.amount,
      memo: cmd.memo || null,
    });
    if (error) return serverError();
    return `✅ 売上 ${yen(cmd.amount)} を記録しました${cmd.memo ? '\n📝 ' + cmd.memo : ''}\n🕐 ${fmtDatetime(now)}`;
  }

  // 経費登録
  if (cmd.type === 'exp') {
    const { error } = await supabase.from('transactions').insert({
      user_id: userId,
      type: 'exp',
      amount: cmd.amount,
      memo: cmd.memo || null,
    });
    if (error) return serverError();
    return `✅ 経費 ${yen(cmd.amount)} を記録しました${cmd.memo ? '\n📝 ' + cmd.memo : ''}\n🕐 ${fmtDatetime(now)}`;
  }

  // 今日のサマリー
  if (cmd.type === 'today') {
    const start = toJSTDateString(now) + 'T00:00:00+09:00';
    const end   = toJSTDateString(now) + 'T23:59:59+09:00';
    const { data, error } = await supabase
      .from('transactions')
      .select('type, amount')
      .eq('user_id', userId)
      .gte('recorded_at', start)
      .lte('recorded_at', end);
    if (error) return serverError();
    return buildSummary(data, `本日の集計（${fmtDate(now)}）`);
  }

  // 今月のサマリー
  if (cmd.type === 'month') {
    const jst = toJSTDate(now);
    const start = `${jst.year}-${pad(jst.month)}-01T00:00:00+09:00`;
    const lastDay = new Date(jst.year, jst.month, 0).getDate();
    const end = `${jst.year}-${pad(jst.month)}-${lastDay}T23:59:59+09:00`;
    const { data, error } = await supabase
      .from('transactions')
      .select('type, amount')
      .eq('user_id', userId)
      .gte('recorded_at', start)
      .lte('recorded_at', end);
    if (error) return serverError();
    return buildSummary(data, `${jst.month}月の集計（1日〜${jst.day}日）`);
  }

  // 取消
  if (cmd.type === 'undo') {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, type, amount, memo')
      .eq('user_id', userId)
      .order('recorded_at', { ascending: false })
      .limit(1);
    if (error) return serverError();
    if (!data || data.length === 0) return '⚠️ 取り消せる記録がありません。';
    const last = data[0];
    await supabase.from('transactions').delete().eq('id', last.id);
    const label = last.type === 'uri' ? '売上' : '経費';
    return `↩ 直前の記録を取り消しました\n${label} ${yen(last.amount)}${last.memo ? ' ' + last.memo : ''}`;
  }

  // ヘルプ
  if (cmd.type === 'help') {
    return `📖 使い方ガイド\n\n【登録】\n売上 15000 案件名\n経費 3200 交通費\n※メモは省略OKです\n\n【確認】\n今日 → 本日の集計\n今月 → 月次集計\n\n【修正】\n取消 → 直前の1件を削除`;
  }

  if (cmd.type === 'error') return cmd.msg;

  return '❓ わからないコマンドです。\n「ヘルプ」と送ると使い方が見られます。';
}

// ---- ヘルパー ----
function yen(n) {
  return '¥' + n.toLocaleString('ja-JP');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function toJSTDate(d) {
  const jst = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  return { year: jst.getFullYear(), month: jst.getMonth() + 1, day: jst.getDate() };
}

function toJSTDateString(d) {
  const j = toJSTDate(d);
  return `${j.year}-${pad(j.month)}-${pad(j.day)}`;
}

function fmtDate(d) {
  const j = toJSTDate(d);
  return `${j.month}/${j.day}`;
}

function fmtDatetime(d) {
  const jst = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  return `${jst.getFullYear()}/${pad(jst.getMonth()+1)}/${pad(jst.getDate())} ${pad(jst.getHours())}:${pad(jst.getMinutes())}`;
}

function buildSummary(data, title) {
  const uri = data.filter(r => r.type === 'uri').reduce((s, r) => s + r.amount, 0);
  const exp = data.filter(r => r.type === 'exp').reduce((s, r) => s + r.amount, 0);
  const profit = uri - exp;
  const profitStr = profit >= 0 ? yen(profit) : `-${yen(Math.abs(profit))}`;
  return `📊 ${title}\n─────────────────\n売上　　${yen(uri)}\n経費　　${yen(exp)}\n─────────────────\n利益　　${profitStr}`;
}

function serverError() {
  return '🔧 ただいま障害が発生しています。\nしばらくしてから再送してください。';
}

// ---- 起動 ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

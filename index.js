const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

// –– 設定 ––
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

// –– 補助金データ（Jグランツ API自動取得）––
let subsidyCache = null;
let subsidyCacheTime = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1時間

async function fetchSubsidiesFromJGrants(keyword = '小規模事業者') {
  const url = `https://api.jgrants-portal.go.jp/exp/v1/public/subsidies?keyword=${encodeURIComponent(keyword)}&sort=acceptance_end_datetime&order=ASC&acceptance=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('API error');
    const json = await res.json();
    return json.result || [];
  } catch (e) {
    console.error('Jグランツ API error:', e);
    return [];
  }
}

async function getMatchedSubsidies(userId) {
  const now = new Date();
  const jstNow = toJSTDate(now);

  const start = `${jstNow.year}-${pad(jstNow.month)}-01T00:00:00+09:00`;
  const end   = `${jstNow.year}-${pad(jstNow.month)}-${jstNow.day}T23:59:59+09:00`;

  const { data } = await supabase.from('transactions')
    .select('type, amount')
    .eq('user_id', userId)
    .gte('recorded_at', start)
    .lte('recorded_at', end);

  const monthlySales = data ? data.filter(r => r.type === 'uri').reduce((s, r) => s + r.amount, 0) : 0;
  const estimatedAnnual = monthlySales * 12;

  if (!subsidyCache || Date.now() - subsidyCacheTime > CACHE_TTL) {
    const results = await fetchSubsidiesFromJGrants('個人事業主');
    subsidyCache = results.slice(0, 5).map(s => ({
      name: s.title || s.subsidy_name || '補助金',
      amount: s.upper_limit ? `最大¥${Number(s.upper_limit).toLocaleString('ja-JP')}` : '要確認',
      deadline: s.acceptance_end_datetime ? s.acceptance_end_datetime.slice(0, 10).replace(/-/g, '/') : '随時受付',
      description: s.summary || s.target_number_of_employees || '詳細はURLから確認してください',
      url: `https://www.jgrants-portal.go.jp/subsidy/${s.id}`,
      score: 3,
    }));
    subsidyCacheTime = Date.now();
  }

  const matched = subsidyCache.length > 0 ? subsidyCache : [
    { name: '小規模事業者持続化補助金', amount: '最大¥200万', deadline: '2026/6/30', description: '販路開拓・業務効率化のための経費を補助', url: 'https://jizokukahojokin.info', score: 3 },
    { name: 'IT導入補助金',             amount: '最大¥450万', deadline: '2026/5/31', description: 'ITツール導入費用を補助',                url: 'https://www.it-hojo.jp', score: 2 },
    { name: 'ものづくり補助金',          amount: '最大¥1,250万', deadline: '2026/7/31', description: '設備投資・新製品開発を補助',          url: 'https://portal.monodukuri-hojo.jp', score: 2 },
  ];

  return { matched, estimatedAnnual };
}

function starRating(score) {
  return '★'.repeat(score) + '☆'.repeat(3 - score);
}

// –– スーパー特売データ ––
async function getSaleItems() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('sales')
    .select('*')
    .gte('valid_until', today)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error || !data || data.length === 0) return null;
  return data;
}

// –– Webhook ––
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

app.get('/', (_, res) => res.send('LINE Bot is running!'));

// –– CSV ダウンロード ––
app.get('/csv/:userId', async (req, res) => {
  const { userId } = req.params;
  const { year, month } = req.query;

  let query = supabase
    .from('transactions')
    .select('type, amount, memo, recorded_at')
    .eq('user_id', userId)
    .order('recorded_at', { ascending: true });

  if (year && month) {
    const lastDay = new Date(year, month, 0).getDate();
    query = query
      .gte('recorded_at', `${year}-${pad(month)}-01T00:00:00+09:00`)
      .lte('recorded_at', `${year}-${pad(month)}-${lastDay}T23:59:59+09:00`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).send('エラーが発生しました');

  const rows = ['日時,種別,金額,メモ'];
  data.forEach(r => {
    const jst = new Date(r.recorded_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const type = r.type === 'uri' ? '売上' : '経費';
    rows.push(`"${jst}","${type}","${r.amount}","${r.memo || ''}"`);
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=sales.csv');
  res.send('\uFEFF' + rows.join('\n'));
});

// –– イベントハンドラ ––
async function handleEvent(event) {
  if (event.type === 'follow') return handleFollow(event);
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId;
  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  const cmd = parse(text);
  const reply = await respond(cmd, userId);

  return client.replyMessage(replyToken, { type: 'text', text: reply });
}

async function handleFollow(event) {
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: 'こんにちは！💚 売上・経費ボットです。\n\n毎日の売上や経費を送るだけで利益を自動集計します。\n\n「ヘルプ」でいつでも使い方を確認できます！',
  });
}

// –– コマンドパーサー ––
function parse(text) {
  const uriMatch = text.match(/^売上\s*([0-9０-９,，]+)\s*(.*)/);
  if (uriMatch) {
    const amount = toNumber(uriMatch[1]);
    if (!amount)      return { type: 'error', msg: '⚠️ 金額は正しい数字で入力してください。\n例：売上 15000 デザイン案件' };
    if (amount === 'over') return { type: 'error', msg: '⚠️ 1回の登録上限は¥99,999,999です。\n分けて入力してください。' };
    return { type: 'uri', amount, memo: uriMatch[2].trim() };
  }

  const expMatch = text.match(/^経費\s*([0-9０-９,，]+)\s*(.*)/);
  if (expMatch) {
    const amount = toNumber(expMatch[1]);
    if (!amount)      return { type: 'error', msg: '⚠️ 金額は正しい数字で入力してください。\n例：経費 3200 交通費' };
    if (amount === 'over') return { type: 'error', msg: '⚠️ 1回の登録上限は¥99,999,999です。\n分けて入力してください。' };
    return { type: 'exp', amount, memo: expMatch[2].trim() };
  }

  if (/^(今日|きょう)$/.test(text))         return { type: 'today' };
  if (/^(今月|こんげつ)$/.test(text))        return { type: 'month' };
  if (/^先月$/.test(text))                   return { type: 'lastmonth' };
  if (/^(取消|取り消し|とりけし)$/.test(text)) return { type: 'undo' };
  if (/^(ヘルプ|help|HELP|使い方)$/i.test(text)) return { type: 'help' };
  if (/^(月別|年間)$/.test(text))            return { type: 'yearly' };
  if (/^直近$/.test(text))                   return { type: 'history', limit: 5 };

  const histMatch = text.match(/^履歴\s*(\d+)件?$/);
  if (histMatch) return { type: 'history', limit: parseInt(histMatch[1]) };

  const monthMatch = text.match(/^(\d{1,2})月$/);
  if (monthMatch) return { type: 'specificmonth', month: parseInt(monthMatch[1]) };

  const catMatch = text.match(/^カテゴリ\s*(\d{1,2})?月?$/);
  if (catMatch && (catMatch[0] === 'カテゴリ' || catMatch[1])) return { type: 'category', month: catMatch[1] ? parseInt(catMatch[1]) : null };

  const csvMatch = text.match(/^CSV(\s+(\d{1,2})月)?$/i);
  if (csvMatch) return { type: 'csv', month: csvMatch[2] ? parseInt(csvMatch[2]) : null };

  if (/^今年$/.test(text)) return { type: 'yearlySummary', year: null };
  const yearMatch = text.match(/^(\d{4})年$/);
  if (yearMatch) return { type: 'yearlySummary', year: parseInt(yearMatch[1]) };

  if (/^補助金$/.test(text))      return { type: 'subsidy' };
  if (/^補助金\s*詳細$/.test(text)) return { type: 'subsidyDetail' };

  const kaizeMatch = text.match(/^改善(.+)/s);
  if (kaizeMatch) return { type: 'kaizen', msg: kaizeMatch[1].trim() };

  if (/^特売$/.test(text))         return { type: 'sale' };
  if (/^特売\s*登録$/.test(text))  return { type: 'saleRegister' };

  const saleInputMatch = text.match(/^特売登録\s+(.+?)\s+(.+?)\s+(\d+)\s*(\d*)\s*(\d{4}-\d{2}-\d{2})?$/);
  if (saleInputMatch) return {
    type: 'saleInput',
    store:   saleInputMatch[1],
    item:    saleInputMatch[2],
    price:   parseInt(saleInputMatch[3]),
    discount: parseInt(saleInputMatch[4] || '0'),
    until:   saleInputMatch[5] || new Date(Date.now() + 86400000).toISOString().slice(0, 10),
  };

  return { type: 'unknown' };
}

function toNumber(str) {
  const n = parseInt(
    str.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[,，]/g, '')
  );
  if (isNaN(n) || n <= 0) return null;
  if (n > 99999999) return 'over';
  return n;
}

// –– ボット応答 ––
async function respond(cmd, userId) {
  const now = new Date();
  const jstNow = toJSTDate(now);

  if (cmd.type === 'uri') {
    const { error } = await supabase.from('transactions').insert({ user_id: userId, type: 'uri', amount: cmd.amount, memo: cmd.memo || null });
    if (error) return serverError();
    return `✅ 売上 ${yen(cmd.amount)} を記録しました${cmd.memo ? '\n📝 ' + cmd.memo : ''}\n🕐 ${fmtDatetime(now)}`;
  }

  if (cmd.type === 'exp') {
    const { error } = await supabase.from('transactions').insert({ user_id: userId, type: 'exp', amount: cmd.amount, memo: cmd.memo || null });
    if (error) return serverError();
    return `✅ 経費 ${yen(cmd.amount)} を記録しました${cmd.memo ? '\n📝 ' + cmd.memo : ''}\n🕐 ${fmtDatetime(now)}`;
  }

  if (cmd.type === 'today') {
    const start = toJSTDateString(now) + 'T00:00:00+09:00';
    const end   = toJSTDateString(now) + 'T23:59:59+09:00';
    const { data, error } = await supabase.from('transactions').select('type, amount').eq('user_id', userId).gte('recorded_at', start).lte('recorded_at', end);
    if (error) return serverError();
    return buildSummary(data, `本日の集計（${fmtDate(now)}）`);
  }

  if (cmd.type === 'month') {
    return await monthSummary(userId, jstNow.year, jstNow.month, `${jstNow.month}月の集計（1日〜${jstNow.day}日）`);
  }

  if (cmd.type === 'lastmonth') {
    const lm = jstNow.month === 1
      ? { year: jstNow.year - 1, month: 12 }
      : { year: jstNow.year, month: jstNow.month - 1 };
    const lastDay = new Date(lm.year, lm.month, 0).getDate();
    return await monthSummary(userId, lm.year, lm.month, `${lm.month}月の集計（全期間）`, lastDay);
  }

  if (cmd.type === 'specificmonth') {
    const y = cmd.month > jstNow.month ? jstNow.year - 1 : jstNow.year;
    const lastDay = new Date(y, cmd.month, 0).getDate();
    return await monthSummary(userId, y, cmd.month, `${cmd.month}月の集計`, lastDay);
  }

  if (cmd.type === 'yearly') {
    const results = [];
    for (let m = 1; m <= jstNow.month; m++) {
      const lastDay = m === jstNow.month ? jstNow.day : new Date(jstNow.year, m, 0).getDate();
      const start = `${jstNow.year}-${pad(m)}-01T00:00:00+09:00`;
      const end   = `${jstNow.year}-${pad(m)}-${lastDay}T23:59:59+09:00`;
      const { data } = await supabase.from('transactions').select('type, amount').eq('user_id', userId).gte('recorded_at', start).lte('recorded_at', end);
      if (!data || data.length === 0) continue;
      const uri = data.filter(r => r.type === 'uri').reduce((s, r) => s + r.amount, 0);
      const exp = data.filter(r => r.type === 'exp').reduce((s, r) => s + r.amount, 0);
      const profit = uri - exp;
      results.push(`${m}月　利益 ${profit >= 0 ? '' : '-'}${yen(Math.abs(profit))}`);
    }
    if (results.length === 0) return '📅 まだデータがありません。';
    return `📅 ${jstNow.year}年 月別サマリー\n─────────────────\n${results.join('\n')}`;
  }

  if (cmd.type === 'yearlySummary') {
    const targetYear = cmd.year || jstNow.year;
    const maxMonth = targetYear === jstNow.year ? jstNow.month : 12;
    let totalUri = 0, totalExp = 0;
    const results = [];
    for (let m = 1; m <= maxMonth; m++) {
      const lastDay = (targetYear === jstNow.year && m === jstNow.month) ? jstNow.day : new Date(targetYear, m, 0).getDate();
      const start = `${targetYear}-${pad(m)}-01T00:00:00+09:00`;
      const end   = `${targetYear}-${pad(m)}-${lastDay}T23:59:59+09:00`;
      const { data } = await supabase.from('transactions').select('type, amount').eq('user_id', userId).gte('recorded_at', start).lte('recorded_at', end);
      if (!data || data.length === 0) continue;
      const uri = data.filter(r => r.type === 'uri').reduce((s, r) => s + r.amount, 0);
      const exp = data.filter(r => r.type === 'exp').reduce((s, r) => s + r.amount, 0);
      totalUri += uri;
      totalExp += exp;
      results.push(`${m}月　売上 ${yen(uri)}　経費 ${yen(exp)}`);
    }
    if (results.length === 0) return `📅 ${targetYear}年のデータがありません。`;
    const profit = totalUri - totalExp;
    const profitStr = profit >= 0 ? yen(profit) : `-${yen(Math.abs(profit))}`;
    return `📅 ${targetYear}年 年間集計\n─────────────────\n${results.join('\n')}\n─────────────────\n売上合計　${yen(totalUri)}\n経費合計　${yen(totalExp)}\n利益合計　${profitStr}`;
  }

  if (cmd.type === 'category') {
    const targetMonth = cmd.month || jstNow.month;
    const y = (!cmd.month || cmd.month <= jstNow.month) ? jstNow.year : jstNow.year - 1;
    const lastDay = new Date(y, targetMonth, 0).getDate();
    const start = `${y}-${pad(targetMonth)}-01T00:00:00+09:00`;
    const end   = `${y}-${pad(targetMonth)}-${lastDay}T23:59:59+09:00`;
    const { data, error } = await supabase.from('transactions').select('type, amount, memo').eq('user_id', userId).eq('type', 'exp').gte('recorded_at', start).lte('recorded_at', end);
    if (error) return serverError();
    if (!data || data.length === 0) return `📂 ${targetMonth}月の経費データがありません。`;
    const cats = {};
    data.forEach(r => { const key = r.memo || 'その他'; cats[key] = (cats[key] || 0) + r.amount; });
    const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1]);
    const lines = sorted.map(([k, v]) => `${k}　${yen(v)}`);
    const total = data.reduce((s, r) => s + r.amount, 0);
    return `📂 ${targetMonth}月 経費カテゴリ別\n─────────────────\n${lines.join('\n')}\n─────────────────\n合計　${yen(total)}`;
  }

  if (cmd.type === 'history') {
    const { data, error } = await supabase.from('transactions').select('type, amount, memo, recorded_at').eq('user_id', userId).order('recorded_at', { ascending: false }).limit(cmd.limit);
    if (error) return serverError();
    if (!data || data.length === 0) return '📋 まだ記録がありません。';
    const lines = data.map(r => {
      const j = toJSTDate(new Date(r.recorded_at));
      const label = r.type === 'uri' ? '売上' : '経費';
      return `${j.month}/${j.day} ${label} ${yen(r.amount)}${r.memo ? ' ' + r.memo : ''}`;
    });
    return `📋 直近${cmd.limit}件\n─────────────────\n${lines.join('\n')}`;
  }

  if (cmd.type === 'csv') {
    const targetMonth = cmd.month || jstNow.month;
    const baseUrl = process.env.BASE_URL || 'https://line-sales-bot-production-3f91.up.railway.app';
    const csvUrl = `${baseUrl}/csv/${userId}?year=${jstNow.year}&month=${targetMonth}`;
    return `📥 ${targetMonth}月のCSVダウンロード\n\n以下のURLをブラウザで開いてください：\n${csvUrl}\n\n※ Excelで開けます（日本語対応）`;
  }

  if (cmd.type === 'subsidy') {
    const { matched, estimatedAnnual } = await getMatchedSubsidies(userId);
    const lines = matched.map(s =>
      `${starRating(s.score)} ${s.name}\n　最大${s.amount} | 締切：${s.deadline}`
    );
    const salesText = estimatedAnnual > 0 ? `\n（年間売上推定：${yen(estimatedAnnual)}をもとにマッチング）` : '';
    return `💰 あなたに使える補助金${salesText}\n\n${lines.join('\n\n')}\n\n「補助金 詳細」で詳しい情報が見られます！`;
  }

  if (cmd.type === 'subsidyDetail') {
    const { matched } = await getMatchedSubsidies(userId);
    const lines = matched.map(s =>
      `📌 ${s.name}\n💴 ${s.amount}\n⏰ 締切：${s.deadline}\n📝 ${s.description}\n🔗 ${s.url}`
    );
    return `📋 補助金詳細情報\n\n${lines.join('\n──────────────\n')}`;
  }

  if (cmd.type === 'kaizen') {
    const adminId = process.env.ADMIN_USER_ID;
    await supabase.from('feedback').insert({
      user_id: userId,
      message: cmd.msg,
      created_at: new Date().toISOString(),
    });
    if (adminId) {
      try {
        await client.pushMessage(adminId, {
          type: 'text',
          text: `📬 改善要望が届きました！\n\nユーザー：${userId}\n\n内容：\n${cmd.msg}`,
        });
      } catch (e) {
        console.error('Admin notify error:', e);
      }
    }
    return `📝 改善要望を受け付けました！\nありがとうございます😊\n\nいただいたご意見はサービス改善に活用させていただきます。`;
  }

  if (cmd.type === 'sale') {
    const items = await getSaleItems();
    if (!items) return '🏪 現在配信中の特売情報はありません。\n\n近くのスーパーの特売情報が届いたらお知らせします！';
    const grouped = {};
    items.forEach(i => {
      if (!grouped[i.store_name]) grouped[i.store_name] = [];
      grouped[i.store_name].push(i);
    });
    const lines = Object.entries(grouped).map(([store, its]) => {
      const itemLines = its.map(i => {
        const discount = i.discount ? ` (${i.discount}%OFF)` : '';
        return `　${i.item_name}${discount} → ¥${Number(i.price).toLocaleString('ja-JP')}`;
      }).join('\n');
      return `🏪 ${store}\n${itemLines}\n⏰ ${its[0].valid_until}まで`;
    });
    return `📢 本日の特売情報\n\n${lines.join('\n\n')}\n\n「特売 登録」でスーパーの情報を登録できます（管理者のみ）`;
  }

  if (cmd.type === 'saleInput') {
    const adminId = process.env.ADMIN_USER_ID;
    if (adminId && userId !== adminId) return '⚠️ 特売情報の登録は管理者のみできます。';
    const { error } = await supabase.from('sales').insert({
      store_name: cmd.store,
      item_name:  cmd.item,
      price:      cmd.price,
      discount:   cmd.discount,
      valid_until: cmd.until,
    });
    if (error) return '❌ 登録に失敗しました。もう一度お試しください。';
    const discountText = cmd.discount > 0 ? ` (${cmd.discount}%OFF)` : '';
    return `✅ 特売情報を登録しました！\n\n🏪 ${cmd.store}\n📦 ${cmd.item}${discountText}\n💰 ¥${cmd.price.toLocaleString('ja-JP')}\n⏰ ${cmd.until}まで\n\nユーザーが「特売」と送ると表示されます。`;
  }

  if (cmd.type === 'saleRegister') {
    return `📝 特売情報の登録方法\n\n以下の形式で送ってください：\n\n特売登録 店名 商品名 価格 割引率 有効期限\n\n例：\n特売登録 イオン 国産牛肉 680 30 2026-04-15\n特売登録 イオン 刺身盛り合わせ 498 0 2026-04-15\n\n※管理者のみ登録できます`;
  }

  if (cmd.type === 'undo') {
    const { data, error } = await supabase.from('transactions').select('id, type, amount, memo').eq('user_id', userId).order('recorded_at', { ascending: false }).limit(1);
    if (error) return serverError();
    if (!data || data.length === 0) return '⚠️ 取り消せる記録がありません。';
    const last = data[0];
    await supabase.from('transactions').delete().eq('id', last.id);
    const label = last.type === 'uri' ? '売上' : '経費';
    return `↩ 直前の記録を取り消しました\n${label} ${yen(last.amount)}${last.memo ? ' ' + last.memo : ''}`;
  }

  if (cmd.type === 'help') {
    return `📖 使い方ガイド\n\n【登録】\n売上 15000 案件名\n経費 3200 交通費\n\n【確認】\n今日 → 本日の集計\n今月 → 今月の集計\n先月 → 先月の集計\n3月 → 指定月の集計\n月別 → 年間の月別一覧\n今年 → 今年の年間集計\n2026年 → 指定年の集計\n直近 → 直近5件の記録\n\n【カテゴリ別】\nカテゴリ → 今月の経費をメモ別に集計\nカテゴリ 3月 → 指定月\n\n【CSV出力】\nCSV → 今月のCSVリンク\nCSV 3月 → 指定月のCSV\n\n【補助金】\n補助金 → 使える補助金一覧\n補助金 詳細 → 詳細・申請方法\n\n【特売情報】\n特売 → 近くのスーパーの特売一覧\n\n【改善要望】\n改善〇〇 → 改善要望を送る\n\n【修正】\n取消 → 直前の1件を削除`;
  }

  if (cmd.type === 'error') return cmd.msg;
  return '❓ わからないコマンドです。\n「ヘルプ」と送ると使い方が見られます。';
}

// –– 月集計ヘルパー ––
async function monthSummary(userId, year, month, title, lastDay) {
  const endDay = lastDay || new Date(year, month, 0).getDate();
  const start = `${year}-${pad(month)}-01T00:00:00+09:00`;
  const end   = `${year}-${pad(month)}-${endDay}T23:59:59+09:00`;
  const { data, error } = await supabase.from('transactions').select('type, amount').eq('user_id', userId).gte('recorded_at', start).lte('recorded_at', end);
  if (error) return serverError();
  return buildSummary(data, title);
}

// –– ユーティリティ ––
function yen(n)  { return '¥' + n.toLocaleString('ja-JP'); }
function pad(n)  { return String(n).padStart(2, '0'); }

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

// –– 毎日の自動レポート ––
app.post('/daily-report', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  try {
    const now = new Date();
    const jstNow = toJSTDate(now);
    const start = `${jstNow.year}-${pad(jstNow.month)}-${pad(jstNow.day)}T00:00:00+09:00`;
    const end   = `${jstNow.year}-${pad(jstNow.month)}-${pad(jstNow.day)}T23:59:59+09:00`;

    const { data: users, error } = await supabase
      .from('transactions')
      .select('user_id')
      .gte('recorded_at', start)
      .lte('recorded_at', end);

    if (error || !users || users.length === 0) {
      return res.status(200).send('No users today');
    }

    const userIds = [...new Set(users.map(u => u.user_id))];
    let sent = 0;

    for (const userId of userIds) {
      try {
        const { data } = await supabase
          .from('transactions')
          .select('type, amount, memo')
          .eq('user_id', userId)
          .gte('recorded_at', start)
          .lte('recorded_at', end);

        if (!data || data.length === 0) continue;

        const income = data.filter(r => r.type === 'uri').reduce((s, r) => s + r.amount, 0);
        const exp    = data.filter(r => r.type === 'exp').reduce((s, r) => s + r.amount, 0);
        const profit = income - exp;
        const profitStr = profit >= 0 ? yen(profit) : `-${yen(Math.abs(profit))}`;

        const monthStart = `${jstNow.year}-${pad(jstNow.month)}-01T00:00:00+09:00`;
        const { data: monthData } = await supabase
          .from('transactions')
          .select('type, amount')
          .eq('user_id', userId)
          .gte('recorded_at', monthStart)
          .lte('recorded_at', end);

        const monthIncome = monthData ? monthData.filter(r => r.type === 'uri').reduce((s, r) => s + r.amount, 0) : 0;
        const monthExp    = monthData ? monthData.filter(r => r.type === 'exp').reduce((s, r) => s + r.amount, 0) : 0;
        const monthProfit = monthIncome - monthExp;
        const monthProfitStr = monthProfit >= 0 ? yen(monthProfit) : `-${yen(Math.abs(monthProfit))}`;

        const message =
`🌙 ${jstNow.month}/${jstNow.day} 今日のまとめ
─────────────────
収入　　${yen(income)}
支出　　${yen(exp)}
─────────────────
本日収支　${profitStr}

📅 今月累計
収入　${yen(monthIncome)}
支出　${yen(monthExp)}
収支　${monthProfitStr}
─────────────────
明日も記録を続けましょう💪`;

        await client.pushMessage(userId, { type: 'text', text: message });
        sent++;
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.error(`Push error for ${userId}:`, e);
      }
    }

    res.status(200).send(`Sent to ${sent} users`);
  } catch (e) {
    console.error('Daily report error:', e);
    res.status(500).send('Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

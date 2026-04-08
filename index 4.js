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

// ---- 補助金データ ----
const SUBSIDIES = [
  {
    id: 1,
    name: '小規模事業者持続化補助金',
    amount: '最大¥200万',
    maxAmount: 2000000,
    deadline: '2026/6/30',
    description: '販路開拓・業務効率化のための経費を補助。チラシ・HP作成・設備投資など幅広く使えます。',
    conditions: ['個人事業主OK', '従業員20名以下'],
    apply: '商工会議所で申請書を受け取り、電子申請システムで提出',
    url: 'https://jizokukahojokin.info',
    minSales: 0,
    maxSales: 50000000,
  },
  {
    id: 2,
    name: 'IT導入補助金',
    amount: '最大¥450万',
    maxAmount: 4500000,
    deadline: '2026/5/31',
    description: '会計ソフト・受発注システム・ECサイトなどITツールの導入費用を補助。',
    conditions: ['個人事業主OK', '中小企業・小規模事業者'],
    apply: 'IT導入支援事業者と共同で申請',
    url: 'https://www.it-hojo.jp',
    minSales: 0,
    maxSales: 500000000,
  },
  {
    id: 3,
    name: 'ものづくり補助金',
    amount: '最大¥1,250万',
    maxAmount: 12500000,
    deadline: '2026/7/31',
    description: '新製品・サービス開発や生産プロセス改善のための設備投資を補助。',
    conditions: ['中小企業・小規模事業者', '革新的な取り組みが必要'],
    apply: '電子申請システム（jGrants）で申請',
    url: 'https://portal.monodukuri-hojo.jp',
    minSales: 0,
    maxSales: 500000000,
  },
  {
    id: 4,
    name: '事業再構築補助金',
    amount: '最大¥7,000万',
    maxAmount: 70000000,
    deadline: '2026/8/31',
    description: '新分野展開・業態転換・事業転換などを支援。コロナ以降の事業変革に。',
    conditions: ['売上減少要件あり', '認定支援機関の確認必要'],
    apply: '電子申請システム（jGrants）で申請',
    url: 'https://jigyou-saikouchiku.go.jp',
    minSales: 0,
    maxSales: 500000000,
  },
  {
    id: 5,
    name: '雇用調整助成金',
    amount: '最大¥9,000/日',
    maxAmount: 9000,
    deadline: '随時受付',
    description: '従業員を一時休業させた場合の休業手当を助成。',
    conditions: ['従業員がいる事業主', '売上減少要件あり'],
    apply: 'ハローワークで申請',
    url: 'https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/koyou/kyufukin/pageL07.html',
    minSales: 0,
    maxSales: 500000000,
  },
];

// 補助金マッチング関数
async function getMatchedSubsidies(userId) {
  const now = new Date();
  const jstNow = toJSTDate(now);
  
  // 今月の売上を取得
  const start = `${jstNow.year}-${pad(jstNow.month)}-01T00:00:00+09:00`;
  const end = `${jstNow.year}-${pad(jstNow.month)}-${jstNow.day}T23:59:59+09:00`;
  
  const { data } = await supabase.from('transactions')
    .select('type, amount')
    .eq('user_id', userId)
    .gte('recorded_at', start)
    .lte('recorded_at', end);

  const monthlySales = data ? data.filter(r => r.type === 'uri').reduce((s, r) => s + r.amount, 0) : 0;
  const estimatedAnnual = monthlySales * 12;

  // マッチング（全補助金を返す・売上規模でスコアリング）
  const matched = SUBSIDIES.map(s => {
    let score = 3;
    if (estimatedAnnual >= s.minSales && estimatedAnnual <= s.maxSales) score = 3;
    if (estimatedAnnual < 5000000) {
      if (s.id === 1) score = 3; // 持続化補助金は小規模に最適
      if (s.id === 2) score = 2;
      if (s.id === 3) score = 2;
      if (s.id === 4) score = 1;
    }
    return { ...s, score };
  }).sort((a, b) => b.score - a.score);

  return { matched, estimatedAnnual };
}

function starRating(score) {
  return '★'.repeat(score) + '☆'.repeat(3 - score);
}


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

// ---- CSV ダウンロード用エンドポイント ----
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

// ---- イベントハンドラ ----
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

// ---- コマンドパーサー ----
function parse(text) {
  const uriMatch = text.match(/^売上\s*([0-9０-９,，]+)\s*(.*)/);
  if (uriMatch) {
    const amount = toNumber(uriMatch[1]);
    if (!amount) return { type: 'error', msg: '⚠️ 金額は正しい数字で入力してください。\n例：売上 15000 デザイン案件' };
    if (amount === 'over') return { type: 'error', msg: '⚠️ 1回の登録上限は¥99,999,999です。\n分けて入力してください。' };
    return { type: 'uri', amount, memo: uriMatch[2].trim() };
  }

  const expMatch = text.match(/^経費\s*([0-9０-９,，]+)\s*(.*)/);
  if (expMatch) {
    const amount = toNumber(expMatch[1]);
    if (!amount) return { type: 'error', msg: '⚠️ 金額は正しい数字で入力してください。\n例：経費 3200 交通費' };
    if (amount === 'over') return { type: 'error', msg: '⚠️ 1回の登録上限は¥99,999,999です。\n分けて入力してください。' };
    return { type: 'exp', amount, memo: expMatch[2].trim() };
  }

  if (/^(今日|きょう)$/.test(text)) return { type: 'today' };
  if (/^(今月|こんげつ)$/.test(text)) return { type: 'month' };
  if (/^先月$/.test(text)) return { type: 'lastmonth' };
  if (/^(取消|取り消し|とりけし)$/.test(text)) return { type: 'undo' };
  if (/^(ヘルプ|help|HELP|使い方)$/i.test(text)) return { type: 'help' };
  if (/^(月別|年間)$/.test(text)) return { type: 'yearly' };
  if (/^直近$/.test(text)) return { type: 'history', limit: 5 };

  const histMatch = text.match(/^履歴\s*(\d+)件?$/);
  if (histMatch) return { type: 'history', limit: parseInt(histMatch[1]) };

  const monthMatch = text.match(/^(\d{1,2})月$/);
  if (monthMatch) return { type: 'specificmonth', month: parseInt(monthMatch[1]) };

  // カテゴリ（今月・指定月）
  const catMatch = text.match(/^カテゴリ\s*(\d{1,2})?月?$/);
  if (catMatch && (catMatch[0] === 'カテゴリ' || catMatch[1])) return { type: 'category', month: catMatch[1] ? parseInt(catMatch[1]) : null };

  const csvMatch = text.match(/^CSV(\s+(\d{1,2})月)?$/i);
  if (csvMatch) return { type: 'csv', month: csvMatch[2] ? parseInt(csvMatch[2]) : null };

  // 年間集計（今年・指定年）
  if (/^今年$/.test(text)) return { type: 'yearlySummary', year: null };
  const yearMatch = text.match(/^(\d{4})年$/);
  if (yearMatch) return { type: 'yearlySummary', year: parseInt(yearMatch[1]) };

  // 補助金
  if (/^補助金$/.test(text)) return { type: 'subsidy' };
  if (/^補助金\s*詳細$/.test(text)) return { type: 'subsidyDetail' };

  return { type: 'unknown' };
}

function toNumber(str) {
  const n = parseInt(
    str.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[,，]/g, '')
  );
  if (isNaN(n) || n <= 0) return null;
  if (n > 99999999) return 'over'; // 1億円以上はNG
  return n;
}

// ---- ボット応答 ----
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
    const lm = jstNow.month === 1 ? { year: jstNow.year - 1, month: 12 } : { year: jstNow.year, month: jstNow.month - 1 };
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
      const end = `${jstNow.year}-${pad(m)}-${lastDay}T23:59:59+09:00`;
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

  // 年間集計
  if (cmd.type === 'yearlySummary') {
    const targetYear = cmd.year || jstNow.year;
    const maxMonth = targetYear === jstNow.year ? jstNow.month : 12;
    let totalUri = 0, totalExp = 0;
    const results = [];
    for (let m = 1; m <= maxMonth; m++) {
      const lastDay = (targetYear === jstNow.year && m === jstNow.month) ? jstNow.day : new Date(targetYear, m, 0).getDate();
      const start = `${targetYear}-${pad(m)}-01T00:00:00+09:00`;
      const end = `${targetYear}-${pad(m)}-${lastDay}T23:59:59+09:00`;
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
    const end = `${y}-${pad(targetMonth)}-${lastDay}T23:59:59+09:00`;
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

  // 補助金マッチング
  if (cmd.type === 'subsidy') {
    const { matched, estimatedAnnual } = await getMatchedSubsidies(userId);
    const lines = matched.map(s =>
      `${starRating(s.score)} ${s.name}\n　最大${s.amount} | 締切：${s.deadline}`
    );
    const salesText = estimatedAnnual > 0 ? `\n（年間売上推定：${yen(estimatedAnnual)}をもとにマッチング）` : '';
    return `💰 あなたに使える補助金${salesText}\n\n${lines.join('\n\n')}\n\n「補助金 詳細」で詳しい情報が見られます！`;
  }

  // 補助金詳細
  if (cmd.type === 'subsidyDetail') {
    const { matched } = await getMatchedSubsidies(userId);
    const lines = matched.map(s =>
      `📌 ${s.name}\n💴 ${s.amount}\n⏰ 締切：${s.deadline}\n📝 ${s.description}\n✅ ${s.conditions.join('・')}\n🔗 ${s.url}`
    );
    return `📋 補助金詳細情報\n\n${lines.join('\n──────────────\n')}`;
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
    return `📖 使い方ガイド\n\n【登録】\n売上 15000 案件名\n経費 3200 交通費\n\n【確認】\n今日 → 本日の集計\n今月 → 今月の集計\n先月 → 先月の集計\n3月 → 指定月の集計\n月別 → 年間の月別一覧\n直近 → 直近5件の記録\n\n【カテゴリ別】\nカテゴリ → 今月の経費をメモ別に集計\nカテゴリ 3月 → 指定月\n\n【CSV出力】\nCSV → 今月のCSVリンク\nCSV 3月 → 指定月のCSV\n\n【補助金】\n補助金 → 使える補助金一覧\n補助金 詳細 → 詳細・申請方法\n\n【修正】\n取消 → 直前の1件を削除`;
  }

  if (cmd.type === 'error') return cmd.msg;
  return '❓ わからないコマンドです。\n「ヘルプ」と送ると使い方が見られます。';
}

async function monthSummary(userId, year, month, title, lastDay) {
  const endDay = lastDay || new Date(year, month, 0).getDate();
  const start = `${year}-${pad(month)}-01T00:00:00+09:00`;
  const end = `${year}-${pad(month)}-${endDay}T23:59:59+09:00`;
  const { data, error } = await supabase.from('transactions').select('type, amount').eq('user_id', userId).gte('recorded_at', start).lte('recorded_at', end);
  if (error) return serverError();
  return buildSummary(data, title);
}

function yen(n) { return '¥' + n.toLocaleString('ja-JP'); }
function pad(n) { return String(n).padStart(2, '0'); }

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

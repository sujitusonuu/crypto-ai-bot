// scanner.js — 24/7 Cloud V7 AI Quant + News Sentiment Scanner
const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'SUI', 'LINK', 'TRX', 'TON', 'NEAR', 'PEPE', 'SHIB'];
const TRADE_MODE = 'FUTURES'; // Change to 'SPOT' if you only trade Spot
const LEVERAGE = 3;           // Default safe leverage for Futures calculations

const BULLISH_WORDS = ['surge', 'surges', 'rally', 'rallies', 'bull', 'bullish', 'breakout', 'adopt', 'adoption', 'partnership', 'upgrade', 'etf', 'inflow', 'inflows', 'record', 'high', 'soar', 'soars', 'gain', 'gains', 'launch', 'approve', 'approved', 'institutional', 'accumulate'];
const BEARISH_WORDS = ['hack', 'hacked', 'exploit', 'crash', 'crashes', 'plunge', 'plunges', 'bear', 'bearish', 'ban', 'lawsuit', 'sec', 'outflow', 'outflows', 'dump', 'dumps', 'drop', 'drops', 'slump', 'outage', 'halt', 'delist', 'liquidate', 'liquidation', 'fraud', 'scam', 'selloff'];

function computeRSIArray(closes, period = 14) {
  let rsiArr = new Array(closes.length).fill(null);
  if (closes.length <= period) return rsiArr;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    let diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  rsiArr[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  for (let i = period + 1; i < closes.length; i++) {
    let diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    rsiArr[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  }
  return rsiArr;
}

function computeEMAArray(closes, period = 50) {
  let emaArr = new Array(closes.length).fill(null);
  if (closes.length < period) return emaArr;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  let prevEma = sum / period;
  emaArr[period - 1] = prevEma;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    prevEma = closes[i] * k + prevEma * (1 - k);
    emaArr[i] = prevEma;
  }
  return emaArr;
}

function computeATRPercent(candles, period = 14) {
  if (candles.length < period + 2) return 2.5;
  let trSum = 0;
  for (let i = candles.length - period - 1; i < candles.length - 1; i++) {
    const high = candles[i].high, low = candles[i].low, prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSum += (tr / prevClose) * 100;
  }
  return trSum / period;
}

async function fetchCandles(symbol) {
  const pair = symbol + 'USDT';
  const urls = [
    `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=1h&limit=120`,
    `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1h&limit=120`
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = await res.json();
      if (Array.isArray(json) && json.length > 55) {
        return json.map(c => ({
          time: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4])
        }));
      }
    } catch (e) {}
  }
  const ccRes = await fetch(`https://min-api.cryptocompare.com/data/v2/histohour?fsym=${symbol}&tsym=USD&limit=120`);
  const ccJson = await ccRes.json();
  return ccJson.Data.Data.map(c => ({
    time: c.time * 1000, open: parseFloat(c.open), high: parseFloat(c.high), low: parseFloat(c.low), close: parseFloat(c.close)
  }));
}

async function fetchNewsSentiment(symbol) {
  try {
    const res = await fetch(`https://min-api.cryptocompare.com/data/v2/news/?categories=${symbol},Market&excludeCategories=Sponsored`);
    const json = await res.json();
    const articles = (json.Data || []).slice(0, 6);
    let bull = 0, bear = 0;
    articles.forEach(a => {
      const txt = ((a.title || '') + ' ' + (a.body || '')).toLowerCase();
      BULLISH_WORDS.forEach(w => { if (txt.includes(w)) bull++; });
      BEARISH_WORDS.forEach(w => { if (txt.includes(w)) bear++; });
    });
    const score = Math.max(-100, Math.min(100, (bull - bear) * 14));
    const headline = articles.length > 0 ? articles[0].title : 'No major breaking headline';
    return { score, headline };
  } catch (e) {
    return { score: 0, headline: 'News feed offline' };
  }
}

async function getInrRate() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    return data?.rates?.INR || 94.78;
  } catch (e) {
    return 94.78;
  }
}

async function runScanner() {
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  const isManualRun = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';

  if (!token || !chatId) {
    console.error('ERROR: Missing TG_BOT_TOKEN or TG_CHAT_ID in GitHub Secrets!');
    process.exit(1);
  }

  const inrRate = await getInrRate();
  const fmtPrice = (usd) => `$${usd < 1 ? usd.toFixed(5) : usd.toFixed(2)} (₹${(usd * inrRate).toLocaleString('en-IN', { maximumFractionDigits: 2 })})`;

  let triggered = [];
  let closestCoins = [];

  for (const coin of COINS) {
    try {
      const candles = await fetchCandles(coin);
      const closes = candles.map(c => c.close);
      const livePrice = closes[closes.length - 1];
      const idx = closes.length - 2; // Last confirmed closed hour candle

      const rsis = computeRSIArray(closes, 14);
      const ema50s = computeEMAArray(closes, 50);
      const atrPct = computeATRPercent(candles, 14);

      const rsiNow = rsis[idx], rsiPrev = rsis[idx - 1], rsiPrev2 = rsis[idx - 2];
      const ema50 = ema50s[idx];

      // Dynamic ATR-based Take-Profit & Stop-Loss (Self-Adapting to Coin Volatility)
      const tpPct = Number(Math.max(3.5, Math.min(8.5, atrPct * 2.4)).toFixed(1));
      const slPct = Number(Math.max(2.5, Math.min(5.5, atrPct * 1.5)).toFixed(1));

      const buyThreshold = 35;
      const sellThreshold = 65;

      const dippedOversold = (rsiPrev <= buyThreshold || rsiPrev2 <= buyThreshold || rsiNow <= 32);
      const hookedUp = rsiNow > rsiPrev && closes[idx] >= closes[idx - 1];
      const notFreefall = !ema50 || (closes[idx] >= ema50 * 0.94 || rsiPrev < 25);

      const peakedOverbought = (rsiPrev >= sellThreshold || rsiPrev2 >= sellThreshold || rsiNow >= 68);
      const hookedDown = rsiNow < rsiPrev && closes[idx] <= closes[idx - 1];
      const safeToShort = !ema50 || TRADE_MODE === 'SPOT' || (closes[idx] <= ema50 * 1.05 || rsiPrev >= 75);

      let signal = 'NONE';
      if (dippedOversold && hookedUp && notFreefall && rsiNow < 48) signal = 'BUY';
      else if (peakedOverbought && hookedDown && safeToShort && rsiNow > 52) signal = 'SELL';

      closestCoins.push({ coin, rsiNow, livePrice });

      if (signal !== 'NONE') {
        const news = await fetchNewsSentiment(coin);
        // News Sentiment Shield Veto
        if (signal === 'BUY' && news.score <= -30) {
          console.log(`Vetoed ${coin} BUY due to bearish news (${news.score})`);
          continue;
        }
        if (signal === 'SELL' && TRADE_MODE === 'FUTURES' && news.score >= 30) {
          console.log(`Vetoed ${coin} SHORT due to bullish news (+${news.score})`);
          continue;
        }

        const isShort = signal === 'SELL' && TRADE_MODE === 'FUTURES';
        const tpPrice = isShort ? livePrice * (1 - tpPct / 100) : livePrice * (1 + tpPct / 100);
        const slPrice = isShort ? livePrice * (1 + slPct / 100) : livePrice * (1 - slPct / 100);
        const label = signal === 'BUY'
          ? (TRADE_MODE === 'FUTURES' ? `🟢 OPEN LONG (${LEVERAGE}x)` : '🟢 SPOT BUY')
          : (TRADE_MODE === 'FUTURES' ? `🔴 OPEN SHORT (${LEVERAGE}x)` : '🔴 SPOT SELL');

        triggered.push({
          coin, label, livePrice, tpPrice, slPrice, tpPct, slPct, isShort,
          rsiPrev, rsiNow, ema50, newsScore: news.score, headline: news.headline
        });
      }
    } catch (err) {
      console.log(`Skipped ${coin}: ${err.message}`);
    }
  }

  // Send Telegram message if a signal triggered OR if you clicked "Run workflow" manually to test
  if (triggered.length > 0) {
    let msg = `🤖 *V7 CLOUD AI SCANNER ALERT* 🤖\nFound *${triggered.length}* confirmed setup(s):\n\n`;
    triggered.forEach(t => {
      msg += `🔥 *${t.coin}/USDT* — ${t.label}\n` +
             `💰 *Entry:* ${fmtPrice(t.livePrice)}\n` +
             `🎯 *Take-Profit (TP):* ${fmtPrice(t.tpPrice)} (${t.isShort ? '-' : '+'}${t.tpPct}%)\n` +
             `🛑 *Stop-Loss (SL):* ${fmtPrice(t.slPrice)} (${t.isShort ? '+' : '-'}${t.slPct}%)\n` +
             `📊 *RSI Hook:* ${t.rsiPrev.toFixed(1)} → *${t.rsiNow.toFixed(1)}* | *News:* ${t.newsScore}\n` +
             `📰 _"${t.headline}"_\n\n`;
    });
    await sendTelegram(token, chatId, msg);
  } else if (isManualRun) {
    closestCoins.sort((a, b) => a.rsiNow - b.rsiNow);
    const top3Oversold = closestCoins.slice(0, 3).map(c => `• *${c.coin}:* RSI ${c.rsiNow.toFixed(1)} (${fmtPrice(c.livePrice)})`).join('\n');
    const top2Overbought = closestCoins.slice(-2).reverse().map(c => `• *${c.coin}:* RSI ${c.rsiNow.toFixed(1)} (${fmtPrice(c.livePrice)})`).join('\n');

    const testMsg =
      `✅ *V7 Cloud AI Bot is LIVE & Connected!*\n\n` +
      `Scanned all 15 top-volume coins. *0 coins* have an immediate confirmed entry on this hour's candle (protecting your capital!).\n\n` +
      `📉 *Closest to BUY / LONG Zone (Lowest RSI):*\n${top3Oversold}\n\n` +
      `📈 *Closest to SELL / SHORT Zone (Highest RSI):*\n${top2Overbought}\n\n` +
      `⏰ _Your cloud bot will now check the market automatically every hour 24/7 and message you the moment a trade triggers._`;
    await sendTelegram(token, chatId, testMsg);
  } else {
    console.log('Hourly scan complete: No signals triggered this hour. Stay patient!');
  }
}

async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  });
  const data = await res.json();
  console.log('Telegram response:', data.ok ? 'SENT SUCCESSFULLY' : data.description);
}

runScanner();

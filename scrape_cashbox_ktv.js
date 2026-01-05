import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const TARGET_URL = "https://www.cashboxparty.com/Music/KTVMusic.aspx";
const WAIT_TIMEOUT_MS = 180000;

function clean(s) {
  return (s ?? "").toString().replace(/\u00a0/g, " ").trim();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function escapeCSV(v) {
  if (v == null) return "";
  const s = clean(v).replace(/\r?\n/g, " ");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function isoDateStampTaipei() {
  // 以 Asia/Taipei 日期命名，避免 UTC 跨日
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // YYYY-MM-DD
}

async function closeOverlays(page) {
  // 頁面可能有「系統通知 / 系統提醒」類遮罩，嘗試多種關閉方式
  const candidates = [
    'text=關閉視窗',
    'button:has-text("關閉視窗")',
    'text=×',
    'button:has-text("×")',
    ".modal .close",
    ".modal button.close",
    ".modal .btn-close",
    ".sweet-alert button.confirm",
  ];

  for (let round = 0; round < 3; round++) {
    for (const sel of candidates) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count()) {
          await loc.click({ timeout: 1500 }).catch(() => {});
        }
      } catch {}
    }
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(600);
  }
}

async function clickTab(page, name) {
  // 用 role + link 嘗試點擊 tab
  for (let i = 0; i < 2; i++) {
    try {
      const tab = page.getByRole("link", { name }).first();
      if (await tab.count()) {
        await tab.click({ timeout: 10000 });
        await page.waitForTimeout(1200);
        return true;
      }
    } catch {}
  }
  return false;
}

async function writeDebug(page, networkLog) {
  const debugDir = path.join(process.cwd(), "debug");
  ensureDir(debugDir);

  try {
    fs.writeFileSync(path.join(debugDir, "network.log"), networkLog.join("\n"), "utf-8");
  } catch {}

  try {
    const html = await page.content();
    fs.writeFileSync(path.join(debugDir, "page.html"), html, "utf-8");
  } catch {}

  try {
    await page.screenshot({ path: path.join(debugDir, "page.png"), fullPage: true });
  } catch {}
}

(async () => {
  const networkLog = [];

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  });

  // 簡單反偵測（常見 webdriver 判斷）
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["zh-TW", "zh", "en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  });

  const page = await context.newPage();

  page.on("console", (msg) => networkLog.push(`[console.${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => networkLog.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) =>
    networkLog.push(`[requestfailed] ${req.url()} :: ${req.failure()?.errorText}`)
  );
  page.on("response", (res) => {
    const s = res.status();
    if (s >= 400) networkLog.push(`[http ${s}] ${res.url()}`);
  });

  try {
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);

    await closeOverlays(page);

    // 明確點到「點播總排行」
    await clickTab(page, "點播總排行");
    await page.waitForTimeout(1200);
    await closeOverlays(page);

    // 等待資料列出現：只要「存在」即可，不要求 visible
    await page.waitForFunction(() => {
      const c = document.querySelectorAll("ul.billSongC li").length;
      const t = document.querySelectorAll("ul.billSongT li").length;
      return c > 1 && t > 1;
    }, { timeout: WAIT_TIMEOUT_MS });

    const rows = await page.evaluate(() => {
      const clean = (s) => (s ?? "").toString().replace(/\u00a0/g, " ").trim();

      const IGNORE = new Set(["試聽／加入歌本", "試聽/加入歌本", "試聽", "加入歌本", "刪除", "專輯"]);
      const dateRe = /\d{4}[\/-]\d{1,2}[\/-]\d{1,2}/;

      const toISODate = (s) => {
        const m = clean(s).match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
        if (!m) return "";
        const yyyy = m[1];
        const mm = String(parseInt(m[2], 10)).padStart(2, "0");
        const dd = String(parseInt(m[3], 10)).padStart(2, "0");
        return `${yyyy}-${mm}-${dd}`;
      };

      const parseRangeToPeriod = (rangeText) => {
        const hits = (clean(rangeText).match(new RegExp(dateRe, "g")) || []).slice(0, 2);
        return {
          period_start: hits[0] ? toISODate(hits[0]) : "",
          period_end: hits[1] ? toISODate(hits[1]) : "",
        };
      };

      const getLines = (li) =>
        li.innerText
          .split("\n")
          .map(clean)
          .filter(Boolean)
          .filter((x) => !IGNORE.has(x));

      const pickSongNoFromAttrs = (li) => {
        const bucket = [];
        li.querySelectorAll("[href],[onclick]").forEach((el) => {
          bucket.push(el.getAttribute("href") || "");
          bucket.push(el.getAttribute("onclick") || "");
        });
        if (li.getAttributeNames) {
          for (const name of li.getAttributeNames()) {
            if (/song|no|id/i.test(name)) bucket.push(li.getAttribute(name) || "");
          }
        }
        const joined = bucket.join(" ");
        const m =
          joined.match(/(?:songno|song_no|songid|song_id|ktvno|no=|id=)\D*(\d{4,10})/i) || null;
        return m ? m[1] : "";
      };

      const normalizeRankValue = (v) => {
        const t = clean(v);
        if (!t) return "";
        if (t === "--" || t === "—" || t === "–") return "";
        return t;
      };

      const parseRow = (li, chartLabel, period) => {
        const weeks_on_chart = clean(li.querySelector(".charts-list-rank")?.innerText);

        const prev = [...li.querySelectorAll(".charts-list-prev-rank")]
          .map((el) => clean(el.innerText))
          .filter(Boolean);

        const rank = normalizeRankValue(prev[0] || "");
        const last_week_rank_raw = clean(prev[1] || "");
        const last_week_rank = normalizeRankValue(last_week_rank_raw);
        const is_new_entry =
          last_week_rank_raw === "--" || last_week_rank_raw === "—" || last_week_rank_raw === "–"
            ? 1
            : 0;

        let lines = getLines(li);

        // 移除已知數字欄位（避免干擾歌名/藝人解析）
        [weeks_on_chart, prev[0], prev[1]].filter(Boolean).forEach((v) => {
          lines = lines.filter((x) => x !== v);
        });

        // 發行日（若有）
        let release_date = "";
        const di = lines.findIndex((x) => dateRe.test(x));
        if (di >= 0) release_date = toISODate(lines.splice(di, 1)[0]);

        // 歌號
        let song_no = pickSongNoFromAttrs(li);
        if (!song_no) {
          const fromText = lines.find((x) => /^\d{4,10}$/.test(x));
          if (fromText) song_no = fromText;
        }
        if (song_no) lines = lines.filter((x) => x !== song_no);

        // 歌名 / 藝人
        const title = lines[0] || "";
        const artist_raw = lines.slice(1).join(" / ");
        const artist = artist_raw.replace(/、/g, ", ");

        return {
          chart: chartLabel,
          period_start: period.period_start,
          period_end: period.period_end,
          weeks_on_chart,
          rank,
          last_week_rank,
          is_new_entry,
          song_no,
          title,
          artist,
          release_date,
        };
      };

      const extract = (ulClass, chartLabel) => {
        const ul = document.querySelector(`ul.${ulClass}`);
        if (!ul) throw new Error(`找不到 ul.${ulClass}`);
        const rangeText = clean(ul.querySelector(".range")?.innerText);
        const period = parseRangeToPeriod(rangeText);

        const rows = [...ul.querySelectorAll("li")].filter(
          (li) => !li.className.includes("charts-list-row--header")
        );

        return rows.map((li) => parseRow(li, chartLabel, period));
      };

      return [
        ...extract("billSongC", "國語點播週榜"),
        ...extract("billSongT", "台語點播週榜"),
      ];
    });

    if (!rows?.length) throw new Error("Scrape succeeded but no rows returned.");

    const captured_at = isoDateStampTaipei();

    const outDir = path.join(process.cwd(), "data");
    ensureDir(outDir);

    const outPath = path.join(outDir, `cashbox_ktv_weekly_top30_${captured_at}.csv`);

    const headers = ["captured_at", ...Object.keys(rows[0])];
    const csv =
      headers.join(",") +
      "\n" +
      rows
        .map((row) => {
          const full = { captured_at, ...row };
          return headers.map((h) => escapeCSV(full[h])).join(",");
        })
        .join("\n");

    // 加 BOM，Excel 較不易亂碼
    fs.writeFileSync(outPath, "\ufeff" + csv, "utf-8");

    console.log(`Saved: ${outPath} (rows=${rows.length})`);
  } catch (err) {
    await writeDebug(page, networkLog);
    throw err;
  } finally {
    await browser.close();
  }
})();

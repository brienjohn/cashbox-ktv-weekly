import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const TARGET_URL = "https://www.cashboxparty.com/Music/KTVMusic.aspx";

function clean(s) {
  return (s ?? "").toString().replace(/\u00a0/g, " ").trim();
}

function escapeCSV(v) {
  if (v == null) return "";
  const s = clean(v).replace(/\r?\n/g, " ");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function isoDateStampTaipei() {
  // 以 Asia/Taipei 的日期作為檔名日期（避免 UTC 跨日）
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(new Date()); // YYYY-MM-DD
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // 如果站點較慢，可把 timeout 拉長
  page.setDefaultTimeout(60000);

  await page.goto(TARGET_URL, { waitUntil: "networkidle" });

// 1) 可能有「系統通知/提醒」遮住或影響顯示：能關就先關（關不到也沒關係）
try {
  const closeBtn = page.locator('text=關閉視窗').first();
  if (await closeBtn.count()) await closeBtn.click({ timeout: 3000 });
} catch {}

// 2) 明確點到「點播總排行」tab（避免榜單區塊仍在 hidden 的狀態）
try {
  const tab = page.locator('a:has-text("點播總排行")').first();
  if (await tab.count()) await tab.click({ timeout: 10000 });
} catch {}

// 3) 等待「非表頭」的資料列出現（不是 li.charts-list-row--header）
await page.waitForSelector('ul.billSongC li:not(.charts-list-row--header)', { timeout: 120000 });
await page.waitForSelector('ul.billSongT li:not(.charts-list-row--header)', { timeout: 120000 });


  const data = await page.evaluate(() => {
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
        period_end: hits[1] ? toISODate(hits[1]) : ""
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
        release_date
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
      ...extract("billSongT", "台語點播週榜")
    ];
  });

  await browser.close();

  const captured_at = isoDateStampTaipei();
  const outDir = path.join(process.cwd(), "data");
  fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, `cashbox_ktv_weekly_top30_${captured_at}.csv`);

  const headers = ["captured_at", ...Object.keys(data[0])];
  const csv =
    headers.join(",") +
    "\n" +
    data
      .map((row) => {
        const full = { captured_at, ...row };
        return headers.map((h) => escapeCSV(full[h])).join(",");
      })
      .join("\n");

  // 加 BOM，方便 Excel
  fs.writeFileSync(outPath, "\ufeff" + csv, "utf8");

  console.log(`Saved: ${outPath} (rows=${data.length})`);
})();

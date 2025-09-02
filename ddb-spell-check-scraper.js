#!/usr/bin/env node
// ddb-spell-check-scraper.js
// Run:
//   npm init -y && npm install puppeteer
//   node ddb-spell-check-scraper.js
//   node ddb-spell-check-scraper.js 7   # force page 7

const puppeteer = require('puppeteer');
const readline = require('readline');
const fs = require('fs');

/* ---------- tiny color helpers (no deps) ---------- */
const color = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const bold = color(1), dim = color(2);
const red = color(31), green = color(32), yellow = color(33);
const blue = color(34), magenta = color(35), cyan = color(36), gray = color(90);
const step = (n, of, msg) => console.log(`${dim(`[${n}/${of}]`)} ${cyan(msg)}`);
const sep = () => console.log(gray('────────────────────────────────────────'));
const header = (t) => console.log(bold(magenta(t)));
/* -------------------------------------------------- */

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pause = (msg = '> ') => new Promise(res => rl.question(dim(msg), () => res()));

const FILTER_URL = 'https://www.dndbeyond.com/spells?filter-material=t&filter-partnered-content=f&filter-search=&filter-source=1&filter-source=136&filter-source=3&filter-source=49&filter-source=62&filter-source=133&filter-source=111&filter-source=8&filter-source=5&filter-source=89&filter-source=2&filter-source=67&filter-source=104&filter-source=35&filter-source=27&page=1';
const TOTAL_PAGES = 14;
const MAX_ATTEMPTS = 3;
const STEP6_TIMEOUT_MS = 5000;

const HISTORY_FILE = '.ddb-history.json';
const MAX_HISTORY = 50;

const delay = (ms) => new Promise(res => setTimeout(res, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const forcedPageArg = process.argv.find(a => /^\d+$/.test(a));
const forcedPage = forcedPageArg ? Math.max(1, Math.min(TOTAL_PAGES, parseInt(forcedPageArg, 10))) : null;

const getListUrl = () => {
  const url = new URL(FILTER_URL);
  url.searchParams.set('page', String(forcedPage ?? randInt(1, TOTAL_PAGES)));
  return url.toString();
};

const maybeClickConsent = async (page) => {
  try {
    await page.evaluate(() => {
      document.getElementById('onetrust-accept-btn-handler')?.click();
      const btn = Array.from(document.querySelectorAll('button, a'))
        .find(b => /accept|agree|consent|got it/i.test(b?.textContent || ''));
      btn?.click();
    });
  } catch {}
};

const initialsFromName = (s) => {
  if (!s) return '';
  const parts = String(s).trim().split(/[^A-Za-z]+/).filter(Boolean);
  if (!parts.length) return '';
  return parts.map(w => w[0].toUpperCase()).join(' ');
};

const cleanComponents = (s) => {
  if (!s) return '';
  let t = String(s).trim();
  t = t.replace(/^\s*[*•]\s*-\s*/i, '').trim();
  if (t.startsWith('(') && t.endsWith(')')) t = t.slice(1, -1).trim();
  return t;
};

const loadHistory = () => {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
};

const saveHistory = (arr) => {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(arr.slice(0, MAX_HISTORY), null, 2)); } catch {}
};

const addToHistory = (hist, name, url) => {
  const entry = { name, url, ts: Date.now() };
  const dedup = hist.filter(h => h.url !== url);
  dedup.unshift(entry);
  if (dedup.length > MAX_HISTORY) dedup.length = MAX_HISTORY;
  saveHistory(dedup);
  return dedup;
};

(async () => {
  header('DDB Spell “Spellcheck!”');
  step(1, 8, 'Launching browser…');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=en-US,en'],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36');

  let history = loadHistory();

  try {
    step(2, 8, 'Opening listing page…');
    const listUrl = getListUrl();
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await maybeClickConsent(page);

    step(3, 8, 'Waiting for spell lists…');
    await page.waitForFunction(
      () => document.querySelectorAll('div.row.spell-name span.name a[href]').length > 0,
      { timeout: 30000 }
    );

    step(4, 8, 'Collecting spell links…');
    let spellLinks = await page.$$eval(
      'div.row.spell-name span.name a[href]',
      as => Array.from(new Set(as.map(a => a.href)))
    );
    if (!spellLinks.length) {
      console.log(red('No spells found. Exiting.'));
      rl.close();
      await browser.close();
      process.exit(0);
    }

    // Skip recently seen URLs
    const seen = new Set(history.map(h => h.url));
    const shuffled = spellLinks.sort(() => Math.random() - 0.5);
    let candidates = shuffled.filter(u => !seen.has(u));
    if (candidates.length === 0) {
      console.log(yellow(dim('[note] All links on this page were seen recently — allowing repeats.')));
      candidates = shuffled;
    } else {
      const skipped = shuffled.length - candidates.length;
      if (skipped > 0) console.log(dim(gray(`[skip] ${skipped} recently seen link(s)`)));
    }

    let data = null;
    let spellUrl = null;
    let attempt = 0;

    while (attempt < Math.min(MAX_ATTEMPTS, candidates.length) && !data) {
      spellUrl = candidates[attempt];
      attempt += 1;

      step(5, 8, `Opening random spell page… ${dim(`(attempt ${attempt}/${MAX_ATTEMPTS})`)}`);
      const sp = await browser.newPage();
      await sp.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36');

      const resp = await sp.goto(spellUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      await maybeClickConsent(sp);
      if (!resp || resp.status() >= 400) {
        console.log(yellow(`[warn] HTTP ${resp ? resp.status() : 'ERR'} — trying another spell.`));
        await sp.close();
        continue;
      }

      step(6, 8, 'Waiting for data elements to appear…');
      const targetSelectors = [
        'h1.page-title',
        '.components-blurb',
        '.ddb-statblock-item',
        '[class*="ddb-statblock-item-"]',
      ];
      const appeared = await sp
        .waitForFunction((sels) => sels.some(sel => !!document.querySelector(sel)), { timeout: STEP6_TIMEOUT_MS }, targetSelectors)
        .then(() => true)
        .catch(() => false);

      if (!appeared) {
        console.log(yellow('[warn] Timed out waiting — trying another spell.'));
        await sp.close();
        continue;
      }

      await delay(600);

      step(7, 8, 'Extracting spell info…');
      data = await sp.evaluate(() => {
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

        const name = text(document.querySelector('h1.page-title')) || text(document.querySelector('h1'));

        const findStat = (labelNeedle) => {
          const items = Array.from(document.querySelectorAll('.ddb-statblock-item, [class*="ddb-statblock-item-"]'));
          const needle = labelNeedle.toLowerCase();
          for (const item of items) {
            const labelEl =
              item.querySelector('.ddb-statblock-item-label') ||
              item.querySelector('strong, b, dt') ||
              item;
            const labelTxt = text(labelEl).toLowerCase();
            if (labelTxt.includes(needle)) {
              const valEl = item.querySelector('.ddb-statblock-item-value') || item.querySelector('dd') || item;
              const valTxt = text(valEl).replace(/^level\s*/i, '').replace(/^school\s*/i, '');
              if (valTxt) return valTxt;
            }
          }
          return '';
        };

        const level = findStat('level');
        const school = findStat('school');

        let components = text(document.querySelector('.more-info-content .components-blurb')) ||
                         text(document.querySelector('.components-blurb'));
        if (!components) {
          const label = Array.from(document.querySelectorAll('.ddb-statblock-item-label, strong, b, dt'))
            .find(el => /components/i.test(el.textContent || ''));
          if (label) {
            const item = label.closest('.ddb-statblock-item') || label.parentElement;
            const valEl = item?.querySelector('.ddb-statblock-item-value') || label.nextElementSibling;
            components = text(valEl) || '';
          }
        }

        return { name, level, school, components };
      });

      await sp.close();

      if (!data || !data.components) {
        console.log(yellow('[warn] Missing components — trying another spell.'));
        data = null;
      }
    }

    if (!data) {
      sep();
      console.log(red('No accessible spell found after 3 attempts. Exiting gracefully.'));
      sep();
      rl.close();
      await browser.close();
      process.exit(0);
    }

    // Update history with successful result
    history = addToHistory(history, data.name || '(unknown)', spellUrl);

    const cleanedComponents = cleanComponents(data.components);

    console.log();
    sep();
    console.log(`${bold(cyan('Components'))}\n  ${cleanedComponents}`);
    await pause('\nPress Enter to reveal level & school… ');
    console.log(`${bold(cyan('Level'))}\n  ${green(data.level || '')}`);
    console.log(`${bold(cyan('School'))}\n  ${green(data.school || '')}`);
    const initials = initialsFromName(data.name);
    if (initials) {
      await pause('\nPress Enter to the first letter(s) of the spell… ');
      console.log(`${bold(cyan('Hint'))}\n  ${yellow(`Initials: ${initials}`)}`);
    }
    await pause('\nPress Enter to reveal spell name… ');
    console.log(`${bold(cyan('Spell'))}\n  ${magenta(bold(data.name || ''))}`);
    sep();
    console.log();
    step(8, 8, green('Done'));
  } finally {
    rl.close();
    await browser.close();
  }
})();

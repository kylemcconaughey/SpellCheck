#!/usr/bin/env node
// ddb-spell-check-scraper.js
// Setup:
//   npm init -y && npm install puppeteer
// Run:
//   node ddb-spell-check-scraper.js        # random page 1–14
//   node ddb-spell-check-scraper.js 7      # force page 7

const puppeteer = require('puppeteer');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pause = (msg = '> ') => new Promise(res => rl.question(msg, () => res()));

const FILTER_URL = 'https://www.dndbeyond.com/spells?filter-material=t&filter-partnered-content=f&filter-search=&filter-source=1&filter-source=136&filter-source=3&filter-source=49&filter-source=62&filter-source=133&filter-source=111&filter-source=8&filter-source=5&filter-source=89&filter-source=2&filter-source=67&filter-source=104&filter-source=35&filter-source=27&page=1';
const TOTAL_PAGES = 14;
const MAX_ATTEMPTS = 3;       // total tries per run
const STEP6_TIMEOUT_MS = 5000; // 5s per your request

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

(async () => {
  console.log('[1/8] Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=en-US,en'],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36');

  try {
    console.log('[2/8] Opening listing page...');
    const listUrl = getListUrl();
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await maybeClickConsent(page);

    console.log('[3/8] Waiting for spell lists...');
    await page.waitForFunction(
      () => document.querySelectorAll('div.row.spell-name span.name a[href]').length > 0,
      { timeout: 30000 }
    );

    console.log('[4/8] Collecting spell links...');
    let spellLinks = await page.$$eval(
      'div.row.spell-name span.name a[href]',
      as => Array.from(new Set(as.map(a => a.href)))
    );
    if (!spellLinks.length) {
      console.log('No spells found. Exiting.');
      rl.close();
      await browser.close();
      process.exit(0);
    }
    // Shuffle so retries try different spells
    spellLinks = spellLinks.sort(() => Math.random() - 0.5);

    let data = null;
    let attempt = 0;

    while (attempt < Math.min(MAX_ATTEMPTS, spellLinks.length) && !data) {
      const spellUrl = spellLinks[attempt];
      attempt += 1;

      console.log(`[5/8] Opening random spell page... (attempt ${attempt}/${MAX_ATTEMPTS})`);
      const sp = await browser.newPage();
      await sp.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36');

      const resp = await sp.goto(spellUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      await maybeClickConsent(sp);
      if (!resp || resp.status() >= 400) {
        console.log(`[5a] HTTP ${resp ? resp.status() : 'ERR'} — trying another spell.`);
        await sp.close();
        continue;
      }

      console.log('[6/8] Waiting for data elements to appear...');
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
        console.log('[6a] Timed out waiting — trying another spell.');
        await sp.close();
        continue;
      }

      await delay(600);

      console.log('[7/8] Extracting spell info...');
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

      // If components missing, treat as failure and retry
      if (!data || !data.components) {
        console.log('[7a] Missing components — trying another spell.');
        data = null;
      }
    }

    if (!data) {
      console.log('-----');
      console.log('No accessible spell found after 3 attempts. Exiting.');
      console.log('-----');
      rl.close();
      await browser.close();
      process.exit(0);
    }

    const cleanedComponents = cleanComponents(data.components);

    console.log('\n-----');
    console.log(`Components: ${cleanedComponents}`);
    await pause('Press Enter to reveal level & school… ');
    console.log(data.level || '');
    console.log(data.school || '');
    const initials = initialsFromName(data.name);
    if (initials) {
      await pause('Press Enter to the first letter(s) of the spell… ');
      console.log(`Hint — initials: ${initials}`);
    }
    await pause('Press Enter to reveal spell name… ');
    console.log(data.name || '');
    console.log('-----\n');

    console.log('[8/8] Done');
  } finally {
    rl.close();
    await browser.close();
  }
})();

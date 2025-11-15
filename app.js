require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const puppeteer = require('puppeteer');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/gmaps_scraper';
const HEADLESS = (process.env.HEADLESS || 'true') === 'true';
const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';

const app = express();
app.use(express.static('public'));
app.use(bodyParser.json());

/* ---------- MongoDB schema ---------- */
const placeSchema = new mongoose.Schema({
    query: String,
    name: String,
    address: String,
    phone: String,
    website: String,
    rating: String,
    reviews: String,
    mapsUrl: String,
    scrapedAt: { type: Date, default: Date.now }
});
const Place = mongoose.model('Place', placeSchema);

/* ---------- Utility: sleep ---------- */
const sleep = ms => new Promise(res => setTimeout(res, ms));

/* ---------- Core scraping routine ---------- */
async function scrapeGoogleMaps(query, limit = 20) {
    const browser = await puppeteer.launch({
        headless: HEADLESS,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-geolocation',
        ],
        defaultViewport: { width: 1200, height: 900 },
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
        'X-Geo': '0 0'  // tells Google: "No location"
    });
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "geolocation", {
            value: {
                getCurrentPosition: () => { },
                watchPosition: () => { }
            }
        });
    });

    await page.setUserAgent(USER_AGENT);
    await page.setDefaultNavigationTimeout(60000);
    await page.setDefaultTimeout(60000);
    const fixedQuery = `${query}`;
    const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(fixedQuery)}?ucbcb=1&hl=en&authuser=0`;

    await page.goto(mapsUrl, { waitUntil: 'domcontentloaded' });

    await sleep(3000);

    async function scrollResultsAndCollect(limit) {
        const placeSelectors = new Set();

        const containerSelector = 'div[role="feed"]'; // Scroll container
        let previousCount = 0;
        let tries = 0;
        let currentScrollHeight = 0;

        while (placeSelectors.size < limit && tries < 50) {
            // Collect all visible links
            const anchors = await page.$$eval('a.hfpxzc', els => els.map(e => e.href));
            anchors.forEach(a => placeSelectors.add(a));

            // Scroll by a moderate amount and check the scroll height
            currentScrollHeight = await page.evaluate(selector => {
                const container = document.querySelector(selector);
                if (container) {
                    const scrollHeight = container.scrollHeight;
                    container.scrollBy(0, 1000); // Scroll down a bit
                    return scrollHeight;
                }
                return 0;
            }, containerSelector);

            // If scroll height doesn't change, break out of the loop (no more results)
            if (currentScrollHeight === previousCount) {
                tries++;
            } else {
                tries = 0;
            }

            previousCount = currentScrollHeight;

            // Shorter wait for new results to load
            await sleep(1000 + Math.random() * 400);
        }

        return Array.from(placeSelectors).slice(0, limit);
    }


    const placeLinks = await scrollResultsAndCollect(limit);

    const results = [];

    /* -------- Loop for each place -------- */
    await page.setRequestInterception(true);
            page.on('request', req => {
                const type = req.resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                    req.abort();
                } else {
                    req.continue();
                }
            });
    for (let i = 0; i < placeLinks.length; i++) {
        const link = placeLinks[i];
        try {
            
            await page.goto(link, { waitUntil: 'domcontentloaded' });
            console.log(`Scraping item ${i + 1}/${placeLinks.length}: ${link}`);
            await page.waitForSelector('h1.DUwDvf.lfPIob', { timeout: 4000 }).catch(() => { });

            /* ---------- SAFE TEXT EXTRACTOR ---------- */
            const safeTextCode = `
                (el) => (el && el.innerText) ? el.innerText.trim() : null
            `;

            /* ---------- NAME ---------- */
            const name = await page.evaluate(() => {
                const safe = el => (el && el.innerText) ? el.innerText.trim() : null;
                const n =
                    document.querySelector('h1.DUwDvf.lfPIob') ||
                    document.querySelector('h2.section-hero-header-title-title');
                return safe(n);
            });

            /* ---------- ADDRESS ---------- */
            const address = await page.evaluate(() => {
                const safe = el => (el && el.innerText) ? el.innerText.trim() : null;
                const selectors = ['div.Io6YTe.fontBodyMedium.kR99db.fdkmkc'];

                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    const t = safe(el);
                    if (t) return t;
                }

                const metaAddress = document.querySelector('meta[itemprop="address"]');
                return metaAddress ? metaAddress.getAttribute('content') : null;
            });

            /* ---------- PHONE ---------- */
            const phone = await page.evaluate(() => {
                const safe = el => (el && el.innerText) ? el.innerText.trim() : null;
                const phoneEls = Array
                    .from(document.querySelectorAll('div.Io6YTe.fontBodyMedium.kR99db.fdkmkc, a[href^="tel:"], span[jsaction]'))
                    .filter(el => (el.innerText || '').match(/\+?\d[\d\-\s\(\)]{6,}/));

                if (phoneEls.length) return safe(phoneEls[0]);

                const tel = document.querySelector('a[href^="tel:"]');
                if (tel) return safe(tel) || tel.href.replace('tel:', '');
                return null;
            });

            /* ---------- WEBSITE (FIXES YOUR CRASH) ---------- */
            const website = await page.evaluate(() => {
                const safe = el => (el && el.innerText) ? el.innerText.trim() : null;

                const blocks = Array.from(document.querySelectorAll('div.Io6YTe.fontBodyMedium.kR99db.fdkmkc'))
                    .map(el => safe(el))
                    .filter(x => x && x.includes('.'));

                if (blocks.length) return blocks[0];

                const btn = Array.from(document.querySelectorAll('a, button'))
                    .find(el => (el.innerText || '').toLowerCase().includes('website'));

                if (btn && btn.href) return btn.href;

                return null;
            });

            /* ---------- RATING + REVIEWS ---------- */
            const { rating, reviews } = await page.evaluate(() => {
                const safe = el => (el && el.innerText) ? el.innerText.trim() : null;

                let rating = null;
                let reviews = null;

                const r =
                    document.querySelector('div[aria-label*="stars"], span[class*="rating"]') ||
                    document.querySelector('[role="img"][aria-label*="stars"]');

                if (r) {
                    const al = r.getAttribute && r.getAttribute('aria-label');
                    if (al) {
                        const m = al.match(/([\d\.]+)\s*stars?/i);
                        if (m) rating = m[1];
                    } else {
                        const txt = safe(r);
                        const m = txt && txt.match(/[\d\.]+/);
                        if (m) rating = m[0];
                    }
                }

                const rev = Array.from(document.querySelectorAll('button, span'))
                    .find(el =>
                        (el.innerText || '').match(/[\d,]+\s*reviews?/i) ||
                        (el.getAttribute && (el.getAttribute('aria-label') || '').match(/\d+\s+reviews?/i))
                    );

                if (rev) {
                    const src = safe(rev) || rev.getAttribute('aria-label') || '';
                    const m = src.match(/([\d,]+)\s*reviews?/i);
                    if (m) reviews = m[1].replace(/,/g, '');
                }

                return { rating, reviews };
            });

            /* ---------- PUSH RESULT ---------- */
            const item = {
                query,
                name: name || null,
                address: address || null,
                phone: phone || null,
                website: website || null,
                rating: rating || null,
                reviews: reviews || null,
                mapsUrl: link
            };

            results.push(item);

            await sleep(1000 + Math.floor(Math.random() * 1200));

        } catch (err) {
            console.error('Error scraping item', link, err.message);
        }
    }

    await browser.close();
    return results;
}

/* ---------- API endpoint ---------- */
app.get('/scrape', async (req, res) => {
    const query = req.query.query;
    if (!query) return res.status(400).json({ error: 'query param required, e.g. ?query=coffee+shop+London' });

    const limit = Math.min(1000, Number(req.query.limit) || 20);
    try {
        const scraped = await scrapeGoogleMaps(query, limit);

        const ops = scraped.map(d => ({
            updateOne: {
                filter: { mapsUrl: d.mapsUrl || d.name },
                update: { $set: d },
                upsert: true
            }
        }));

        if (ops.length) {
            await Place.bulkWrite(ops);
        }

        return res.json({ query, count: scraped.length, results: scraped });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message || 'scrape-failed' });
    }
});

/* ---------- Start server ---------- */
async function start() {
    try {
        await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
        console.log('Connected to MongoDB');
        app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
    } catch (err) {
        console.error('MongoDB connection failed:', err);
        process.exit(1);
    }
}
start();

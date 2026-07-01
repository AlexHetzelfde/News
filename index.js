/**
 * Briefing — cron worker
 *
 * Draait elke 10 minuten (zie wrangler.toml). Haalt alle feeds op,
 * vertaalt nieuwe artikelen naar het Nederlands (behalve wat al NL is),
 * genereert bullet points per artikel, clustert daarna op de vertaalde
 * titels, en schrijft één samengevatte JSON-blob naar KV.
 *
 * De frontend praat nooit meer rechtstreeks met feeds of Gemini — die
 * leest alleen de kant-en-klare "latest"-blob via een Pages Function.
 */

const FEEDS = [
  { url: 'https://feeds.bbci.co.uk/news/rss.xml?edition=uk', name: 'BBC', lang: 'en', type: 'news' },
  { url: 'https://feeds.nos.nl/nosnieuwsbinnenland', name: 'NOS', lang: 'nl', type: 'news' },
  { url: 'https://feeds.nos.nl/nosnieuwsalgemeen', name: 'NOS', lang: 'nl', type: 'news' },
  { url: 'https://www.nrk.no/nyheter/siste.rss', name: 'NRK', lang: 'no', type: 'news' },
  { url: 'https://www.reddit.com/r/ukraine/.rss', name: 'r/ukraine', lang: 'en', type: 'reddit' },
  { url: 'https://www.reddit.com/r/Military/.rss', name: 'r/Military', lang: 'en', type: 'reddit' },
  { url: 'https://www.reddit.com/r/UkrainianConflict/.rss', name: 'r/UkrainianConflict', lang: 'en', type: 'reddit' },
  { url: 'https://www.reddit.com/r/worldnews/.rss', name: 'r/worldnews', lang: 'en', type: 'reddit' },
];

const ARTICLE_TTL_SECONDS = 60 * 60 * 48; // 48u — na 2 dagen is een artikel niet meer relevant

const STOPWORDS = new Set([
  'de','het','een','van','in','is','op','te','dat','zijn','ook','niet','hij','ze','we','aan',
  'er','als','bij','dan','die','dit','door','maar','met','nog','om','over','uit','voor','wordt',
  'zich','naar','geen','meer','heeft','worden','werd','waren','haar','hun','kunnen','moet','gaat',
  'jaar','twee','drie','onder','tussen','zonder',
]);

const GENERIC_TOPIC_WORDS = new Set([
  'wekdienst','school','scholen','waarschuwt','waarschuwing','dood','overleden','politie',
  'rechter','jaar','jaren','week','weken','dag','dagen','plan','plannen','hulp','ster','sterren',
  'nieuws','leven','gezin','familie','tegen','nederland','nederlandse','regering','minister','kabinet',
]);

// ── FEED PARSING ─────────────────────────────────────────────────────────
async function fetchFeed(feed) {
  try {
    const resp = await fetch(feed.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BriefingBot/1.0)' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const xml = await resp.text();
    return parseFeedXml(xml, feed);
  } catch (e) {
    console.warn(`[feed fail] ${feed.name}: ${e.message}`);
    return [];
  }
}

function stripTags(html) {
  return (html || '').replace(/<[^>]+>/g, '').trim();
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function parseFeedXml(xml, feed) {
  const isAtom = xml.includes('<feed');
  const itemTag = isAtom ? 'entry' : 'item';
  const items = xml.split(`<${itemTag}`).slice(1);

  return items.map((chunk) => {
    chunk = chunk.split(`</${itemTag}>`)[0];

    const titleMatch = chunk.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const title = decodeEntities(stripTags(titleMatch ? titleMatch[1] : '')).replace('<![CDATA[', '').replace(']]>', '').trim();

    let link = '';
    if (isAtom) {
      const linkMatch = chunk.match(/<link[^>]+href=["']([^"']+)["']/);
      link = linkMatch ? linkMatch[1] : '';
    } else {
      const linkMatch = chunk.match(/<link>([\s\S]*?)<\/link>/);
      link = linkMatch ? linkMatch[1].trim() : '';
    }

    const dateMatch = chunk.match(/<(?:pubDate|updated)>([\s\S]*?)<\/(?:pubDate|updated)>/);
    const date = dateMatch ? new Date(dateMatch[1].trim()) : new Date();

    const descMatch = chunk.match(/<(?:description|summary|content)[^>]*>([\s\S]*?)<\/(?:description|summary|content)>/);
    const snippet = decodeEntities(stripTags(descMatch ? descMatch[1] : '')).replace('<![CDATA[', '').replace(']]>', '').slice(0, 300);

    return {
      title, link, date: date.toISOString(), snippet,
      source: feed.name, lang: feed.lang, type: feed.type,
    };
  }).filter(a => a.title && a.link);
}

// ── KEYWORDS + CLUSTERING (werkt nu op vertaalde NL-titels) ────────────────
function keywords(text) {
  return [...new Set(
    text.toLowerCase()
      .replace(/[^a-z\u00C0-\u024F\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOPWORDS.has(w))
  )];
}

function clusterArticles(articles) {
  const news = articles.filter(a => a.type === 'news');
  const kwLists = news.map(a => keywords(a.title_nl || a.title));
  const n = news.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const shared = kwLists[i].filter(w => kwLists[j].includes(w));
      if (!shared.length) continue;
      const hasSpecific = shared.some(w => !GENERIC_TOPIC_WORDS.has(w));
      if (hasSpecific || shared.length >= 2) union(i, j);
    }
  }

  const groups = {};
  for (let i = 0; i < n; i++) {
    const r = find(i);
    (groups[r] = groups[r] || []).push(i);
  }

  const clusters = [];
  const remaining = [];
  Object.values(groups).forEach((idxs) => {
    if (idxs.length < 2) { remaining.push(news[idxs[0]]); return; }
    const arts = idxs.map(i => news[i]);
    const bestTitle = arts.reduce((b, a) => (a.title_nl || a.title).length > (b.title_nl || b.title).length ? a : b);
    clusters.push({ title: bestTitle.title_nl || bestTitle.title, articles: arts });
  });

  return { clusters: clusters.sort((a, b) => b.articles.length - a.articles.length), remaining };
}

// ── GEMINI: vertalen + bullets in één call ──────────────────────────────
async function translateAndBullet(article, env) {
  const prompt = `Je krijgt een Engelse of Noorse nieuwstitel en een korte omschrijving. Doe twee dingen:
1. Vertaal titel en omschrijving letterlijk en accuraat naar het Nederlands. Verzin niets, voeg geen duiding toe.
2. Geef 2-3 bullet points (max 12 woorden per bullet) met de belangrijkste feiten uit de omschrijving, in het Nederlands.

Titel: ${article.title}
Omschrijving: ${article.snippet}

Antwoord ALLEEN met geldig JSON, geen markdown, geen uitleg:
{"title_nl": "...", "snippet_nl": "...", "bullets": ["...", "..."]}`;

  try {
    const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const data = await resp.json();
    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    text = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    return {
      title_nl: parsed.title_nl || article.title,
      snippet_nl: parsed.snippet_nl || article.snippet,
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 3) : [],
    };
  } catch (e) {
    console.warn(`[vertaal fail] ${article.link}: ${e.message}`);
    // Val terug op origineel — beter een onvertaald artikel tonen dan niets
    return { title_nl: article.title, snippet_nl: article.snippet, bullets: [] };
  }
}

async function bulletsOnly(article, env) {
  const prompt = `Geef 2-3 bullet points (max 12 woorden per bullet) met de belangrijkste feiten uit deze Nederlandse nieuwsomschrijving. Verzin niets.

Titel: ${article.title}
Omschrijving: ${article.snippet}

Antwoord ALLEEN met geldig JSON: {"bullets": ["...", "..."]}`;

  try {
    const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const data = await resp.json();
    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    text = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    return { bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 3) : [] };
  } catch (e) {
    console.warn(`[bullets fail] ${article.link}: ${e.message}`);
    return { bullets: [] };
  }
}

// ── HOOFDLOGICA ──────────────────────────────────────────────────────────
async function runCycle(env) {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const all = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));

  const seen = new Set();
  const deduped = all.filter(a => {
    if (seen.has(a.link)) return false;
    seen.add(a.link);
    return true;
  });

  // Alleen artikelen verwerken die we nog niet in KV hebben (voorkomt
  // herhaald vertalen/bulleten van dezelfde artikelen elke 10 minuten)
  const processed = [];
  for (const article of deduped) {
    const key = `article:${await hashUrl(article.link)}`;
    const cached = await env.BRIEFING_KV.get(key, 'json');

    if (cached) {
      processed.push({ ...article, ...cached });
      continue;
    }

    let extra;
    if (article.lang === 'nl') {
      extra = await bulletsOnly(article, env);
      extra.title_nl = article.title;
      extra.snippet_nl = article.snippet;
    } else {
      extra = await translateAndBullet(article, env);
    }

    await env.BRIEFING_KV.put(key, JSON.stringify(extra), { expirationTtl: ARTICLE_TTL_SECONDS });
    processed.push({ ...article, ...extra });
  }

  const news = processed.filter(a => a.type === 'news');
  const reddit = processed.filter(a => a.type === 'reddit');
  const { clusters, remaining } = clusterArticles(news);

  const latest = {
    generated_at: new Date().toISOString(),
    recent: news.sort((a, b) => new Date(b.date) - new Date(a.date)),
    clusters,
    remaining,
    media: reddit,
  };

  await env.BRIEFING_KV.put('latest', JSON.stringify(latest));
  console.log(`Cyclus klaar: ${news.length} nieuws, ${clusters.length} clusters, ${reddit.length} media, ${deduped.length - processed.filter(p=>p._fromCache).length} nieuw vertaald`);
}

async function hashUrl(url) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCycle(env));
  },
  // Handmatig triggeren voor testen: bezoek de worker-URL direct
  async fetch(request, env) {
    await runCycle(env);
    return new Response('Cyclus uitgevoerd — check /latest via je Pages Function', { status: 200 });
  },
};

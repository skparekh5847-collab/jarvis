require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'jarvis-secret-change-me',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 86400000 }
}));

// ── Google OAuth ──
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`
);

// ── Cache ──
let cache = {};
const CACHE_FILE = path.join(__dirname, 'cache.json');
function loadCache() { try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch(e) { cache = {}; } }
function saveCache() { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch(e) {} }
loadCache();

// ── Helpers ──
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function cleanText(t) {
  return t.replace(/\(listen\)/gi,'').replace(/\([^)]*(?:figure|fig\.|citation needed|pronounced)[^)]*\)/gi,'')
    .replace(/^this article is about[^.]*\.\s*/i,'').replace(/^for other uses[^.]*\.\s*/i,'')
    .replace(/\s+/g,' ').trim();
}

function sentences(t, n) {
  const s = t.match(/[^.!?]+[.!?]+/g) || [t];
  return s.slice(0, n).join(' ').trim();
}

function findSection(text, kws) {
  const paras = text.split(/\n\n+/);
  for (const p of paras) {
    if (kws.some(k => p.toLowerCase().includes(k))) return p.substring(0, 600);
  }
  return null;
}

function extractProcess(text, max) {
  max = max || 400;
  const kws = ['works by','involves','process','step','then','first','next','uses','utilizes','operates','mechanism','functions'];
  const s = text.match(/[^.!?]+[.!?]+/g) || [];
  const rel = s.filter(x => kws.some(k => x.toLowerCase().includes(k)));
  return (rel.length ? rel.join(' ') : s.slice(0,3).join(' ')).substring(0, max);
}

// ── Intent Parser ──
function parseIntent(input) {
  const l = input.toLowerCase().trim();
  if (/^what time/i.test(l)) return { type:'quick', answer:`It's currently ${new Date().toLocaleTimeString()}.` };
  if (/^what date|what day/i.test(l)) return { type:'quick', answer:`Today is ${new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}.` };
  if (/^(hi|hello|hey|greetings|good morning|good evening)/i.test(l)) return { type:'greeting' };
  if (/^(thanks|thank you|thx)/i.test(l)) return { type:'thanks' };
  if (/^(bye|goodbye|see you)/i.test(l)) return { type:'farewell' };
  if (/what can you do|capabilities/i.test(l)) return { type:'capability' };
  if (/who are you|what are you|your name/i.test(l)) return { type:'identity' };
  if (/joke|funny|make me laugh/i.test(l)) return { type:'joke' };
  if (/status|systems|diagnostic/i.test(l)) return { type:'status' };

  // Compare patterns
  const cmpP = [
    /compare\s+(.+?)\s+(?:and|vs|versus|with)\s+(.+)/i,
    /(.+?)\s+(?:vs|versus)\s+(.+)/i,
    /difference between\s+(.+?)\s+and\s+(.+)/i
  ];
  for (const p of cmpP) { const m = l.match(p); if (m) return { type:'compare', subjects:[m[1].trim(),m[2].trim()] }; }

  // Question type detection
  let qt = 'explain';
  if (/^how /i.test(l)) qt = 'how';
  else if (/^what (is|are|was|were)/i.test(l)) qt = 'what';
  else if (/^why /i.test(l)) qt = 'why';
  else if (/^who /i.test(l)) qt = 'who';
  else if (/^when /i.test(l)) qt = 'when';
  else if (/^where /i.test(l)) qt = 'where';
  else if (/^list|give me|tell me all/i.test(l)) qt = 'list';

  // Extract subject
  let subj = l.replace(/^(can you |could you |please |hey |jarvis )/i,'').replace(/\?$/,'').trim();
  subj = subj.replace(/^(what is|what are|what was|what were|how does|how do|how did|how can|why does|why do|why is|why are|who is|who are|who was|when was|when is|when did|where is|where are|tell me about|explain|describe|list|give me|compare)\s+/i,'').trim();

  return { type:'research', questionType:qt, subject:subj, original:input };
}

// ── Answer Composer ──
function composeAnswer(intent, wikiData, ddgData) {
  if (!wikiData && !ddgData) return 'I couldn\'t find specific data on that. Try rephrasing or check spelling.';
  const text = wikiData?.extract || '';
  const qt = intent.questionType || 'what';
  let ans = '';
  if (qt === 'how') {
    const s = findSection(text,['mechanism','process','works by','operates','functions by','principle','method','operation','technology','design','architecture']);
    ans = s ? cleanText(s) : extractProcess(text);
  } else if (qt === 'why') {
    const s = findSection(text,['because','reason','cause','due to','result of','motivation','led to','driven by','purpose']);
    ans = s ? cleanText(s) : sentences(text,4);
  } else if (qt === 'who') { ans = sentences(text,5); }
  else if (qt === 'list') {
    const lines = text.split('\n').filter(l => l.trim().length > 20);
    ans = lines.slice(0,8).join('\n\n');
  } else { ans = sentences(text,5); }
  if (!ans && ddgData?.abstract) ans = ddgData.abstract;
  if (!ans) ans = sentences(text,4);
  return ans.trim() || 'Data retrieved but couldn\'t extract a clean summary. Check the detail panels.';
}

// ── Wikipedia ──
async function wikiSearch(query) {
  const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json&origin=*&srlimit=6`);
  const d = await r.json();
  return (d.query?.search||[]).map(s => ({ title:s.title, snippet:s.snippet.replace(/<[^>]+>/g,'') }));
}

async function wikiExtract(title) {
  const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=extracts|info&explaintext=1&exintro=0&inprop=url&format=json&origin=*`);
  const d = await r.json();
  const pages = d.query?.pages; if (!pages) return null;
  const p = Object.values(pages)[0]; if (p.missing) return null;
  return { title:p.title, extract:cleanText(p.extract||''), url:p.fullurl };
}

async function wikiRelated(title) {
  try {
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/related/${encodeURIComponent(title)}`);
    const d = await r.json();
    return (d.pages||[]).slice(0,6).map(p => p.title);
  } catch(e) { return []; }
}

// ── DuckDuckGo ──
async function ddgQuery(query) {
  try {
    const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`);
    const d = await r.json();
    if (d.Abstract || d.Answer) return { abstract:d.Abstract, answer:d.Answer, source:d.AbstractSource||'DuckDuckGo', url:d.AbstractURL||'' };
    return null;
  } catch(e) { return null; }
}

// ── Panel Builders ──
function buildPanels(answer, wikiData, related) {
  const panels = [];

  panels.push({ type:'summary', title:'Direct Answer', icon:'fa-bolt',
    content:`<div class="summary-text">${esc(answer)}</div>` });

  if (wikiData?.extract) {
    const sents = wikiData.extract.match(/[^.!?]+[.!?]+/g)||[];
    const pts = sents.slice(0,6).map(s => `<div class="key-point">${esc(s.trim())}</div>`).join('');
    if (pts) panels.push({ type:'keypoints', title:'Key Points', icon:'fa-list-check', content:pts });
  }

  if (wikiData?.extract) {
    const lines = wikiData.extract.split('\n').filter(l => l.trim());
    let cur = 'Overview', sections = { Overview:[] };
    lines.forEach(l => {
      if (l.length < 80 && !l.endsWith('.') && !l.endsWith(',')) { cur = l.trim(); sections[cur] = []; }
      else if (sections[cur]) sections[cur].push(l.trim());
    });
    let html = '';
    Object.entries(sections).forEach(([t,c]) => {
      if (!c.length) return;
      html += `<div class="detail-section"><h4 class="section-toggle"><i class="fas fa-chevron-right"></i>${esc(t)}</h4><div class="detail-content">${esc(c.join(' ').substring(0,1500))}</div></div>`;
    });
    if (html) panels.push({ type:'details', title:'Deep Dive', icon:'fa-microscope', content:html });
  }

  if (related?.length) {
    panels.push({ type:'related', title:'Related Topics', icon:'fa-project-diagram',
      content: related.map(t => `<span class="tag" data-topic="${esc(t)}">${esc(t)}</span>`).join('') });
  }

  return panels;
}

function buildComparePanels(wA, wB) {
  const a = wA?.extract || 'No data found.';
  const b = wB?.extract || 'No data found.';
  return [{ type:'compare', title:'Comparison', icon:'fa-arrows-left-right',
    content:`<div class="compare-grid"><div class="compare-col"><h4>${esc(wA?.title||'Topic A')}</h4><div style="font-size:13px;line-height:1.7;color:var(--muted)">${esc(cleanText(sentences(a,5)))}</div></div><div class="compare-col"><h4>${esc(wB?.title||'Topic B')}</h4><div style="font-size:13px;line-height:1.7;color:var(--muted)">${esc(cleanText(sentences(b,5)))}</div></div></div>` }];
}

// ═══════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════

app.get('/api/auth/status', (req, res) => {
  res.json({ connected: !!req.session.tokens });
});

app.get('/api/auth/url', (req, res) => {
  const url = oauth2Client.generateAuthUrl({ access_type:'offline', scope:['https://www.googleapis.com/auth/drive.file'], prompt:'consent' });
  res.json({ url });
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?auth_error=' + encodeURIComponent(error));
  try {
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    res.redirect('/?auth_success=1');
  } catch(e) {
    console.error('Token error:', e.message);
    res.redirect('/?auth_error=token_failed');
  }
});

app.post('/api/auth/disconnect', (req, res) => {
  req.session.tokens = null;
  res.json({ ok:true });
});

app.post('/api/research', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error:'No query' });

  const intent = parseIntent(query);

  // Quick replies
  const quickMap = {
    greeting: ['At your service. What do you need?','Ready. What are we looking into?','Online. Fire away.'],
    thanks: ['My pleasure.'],
    farewell: ['Standing by. Available when you need me.'],
    capability: ['I fetch live data from Wikipedia and DuckDuckGo based on your intent. I understand how/what/why/who/when/where questions, handle comparisons, and drill deeper on follow-up. Connect Google Drive to save findings.'],
    identity: ['I am J.A.R.V.I.S. — a live research assistant running on a Node.js backend. I pull real-time data, understand context, and store findings to your Google Drive.'],
    joke: ['Why do programmers prefer dark mode? Because light attracts bugs.','A SQL query walks into a bar, sees two tables, and asks: can I join you?','There are 10 types of people: those who get binary and those who don\'t.'],
    status: [`All systems nominal. Drive ${req.session.tokens?'connected':'offline'}. Cache: ${Object.keys(cache).length} entries.`]
  };

  if (quickMap[intent.type]) {
    const arr = quickMap[intent.type];
    return res.json({ type:'quick', answer: arr[Math.floor(Math.random()*arr.length)] });
  }
  if (intent.type === 'quick') return res.json({ type:'quick', answer:intent.answer });

  try {
    if (intent.type === 'compare') {
      const [sa, sb] = intent.subjects;
      const [wA, wB] = await Promise.all([wikiExtract(sa), wikiExtract(sb)]);
      const [dA, dB] = await Promise.all([ddgQuery(sa), ddgQuery(sb)]);
      const [sA, sB] = await Promise.all([wikiSearch(sa), wikiSearch(sb)]);
      const [rA, rB] = await Promise.all([wA?wikiRelated(wA.title):[], wB?wikiRelated(wB.title):[]]);

      const panels = [...buildComparePanels(wA, wB)];
      if (wA?.extract) panels.push(...buildPanels('', wA, []));
      if (wB?.extract) panels.push(...buildPanels('', wB, []));
      const allRel = [...new Set([...rA,...rB])].slice(0,8);
      if (allRel.length) panels.push({ type:'related', title:'Related Topics', icon:'fa-project-diagram', content:allRel.map(t=>`<span class="tag" data-topic="${esc(t)}">${esc(t)}</span>`).join('') });

      const sources = [];
      if (wA) sources.push({ type:'Wikipedia', title:wA.title, url:wA.url });
      if (wB) sources.push({ type:'Wikipedia', title:wB.title, url:wB.url });
      if (dA?.abstract) sources.push({ type:'DuckDuckGo', title:dA.source||'DDG', snippet:dA.abstract.substring(0,120), url:dA.url });
      if (dB?.abstract) sources.push({ type:'DuckDuckGo', title:dB.source||'DDG', snippet:dB.abstract.substring(0,120), url:dB.url });
      sA.forEach(s => sources.push({ type:'Wiki Search', title:s.title, snippet:s.snippet, url:`https://en.wikipedia.org/wiki/${encodeURIComponent(s.title)}` }));
      sB.forEach(s => sources.push({ type:'Wiki Search', title:s.title, snippet:s.snippet, url:`https://en.wikipedia.org/wiki/${encodeURIComponent(s.title)}` }));

      const topic = sa + ' vs ' + sb;
      cache[topic.toLowerCase()] = { answer:'Comparison complete', timestamp:Date.now() };
      saveCache();
      return res.json({ type:'compare', topic, panels, sources, answer:`Here's the comparison between ${wA?.title||sa} and ${wB?.title||sb}.` });

    } else {
      const subject = intent.subject;
      const [wikiResults, ddgResult] = await Promise.all([wikiSearch(subject), ddgQuery(subject)]);

      let wikiData = null;
      if (wikiResults.length > 0) {
        let best = wikiResults[0].title;
        if (ddgResult?.abstract) {
          const m = wikiResults.find(w => w.title.toLowerCase() === (ddgResult.AbstractSource||'').toLowerCase());
          if (m) best = m.title;
        }
        wikiData = await wikiExtract(best);
      }

      const answer = composeAnswer(intent, wikiData, ddgResult);
      const related = wikiData ? await wikiRelated(wikiData.title) : [];
      const panels = buildPanels(answer, wikiData, related);

      const sources = [];
      if (wikiData) sources.push({ type:'Wikipedia', title:wikiData.title, url:wikiData.url });
      if (ddgResult?.abstract) sources.push({ type:'DuckDuckGo', title:ddgResult.source||'DDG', snippet:ddgResult.abstract.substring(0,120), url:ddgResult.url });
      wikiResults.slice(0,4).forEach(s => sources.push({ type:'Wiki Search', title:s.title, snippet:s.snippet, url:`https://en.wikipedia.org/wiki/${encodeURIComponent(s.title)}` }));

      cache[subject.toLowerCase()] = { answer, timestamp:Date.now() };
      saveCache();
      return res.json({ type:'research', topic:subject, panels, sources, answer });
    }
  } catch(e) {
    console.error('Research error:', e.message);
    res.status(500).json({ error:'Research failed: ' + e.message });
  }
});

app.post('/api/save', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error:'Not connected' });
  const { topic, answer, wikiData, ddgData, sources } = req.body;

  try {
    oauth2Client.setCredentials(req.session.tokens);
    const drive = google.drive({ version:'v3', auth:oauth2Client });

    // Find/create root folder
    let rootList = await drive.files.list({ q:"name='JARVIS Research' and mimeType='application/vnd.google-apps.folder' and trashed=false", fields:'files(id)' });
    let rootId = rootList.data.files[0]?.id;
    if (!rootId) { const c = await drive.files.create({ requestBody:{ name:'JARVIS Research', mimeType:'application/vnd.google-apps.folder' }, fields:'id' }); rootId = c.data.id; }

    // Find/create topic folder
    const safe = (topic||'untitled').replace(/[\/\\?%*:|"<>]/g,'-').substring(0,100);
    let topicList = await drive.files.list({ q:`name='${safe.replace(/'/g,"\\'")}' and mimeType='application/vnd.google-apps.folder' and '${rootId}' in parents and trashed=false`, fields:'files(id)' });
    let topicId = topicList.data.files[0]?.id;
    if (!topicId) { const c = await drive.files.create({ requestBody:{ name:safe, mimeType:'application/vnd.google-apps.folder', parents:[rootId] }, fields:'id' }); topicId = c.data.id; }

    // Build markdown report
    let md = `# Research: ${topic}\n**Date:** ${new Date().toLocaleString()}\n**Sources:** Wikipedia, DuckDuckGo\n\n---\n\n## Summary\n${answer}\n\n`;
    if (wikiData?.extract) md += `\n## Full Article: ${wikiData.title}\n${wikiData.extract}\n\n`;
    if (ddgData?.abstract) md += `\n## DuckDuckGo\n${ddgData.abstract}\n\n`;
    if (sources?.length) md += `\n## Sources\n${sources.map(s=>`- [${s.title}](${s.url||''})`).join('\n')}\n\n`;
    md += `\n---\n*Generated by J.A.R.V.I.S.*`;

    await drive.files.create({
      requestBody: { name:`${safe} — Report.md`, mimeType:'text/plain', parents:[topicId] },
      media: { mimeType:'text/plain', body:Buffer.from(md,'utf-8') },
      fields: 'id'
    });

    res.json({ ok:true, message:`Saved to JARVIS Research / ${safe} /` });
  } catch(e) {
    if (e.code === 401 && req.session.tokens?.refresh_token) {
      try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        req.session.tokens = credentials;
        return res.status(401).json({ error:'Token refreshed, try saving again' });
      } catch(e2) { req.session.tokens = null; }
    }
    console.error('Drive error:', e.message);
    res.status(500).json({ error:'Save failed: '+e.message });
  }
});

app.get('/api/cache/stats', (req, res) => {
  res.json({ count:Object.keys(cache).length, topics:Object.keys(cache) });
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║    J.A.R.V.I.S. Server Running        ║`);
  console.log(`  ║    http://localhost:${PORT}               ║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
});

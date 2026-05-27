require('dotenv').config();

const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY });

// ─── Sessions & monitoring ───────────────────────────────────────────────────
const sessions = {};
const monitoring = {};

function sess(chatId) {
  if (!sessions[chatId]) sessions[chatId] = { matches: [], budget: null };
  return sessions[chatId];
}

// ─── ESPN — toutes les ligues foot ───────────────────────────────────────────
const ALL_ESPN_LEAGUES = [
  // Europe top
  "eng.1","eng.2","eng.3","eng.fa","eng.league_cup",
  "esp.1","esp.2","esp.copa_del_rey",
  "ger.1","ger.2","ger.3",
  "fra.1","fra.2","fra.coupe_de_france",
  "ita.1","ita.2","ita.coppa_italia",
  "por.1","por.2",
  "ned.1","ned.2",
  "bel.1","bel.2",
  "sco.1","sco.2",
  "tur.1","tur.2",
  "gre.1",
  "rus.1",
  "ukr.1",
  "aut.1",
  "sui.1",
  "den.1",
  "nor.1",
  "swe.1",
  "cze.1",
  "pol.1",
  "rom.1",
  "srb.1",
  "cro.1",
  "hun.1",
  "svk.1",
  "bul.1",
  // UEFA
  "uefa.champions",
  "uefa.europa",
  "uefa.europa.conf",
  "uefa.nations",
  // Amériques
  "conmebol.libertadores",
  "conmebol.sudamericana",
  "conmebol.recopa",
  "arg.1","arg.2",
  "bra.1","bra.2","bra.copa_do_brasil",
  "col.1","col.2",
  "chi.1","chi.2",
  "uru.1",
  "per.1",
  "ecu.1",
  "bol.1",
  "ven.1",
  "par.1",
  "mex.1","mex.2","mex.copa_mx",
  "usa.1","usa.2","usa.open",
  "concacaf.champions","concacaf.league",
  // Asie / Moyen-Orient
  "jpn.1","jpn.2",
  "kor.1",
  "chn.1",
  "sau.1",
  "qat.1",
  "uae.sl",
  "isr.1",
  // Afrique / Océanie
  "rsa.1",
  "egy.1",
  "mar.1",
  "caf.champions",
  // FIFA
  "fifa.worldcup",
  "fifa.worldq.conmebol",
  "fifa.worldq.uefa",
  "fifa.worldq.concacaf",
  "fifa.worldq.afc",
  "fifa.worldq.caf",
];

async function espnFetch(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return r.json();
}

// Cherche un match dans TOUTES les ligues ESPN en parallèle
async function findEspnMatch(team1, team2) {
  const t1 = team1.toLowerCase().split(" ")[0];
  const t2 = team2.toLowerCase().split(" ")[0];

  const results = await Promise.allSettled(
    ALL_ESPN_LEAGUES.map(async (league) => {
      const data = await espnFetch(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard`
      );
      for (const ev of data.events || []) {
        const comps = ev.competitions?.[0]?.competitors || [];
        const names = comps.map(c => c.team?.displayName?.toLowerCase() || "");
        const match1 = names.some(n => n.includes(t1) || t1.includes(n.split(" ")[0]));
        const match2 = names.some(n => n.includes(t2) || t2.includes(n.split(" ")[0]));
        if (match1 && match2) return { eventId: ev.id, league, event: ev };
      }
      return null;
    })
  );

  for (const r of results) {
    if (r.status === "fulfilled" && r.value) return r.value;
  }
  return null;
}

// Parse les stats ESPN d'un event
async function getEspnStats(league, eventId) {
  const summary = await espnFetch(
    `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/summary?event=${eventId}`
  );
  try {
    const comp = summary.header?.competitions?.[0];
    const comps = comp?.competitors || [];
    const home = comps.find(c => c.homeAway === "home");
    const away = comps.find(c => c.homeAway === "away");
    const clock = comp?.status?.displayClock || "?";
    const period = comp?.status?.period || 1;
    const statusName = comp?.status?.type?.name || "";

    // Si match pas encore commencé ou terminé
    if (["STATUS_SCHEDULED", "STATUS_FINAL", "STATUS_FULL_TIME"].includes(statusName)) {
      return { notStarted: statusName === "STATUS_SCHEDULED", finished: statusName.includes("FINAL") || statusName.includes("FULL") };
    }

    const getStat = (team, key) => {
      const s = (team?.statistics || []).find(x => x.name?.toLowerCase().includes(key));
      return s?.displayValue || s?.value || null;
    };

    const minute = clock.replace("'", "").split(":")[0];

    return {
      minute, period,
      score1: home?.score || "0",
      score2: away?.score || "0",
      poss1: getStat(home, "possession")?.replace("%", "") || null,
      poss2: getStat(away, "possession")?.replace("%", "") || null,
      shots1: getStat(home, "shots total") || getStat(home, "shots on") || null,
      shots2: getStat(away, "shots total") || getStat(away, "shots on") || null,
      shotsOn1: getStat(home, "shots on") || null,
      shotsOn2: getStat(away, "shots on") || null,
      corners1: getStat(home, "corner") || null,
      corners2: getStat(away, "corner") || null,
      cards1: getStat(home, "yellow") || null,
      cards2: getStat(away, "yellow") || null,
      notes: `ESPN auto — ${clock} période ${period}`,
    };
  } catch { return null; }
}

// ─── Claude helpers ───────────────────────────────────────────────────────────
async function askClaude(prompt, system, maxTokens = 8000) {
  const msgs = [{ role: "user", content: prompt }];
  for (let i = 0; i < 10; i++) {
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-6", max_tokens: maxTokens, system, messages: msgs,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });
    const texts = resp.content.filter(b => b.type === "text");
    if (resp.stop_reason === "end_turn") return texts.map(b => b.text).join("\n");
    if (resp.stop_reason === "tool_use") {
      const tools = resp.content.filter(b => b.type === "tool_use");
      msgs.push({ role: "assistant", content: resp.content });
      msgs.push({ role: "user", content: tools.map(b => ({ type: "tool_result", tool_use_id: b.id, content: "" })) });
      continue;
    }
    const t = texts.map(b => b.text).join("\n");
    if (t) return t;
    break;
  }
  throw new Error("Pas de réponse Claude");
}

async function askClaudeVision(prompt, system, imageBase64, mimeType = "image/jpeg") {
  const resp = await anthropic.messages.create({
    model: "claude-sonnet-4-6", max_tokens: 4000, system,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
      { type: "text", text: prompt }
    ]}],
  });
  return resp.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

function xj(text) {
  const t = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i === -1 || j === -1) return null;
  try { return JSON.parse(t.slice(i, j + 1)); } catch { return null; }
}

async function downloadTelegramPhoto(fileId) {
  const file = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
  const resp = await fetch(url);
  const buffer = await resp.arrayBuffer();
  return { base64: Buffer.from(buffer).toString("base64"), mime: "image/jpeg" };
}

// ─── Formatage Telegram ───────────────────────────────────────────────────────
const e = s => String(s || "").replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
const stars = n => "⭐".repeat(Math.min(n || 0, 5));
const risk = r => ({ LOW: "🟢", MEDIUM: "🟡", HIGH: "🔴" }[r] || "⚪");

function fmtBet(b, i) {
  const v = (b.value_pct || b.valuePercent || 0).toFixed(1);
  const odds = (b.odds || b.bookmakerOdds || b.estimatedOdds || 0).toFixed(2);
  let t = `*${e(i + 1)}\\. ${e(b.selection)}*\n`;
  t += `${stars(b.stars || b.confidence_stars)} ${risk(b.risk || b.risk_level)} \\| @ *${e(odds)}* \\| \\+${e(v)}%\n`;
  if (b.inside_angle) t += `💡 _${e(b.inside_angle)}_\n`;
  const reasons = (b.reasons || []).map(r => typeof r === "object" ? r.text : r).filter(Boolean);
  if (reasons[0]) t += `  ✅ ${e(reasons[0])}\n`;
  if (b.counter_arg) t += `  ⚠️ _${e(b.counter_arg)}_\n`;
  return t;
}

function fmtStrategy(result, budget) {
  const s = result.strategy || {};
  const v = result.verdict || {};
  const bestKey = v.best_strategy || "combo_1";
  const bestCombo = s[bestKey] || s.combo_1;
  const ma = result.matches_analysis || [];

  let msg = `🎯 *BETS DU SOIR* \\| ${e(budget)}€ \\| ${e(v.confidence_overall || "?")}\n`;
  if (v.key_risk_of_the_day) msg += `⚠️ _${e(v.key_risk_of_the_day)}_\n`;
  msg += `\n`;

  // PARIS JOUEURS VALUE (le truc que le marché rate)
  const playerBets = ma.flatMap(m => (m.player_value_bets || []).filter(p => p && p.value_pct >= 6 && p.odds));
  if (playerBets.length) {
    msg += `🎯 *PARIS JOUEURS VALUE:*\n`;
    playerBets.forEach(p => {
      msg += `• *${e(p.player)}* buteur @ ${e(p.odds)}\n`;
      msg += `  Taux réel: ${e(p.real_scoring_rate_pct)}% \\| Cote implicite: ${e(p.implied_prob_pct)}% \\| Value: \\+${e(p.value_pct)}%\n`;
      msg += `  _${e(p.why)}_\n`;
      if (p.titularisation && p.titularisation !== 'confirmée') msg += `  ⚠️ Titularisation: ${e(p.titularisation)}\n`;
    });
    msg += `\n`;
  }

  // SIMPLES
  if (s.best_singles?.length) {
    msg += `*▶️ PARIS À PLACER:*\n`;
    s.best_singles.forEach(b => {
      msg += `• *${e(b.selection)}* @ ${e(b.odds)} → ${e(b.stake_suggested)}€\n`;
      msg += `  _${e(b.matchup)}_\n`;
    });
    msg += `\n`;
  }

  // MEILLEUR COMBO
  if (bestCombo?.legs?.length) {
    msg += `*🔥 COMBO ${e(bestCombo.label || "")}* @ *${e(bestCombo.combined_odds?.toFixed(2))}* \\| ${e(bestCombo.stake_suggested)}€ → *${e(bestCombo.potential_return)}€*\n`;
    bestCombo.legs.forEach(l => {
      const ri = { banquier: "🔒", révisé: "🔄", risqué: "⚡", "leg tueur": "💀" }[l.role] || "•";
      msg += `${ri} ${e(l.selection)} @ ${e(l.odds)} — _${e(l.matchup)}_\n`;
    });
    if (bestCombo.weak_leg) msg += `⚠️ _${e(bestCombo.weak_leg)}_\n`;
    if (bestCombo.cashout_advice) msg += `💸 _${e(bestCombo.cashout_advice)}_\n`;
    msg += `\n`;
  }

  // Autres combos résumé
  const otherCombos = [s.combo_1, s.combo_2, s.combo_3].filter(c => c && c !== bestCombo && c.legs?.length);
  if (otherCombos.length) {
    msg += `*Alternatives:*\n`;
    otherCombos.forEach(c => {
      msg += `• ${e(c.label || "")} @ ${e(c.combined_odds?.toFixed(2))} — ${e(c.stake_suggested)}€ → ${e(c.potential_return)}€\n`;
    });
  }

  return msg;
}

// ─── Prompts ─────────────────────────────────────────────────────────────────
const PARSE_SYS = `Tu analyses des screenshots de bookmakers. Extrais les matchs visibles. JSON pur.`;
const PARSE_PROMPT = `Extrais tous les matchs visibles.
{"matches":[{"team1":"...","team2":"...","league":"...","time":"HH:MM","odds":{"home":2.1,"draw":3.5,"away":3.2},"markets_visible":[{"name":"Over 2.5","odds":1.85}]}],"confidence":"HIGH|MEDIUM|LOW","notes":"..."}
N'invente rien. Cotes inconnues = null.`;

const BATCH_SYS = `Tu es un trader bookmaker professionnel spécialisé dans la détection d'anomalies de marché.

TON EDGE: tu trouves ce que le marché grand public rate. Pas les paris évidents — les angles cachés.

MÉTHODE OBLIGATOIRE pour chaque match:
1. Recherche web les stats détaillées: FBref, Sofascore, Whoscored, Footystats
2. Pour les BUTS: cherche les buts par 90 min de chaque attaquant titulaire probable
   → Si un joueur marque dans 28% de ses matchs mais est coté 4.50 (=22% implicite) = VALUE
   → Priorité aux joueurs: en forme (2+ buts sur 5 derniers), qui prennent les corners/penalties, bon matchup défensif ce soir
3. Pour les ÉQUIPES: cherche les under-performance récentes (xG vs goals) — une équipe qui sur-performe son xG va régresser
4. Pour les MARCHÉS: cherche les Over/Under où le marché est influencé par le résultat du dernier match (biais de récence)
5. Compare TOUJOURS: taux réel observé sur 10 matchs vs probabilité implicite dans la cote

RÈGLES ABSOLUES:
- Pari joueur UNIQUEMENT si tu as trouvé son taux de buts et confirmé sa titularisation probable
- Jamais un pari "Victoire favorite" sans que la cote offre au moins 8% de value calculée
- Si tu ne trouves pas d'angle — dis skip, ne remplis pas avec du bruit
- JSON pur seulement`;

function buildBatchPrompt(matches, budget) {
  const today = new Date().toISOString().slice(0, 10);
  const list = matches.map((m, i) =>
    `Match ${i+1}: ${m.team1} vs ${m.team2} | ${m.league||'?'} | ${m.time||'?'} | Cotes: ${m.odds?.home||'?'}/${m.odds?.draw||'?'}/${m.odds?.away||'?'}`
  ).join('\n');
  return `MATCHS (${matches.length}) — Date: ${today}
${list}
BUDGET: ${budget}€

Pour chaque match, cherche OBLIGATOIREMENT:
A) Les buteurs en forme avec leur taux réel (buts/matchs joués cette saison) vs leur cote actuelle
B) Les set piece specialists (corners, penalties) souvent sous-évalués par le marché
C) Les matchups défensifs favorables (attaquant rapide vs défenseur lent, etc.)
D) L'historique Over/Under des 5 derniers matchs des DEUX équipes + H2H
E) Les anomalies xG (équipe qui sur/sous-performe = regression à venir)

JSON:
{"matches_analysis":[{"matchup":"...","league":"...","time":"...","context":"enjeu + classement en 1 phrase","skip":false,"skip_reason":null,"best_bet":{"market":"...","selection":"...","odds":1.85,"value_pct":14.7,"stars":4,"risk":"LOW|MEDIUM|HIGH","reasons":[{"text":"stat précise avec chiffre","source":"FBref/Sofascore/..."}],"counter_arg":"...","inside_angle":"pourquoi le marché rate ça"},"player_value_bets":[{"player":"...","team":"...","market":"Buteur anytime|Premier buteur","odds":4.0,"real_scoring_rate_pct":32,"implied_prob_pct":25,"value_pct":7,"stars":3,"why":"a marqué dans 4 des 5 derniers, face à une défense qui concède en moyenne 1.8 xG/match","source":"FBref","titularisation":"confirmée/probable/incertaine"}]}],"strategy":{"combo_1":{"label":"SOLIDE","profile":"solide","legs":[{"matchup":"...","selection":"...","odds":1.85,"role":"banquier|révisé|risqué","why_this_leg":"1 phrase"}],"combined_odds":5.4,"prob_estimate":0.22,"stake_suggested":5,"potential_return":27,"weak_leg":"...","cashout_advice":"..."},"combo_2":{"label":"ÉQUILIBRÉ","profile":"équilibré","legs":[...],"combined_odds":8.2,"prob_estimate":0.15,"stake_suggested":4,"potential_return":33},"combo_3":{"label":"RISQUÉ","profile":"risqué","legs":[...],"combined_odds":14.0,"prob_estimate":0.08,"stake_suggested":3,"potential_return":42},"best_singles":[{"matchup":"...","selection":"...","odds":2.1,"value_pct":12.0,"stake_suggested":4,"rationale":"1 phrase"}]},"verdict":{"best_strategy":"combo_1|combo_2|combo_3","rationale":"...","total_stake_recommended":12,"max_return_if_best_hits":82,"key_risk_of_the_day":"...","confidence_overall":"HIGH|MEDIUM|LOW"}}

IMPORTANT: le champ player_value_bets est OBLIGATOIRE pour chaque match avec au moins 1 tentative de recherche.
Si tu n'as pas le taux réel du joueur = mets null dans player_value_bets et explique pourquoi dans skip_reason.`;
}

const LIVE_SYS = `Tu es un analyste paris live expert qui COMPARE les stats live aux données historiques.
Tu ne te contentes pas de regarder les stats brutes — tu analyses si elles sont au-dessus ou en-dessous de la normale pour ces équipes.
Inside angle + contre-arg obligatoires. JSON pur seulement.`;

function buildLivePrompt(match, s) {
  // Extraire les stats historiques de l'analyse pré-match si disponibles
  const a = match.analysis;
  const ks = a?.keyStats || {};
  const f = a?.form || {};
  const h2h = a?.h2h || {};
  const ctx = a?.context || {};

  const getVal = (obj) => typeof obj === 'object' && obj?.value !== undefined ? obj.value : obj;

  const historicalContext = a ? `
DONNÉES HISTORIQUES (pour comparer aux stats live ci-dessus):
${match.team1}:
- Possession moyenne saison: ${getVal(ks.team1_goals_per_home) ? `${getVal(ks.team1_goals_per_home)} buts/match dom` : 'inconnue'}
- Tirs moyens/match: à comparer avec stats actuelles
- xG récent: ${getVal(ks.xg_team1_recent) || 'inconnu'}
- BTTS rate: ${ks.btts_rate_team1 ? (getVal(ks.btts_rate_team1)*100).toFixed(0)+'%' : 'inconnu'}
- Over 2.5 rate: ${ks.over25_rate_team1 ? (getVal(ks.over25_rate_team1)*100).toFixed(0)+'%' : 'inconnu'}
- Forme (5 derniers): ${f.team1?.last5?.join(' ') || 'inconnue'} — tendance: ${f.team1?.trend || 'inconnue'}
${match.team2}:
- xG récent: ${getVal(ks.xg_team2_recent) || 'inconnu'}
- BTTS rate: ${ks.btts_rate_team2 ? (getVal(ks.btts_rate_team2)*100).toFixed(0)+'%' : 'inconnu'}
- Over 2.5 rate: ${ks.over25_rate_team2 ? (getVal(ks.over25_rate_team2)*100).toFixed(0)+'%' : 'inconnu'}
- Forme (5 derniers): ${f.team2?.last5?.join(' ') || 'inconnue'} — tendance: ${f.team2?.trend || 'inconnue'}
H2H: ${h2h.avg_goals_h2h ? `moyenne ${h2h.avg_goals_h2h} buts/match` : 'inconnu'} | ${h2h.venue_dominance || ''}
Contexte qualification: ${ctx.motivation_team1 || ''} / ${ctx.motivation_team2 || ''}
${a.overview?.summary || ''}` : 'Pas de données pré-match disponibles.';

  return `LIVE: ${match.team1} vs ${match.team2} | ${match.league||''}

STATS ACTUELLES:
- Minute: ${s.minute}' | Score: ${s.score1}-${s.score2}
${s.poss1?`- Possession: ${s.poss1}% / ${s.poss2}%`:''}
${s.shots1?`- Tirs: ${s.shots1} / ${s.shots2}`:''}
${s.shotsOn1?`- Cadrés: ${s.shotsOn1} / ${s.shotsOn2}`:''}
${s.corners1?`- Corners: ${s.corners1} / ${s.corners2}`:''}
${s.cards1?`- Cartons: ${s.cards1} / ${s.cards2}`:''}
${s.notes?`- Notes: ${s.notes}`:''}
${historicalContext}

ANALYSE OBLIGATOIRE:
1. Compare les stats live aux moyennes historiques — est-ce anormal ou dans la norme ?
2. La tendance actuelle (possession, tirs) confirme-t-elle ou contredit-elle le profil habituel de ces équipes ?
3. Quel scénario de 2ème mi-temps est le plus probable compte tenu de TOUT ça ?
4. Identifie les paris live avec vraie valeur en tenant compte du contexte historique

JSON:
{"momentum":"...","score_dynamics":"...","context_vs_history":"1 phrase: les stats live vs leur normale (ex: Nacional domine plus que d'habitude / moins que prévu)","liveBets":[{"selection":"...","market":"Prochain but|Over/Under restant|Score final|2ème MT résultat|Cartons|Corners","odds":2.2,"value_pct":14.4,"stars":4,"risk":"LOW|MEDIUM|HIGH","reasons":["raison avec comparaison historique"],"counter_arg":"...","inside_angle":"pourquoi le marché rate ce contexte"}],"halftime_bets":[],"alert_level":"NONE|NORMAL|STRONG","warnings":[""]}
STRONG si stars>=4 ET value>=12. Max 4 bets. Refuse de sortir un pari sans comparaison historique.`;
}

// ─── HANDLER PHOTOS ───────────────────────────────────────────────────────────
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const session = sess(chatId);
  await bot.sendMessage(chatId, "📸 Screenshot reçu\\! Lecture des matchs\\.\\.\\.", { parse_mode: "MarkdownV2" });
  try {
    const photo = msg.photo[msg.photo.length - 1];
    const { base64, mime } = await downloadTelegramPhoto(photo.file_id);
    const text = await askClaudeVision(PARSE_PROMPT, PARSE_SYS, base64, mime);
    const parsed = xj(text);
    if (!parsed?.matches?.length) {
      return bot.sendMessage(chatId, "❌ Aucun match détecté\\. Essaie avec une image plus nette\\.", { parse_mode: "MarkdownV2" });
    }
    const startId = session.matches.length + 1;
    parsed.matches.forEach((m, i) => session.matches.push({ id: startId + i, ...m }));
    let txt = `✅ *${e(parsed.matches.length)} match${parsed.matches.length > 1 ? "s" : ""} détecté${parsed.matches.length > 1 ? "s" : ""}*\n\n`;
    parsed.matches.forEach((m, i) => {
      txt += `*${e(startId + i)}\\.* ${e(m.team1)} vs ${e(m.team2)}`;
      if (m.league) txt += ` \\| ${e(m.league)}`;
      if (m.time) txt += ` \\| ${e(m.time)}`;
      if (m.odds?.home) txt += `\n   ${e(m.odds.home)} / ${e(m.odds.draw)} / ${e(m.odds.away)}`;
      txt += "\n";
    });
    txt += `\nTon budget ce soir ? \\(envoie juste un nombre, ex: *17*\\)`;
    await bot.sendMessage(chatId, txt, { parse_mode: "MarkdownV2" });
    session.awaitingBudget = true;
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Erreur: ${e(err.message)}`);
  }
});

// ─── Budget + lancement analyse après photo ───────────────────────────────────
bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/") || msg.photo) return;
  const chatId = msg.chat.id;
  const session = sess(chatId);
  const txt = msg.text?.trim();
  if (!txt || !session.awaitingBudget || !/^\d+(\.\d+)?$/.test(txt)) return;

  const budget = parseFloat(txt);
  session.budget = budget;
  session.awaitingBudget = false;
  const unanalyzed = session.matches.filter(m => !m.analysis);
  if (!unanalyzed.length) return;

  await bot.sendMessage(chatId,
    `⚡ Analyse *${e(unanalyzed.length)} match${unanalyzed.length > 1 ? "s" : ""}* avec budget *${e(budget)}€*\\.\\.\\.\n_Recherche stats, formes, value bets — 2 à 4 min_`,
    { parse_mode: "MarkdownV2" }
  );
  try {
    const text = await askClaude(buildBatchPrompt(unanalyzed, budget), BATCH_SYS, 14000);
    const result = xj(text);
    if (!result) throw new Error("Réponse non parsable");
    session.lastResult = result;
    const ma = result.matches_analysis || [];
    unanalyzed.forEach((m, i) => { if (ma[i]) m.analysis = ma[i]; });
    await bot.sendMessage(chatId, fmtStrategy(result, budget), { parse_mode: "MarkdownV2" });

    // AUTO-LANCER le monitoring sur TOUS les matchs — sans commande manuelle
    await bot.sendMessage(chatId,
      `🔴 *Lancement monitoring automatique sur ${e(unanalyzed.length)} match${unanalyzed.length > 1 ? "s" : ""}\\.\\.\\.*\n_Recherche ESPN en cours_`,
      { parse_mode: "MarkdownV2" }
    );

    // Monitoring en parallèle sur tous les matchs (sans bloquer)
    const monitoringResults = [];
    for (const m of unanalyzed) {
      try {
        const espn = await findEspnMatch(m.team1, m.team2);
        if (espn) {
          // Stocker le monitoring pour ce match dans une map multi-match
          if (!session.activeMonitoring) session.activeMonitoring = {};
          let lastScore = null;
          let lastAlertMinute = -10;
          const timer = setInterval(async () => {
            try {
              const stats = await getEspnStats(espn.league, espn.eventId);
              if (!stats || stats.notStarted) return;
              if (stats.finished) {
                clearInterval(timer);
                delete session.activeMonitoring[m.id];
                await bot.sendMessage(chatId, `🏁 *${e(m.team1)} vs ${e(m.team2)}* terminé\\.`, { parse_mode: "MarkdownV2" });
                return;
              }
              const minNum = parseInt(stats.minute) || 0;
              const curScore = `${stats.score1}-${stats.score2}`;
              const scoredGoal = curScore !== lastScore && lastScore !== null;
              lastScore = curScore;
              if (minNum - lastAlertMinute < 12 && !scoredGoal) return;
              lastAlertMinute = minNum;
              console.log(`[AUTO] ${m.team1} vs ${m.team2} — ${stats.minute}' ${curScore}`);
              const text2 = await askClaude(buildLivePrompt(m, stats), LIVE_SYS, 3000);
              const data = xj(text2);
              if (!data) return;
              let alertMsg = "";

              // ⚽ But marqué
              if (scoredGoal) {
                alertMsg += `⚽ *BUT\\!* ${e(m.team1)} *${e(stats.score1)}\\-${e(stats.score2)}* ${e(m.team2)} \\(${e(stats.minute)}\\'\\)\n\n`;
              }

              // 🚨 Value bet FORT (stars≥4 ET value≥12%)
              if (data.alert_level === "STRONG" && data.liveBets?.[0]) {
                const top = data.liveBets[0];
                alertMsg += `🚨 *VALUE BET FORT — ${e(m.team1)} vs ${e(m.team2)}*\n`;
                alertMsg += `*${e(top.selection)}* @ ~${e(top.odds)} \\| \\+${e(top.value_pct?.toFixed(1))}% \\| ${stars(top.stars)}\n`;
                alertMsg += `💡 _${e(top.inside_angle)}_\n`;
                alertMsg += `⚠️ _${e(top.counter_arg)}_\n`;
              }
              // 📊 Update régulière toutes les ~15 min même sans STRONG
              else if (!scoredGoal) {
                const top = data.liveBets?.[0];
                alertMsg += `📊 *${e(m.team1)} vs ${e(m.team2)} — ${e(stats.minute)}\\'* \\| ${e(curScore)}\n`;
                if (stats.poss1) alertMsg += `Poss: ${e(stats.poss1)}%\\-${e(stats.poss2)}% \\| Tirs: ${e(stats.shots1||'?')}\\-${e(stats.shots2||'?')}\n`;
                alertMsg += `_${e(data.momentum)}_\n`;
                if (data.context_vs_history) alertMsg += `_${e(data.context_vs_history)}_\n`;
                if (top) {
                  const lvl = data.alert_level === "NORMAL" ? "🟡" : "⚪";
                  alertMsg += `${lvl} Meilleur pari: *${e(top.selection)}* @ ~${e(top.odds)}\n`;
                } else {
                  alertMsg += `⚪ Pas de value bet identifié à ce stade\n`;
                }
              }

              if (alertMsg) await bot.sendMessage(chatId, alertMsg, { parse_mode: "MarkdownV2" });
            } catch (err) {
              console.error(`[AUTO ${m.team1}]`, err.message);
              // Rendre les erreurs visibles à l'utilisateur
              try {
                await bot.sendMessage(chatId, `⚠️ Erreur monitoring *${e(m.team1)} vs ${e(m.team2)}*: ${e(err.message.slice(0,100))}`, { parse_mode: "MarkdownV2" });
              } catch {}
            }
          }, 5 * 60 * 1000);
          session.activeMonitoring[m.id] = { timer, match: m };
          monitoringResults.push(`✅ ${m.team1} vs ${m.team2} \\(ESPN ${e(espn.league)}\\)`);
        } else {
          monitoringResults.push(`⚠️ ${m.team1} vs ${m.team2} — non trouvé ESPN`);
        }
      } catch (err) {
        monitoringResults.push(`❌ ${m.team1} vs ${m.team2} — erreur`);
      }
    }

    await bot.sendMessage(chatId,
      `📡 *Monitoring activé:*\n${monitoringResults.map(r => `  ${r}`).join('\n')}\n\n⏱ Stats ESPN toutes les 5 min\n🚨 Notif push si but ou value bet fort\n/stoplive pour tout arrêter`,
      { parse_mode: "MarkdownV2" }
    );
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Erreur analyse: ${e(err.message)}`);
  }
});

// ─── /autolive — 100% auto ESPN toutes les 5 min ─────────────────────────────
bot.onText(/\/autolive (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const matchId = parseInt(match[1]);
  const session = sess(chatId);
  const m = session.matches.find(x => x.id === matchId);
  if (!m) return bot.sendMessage(chatId, `❌ Match ${matchId} introuvable\\.`, { parse_mode: "MarkdownV2" });

  await bot.sendMessage(chatId,
    `🔍 Recherche *${e(m.team1)} vs ${e(m.team2)}* sur ESPN \\(${e(ALL_ESPN_LEAGUES.length)} ligues scannées\\)\\.\\.\\.\n_5 à 15 secondes_`,
    { parse_mode: "MarkdownV2" }
  );

  const espn = await findEspnMatch(m.team1, m.team2);

  if (!espn) {
    return bot.sendMessage(chatId,
      `⚠️ Match non trouvé sur ESPN\\.\n→ /golive ${e(matchId)} pour mode semi\\-auto \\(rappels 15min\\)\n→ /live ${e(matchId)} \\[min\\] \\[score\\] \\[notes\\] pour analyse manuelle`,
      { parse_mode: "MarkdownV2" }
    );
  }

  if (monitoring[chatId]) clearInterval(monitoring[chatId].timer);

  let lastScore = null;
  let lastAlertMinute = -10;

  monitoring[chatId] = {
    matchId, match: m, chatId,
    espnEventId: espn.eventId, espnLeague: espn.league,
    timer: setInterval(async () => {
      try {
        const stats = await getEspnStats(espn.league, espn.eventId);
        if (!stats || stats.notStarted) return;
        if (stats.finished) {
          clearInterval(monitoring[chatId]?.timer);
          delete monitoring[chatId];
          await bot.sendMessage(chatId, `🏁 *${e(m.team1)} vs ${e(m.team2)}* terminé\\. Monitoring arrêté\\.`, { parse_mode: "MarkdownV2" });
          return;
        }

        const minNum = parseInt(stats.minute) || 0;
        const curScore = `${stats.score1}-${stats.score2}`;
        const scoredGoal = curScore !== lastScore && lastScore !== null;
        lastScore = curScore;

        if (minNum - lastAlertMinute < 8 && !scoredGoal) return;
        lastAlertMinute = minNum;

        console.log(`[AUTO] ${m.team1} vs ${m.team2} — ${stats.minute}' ${curScore}`);

        const text = await askClaude(buildLivePrompt(m, stats), LIVE_SYS, 3000);
        const data = xj(text);
        if (!data) return;

        let alertMsg = "";

        if (scoredGoal) {
          alertMsg += `⚽ *BUT\\!* Score: ${e(m.team1)} *${e(stats.score1)}\\-${e(stats.score2)}* ${e(m.team2)}\n\n`;
        }

        if (data.alert_level === "STRONG" && data.liveBets?.[0]) {
          const top = data.liveBets[0];
          alertMsg += `🚨 *VALUE BET FORT — ${e(stats.minute)}\\'*\n`;
          alertMsg += `*${e(top.selection)}* @ ~${e(top.odds)}\n`;
          alertMsg += `\\+${e(top.value_pct?.toFixed(1))}% value \\| ${stars(top.stars)}\n`;
          alertMsg += `💡 _${e(top.inside_angle)}_\n`;
          alertMsg += `⚠️ _${e(top.counter_arg)}_\n`;
        } else if (scoredGoal && data.liveBets?.[0]) {
          const top = data.liveBets[0];
          alertMsg += `📊 *${e(data.momentum)}*\n`;
          alertMsg += `Meilleur bet live: ${e(top.selection)} @ ~${e(top.odds)} \\| ${stars(top.stars)}\n`;
        }

        if (alertMsg) await bot.sendMessage(chatId, alertMsg, { parse_mode: "MarkdownV2" });

      } catch (err) {
        console.error("[AUTO] erreur:", err.message);
      }
    }, 5 * 60 * 1000)
  };

  await bot.sendMessage(chatId,
    `✅ *AUTO-LIVE activé*\n${e(m.team1)} vs ${e(m.team2)}\n\n` +
    `📡 ESPN connecté \\(${e(espn.league)}\\)\n` +
    `⏱ Stats récupérées toutes les *5 min*\n` +
    `🚨 Alerte auto si:\n` +
    `  • Value bet fort \\(4★\\+ \\| value ≥12%\\)\n` +
    `  • But marqué\n\n` +
    `_Tu n\\'as rien à faire — laisse tourner_\n/stoplive pour arrêter`,
    { parse_mode: "MarkdownV2" }
  );
});

// ─── /golive — semi-auto, rappels 15 min ─────────────────────────────────────
bot.onText(/\/golive (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const matchId = parseInt(match[1]);
  const session = sess(chatId);
  const m = session.matches.find(x => x.id === matchId);
  if (!m) return bot.sendMessage(chatId, `❌ Match ${matchId} introuvable\\.`, { parse_mode: "MarkdownV2" });

  if (monitoring[chatId]) clearInterval(monitoring[chatId].timer);
  let minuteCount = 0;

  monitoring[chatId] = {
    matchId, match: m, chatId,
    timer: setInterval(async () => {
      minuteCount += 15;
      try {
        await bot.sendMessage(chatId,
          `⏱ *${e(m.team1)} vs ${e(m.team2)}* — ~${e(minuteCount)}\\'\n\nEnvoie les stats:\n\`/live ${matchId} ${minuteCount} 0\\-0 possession 55% 6 tirs\``,
          { parse_mode: "MarkdownV2" }
        );
      } catch {}
    }, 15 * 60 * 1000)
  };

  await bot.sendMessage(chatId,
    `🟡 *Semi-auto actif — ${e(m.team1)} vs ${e(m.team2)}*\nRappel toutes les 15 min\\. Envoie les stats pour analyse\\.\n/stoplive pour arrêter`,
    { parse_mode: "MarkdownV2" }
  );
});

// ─── /stoplive ────────────────────────────────────────────────────────────────
bot.onText(/\/stoplive/, (msg) => {
  const chatId = msg.chat.id;
  if (monitoring[chatId]) { clearInterval(monitoring[chatId].timer); delete monitoring[chatId]; }
  bot.sendMessage(chatId, "✅ Monitoring arrêté\\.", { parse_mode: "MarkdownV2" });
});

// ─── /live — analyse manuelle ─────────────────────────────────────────────────
bot.onText(/\/live (\d+)\s+(\d+)\s+(\d+)[:\-](\d+)(.*)/, async (msg, m) => {
  const chatId = msg.chat.id;
  const matchId = parseInt(m[1]);
  const session = sess(chatId);
  const match = session.matches.find(x => x.id === matchId);
  if (!match) return bot.sendMessage(chatId, `❌ Match ${matchId} introuvable\\.`, { parse_mode: "MarkdownV2" });

  const stats = { minute: m[2], score1: m[3], score2: m[4], notes: m[5]?.trim() || "" };
  const n = stats.notes;
  const pm = n.match(/(\d+)[%]/); if (pm) { stats.poss1 = pm[1]; stats.poss2 = 100 - parseInt(pm[1]); }
  const sm = n.match(/(\d+)\s*tir/i); if (sm) stats.shots1 = sm[1];
  const xm = n.match(/([\d.]+)\s*xg/i); if (xm) stats.xg1 = xm[1];

  await bot.sendMessage(chatId, `⚡ Analyse live ${e(match.team1)} vs ${e(match.team2)} ${e(stats.minute)}\\'\\.\\.\\.\n_Score: ${e(stats.score1)}\\-${e(stats.score2)}_`, { parse_mode: "MarkdownV2" });
  try {
    const text = await askClaude(buildLivePrompt(match, stats), LIVE_SYS, 4000);
    const data = xj(text);
    if (!data) throw new Error("Réponse non parsable");

    let msg2 = `🔴 *LIVE* — ${e(stats.minute)}\\' \\| *${e(stats.score1)}\\-${e(stats.score2)}*\n`;
    msg2 += `${e(data.momentum)}\n_${e(data.score_dynamics)}_\n\n`;
    if (data.liveBets?.length) {
      msg2 += `*Paris live:*\n\n`;
      data.liveBets.slice(0, 3).forEach((b, i) => { msg2 += fmtBet(b, i) + "\n"; });
    }
    if (data.warnings?.[0]) msg2 += `⚠️ _${e(data.warnings[0])}_\n`;
    await bot.sendMessage(chatId, msg2, { parse_mode: "MarkdownV2" });

    if (data.alert_level === "STRONG" && data.liveBets?.[0]) {
      const top = data.liveBets[0];
      await bot.sendMessage(chatId,
        `🚨🚨 *VALUE BET FORT*\n*${e(top.selection)}* @ ~${e(top.odds)}\n\\+${e(top.value_pct?.toFixed(1))}% \\| ${stars(top.stars)}\n💡 _${e(top.inside_angle)}_`,
        { parse_mode: "MarkdownV2" }
      );
    }
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Erreur: ${e(err.message)}`);
  }
});

// ─── /analyser texte ──────────────────────────────────────────────────────────
bot.onText(/\/analyser (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim();
  const parts = input.split(/\s+vs\s+/i);
  const team1 = parts[0]?.trim() || input;
  const rest = (parts[1] || "").trim().split(/\s+/);
  const team2 = rest[0] || "Adversaire";
  const nums = rest.filter(x => /^\d+\.\d+$/.test(x));
  const odds = nums.length >= 3 ? { home: parseFloat(nums[0]), draw: parseFloat(nums[1]), away: parseFloat(nums[2]) } : null;
  const league = rest.filter(x => !/^\d/.test(x)).slice(1).join(" ") || "?";
  const time = rest.find(x => /\d{1,2}[h:]\d{2}/i.test(x)) || "";

  const session = sess(chatId);
  const id = session.matches.length + 1;
  const m = { id, team1, team2, league, time, odds, date: new Date().toISOString().slice(0, 10) };
  session.matches.push(m);

  await bot.sendMessage(chatId, `🔍 Analyse *${e(team1)} vs ${e(team2)}*\\.\\.\\. \\(60\\-90 sec\\)`, { parse_mode: "MarkdownV2" });
  try {
    const budget = session.budget || 20;
    const text = await askClaude(buildBatchPrompt([m], budget), BATCH_SYS, 10000);
    const result = xj(text);
    if (!result) throw new Error("Réponse non parsable");
    m.analysis = result.matches_analysis?.[0];
    await bot.sendMessage(chatId, fmtStrategy(result, budget) + `\n/autolive ${e(id)} pour monitoring automatique`, { parse_mode: "MarkdownV2" });
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Erreur: ${e(err.message)}`);
  }
});

// ─── /plan ────────────────────────────────────────────────────────────────────
bot.onText(/\/plan\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/, async (msg, m) => {
  const chatId = msg.chat.id;
  const budget = parseFloat(m[1]);
  session = sess(chatId);
  session.budget = budget;
  const all = session.matches;
  if (!all.length) return bot.sendMessage(chatId, "Envoie des screenshots d\\'abord\\.", { parse_mode: "MarkdownV2" });
  await bot.sendMessage(chatId, `💰 Composition plan ${e(budget)}€\\.\\.\\. \\(${e(all.length)} matchs\\)`, { parse_mode: "MarkdownV2" });
  try {
    const text = await askClaude(buildBatchPrompt(all, budget), BATCH_SYS, 12000);
    const result = xj(text);
    if (!result) throw new Error("Réponse non parsable");
    await bot.sendMessage(chatId, fmtStrategy(result, budget), { parse_mode: "MarkdownV2" });
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Erreur: ${e(err.message)}`);
  }
});

// ─── /matchs ──────────────────────────────────────────────────────────────────
bot.onText(/\/matchs/, (msg) => {
  const chatId = msg.chat.id;
  const session = sess(chatId);
  if (!session.matches.length) return bot.sendMessage(chatId, "Aucun match\\. Envoie des screenshots\\.", { parse_mode: "MarkdownV2" });
  let txt = `📋 *Session*\n\n`;
  session.matches.forEach(m => {
    txt += `*${e(m.id)}\\.* ${e(m.team1)} vs ${e(m.team2)} — ${e(m.league||'?')}\n`;
    txt += m.analysis ? `  ✅ Analysé \\| /autolive ${e(m.id)}\n` : `  ⏳ Non analysé\n`;
  });
  bot.sendMessage(chatId, txt, { parse_mode: "MarkdownV2" });
});

// ─── /status ─────────────────────────────────────────────────────────────────
bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const mon = monitoring[chatId];
  if (!mon) return bot.sendMessage(chatId, "⚪ Aucun monitoring actif\\.", { parse_mode: "MarkdownV2" });
  const mode = mon.espnEventId ? "🟢 AUTO ESPN" : "🟡 Semi\\-auto";
  bot.sendMessage(chatId,
    `📡 *Monitoring actif*\n${e(mon.match.team1)} vs ${e(mon.match.team2)}\nMode: ${mode}\n/stoplive pour arrêter`,
    { parse_mode: "MarkdownV2" }
  );
});

// ─── /reset ───────────────────────────────────────────────────────────────────
bot.onText(/\/reset/, (msg) => {
  const chatId = msg.chat.id;
  if (monitoring[chatId]) { clearInterval(monitoring[chatId].timer); delete monitoring[chatId]; }
  delete sessions[chatId];
  bot.sendMessage(chatId, "✅ Session réinitialisée\\.", { parse_mode: "MarkdownV2" });
});

// ─── /start + /help ───────────────────────────────────────────────────────────
bot.onText(/\/start|\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎯 *Le Pari Bot*\n\n` +
    `📸 *Envoie une photo* de ton bookmaker\n_→ Détection auto des matchs \\+ stratégie_\n\n` +
    `*Live \\(pendant le match\\):*\n` +
    `/autolive \\[ID\\] — 100% auto via ESPN \\(toutes ligues\\)\n` +
    `/golive \\[ID\\] — semi\\-auto \\(rappels 15min\\)\n` +
    `/live \\[ID\\] \\[min\\] \\[score\\] \\[notes\\] — manuel\n` +
    `/stoplive — arrêter\n\n` +
    `*Analyse texte:*\n` +
    `/analyser PSG vs Lyon Ligue1 21h00 1\\.80 3\\.50 4\\.20\n\n` +
    `*Autres:*\n` +
    `/plan \\[budget\\] \\[objectif\\]\n` +
    `/matchs — voir session\n` +
    `/status — monitoring actif ?\n` +
    `/reset — tout effacer`,
    { parse_mode: "MarkdownV2" }
  );
});

console.log("🚀 Le Pari Bot démarré — en écoute...");
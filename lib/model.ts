// Token Radar model, version radar-2.
//
// One sealed snapshot in, one ranked board out. The board covers every slug on the
// snapshot's watchlist and adds pre-token protocols below the watchlist floor, ranked
// by an implied value that comes only from the snapshot's own numbers. No protocol
// name is ever special-cased: one scoring function runs over every row.
//
// How a protocol is valued (radar-2):
//
//   category multiple  the median market-cap-to-TVL ratio of the live-token
//                      protocols in the same category, in this same snapshot,
//                      winsorised and shrunk toward the whole-market median,
//                      clamped to [0.08, 0.60]. Categories with fewer than three
//                      live protocols use the whole-market median. This is the
//                      market's own sector pricing, read out of the snapshot.
//   growth multiplier  1 + clamp(change_7d, -60, 150) / 100 * 0.5
//   chain multiplier   1 + 0.02 * min(number of chains, 10)   (1.00 to 1.20)
//   maturity multiplier 0.6 + min(age_days, 1095) / 1095 * 0.4
//                      (age unknown: 365 days)
//   implied = max(1, round(tvl_usd * category * growth * chain * maturity))
//
// A protocol is pre-token when its record carries no market cap, no CoinGecko id
// and no symbol. Live-token protocols are kept apart and shown with the market's
// own capitalisation, never mixed into the ranking.

export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snap {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

export interface ModelTuning {
  growth_floor: number;
  growth_cap: number;
  growth_weight: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_step: number;
  chain_cap: number;
  cat_min: number;
  cat_max: number;
  cat_min_live: number;
  cat_shrink: number;
  ratio_cap: number;
}

export const TUNING: ModelTuning = {
  growth_floor: -60,
  growth_cap: 150,
  growth_weight: 0.5,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_step: 0.02,
  chain_cap: 10,
  cat_min: 0.08,
  cat_max: 0.6,
  cat_min_live: 3,
  cat_shrink: 6,
  ratio_cap: 3,
};

export const MODEL_VERSION = 'radar-2';

/** Early rows: pre-token protocols below the watchlist floor, taken by TVL. */
export const EARLY_ROWS = 360;

/** Live-token rows shown beside the board, by market cap. */
export const LIVE_ROWS = 24;

export interface Score {
  implied: number;
  category_multiple: number;
  growth_pct: number;
  growth_mult: number;
  chain_mult: number;
  maturity_mult: number;
  age_days: number | null;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watch: boolean;
  implied_value_usd: number;
  category_multiple: number;
  growth_multiplier: number;
  chain_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  tuning: ModelTuning;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  categories: { name: string; live_n: number; multiple: number }[];
  rows: BoardRow[];
  live: LiveRow[];
}

export class SnapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapError';
  }
}

const DAY_MS = 86_400_000;

function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Whole days from `listedAt` to `asOf`; null when either date is missing or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a sorted array, or null when it is empty. */
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * One multiple per category, read out of the snapshot's own live-token rows.
 * Each live protocol contributes market-cap / TVL, winsorised to [0, ratio_cap];
 * a category's multiple is its median, shrunk toward the whole-market median by
 * cat_shrink phantom observations, clamped to [cat_min, cat_max]. A category with
 * fewer than cat_min_live live rows uses the whole-market median outright, so a
 * single loud outlier cannot set a sector's price.
 */
export function categoryMultiples(
  protocols: Proto[],
  t: ModelTuning = TUNING,
): { byCategory: Map<string, number>; overall: number; table: { name: string; live_n: number; multiple: number }[] } {
  const live = protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const allRatios = live.map((p) => clamp(p.mcap_usd! / p.tvl_usd, 0, t.ratio_cap)).sort((a, b) => a - b);
  const overall = median(allRatios) ?? 0.25;
  const byCat = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Uncategorised';
    const arr = byCat.get(key) ?? [];
    arr.push(clamp(p.mcap_usd! / p.tvl_usd, 0, t.ratio_cap));
    byCat.set(key, arr);
  }
  const byCategory = new Map<string, number>();
  const table: { name: string; live_n: number; multiple: number }[] = [];
  for (const [name, ratios] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
    ratios.sort((a, b) => a - b);
    let multiple: number;
    if (ratios.length < t.cat_min_live) {
      multiple = overall;
    } else {
      const med = median(ratios) ?? overall;
      multiple = (ratios.length * med + t.cat_shrink * overall) / (ratios.length + t.cat_shrink);
    }
    multiple = clamp(multiple, t.cat_min, t.cat_max);
    byCategory.set(name, round4(multiple));
    table.push({ name, live_n: ratios.length, multiple: round4(multiple) });
  }
  return { byCategory, overall: round4(overall), table };
}

/** Whether the record carries no token at all. */
export function isPreToken(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether the board may rank this protocol: pre-token, not a centralised exchange, not a versioned pool. */
export function isRankable(p: Proto): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** Score one protocol under the radar-2 model. */
export function scoreProtocol(
  p: Proto,
  asOf: string,
  multiples: Map<string, number>,
  overall: number,
  t: ModelTuning = TUNING,
): Score {
  const age = ageDays(asOf, p.listed_at);
  const growthPct = clamp(numOr(p.change_7d, 0), t.growth_floor, t.growth_cap);
  const growthMult = 1 + (growthPct / 100) * t.growth_weight;
  const chainMult = 1 + t.chain_step * Math.min(p.chains.length, t.chain_cap);
  const ageForModel = age ?? t.unknown_age_days;
  const maturityMult =
    t.maturity_floor + (Math.min(Math.max(ageForModel, 0), t.maturity_days) / t.maturity_days) * t.maturity_range;
  const catMult = multiples.get(p.category ?? 'Uncategorised') ?? overall;
  const implied = Math.max(1, Math.round(p.tvl_usd * catMult * growthMult * chainMult * maturityMult));
  return {
    implied,
    category_multiple: catMult,
    growth_pct: growthPct,
    growth_mult: round4(growthMult),
    chain_mult: round4(chainMult),
    maturity_mult: round4(maturityMult),
    age_days: age,
  };
}

/** The board: every watchlist slug, plus the strongest pre-token protocols below the floor, by TVL. */
export function buildBoard(snap: Snap, t: ModelTuning = TUNING): { rows: BoardRow[]; multiples: Map<string, number>; overall: number; table: { name: string; live_n: number; multiple: number }[] } {
  const { byCategory, overall, table } = categoryMultiples(snap.protocols, t);
  const index = new Map(snap.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, Proto>();
  for (const slug of snap.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snap.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snap.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, s: scoreProtocol(p, snap.as_of, byCategory, overall, t) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const rows: BoardRow[] = scored.map((x, i) => ({
    rank: i + 1,
    slug: x.p.slug,
    name: x.p.name,
    category: x.p.category,
    chains: x.p.chains,
    tvl_usd: x.p.tvl_usd,
    change_7d: x.p.change_7d,
    age_days: x.s.age_days,
    watch: snap.watchlist.includes(x.p.slug),
    implied_value_usd: x.s.implied,
    category_multiple: x.s.category_multiple,
    growth_multiplier: x.s.growth_mult,
    chain_multiplier: x.s.chain_mult,
    maturity_multiplier: x.s.maturity_mult,
    farm_steps: farmPlan(x.p, x.s.age_days).map(joinStep),
  }));
  return { rows, multiples: byCategory, overall, table };
}

/** One farm step as a single string: action, then cost and time, 20 to 600 characters. */
export function joinStep(step: { text: string; cost: string; time: string }): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position and check the protocol's own page for updates.`;
  return s;
}

function firstChain(p: Proto): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function secondChain(p: Proto): string | null {
  return p.chains.length > 1 ? p.chains[1]! : null;
}

/** Capital for one farm position, from the protocol's own TVL. */
function capitalFor(p: Proto): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** Hold length in days, from the protocol's age: younger protocols need a longer qualifying window. */
function holdFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's core action, in words a farmer can follow. */
function coreAction(p: Proto, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Lend $${capital} of USDC into ${name} on ${chain} and leave the deposit earning.`;
  }
  if (c.includes('dex') || c.includes('leveraged farm')) {
    return `Add $${capital} of liquidity to ${name}'s deepest pool on ${chain} and hold the LP tokens.`;
  }
  if (c.includes('yield') || c.includes('yield aggregator')) {
    return `Deposit $${capital} of USDC into ${name}'s highest-yield vault on ${chain} and keep the receipt.`;
  }
  if (c.includes('bridge') || c.includes('cross chain')) {
    return `Bridge $${capital} of USDC to ${chain} through ${name}, then put the bridged funds to work in its app.`;
  }
  if (c.includes('staking') || c.includes('restak')) {
    return `Stake $${capital} of the chain's staking asset through ${name} and keep the staking receipt.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) {
    return `Post $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  }
  if (c.includes('prediction')) {
    return `Fund ${name} with $${capital} and take one position in an active market.`;
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return `Deposit $${capital} into a ${name} vault on ${chain} and hold the vault shares.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  }
  if (c.includes('basis')) {
    return `Deposit $${capital} into ${name}'s basis vault on ${chain} and keep the position open.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

export interface Step {
  text: string;
  cost: string;
  time: string;
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a time.
 * Every step is derived from the protocol's own record (category, chains, TVL,
 * age); no name is ever special-cased.
 */
export function farmPlan(p: Proto, age: number | null): Step[] {
  const chain = firstChain(p);
  const chain2 = secondChain(p);
  const capital = capitalFor(p);
  const hold = holdFor(age);
  const small = Math.max(25, Math.round(capital / 2));
  return [
    {
      text: `Open a fresh wallet that holds only this farm, and write its seed phrase on paper and store it offline.`,
      cost: 'under $3 of gas to fund it',
      time: '5 minutes',
    },
    {
      text: coreAction(p, capital, chain),
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text:
        chain2 !== null
          ? `Repeat the position on a second chain, ${chain2}, with $${small}, so the farm touches two networks.`
          : `Add a second position of $${small} in the same pool to deepen the footprint without a new wallet.`,
      cost: `$${small} of capital and about $4 of gas`,
      time: '10 minutes',
    },
    {
      text: `Do one qualifying action every week: a deposit, a borrow, a swap, a vote, or a claim.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity lands in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Check the protocol's own points or rewards page once a week and note any new task it lists.`,
      cost: 'no fee to check',
      time: '5 minutes a week',
    },
    {
      text: `When a claim opens, use only the link the protocol itself publishes, and never pay a fee to claim.`,
      cost: 'gas only, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Keep a farm log with the wallet, the dates and every transaction hash, so you can repeat or unwind the position.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** Live-token protocols by market cap, set aside with the market's own values. */
export function liveRows(snap: Snap): LiveRow[] {
  return snap.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snap: Snap, t: ModelTuning = TUNING): { board: BoardRow[]; radar: RadarData } {
  const { rows, table } = buildBoard(snap, t);
  const live = liveRows(snap);
  const early = rows.filter((r) => !snap.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snap.as_of,
    source: snap.source,
    floor_usd: snap.floor_usd,
    model_version: MODEL_VERSION,
    tuning: t,
    watchlist_size: snap.watchlist.length,
    board_size: rows.length,
    early_size: early,
    live_size: live.length,
    categories: table,
    rows,
    live,
  };
  return { board: rows, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnap(text: string): Snap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null. */
export function boardProblem(board: BoardRow[], snap: Snap): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snap.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The dashboard's dataset as one script: no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

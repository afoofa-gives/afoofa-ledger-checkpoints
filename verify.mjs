// scripts/verify.ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// src/canonical-json.ts
function canonicalJson(value) {
  return serialize(value, "$");
}
function serialize(value, path) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      }
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new TypeError(`canonicalJson: unsafe integer at ${path}`);
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => serialize(item, `${path}[${i}]`)).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonicalJson: only plain objects are allowed at ${path}`);
      }
      const record = value;
      const keys = Object.keys(record).sort();
      const parts = [];
      for (const key of keys) {
        const item = record[key];
        if (item === void 0) {
          throw new TypeError(`canonicalJson: undefined value at ${path}.${key}`);
        }
        parts.push(`${JSON.stringify(key)}:${serialize(item, `${path}.${key}`)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}

// src/verify-export.ts
var EXPORT_FORMAT = "afoofa-ledger-export";
var GENESIS = "0".repeat(64);
var ANNUAL_CAP_DOLLARS = 365;
var WINDOW_MS = 365 * 864e5;
async function verifyExport(files2, options) {
  const problems = [];
  for (const f of files2) {
    if (f.format !== EXPORT_FORMAT || f.version !== 1 || !Array.isArray(f.entries)) {
      problems.push({ check: "format", message: `${f.month ?? "a file"} isn't an afoofa ledger export (version 1)` });
    }
  }
  const entries = [...files2].sort((a, b) => a.month < b.month ? -1 : 1).flatMap((f) => f.entries ?? []);
  const result = {
    ok: false,
    entries: entries.length,
    withheld: entries.filter((e) => e.v === 1).length,
    headId: 0,
    headHash: GENESIS,
    checkpoint: options.checkpoint ? "not_reached" : "none",
    rulesChecked: false,
    problems
  };
  if (problems.length) return result;
  let prev = GENESIS;
  for (const [i, e] of entries.entries()) {
    if (e.id !== i + 1) {
      problems.push({ entryId: e.id, check: "chain", message: `expected entry ${i + 1} here, found ${e.id} (an entry is missing or out of order)` });
      return result;
    }
    if (e.prevHash !== prev) {
      problems.push({ entryId: e.id, check: "chain", message: "doesn't link to the entry before it" });
      return result;
    }
    if (e.v === 2) {
      const { hash, ...content } = e;
      if (await options.sha256(e.prevHash + canonicalJson(content)) !== hash) {
        problems.push({ entryId: e.id, check: "chain", message: "its contents don't match its hash" });
        return result;
      }
    } else if (e.v !== 1 || !/^[0-9a-f]{64}$/.test(e.hash)) {
      problems.push({ entryId: e.id, check: "format", message: "isn't a v1 or v2 entry" });
      return result;
    }
    prev = e.hash;
    result.headId = e.id;
    result.headHash = e.hash;
  }
  if (options.checkpoint) {
    const at = entries[options.checkpoint.entryId - 1];
    if (!at) {
      problems.push({ check: "checkpoint", message: `the export ends at entry ${result.headId}, before the checkpoint's entry ${options.checkpoint.entryId}` });
    } else if (at.hash !== options.checkpoint.hash) {
      result.checkpoint = "mismatch";
      problems.push({ entryId: at.id, check: "checkpoint", message: "its hash differs from the published checkpoint" });
    } else {
      result.checkpoint = "matched";
    }
  }
  if (result.withheld === 0) {
    result.rulesChecked = true;
    problems.push(...checkRules(entries));
  }
  result.ok = problems.length === 0;
  return result;
}
var int = (v) => typeof v === "number" ? v : 0;
function rank(rows) {
  return [...rows].sort((a, b) => b.votes - a.votes || (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0));
}
function checkRules(entries) {
  const problems = [];
  const capLines = /* @__PURE__ */ new Map();
  const balances = /* @__PURE__ */ new Map();
  const shortlists = /* @__PURE__ */ new Map();
  const castByCycle = /* @__PURE__ */ new Map();
  const accrued = /* @__PURE__ */ new Map();
  const closedPools = [];
  const carried = [];
  const closed = /* @__PURE__ */ new Map();
  const awards = /* @__PURE__ */ new Map();
  const paid = /* @__PURE__ */ new Map();
  const confirmations = /* @__PURE__ */ new Map();
  const currentConfirmation = /* @__PURE__ */ new Map();
  const payoutsByCycle = /* @__PURE__ */ new Map();
  const partnerBalance = /* @__PURE__ */ new Map();
  const pledges = /* @__PURE__ */ new Map();
  const pendingMatches = /* @__PURE__ */ new Map();
  const matched = /* @__PURE__ */ new Map();
  let rateInForce = null;
  const checkMatches = (closing, cycleId) => {
    const applied = pendingMatches.get(cycleId) ?? [];
    pendingMatches.delete(cycleId);
    const list = pledges.get(cycleId) ?? [];
    if (!list.length && !applied.length) return;
    const rate = applied.length ? int(applied[0].payload.rateBps) : rateInForce ?? 1e3;
    if (rate < 100 || rate > 1e3 || rateInForce !== null && rate !== rateInForce || applied.some((a) => int(a.payload.rateBps) !== rate)) {
      problems.push({ entryId: closing.id, check: "matches", message: `${cycleId}'s matches use the wrong operator fee rate` });
    }
    let base = Math.max(0, accrued.get(cycleId) ?? 0);
    const expected = [];
    for (const pl of list) {
      const target = Math.floor(base * pl.ratioBps / 1e4);
      const gross = Math.max(0, Math.min(target, pl.ceilingCents, partnerBalance.get(pl.partnerId) ?? 0));
      if (gross === 0) continue;
      partnerBalance.set(pl.partnerId, (partnerBalance.get(pl.partnerId) ?? 0) - gross);
      base -= Math.min(base, Math.ceil(gross * 1e4 / pl.ratioBps));
      expected.push({ pledgeId: pl.pledgeId, gross, fee: Math.floor(gross * rate / 1e4) });
    }
    const got = applied.map((a) => ({ pledgeId: String(a.payload.pledgeId), gross: int(a.payload.grossAppliedCents), fee: int(a.payload.operatorFeeCents) }));
    if (canonicalJson(got) !== canonicalJson(expected) || applied.some((a) => a.amountCents !== int(a.payload.grossAppliedCents) - int(a.payload.operatorFeeCents))) {
      problems.push({ entryId: closing.id, check: "matches", message: `${cycleId}'s matching grants don't follow from its pledges` });
    }
    matched.set(cycleId, applied.reduce((s, a) => s + a.amountCents, 0));
  };
  for (const e of entries) {
    const p = e.payload;
    switch (e.entryType) {
      case "payment_settled":
      case "refund":
      case "chargeback": {
        if (!e.account) break;
        const dollars = int(p.dollars);
        const lines = capLines.get(e.account) ?? [];
        const at = Date.parse(e.createdAt);
        lines.push({ at, dollars: e.entryType === "payment_settled" ? dollars : -dollars });
        capLines.set(e.account, lines);
        if (e.entryType === "payment_settled" && dollars > 0 && p.reverses === void 0) {
          const inWindow = lines.filter((l) => l.at > at - WINDOW_MS && l.at <= at).reduce((s, l) => s + l.dollars, 0);
          if (inWindow > ANNUAL_CAP_DOLLARS) {
            problems.push({ entryId: e.id, check: "cap", message: `${e.account} reaches $${inWindow} in a rolling year` });
          }
        }
        break;
      }
      case "fee_tier_evaluated":
        rateInForce = int(p.rateBps);
        break;
      case "match_received": {
        const net = int(p.netCents);
        if (net !== e.amountCents - int(p.processingFeeCents) || net < 0) {
          problems.push({ entryId: e.id, check: "matches", message: "a matching payment's net isn't its gross less Stripe's fee" });
        }
        partnerBalance.set(String(p.partnerId), (partnerBalance.get(String(p.partnerId)) ?? 0) + net);
        break;
      }
      case "match_pledged": {
        if (!e.cycleId || closed.has(e.cycleId)) problems.push({ entryId: e.id, check: "matches", message: `a pledge on ${e.cycleId}, which is already closed` });
        const list = pledges.get(e.cycleId ?? "") ?? [];
        list.push({ pledgeId: String(p.pledgeId), partnerId: String(p.partnerId), ratioBps: int(p.ratioBps), ceilingCents: int(p.ceilingCents) });
        pledges.set(e.cycleId ?? "", list);
        break;
      }
      case "match_applied": {
        const list = pendingMatches.get(e.cycleId ?? "") ?? [];
        list.push(e);
        pendingMatches.set(e.cycleId ?? "", list);
        break;
      }
      case "match_returned": {
        const id = String(p.partnerId);
        const balance = (partnerBalance.get(id) ?? 0) - e.amountCents;
        if (e.amountCents <= 0 || balance < 0) problems.push({ entryId: e.id, check: "matches", message: `${id} is returned more than its balance` });
        partnerBalance.set(id, balance);
        break;
      }
      case "cycle_opened": {
        const list = Array.isArray(p.shortlist) ? p.shortlist : [];
        if (e.cycleId) shortlists.set(e.cycleId, list.map((s) => s.projectId));
        break;
      }
      case "vote_accrued":
        if (e.cycleId) accrued.set(e.cycleId, (accrued.get(e.cycleId) ?? 0) + e.amountCents);
        break;
      case "vote_cast": {
        if (!e.account || !e.cycleId) break;
        const projectId = String(p.projectId);
        if (!shortlists.get(e.cycleId)?.includes(projectId)) {
          problems.push({ entryId: e.id, check: "votes", message: `a vote for ${projectId}, which isn't on ${e.cycleId}'s shortlist` });
        }
        if (closed.has(e.cycleId)) problems.push({ entryId: e.id, check: "votes", message: `a vote cast after ${e.cycleId} closed` });
        const c = castByCycle.get(e.cycleId) ?? { byProject: /* @__PURE__ */ new Map(), voters: /* @__PURE__ */ new Set() };
        c.byProject.set(projectId, (c.byProject.get(projectId) ?? 0) - e.votes);
        c.voters.add(e.account);
        castByCycle.set(e.cycleId, c);
        break;
      }
      case "cycle_closed": {
        const cycleId = e.cycleId;
        checkMatches(e, cycleId);
        const c = castByCycle.get(cycleId);
        const expected = rank((shortlists.get(cycleId) ?? []).map((projectId) => ({ projectId, votes: c?.byProject.get(projectId) ?? 0 })));
        const recorded = (Array.isArray(p.tally) ? p.tally : []).map((r2) => ({ projectId: r2.projectId, votes: r2.votes }));
        const votesCast = expected.reduce((s, r2) => s + r2.votes, 0);
        if (canonicalJson(rank(recorded)) !== canonicalJson(expected) || p.votesCast !== votesCast || p.voters !== (c?.voters.size ?? 0)) {
          problems.push({ entryId: e.id, check: "tally", message: `${cycleId}'s recorded tally doesn't match the votes cast` });
        }
        let accruedSoFar = 0;
        for (const [id, cents] of accrued) if (id <= cycleId) accruedSoFar += cents;
        const locked = closedPools.filter((x) => x.cycleId < cycleId).reduce((s, x) => s + x.amountCents, 0);
        const carriedIn = carried.filter((x) => x.cycleId < cycleId).reduce((s, x) => s + x.cents, 0);
        let matchedSoFar = 0;
        for (const [id, cents] of matched) if (id <= cycleId) matchedSoFar += cents;
        const pool = accruedSoFar + matchedSoFar - locked + carriedIn;
        const own = accrued.get(cycleId) ?? 0;
        const ownMatched = matched.get(cycleId) ?? 0;
        if (e.amountCents !== pool || p.ownPoolCents !== own || int(p.matchedCents) !== ownMatched || p.carryInCents !== pool - own - ownMatched) {
          problems.push({ entryId: e.id, check: "pool", message: `${cycleId}'s pool should be ${pool}\xA2 (${own}\xA2 its own), not ${e.amountCents}\xA2` });
        }
        closedPools.push({ cycleId, amountCents: e.amountCents });
        closed.set(cycleId, { tally: recorded, poolCents: e.amountCents });
        break;
      }
      case "winner_confirmed": {
        const cycleId = e.cycleId;
        const c = closed.get(cycleId);
        if (currentConfirmation.has(cycleId)) {
          problems.push({ entryId: e.id, check: "winners", message: `${cycleId} is confirmed again without its earlier confirmation being reversed` });
        }
        const excluded = new Set((Array.isArray(p.excluded) ? p.excluded : []).map((x) => x.projectId));
        const winners = Array.isArray(p.winners) ? p.winners : [];
        if (!c) {
          problems.push({ entryId: e.id, check: "winners", message: `${cycleId} was confirmed before it closed` });
        } else {
          const eligible = rank(c.tally.filter((t) => !excluded.has(t.projectId) && t.votes > 0));
          const top = eligible[0]?.votes ?? 0;
          const tied = top > 0 ? eligible.filter((t) => t.votes === top) : [];
          const share = tied.length ? Math.floor(c.poolCents / tied.length) : 0;
          const expected = tied.map((t) => ({ projectId: t.projectId, votes: t.votes, amountCents: share }));
          const got = winners.map((w) => ({ projectId: w.projectId, votes: w.votes, amountCents: w.amountCents }));
          const carry = c.poolCents - share * tied.length;
          if (canonicalJson(got) !== canonicalJson(expected) || p.carriedCents !== carry || p.tie !== tied.length > 1 || e.amountCents !== share * tied.length) {
            problems.push({ entryId: e.id, check: "winners", message: `${cycleId}'s winners don't follow from its tally and pool` });
          }
        }
        for (const w of winners) awards.set(`${cycleId}:${w.projectId}`, w.amountCents);
        carried.push({ cycleId, cents: int(p.carriedCents) });
        confirmations.set(e.id, { cycleId, projectIds: winners.map((w) => w.projectId) });
        currentConfirmation.set(cycleId, e.id);
        break;
      }
      case "admin_correction": {
        const target = confirmations.get(int(p.reverses));
        if (!target) break;
        const { cycleId } = target;
        if (currentConfirmation.get(cycleId) !== int(p.reverses)) {
          problems.push({ entryId: e.id, check: "winners", message: `reverses a confirmation of ${cycleId} that isn't its current one` });
          break;
        }
        if ((payoutsByCycle.get(cycleId) ?? 0) > 0) {
          problems.push({ entryId: e.id, check: "winners", message: `reverses ${cycleId}'s confirmation after a payout on it` });
        }
        if (closedPools.some((x) => x.cycleId > cycleId)) {
          problems.push({ entryId: e.id, check: "winners", message: `reverses ${cycleId}'s confirmation after a later cycle closed` });
        }
        for (const projectId of target.projectIds) awards.delete(`${cycleId}:${projectId}`);
        const at = carried.findIndex((x) => x.cycleId === cycleId);
        if (at >= 0) carried.splice(at, 1);
        currentConfirmation.delete(cycleId);
        break;
      }
      case "payout_sent": {
        payoutsByCycle.set(e.cycleId, (payoutsByCycle.get(e.cycleId) ?? 0) + 1);
        const key = `${e.cycleId}:${String(p.projectId)}`;
        const total = (paid.get(key) ?? 0) + e.amountCents;
        paid.set(key, total);
        const award = awards.get(key);
        if (award === void 0) problems.push({ entryId: e.id, check: "payouts", message: `a payout for ${key}, which has no award` });
        else if (total > award) problems.push({ entryId: e.id, check: "payouts", message: `${key} is paid ${total}\xA2 on an award of ${award}\xA2` });
        break;
      }
    }
    if (e.account && e.votes !== 0) {
      const balance = (balances.get(e.account) ?? 0) + e.votes;
      balances.set(e.account, balance);
      if (e.entryType === "vote_cast" && balance < 0) {
        problems.push({ entryId: e.id, check: "votes", message: `${e.account} casts more votes than they have` });
      }
    }
  }
  return problems;
}

// scripts/verify.ts
var sha256 = async (text) => createHash("sha256").update(text).digest("hex");
async function load(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`${source}: ${res.status}`);
    return res.json();
  }
  return JSON.parse(await readFile(source, "utf8"));
}
var args = process.argv.slice(2).filter((a) => a !== "--");
var take = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? void 0 : args.splice(i, 2)[1];
};
var site = take("--site");
var checkpointSource = take("--checkpoint");
var sources = [...args];
if (site) {
  const index = await load(new URL("/transparency/ledger/index.json", site).href);
  sources.push(...index.months.map((m) => new URL(m.url, site).href));
}
if (!sources.length) {
  console.error("Pass monthly export files, or --site <url>. See the comment at the top of this script.");
  process.exit(2);
}
var files = await Promise.all(sources.map(load));
var checkpoint = checkpointSource ? await load(checkpointSource) : void 0;
var r = await verifyExport(files, { sha256, checkpoint });
console.log(`Entries: ${r.entries} (${r.withheld} from before format v2, contents withheld)`);
console.log(`Head: entry ${r.headId}, ${r.headHash}`);
console.log(`Checkpoint: ${r.checkpoint}${checkpoint ? ` (entry ${checkpoint.entryId}, ${checkpoint.hash})` : ""}`);
console.log(`Rules: ${r.rulesChecked ? "checked" : "not checked (entries from before format v2 are present)"}`);
for (const p of r.problems) console.log(`PROBLEM [${p.check}]${p.entryId ? ` entry ${p.entryId}` : ""}: ${p.message}`);
console.log(r.ok ? "OK: the export verifies." : "FAILED.");
process.exit(r.ok ? 0 : 1);

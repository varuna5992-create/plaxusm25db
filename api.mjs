// PLAXUS M25 — shared cloud backend (Netlify Functions v2 + Netlify Blobs)
// One master copy of the dashboard data lives here. The CR link writes to it
// (passcode-protected, verified on the server); the class link and the CR link
// both read from it, so every change shows up everywhere.

import { getStore } from "@netlify/blobs";
import { createHash, scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/*" };

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const CR_SECTIONS = [
  "announcements", "deadlines", "guidelines", "creativeWorks", "classBlogs",
  "timetable", "marqueeText", "userBg", "classPhoto",
];
const STATE_KEYS = [...CR_SECTIONS, "scholars", "suggestions"];
const BLOOD = ["", "A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

/* ---------- helpers ---------- */
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const str = (v, max, fallback = "") =>
  typeof v === "string" ? v.trim().slice(0, max) : fallback;
const sha = (s) => createHash("sha256").update(String(s)).digest();
const safeEq = (a, b) => a.length === b.length && timingSafeEqual(a, b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);

function istDate(opts) {
  return new Date().toLocaleDateString("en-US", { timeZone: "Asia/Kolkata", ...opts });
}

/* ---------- validation ---------- */
function validSection(key, v) {
  switch (key) {
    case "marqueeText": return typeof v === "string" && v.length <= 600;
    case "userBg": return typeof v === "string" && v.length <= 2048;
    case "classPhoto":
      return typeof v === "string" && v.length <= 1_200_000 &&
        (v === "" || v.startsWith("data:image/") || /^https?:\/\//.test(v));
    case "timetable":
      return isObj(v) && Object.entries(v).every(([d, slots]) =>
        DAYS.includes(d) && Array.isArray(slots) && slots.length <= 12 &&
        slots.every((s) => typeof s === "string" && s.length <= 60));
    default:
      return Array.isArray(v) && v.length <= 500 && v.every(isObj);
  }
}

function cleanScholar(s) {
  return {
    roll: str(s.roll, 24).toUpperCase(),
    name: str(s.name, 80),
    dob: str(s.dob, 12),
    email: str(s.email, 120),
    blood: BLOOD.includes(s.blood) ? s.blood : "",
    phone: str(s.phone, 20),
    ...(typeof s.photo === "string" && s.photo.startsWith("data:image/") && s.photo.length <= 80_000
      ? { photo: s.photo } : {}),
  };
}

function mergeLikes(prev = [], next = []) {
  const likes = new Map(prev.map((x) => [x.id, Number(x.likes) || 0]));
  return next.map((x) => ({ ...x, likes: Math.max(Number(x.likes) || 0, likes.get(x.id) || 0) }));
}

/* ---------- auth ---------- */
async function checkPass(store, pass) {
  if (typeof pass !== "string" || !pass || pass.length > 200) return false;
  const cfg = await store.get("config", { type: "json" });
  if (cfg && cfg.salt && cfg.hash) {
    const h = scryptSync(pass, Buffer.from(cfg.salt, "hex"), 32);
    return safeEq(h, Buffer.from(cfg.hash, "hex"));
  }
  const fallback = process.env.PLAXUS_CR_PASSCODE || "m25nitc";
  return safeEq(sha(pass), sha(fallback));
}

async function requireCR(req, store) {
  let pass = req.headers.get("x-cr-passcode") || "";
  try { pass = decodeURIComponent(pass); } catch { /* keep raw */ }
  if (await checkPass(store, pass)) return true;
  await sleep(700); // slows down guessing
  return false;
}

/* ---------- storage with optimistic concurrency ---------- */
async function readState(store) {
  return store.get("state", { type: "json" });
}

async function mutate(store, fn) {
  for (let attempt = 0; attempt < 15; attempt++) {
    if (attempt) await sleep(Math.random() * 40 * attempt); // jittered backoff
    const cur = await store.getWithMetadata("state", { type: "json" });
    const base = cur && cur.data ? cur.data : null;
    const draft = base ? structuredClone(base) : null;
    const next = fn(draft);
    if (!next) return base; // fn declined to change anything
    next.version = (base ? base.version || 0 : 0) + 1;
    next.updatedAt = Date.now();
    const opts = cur && cur.etag ? { onlyIfMatch: cur.etag } : { onlyIfNew: true };
    const res = await store.setJSON("state", next, opts);
    if (!res || res.modified !== false) return next;
  }
  throw new Error("busy");
}

/* ---------- CR operations (passcode required) ---------- */
function crOp(store, body) {
  switch (body.op) {
    case "seed":
      return mutate(store, (cur) => {
        if (cur) return null; // never overwrite existing data
        const st = isObj(body.state) ? body.state : {};
        const out = { scholars: [], suggestions: [] };
        for (const k of STATE_KEYS) {
          if (st[k] !== undefined && (k === "scholars" || k === "suggestions" ? Array.isArray(st[k]) : validSection(k, st[k]))) out[k] = st[k];
        }
        out.scholars = (out.scholars || []).slice(0, 500).filter(isObj).map(cleanScholar);
        return out;
      });

    case "save":
      return mutate(store, (cur) => {
        if (!cur) throw new Error("not-seeded");
        const sections = isObj(body.sections) ? body.sections : {};
        for (const k of Object.keys(sections)) {
          if (!CR_SECTIONS.includes(k)) throw new Error(`bad-section:${k}`);
          if (!validSection(k, sections[k])) throw new Error(`invalid:${k}`);
          cur[k] = (k === "creativeWorks" || k === "classBlogs")
            ? mergeLikes(cur[k], sections[k]) : sections[k];
        }
        return cur;
      });

    case "delete_suggestion":
      return mutate(store, (cur) => {
        if (!cur) throw new Error("not-seeded");
        cur.suggestions = (cur.suggestions || []).filter((s) => s.id !== body.id);
        return cur;
      });

    case "delete_reply":
      return mutate(store, (cur) => {
        if (!cur) throw new Error("not-seeded");
        const s = (cur.suggestions || []).find((x) => x.id === body.id);
        if (s && Array.isArray(s.responses) && Number.isInteger(body.index)) s.responses.splice(body.index, 1);
        return cur;
      });

    case "scholar_save":
      return mutate(store, (cur) => {
        if (!cur) throw new Error("not-seeded");
        const sch = isObj(body.scholar) ? body.scholar : {};
        const roll = str(sch.roll, 24).toUpperCase();
        const name = str(sch.name, 80);
        if (!roll || !name) throw new Error("invalid:scholar");
        const orig = str(body.origRoll, 24).toUpperCase();
        const list = cur.scholars || [];
        const idx = list.findIndex((s) => s.roll === (orig || roll));
        if (idx === -1 && list.some((s) => s.roll === roll)) throw new Error("duplicate-roll");
        if (idx !== -1 && roll !== orig && list.some((s, i) => i !== idx && s.roll === roll)) throw new Error("duplicate-roll");
        const merged = cleanScholar({ ...(idx !== -1 ? list[idx] : {}), roll, name, dob: sch.dob, email: sch.email });
        if (idx !== -1) list[idx] = merged; else list.push(merged);
        cur.scholars = list;
        return cur;
      });

    case "scholar_remove":
      return mutate(store, (cur) => {
        if (!cur) throw new Error("not-seeded");
        cur.scholars = (cur.scholars || []).filter((s) => s.roll !== str(body.roll, 24).toUpperCase());
        return cur;
      });

    default:
      throw new Error("unknown-op");
  }
}

/* ---------- public operations (no passcode) ---------- */
function actOp(store, body) {
  return mutate(store, (cur) => {
    if (!cur) throw new Error("not-seeded");
    switch (body.op) {
      case "like": {
        const key = { creative: "creativeWorks", blog: "classBlogs", suggestion: "suggestions" }[body.kind];
        if (!key) throw new Error("unknown-kind");
        const item = (cur[key] || []).find((x) => x.id === body.id);
        if (!item) throw new Error("not-found");
        item.likes = (Number(item.likes) || 0) + 1;
        return cur;
      }
      case "post_suggestion": {
        const title = str(body.title, 140);
        const text = str(body.body, 2000);
        if (!title || !text) throw new Error("invalid:suggestion");
        cur.suggestions = cur.suggestions || [];
        cur.suggestions.unshift({
          id: newId(), author: str(body.author, 60, "Scholar") || "Scholar", title, body: text,
          date: istDate({ month: "short", day: "numeric", year: "numeric" }), likes: 1, responses: [],
        });
        cur.suggestions = cur.suggestions.slice(0, 300);
        return cur;
      }
      case "reply": {
        const text = str(body.text, 1000);
        if (!text) throw new Error("invalid:reply");
        const s = (cur.suggestions || []).find((x) => x.id === body.id);
        if (!s) throw new Error("not-found");
        s.responses = s.responses || [];
        if (s.responses.length >= 200) throw new Error("too-many-replies");
        s.responses.push({
          author: str(body.author, 60, "Studio Member") || "Studio Member", text,
          date: istDate({ month: "short", day: "numeric" }),
        });
        return cur;
      }
      case "scholar_update": {
        const s = (cur.scholars || []).find((x) => x.roll === str(body.roll, 24).toUpperCase());
        if (!s) throw new Error("not-found");
        if (body.blood !== undefined) {
          if (!BLOOD.includes(body.blood)) throw new Error("invalid:blood");
          s.blood = body.blood;
        }
        if (body.phone !== undefined) s.phone = str(body.phone, 20);
        if (body.photo !== undefined) {
          if (typeof body.photo !== "string" || !body.photo.startsWith("data:image/") || body.photo.length > 80_000) throw new Error("invalid:photo");
          s.photo = body.photo;
        }
        return cur;
      }
      default:
        throw new Error("unknown-op");
    }
  });
}

/* ---------- request handler ---------- */
const ERROR_STATUS = {
  "not-seeded": [409, "The dashboard has not been published yet by the CR."],
  "duplicate-roll": [409, "A scholar with this roll number already exists."],
  "not-found": [404, "Item not found (it may have been removed)."],
  busy: [503, "Server is busy, please try again."],
};

export async function handle(req, store) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  try {
    if (req.method === "GET" && path === "/api/state") {
      const st = await readState(store);
      if (!st) return json({ empty: true });
      if (Number(url.searchParams.get("v")) === st.version) return json({ unchanged: true, version: st.version });
      return json({ state: st });
    }

    if (req.method !== "POST") return json({ error: "Not found" }, 404);

    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: "Payload too large" }, 413);
    let body;
    try { body = JSON.parse(raw || "{}"); } catch { return json({ error: "Bad JSON" }, 400); }
    if (!isObj(body)) return json({ error: "Bad request" }, 400);

    if (path === "/api/verify") {
      const ok = await checkPass(store, str(body.passcode, 200));
      if (!ok) { await sleep(700); return json({ ok: false }, 401); }
      return json({ ok: true });
    }

    if (path === "/api/cr") {
      if (!(await requireCR(req, store))) return json({ error: "Wrong or expired passcode." }, 401);
      if (body.op === "set_passcode") {
        const np = str(body.newPasscode, 200);
        if (np.length < 4) return json({ error: "Passcode must be at least 4 characters." }, 400);
        const salt = randomBytes(16);
        await store.setJSON("config", { salt: salt.toString("hex"), hash: scryptSync(np, salt, 32).toString("hex") });
        return json({ ok: true });
      }
      const state = await crOp(store, body);
      return json({ state });
    }

    if (path === "/api/act") {
      const state = await actOp(store, body);
      return json({ state });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    const msg = String(e && e.message || e);
    const known = ERROR_STATUS[msg];
    if (known) return json({ error: known[1] }, known[0]);
    if (msg.startsWith("invalid") || msg.startsWith("bad-section") || msg.startsWith("unknown")) return json({ error: "Invalid request: " + msg }, 400);
    console.error("API error:", e);
    return json({ error: "Server error" }, 500);
  }
}

export default async (req) =>
  handle(req, getStore({ name: "plaxus-db", consistency: "strong" }));

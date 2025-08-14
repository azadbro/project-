import * as functions from "firebase-functions";
import admin from "firebase-admin";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";

admin.initializeApp();
const db = admin.database();

// Defaults provided by user (can be overridden via functions:config or env)
const DEFAULT_BOT_TOKEN = "8255214896:AAFFHGVMOR3tWVeUHu_GX2uCVynqlsg9BwM";
const DEFAULT_ADMINS = ["6434588999"]; // Telegram user IDs to auto-mark as admins
const DEFAULT_BOT_USERNAME = "trxbyadsbot";

// Helpers
function parseInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const user = JSON.parse(params.get("user") || "{}");
    const start_param = params.get("start_param");
    return { user, start_param };
  } catch (e) {
    return { user: {}, start_param: null };
  }
}

function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return false;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return false;
  params.delete("hash");
  const payload = Array.from(params.entries())
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secretKey = crypto
    .createHash("sha256")
    .update("WebAppData" + botToken)
    .digest();
  const hmac = crypto.createHmac("sha256", secretKey).update(payload).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(hash, "hex"));
}

export const verifyTelegram = functions.https.onRequest(async (req, res) => {
  // In production, verify hash per Telegram docs using bot token.
  // Then mint a Firebase custom token for the Telegram user id.
  try {
    const { initData } = req.body || {};
    const { user } = parseInitData(initData || "");

    const botToken = (functions.config().bot && functions.config().bot.token) || process.env.BOT_TOKEN || DEFAULT_BOT_TOKEN;
    let uid = (verifyTelegramInitData(initData, botToken) && user?.id) ? String(user.id) : `dev-${crypto.randomUUID()}`;
    const customToken = await admin.auth().createCustomToken(uid, { tg: true });

    // Ensure admin flag for pre-approved IDs
    if (DEFAULT_ADMINS.includes(uid)) {
      await db.ref(`admins/${uid}`).set(true);
    }

    res.set("Access-Control-Allow-Origin", "*");
    res.json({ token: customToken });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Express API with auth middleware using Firebase ID tokens
const api = express();
api.use(cors({ origin: true }));
api.use(express.json());

// Support both "/api/..." and "/..." paths depending on hosting/rewrite setup
api.use((req, _res, next) => {
  if (req.url.startsWith('/api/')) {
    req.url = req.url.replace(/^\/api\//, '/');
  }
  next();
});

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) return res.status(401).json({ error: "Missing Authorization header" });
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

api.post("/reward/ad", authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  const settingsSnap = await db.ref("settings").get();
  const settings = settingsSnap.val() || { adRewardTRX: 0.005, referralCommissionPct: 5, adCooldownSec: 30 };
  const reward = Number(settings.adRewardTRX || 0.005);

  // cooldown check
  const userRef = db.ref(`users/${uid}`);
  await userRef.transaction((u) => {
    if (!u) return u;
    if (u.banned) return u;
    if ((u.cooldown || 0) > Date.now()) return u; // still cooling
    const balances = u.balances || { total: 0, ads: 0, referrals: 0, tasks: 0 };
    balances.total = Number((balances.total || 0) + reward);
    balances.ads = Number((balances.ads || 0) + reward);
    u.balances = balances;
    u.cooldown = Date.now() + (Number(settings.adCooldownSec || 30) * 1000);
    return u;
  });

  await db.ref(`transactions/${uid}`).push({ type: "earn_ad", amount: reward, status: "Completed", createdAt: Date.now() });

  // commission
  const u = (await userRef.get()).val();
  const referrerId = u?.referral?.referrerId;
  if (referrerId && referrerId !== uid) {
    const commission = +(reward * (Number(settings.referralCommissionPct || 5) / 100)).toFixed(6);
    await db.ref(`users/${referrerId}`).transaction((r) => {
      if (!r) return r;
      if (r.banned) return r;
      const bal = r.balances || { total: 0, ads: 0, referrals: 0, tasks: 0 };
      bal.total = Number((bal.total || 0) + commission);
      bal.referrals = Number((bal.referrals || 0) + commission);
      r.balances = bal;
      const ref = r.referral || { totalRefs: 0, earned: 0, commission: 0 };
      ref.commission = Number((ref.commission || 0) + commission);
      r.referral = ref;
      return r;
    });
    await db.ref(`transactions/${referrerId}`).push({ type: "commission", fromUserId: uid, amount: commission, status: "Completed", createdAt: Date.now() });
  }

  res.json({ ok: true });
});

api.post("/withdraw", authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  const { amount, uid: binanceUid, asset, method } = req.body || {};
  const settings = (await db.ref("settings").get()).val() || { minWithdrawalTRX: 0.5 };
  const min = Number(settings.minWithdrawalTRX || 0.5);
  if (Number(amount) < min) return res.status(400).json({ error: "Below minimum" });

  const userRef = db.ref(`users/${uid}`);
  let accepted = false;
  await userRef.transaction((u) => {
    if (!u) return u;
    const bal = u.balances || { total: 0 };
    if ((bal.total || 0) < Number(amount)) return u;
    bal.total = Number((bal.total || 0) - Number(amount));
    u.balances = bal;
    accepted = true;
    return u;
  });
  if (!accepted) return res.status(400).json({ error: "Insufficient balance" });

  await db.ref(`withdrawals`).push({ userId: uid, amount: Number(amount), uid: String(binanceUid || ""), asset: asset || "TRX", method: method || "binance", status: "Pending", createdAt: Date.now() });
  await db.ref(`transactions/${uid}`).push({ type: "withdraw", amount: -Number(amount), status: "Pending", createdAt: Date.now() });
  res.json({ ok: true });
});

api.post("/task/submit", authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  const { taskId } = req.body || {};
  if (!taskId) return res.status(400).json({ error: "Missing taskId" });
  await db.ref(`taskSubmissions/${taskId}`).push({ taskId, userId: uid, status: "Pending", createdAt: Date.now() });
  res.json({ ok: true });
});

api.post("/referral/credit-signup", authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  const uSnap = await db.ref(`users/${uid}`).get();
  if (!uSnap.exists()) return res.status(404).json({ error: "User not found" });
  const u = uSnap.val();
  const referrerId = u?.referral?.referrerId;
  if (!referrerId || referrerId === uid) return res.json({ ok: true, skipped: true });
  const already = (await db.ref(`referralRewards/${referrerId}/${uid}`).get()).exists();
  if (already) return res.json({ ok: true, already: true });
  const settings = (await db.ref("settings").get()).val() || { referralRewardTRX: 0.05 };
  const reward = Number(settings.referralRewardTRX || 0.05);
  // record mapping for dashboard
  await db.ref(`referrals/${referrerId}/${uid}`).set({ createdAt: Date.now() });
  await db.ref(`users/${referrerId}`).transaction((r) => {
    if (!r) return r;
    const bal = r.balances || { total: 0, ads: 0, referrals: 0, tasks: 0 };
    bal.total = Number((bal.total || 0) + reward);
    bal.referrals = Number((bal.referrals || 0) + reward);
    r.balances = bal;
    const ref = r.referral || { totalRefs: 0, earned: 0, commission: 0 };
    ref.totalRefs = Number((ref.totalRefs || 0) + 1);
    ref.earned = Number((ref.earned || 0) + reward);
    r.referral = ref;
    return r;
  });
  await db.ref(`referralRewards/${referrerId}/${uid}`).set({ amount: reward, createdAt: Date.now() });
  await db.ref(`transactions/${referrerId}`).push({ type: "referral", fromUserId: uid, amount: reward, status: "Completed", createdAt: Date.now() });
  res.json({ ok: true });
});

api.post("/task/verify-telegram", authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  const { taskId } = req.body || {};
  if (!taskId) return res.status(400).json({ error: "Missing taskId" });
  const taskSnap = await db.ref(`tasks/${taskId}`).get();
  if (!taskSnap.exists()) return res.status(404).json({ error: "Task not found" });
  const task = taskSnap.val();
  const link = String(task.link || "");
  const m = link.match(/t\.me\/(.+)$/);
  const channel = m ? m[1] : null;
  if (!channel) return res.status(400).json({ error: "Invalid channel link" });
  const botToken = (functions.config().bot && functions.config().bot.token) || process.env.BOT_TOKEN || DEFAULT_BOT_TOKEN;
  if (!botToken) return res.status(500).json({ error: "Missing bot token" });
  const url = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=@${channel}&user_id=${uid}`;
  try {
    const fetchRes = await fetch(url);
    const data = await fetchRes.json();
    const status = data?.result?.status;
    const okStatuses = ["member", "administrator", "creator"];
    if (!okStatuses.includes(status)) return res.status(400).json({ error: "Not a member" });
  } catch (e) {
    return res.status(500).json({ error: "Verification failed" });
  }

  // prevent double credit
  const claimedRef = db.ref(`taskRewardsClaimed/${taskId}/${uid}`);
  const already = (await claimedRef.get()).exists();
  if (already) return res.json({ ok: true, already: true });

  const reward = Number(task.rewardTRX || 0);
  if (reward > 0) {
    await db.ref(`users/${uid}`).transaction((u) => {
      if (!u) return u;
      const bal = u.balances || { total: 0, ads: 0, referrals: 0, tasks: 0 };
      bal.total = Number((bal.total || 0) + reward);
      bal.tasks = Number((bal.tasks || 0) + reward);
      u.balances = bal;
      return u;
    });
    await db.ref(`transactions/${uid}`).push({ type: "task", taskId, amount: reward, status: "Completed", createdAt: Date.now() });
  }
  await claimedRef.set({ at: Date.now() });

  // lifetime commission to referrer
  const u = (await db.ref(`users/${uid}`).get()).val();
  const referrerId = u?.referral?.referrerId;
  if (referrerId && referrerId !== uid && reward > 0) {
    const commissionPct = Number((await db.ref("settings").get()).val()?.referralCommissionPct || 5);
    const commission = +(reward * commissionPct / 100).toFixed(6);
    await db.ref(`users/${referrerId}`).transaction((r)=>{
      if (!r) return r;
      const bal = r.balances || { total: 0, ads: 0, referrals: 0, tasks: 0 };
      bal.total = Number((bal.total || 0) + commission);
      bal.referrals = Number((bal.referrals || 0) + commission);
      r.balances = bal;
      const ref = r.referral || { totalRefs: 0, earned: 0, commission: 0 };
      ref.commission = Number((ref.commission || 0) + commission);
      r.referral = ref;
      return r;
    });
    await db.ref(`transactions/${referrerId}`).push({ type: "commission", fromUserId: uid, amount: commission, status: "Completed", createdAt: Date.now() });
  }

  res.json({ ok: true });
});

api.post("/admin/withdraw/:id/:action", authMiddleware, async (req, res) => {
  const adminFlag = (await db.ref(`admins/${req.user.uid}`).get()).val() === true;
  if (!adminFlag) return res.status(403).json({ error: "Forbidden" });
  const { id, action } = req.params;
  const wSnap = await db.ref(`withdrawals/${id}`).get();
  if (!wSnap.exists()) return res.status(404).json({ error: "Not found" });
  const w = wSnap.val();
  if (action === "approve") {
    await db.ref(`withdrawals/${id}`).update({ status: "Approved" });
    await db.ref(`transactions/${w.userId}`).push({ type: "withdraw", amount: -Number(w.amount), status: "Approved", createdAt: Date.now() });
  } else if (action === "reject") {
    await db.ref(`withdrawals/${id}`).update({ status: "Rejected" });
    // refund
    await db.ref(`users/${w.userId}`).transaction((u)=>{ if(!u) return u; const b=u.balances||{total:0}; b.total = Number((b.total||0)+Number(w.amount)); u.balances=b; return u; });
    await db.ref(`transactions/${w.userId}`).push({ type: "withdraw_refund", amount: Number(w.amount), status: "Completed", createdAt: Date.now() });
  } else {
    return res.status(400).json({ error: "Invalid action" });
  }
  res.json({ ok: true });
});

api.post("/admin/task/:taskId/:submissionId/:action", authMiddleware, async (req, res) => {
  const adminFlag = (await db.ref(`admins/${req.user.uid}`).get()).val() === true;
  if (!adminFlag) return res.status(403).json({ error: "Forbidden" });
  const { taskId, submissionId, action } = req.params;
  const subRef = db.ref(`taskSubmissions/${taskId}/${submissionId}`);
  const subSnap = await subRef.get();
  if (!subSnap.exists()) return res.status(404).json({ error: "Not found" });
  const sub = subSnap.val();
  if (action === "approve") {
    // fetch task for reward
    const taskSnap = await db.ref(`tasks/${taskId}`).get();
    const task = taskSnap.val() || {};
    const reward = Number(task.rewardTRX || 0);
    await subRef.update({ status: "Approved", reviewedAt: Date.now(), reviewer: req.user.uid });
    if (reward > 0) {
      await db.ref(`users/${sub.userId}`).transaction((u) => {
        if (!u) return u;
        const bal = u.balances || { total: 0, ads: 0, referrals: 0, tasks: 0 };
        bal.total = Number((bal.total || 0) + reward);
        bal.tasks = Number((bal.tasks || 0) + reward);
        u.balances = bal;
        return u;
      });
      await db.ref(`transactions/${sub.userId}`).push({ type: "task", taskId, amount: reward, status: "Completed", createdAt: Date.now() });
    }
  } else if (action === "reject") {
    await subRef.update({ status: "Rejected", reviewedAt: Date.now(), reviewer: req.user.uid });
  } else {
    return res.status(400).json({ error: "Invalid action" });
  }
  res.json({ ok: true });
});

export const apiV1 = functions.https.onRequest(api);



import { db, dbRef, dbGet, dbSet, dbUpdate, dbOn, dbPush, dbTxn, now, authState, signInWithTelegram, auth } from "./firebase.js";

const tg = window.Telegram?.WebApp;
if (tg) {
    tg.expand();
}

const state = {
    user: null,
    settings: {
        adRewardTRX: 0.005,
        referralRewardTRX: 0.05,
        referralCommissionPct: 5,
        adCooldownSec: 30,
        minWithdrawalTRX: 0.5,
        botUsername: "trxbyadsbot",
    },
    cooldownUntil: 0,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toTRX(n) {
    return (Number(n) || 0).toFixed(6);
}

function setActiveTab(tab) {
    $$(".tab").forEach(el => el.classList.remove("active"));
    $$(".tabbtn").forEach(el => el.classList.remove("active"));
    const t = document.getElementById(tab);
    const b = Array.from($$(".tabbtn")).find(x => x.dataset.tab === tab);
    if (t) t.classList.add("active");
    if (b) b.classList.add("active");
}

function initTabs() {
    $$(".tabbtn").forEach(btn => {
        btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
        btn.addEventListener("keydown", (e) => {
            if (e.key === 'Enter' || e.key === ' ') setActiveTab(btn.dataset.tab);
        });
    });
}

function getInitDataUnsafe() {
    try {
        return tg?.initDataUnsafe || null;
    } catch (e) {
        return null;
    }
}

async function ensureUser(initData) {
    const userId = auth.currentUser?.uid || localStorage.getItem('devUserId') || `dev-${Math.floor(Math.random()*1e9)}`;
    if (!auth.currentUser?.uid) localStorage.setItem('devUserId', userId);
    const userPath = `users/${userId}`;

    const snap = await dbGet(userPath);
    if (!snap.exists()) {
        const referrerId = parseStartParam(initData?.start_param);
        await dbSet(userPath, {
            id: userId,
            username: initData?.user?.username || "guest",
            createdAt: Date.now(),
            balances: { total: 0, ads: 0, referrals: 0, tasks: 0 },
            referral: { referrerId: referrerId || null, totalRefs: 0, earned: 0, commission: 0 },
            cooldown: 0,
            banned: false,
        });
    }

    return userId;
}

function parseStartParam(startParam) {
    if (!startParam) return null;
    try {
        // expected format is just userId; but support payloads like r_userId
        const m = /([\w\-]+)/.exec(startParam);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

function renderUserHeader(userId, username) {
    $("#userid").textContent = userId;
    $("#username").textContent = username ? `@${username}` : "@guest";
}

function startCooldown(seconds) {
    const until = Date.now() + seconds * 1000;
    state.cooldownUntil = until;
    dbUpdate(`users/${state.user}/cooldown`, until).catch(() => {});
    updateCooldownUI();
}

function updateCooldownUI() {
    const btn = $("#watchAdBtn");
    const cdWrap = $("#cooldown");
    const timer = $("#cooldownTimer");
    const nowTs = Date.now();
    const remainMs = Math.max(0, state.cooldownUntil - nowTs);
    const remain = Math.ceil(remainMs / 1000);
    if (remain > 0) {
        btn.disabled = true;
        cdWrap.style.display = "block";
        const mm = String(Math.floor(remain / 60)).padStart(2, "0");
        const ss = String(remain % 60).padStart(2, "0");
        timer.textContent = `${mm}:${ss}`;
    } else {
        btn.disabled = false;
        cdWrap.style.display = "block";
        timer.textContent = "00:00";
    }
}

setInterval(updateCooldownUI, 500);

function wireAdFlow() {
    const openOverlay = () => $("#adOverlay").classList.remove("hidden");
    const closeOverlay = () => $("#adOverlay").classList.add("hidden");
    const video = $("#adVideo");
    const closeBtn = $("#closeAd");

    // If Monetag SDK function exists, use that; else fallback to in-app video
    const callMonetag = async () => {
        if (typeof window.show_9712617 === 'function') {
            try {
                await window.show_9712617();
                await apiPost("/reward/ad", {});
                startCooldown(state.settings.adCooldownSec);
            } catch (e) {
                console.warn('Ad failed/cancelled', e);
            }
            return true;
        }
        return false;
    };

    $("#watchAdBtn").addEventListener("click", async () => {
        if (Date.now() < state.cooldownUntil) return;
        const usedMonetag = await callMonetag();
        if (!usedMonetag) {
            openOverlay();
            video.currentTime = 0;
            video.play().catch(() => {});
        }
    });

    closeBtn.addEventListener("click", () => {
        video.pause();
        closeOverlay();
    });

    video.addEventListener("ended", async () => {
        try {
            await apiPost("/reward/ad", {});
        } catch (e) {
            console.error(e);
        } finally {
            startCooldown(state.settings.adCooldownSec);
            closeOverlay();
        }
    });
}

// removed local-only reward function; now via backend

function liveBindUser(userId) {
    dbOn(`users/${userId}`, (snap) => {
        const u = snap.val();
        if (!u) return;
        $("#availableBalance").textContent = toTRX(u.balances?.total || 0);
        $("#walletBalance").textContent = toTRX(u.balances?.total || 0);
        $("#earnAds").textContent = toTRX(u.balances?.ads || 0);
        $("#earnReferrals").textContent = toTRX(u.balances?.referrals || 0);
        $("#earnTasks").textContent = toTRX(u.balances?.tasks || 0);
        state.cooldownUntil = u.cooldown || 0;
        renderUserHeader(userId, u.username);
        renderReferral(userId);
        renderTransactions(userId);
        renderTasks(userId);
    });

    dbOn(`settings`, (snap) => {
        const s = snap.val();
        if (s) {
            state.settings = {
                adRewardTRX: Number(s.adRewardTRX ?? state.settings.adRewardTRX),
                referralRewardTRX: Number(s.referralRewardTRX ?? state.settings.referralRewardTRX),
                referralCommissionPct: Number(s.referralCommissionPct ?? state.settings.referralCommissionPct),
                adCooldownSec: Number(s.adCooldownSec ?? state.settings.adCooldownSec),
                minWithdrawalTRX: Number(s.minWithdrawalTRX ?? state.settings.minWithdrawalTRX),
                botUsername: s.botUsername || state.settings.botUsername,
            };
            $("#adReward").textContent = toTRX(state.settings.adRewardTRX);
            $("#minWithdrawal").textContent = toTRX(state.settings.minWithdrawalTRX);
        }
    });
}

function renderReferral(userId) {
    const botName = (state.settings.botUsername || "trxbyadsbot").replace(/^@/, "");
    const link = `https://t.me/${botName}?start=${userId}`;
    $("#refLink").value = link;

    $("#copyLink").onclick = async () => {
        try { await navigator.clipboard.writeText(link); toast("Link copied"); } catch {}
    };
    $("#shareTelegram").onclick = () => tg?.openTelegramLink ? tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Earn TRX with me!")}`) : window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}`);
    $("#shareWhatsApp").onclick = () => window.open(`https://wa.me/?text=${encodeURIComponent("Earn TRX with me! " + link)}`);
    $("#shareMore").onclick = async () => {
        if (navigator.share) await navigator.share({ title: "TRX Earn", text: "Earn TRX with me!", url: link });
    };

    // Totals
    dbOn(`referrals/${userId}`, (snap) => {
        const refs = snap.val() || {};
        const ids = Object.keys(refs);
        $("#totalReferrals").textContent = ids.length.toString();
        // Load referral earnings from user doc
        dbGet(`users/${userId}/referral`).then(s => {
            const r = s.val() || {};
            $("#referralEarnings").textContent = toTRX(r.earned || 0);
            $("#lifetimeCommission").textContent = toTRX(r.commission || 0);
        });

        const container = $("#refList");
        container.innerHTML = "";
        ids.slice(-20).reverse().forEach(rid => {
            const row = document.createElement("div");
            row.className = "row";
            row.innerHTML = `<div>@${rid}</div><div class="badge success">Joined</div>`;
            container.appendChild(row);
        });
    });
}

function toast(msg) {
    if (tg?.showPopup) {
        tg.showPopup({ title: "", message: msg, buttons: [{ type: "close" }] });
    } else {
        console.log(msg);
    }
}

function renderTransactions(userId) {
    dbOn(`transactions/${userId}`, (snap) => {
        const txs = snap.val() || {};
        const container = $("#txList");
        container.innerHTML = "";
        Object.entries(txs).sort((a,b) => b[1].createdAt - a[1].createdAt).slice(0,50).forEach(([id, tx]) => {
            const row = document.createElement("div");
            row.className = "row";
            const badgeClass = tx.status === "Completed" ? "success" : tx.status === "Pending" ? "warning" : "danger";
            row.innerHTML = `<div>${tx.type} • ${toTRX(tx.amount)} TRX</div><div class="badge ${badgeClass}">${tx.status}</div>`;
            container.appendChild(row);
        });
    });
}

function renderTasks(userId) {
    dbOn(`tasks`, (snap) => {
        const tasks = snap.val() || {};
        const container = $("#taskList");
        container.innerHTML = "";
        Object.entries(tasks).forEach(([tid, t]) => {
            const row = document.createElement("div");
            row.className = "row";
            const action = document.createElement("button");
            action.className = "primary";
            action.textContent = t.verification === 'auto' ? 'Verify' : 'Open';
            action.onclick = () => handleTaskAction(tid, t);
            row.innerHTML = `<div><div>${t.title}</div><div class="muted small">${t.category || "General"} • ${toTRX(t.rewardTRX || 0)} TRX</div></div>`;
            row.appendChild(action);
            container.appendChild(row);
        });
    });
}

async function handleTaskAction(taskId, task) {
    if (task.category === "Telegram" && task.verification === "auto" && task.link) {
        if (tg?.openTelegramLink) tg.openTelegramLink(task.link); else window.open(task.link, "_blank");
        const confirmed = await confirmPopup("Verify subscription now?");
        if (confirmed) await apiPost("/task/verify-telegram", { taskId });
    } else if (task.link) {
        window.open(task.link, "_blank");
        const confirmed = await confirmPopup("Submit for manual approval?");
        if (confirmed) await markTaskPending(taskId, task);
    }
}

function confirmPopup(message) {
    return new Promise((resolve) => {
        if (tg?.showPopup) {
            tg.showPopup({ title: "Confirm", message, buttons: [
                { id: "ok", type: "default", text: "Yes" },
                { type: "cancel" },
            ]}, (btnId) => resolve(btnId === "ok"));
        } else {
            resolve(window.confirm(message));
        }
    });
}

async function requestTaskVerification(taskId, task) {
    await apiPost("/task/submit", { taskId });
    toast("Submitted for verification");
}

async function markTaskPending(taskId, task) {
    await apiPost("/task/submit", { taskId });
    toast("Marked as pending – awaiting approval");
}

function initWithdrawForm() {
    $("#withdrawForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const amount = Number($("#withdrawAmount").value);
        const min = Number(state.settings.minWithdrawalTRX);
        const uid = $("#binanceUid").value.trim();
        if (amount < min) return showWithdrawMsg(`Minimum withdrawal is ${toTRX(min)} TRX`, true);
        if (!uid) return showWithdrawMsg("Enter Binance UID", true);

        try {
            await apiPost("/withdraw", { amount, uid, asset: "TRX", method: "binance" });
            showWithdrawMsg("Withdrawal requested. Await approval.");
            $("#withdrawForm").reset();
        } catch (e) {
            showWithdrawMsg(e.message || "Request failed", true);
        }
    });
}

function showWithdrawMsg(msg, isErr=false) {
    const el = $("#withdrawMsg");
    el.textContent = msg;
    el.style.color = isErr ? "#e50914" : "";
}

async function creditReferralOnFirstOpen() {
    await apiPost("/referral/credit-signup", {});
}

async function bootstrap() {
    initTabs();
    wireAdFlow();
    initWithdrawForm();

    const initData = getInitDataUnsafe();
    // Sign-in using Telegram initData or dev guest
    try { await signInWithTelegram(); } catch (e) { console.warn("Auth failed", e); }
    const userId = await ensureUser(initData);
    state.user = userId;
    liveBindUser(userId);
    creditReferralOnFirstOpen();
}

bootstrap();

async function apiPost(path, body) {
    const token = await getIdToken();
    const res = await fetch(`/api${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body || {}) });
    if (!res.ok) {
        let msg = "Request failed";
        try { const j = await res.json(); msg = j.error || msg; } catch {}
        throw new Error(msg);
    }
    return res.json();
}

async function getIdToken() {
    // If using custom auth, auth.currentUser will exist; else return an empty string to allow emulator/local dev
    try {
        const auth = (await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js")).getAuth();
        const user = auth.currentUser;
        if (!user) return "";
        return user.getIdToken();
    } catch {
        return "";
    }
}



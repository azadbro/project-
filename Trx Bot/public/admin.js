import { db, dbRef, dbGet, dbSet, dbUpdate, dbOn, dbPush, auth, signInWithTelegram } from "./firebase.js";

const $ = (s) => document.querySelector(s);

function toast(msg){ console.log(msg); }

async function getIdToken() {
    try {
        const token = await auth.currentUser?.getIdToken();
        return token || "";
    } catch { return ""; }
}

async function apiPost(path) {
    const token = await getIdToken();
    return fetch(`/api${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
}

async function saveSettings() {
    const obj = {
        adRewardTRX: Number($("#setAdReward").value || 0.005),
        referralRewardTRX: Number($("#setRefReward").value || 0.05),
        referralCommissionPct: Number($("#setCommission").value || 5),
        adCooldownSec: Number($("#setCooldown").value || 30),
        minWithdrawalTRX: Number($("#setMinWithdraw").value || 0.5),
        botUsername: String($("#setBotUsername").value || "trxbyadsbot"),
    };
    await dbUpdate(`settings`, obj);
    toast("Saved settings");
}

function bindSettings() {
    dbOn(`settings`, (snap) => {
        const s = snap.val() || {};
        $("#setAdReward").value = s.adRewardTRX ?? 0.005;
        $("#setRefReward").value = s.referralRewardTRX ?? 0.05;
        $("#setCommission").value = s.referralCommissionPct ?? 5;
        $("#setCooldown").value = s.adCooldownSec ?? 30;
        $("#setMinWithdraw").value = s.minWithdrawalTRX ?? 0.5;
        $("#setBotUsername").value = s.botUsername || "trxbyadsbot";
    });
}

function bindTasks() {
    $("#addTask").onclick = async () => {
        const title = $("#taskTitle").value.trim();
        const link = $("#taskLink").value.trim();
        const rewardTRX = Number($("#taskReward").value || 0);
        const category = $("#taskCategory").value.trim() || "General";
        const verification = $("#taskVerification").value;
        if (!title || !rewardTRX) return toast("Provide title and reward");
        await dbPush(`tasks`, { title, link, rewardTRX, category, verification, createdAt: Date.now(), active: true });
        $("#taskTitle").value = ""; $("#taskLink").value = ""; $("#taskReward").value = "";
        toast("Task added");
    };

    dbOn(`tasks`, (snap) => {
        const tasks = snap.val() || {};
        const container = $("#adminTaskList");
        container.innerHTML = "";
        Object.entries(tasks).forEach(([id, t]) => {
            const row = document.createElement("div");
            row.className = "row";
            const del = document.createElement("button");
            del.className = "secondary";
            del.textContent = "Delete";
            del.onclick = () => dbSet(`tasks/${id}`, null);
            row.innerHTML = `<div><div>${t.title}</div><div class=\"muted small\">${t.category} • ${t.rewardTRX} TRX</div></div>`;
            row.appendChild(del);
            container.appendChild(row);
        });
    });
}

function bindWithdrawals() {
    dbOn(`withdrawals`, (snap) => {
        const list = snap.val() || {};
        const container = $("#adminWithdrawals");
        container.innerHTML = "";
        Object.entries(list).sort((a,b)=> (a[1].createdAt - b[1].createdAt)).forEach(([id, w]) => {
            const row = document.createElement("div");
            row.className = "row";
            const approve = document.createElement("button");
            approve.className = "primary";
            approve.textContent = "Approve";
            approve.onclick = async () => apiPost(`/admin/withdraw/${id}/approve`);
            const reject = document.createElement("button");
            reject.className = "secondary";
            reject.textContent = "Reject";
            reject.onclick = async () => apiPost(`/admin/withdraw/${id}/reject`);
            row.innerHTML = `<div><div>User: ${w.userId}</div><div class=\"muted small\">${w.amount} TRX • UID ${w.uid} • ${w.status}</div></div>`;
            const actions = document.createElement("div");
            actions.appendChild(approve); actions.appendChild(reject);
            row.appendChild(actions);
            container.appendChild(row);
        });
    });
}

function bindUserLookup() {
    $("#loadUser").onclick = async () => {
        const id = $("#searchUser").value.trim();
        if (!id) return;
        const snap = await dbGet(`users/${id}`);
        const container = $("#userDetail");
        container.innerHTML = "";
        if (!snap.exists()) { container.textContent = "User not found"; return; }
        const u = snap.val();
        const row = document.createElement("div");
        row.className = "row";
        const ban = document.createElement("button");
        ban.className = "secondary";
        ban.textContent = u.banned ? "Unban" : "Ban";
        ban.onclick = () => dbUpdate(`users/${id}`, { banned: !u.banned });
        row.innerHTML = `<div><div>${id}</div><div class=\"muted small\">Balance ${u.balances?.total || 0} TRX</div></div>`;
        row.appendChild(ban);
        container.appendChild(row);
    };
}

function bindTaskSubmissions() {
    dbOn(`taskSubmissions`, (snap) => {
        const groups = snap.val() || {};
        const container = $("#adminTaskSubmissions");
        container.innerHTML = "";
        Object.entries(groups).forEach(([taskId, subs]) => {
            Object.entries(subs).forEach(([id, s]) => {
                const row = document.createElement("div");
                row.className = "row";
                const approve = document.createElement("button");
                approve.className = "primary";
                approve.textContent = "Approve";
                approve.onclick = () => apiPost(`/admin/task/${taskId}/${id}/approve`);
                const reject = document.createElement("button");
                reject.className = "secondary";
                reject.textContent = "Reject";
                reject.onclick = () => apiPost(`/admin/task/${taskId}/${id}/reject`);
                row.innerHTML = `<div><div>User: ${s.userId}</div><div class=\"muted small\">Task ${taskId} • ${s.status}</div></div>`;
                const actions = document.createElement("div");
                actions.appendChild(approve); actions.appendChild(reject);
                row.appendChild(actions);
                container.appendChild(row);
            });
        });
    });
}

document.addEventListener("DOMContentLoaded", async () => {
    try { await signInWithTelegram(); } catch {}
    $("#saveSettings").onclick = saveSettings;
    bindSettings();
    bindTasks();
    bindWithdrawals();
    bindTaskSubmissions();
    bindUserLookup();
    bindAdminStats();
});

function bindAdminStats() {
    dbOn(`transactions`, (snap) => {
        const all = snap.val() || {};
        let ads = 0, refs = 0, tasks = 0;
        Object.values(all).forEach(userTxs => {
            Object.values(userTxs).forEach(tx => {
                if (tx.type === 'earn_ad') ads += Number(tx.amount || 0);
                if (tx.type === 'referral' || tx.type === 'commission') refs += Number(tx.amount || 0);
                if (tx.type === 'task') tasks += Number(tx.amount || 0);
            });
        });
        const fmt = (n)=> (Number(n)||0).toFixed(6);
        document.getElementById('statAds').textContent = fmt(ads);
        document.getElementById('statRef').textContent = fmt(refs);
        document.getElementById('statTasks').textContent = fmt(tasks);
    });
}



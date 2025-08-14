// Firebase v9 modular SDK
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, get, set, update, onValue, push, serverTimestamp, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { getAuth, signInWithCustomToken, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

export const firebaseConfig = {
    apiKey: "AIzaSyA3oGdrEupRjglpFDvZ3eL0KPygupMFbrw",
    authDomain: "oject-65bd1.firebaseapp.com",
    databaseURL: "https://oject-65bd1-default-rtdb.firebaseio.com",
    projectId: "oject-65bd1",
    storageBucket: "oject-65bd1.firebasestorage.app",
    messagingSenderId: "500376366588",
    appId: "1:500376366588:web:4ad2ce5b1832f2d4d95679",
    measurementId: "G-M7B87WBFDW"
  };

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);

export const dbRef = (path) => ref(db, path);
export const dbGet = (path) => get(dbRef(path));
export const dbSet = (path, value) => set(dbRef(path), value);
export const dbUpdate = (path, value) => update(dbRef(path), value);
export const dbPush = (path, value) => push(dbRef(path), value);
export const dbOn = (path, cb) => onValue(dbRef(path), cb);
export const dbTxn = runTransaction;
export const now = serverTimestamp;

export async function signInWithTelegram() {
    // Expects a Firebase custom token issued by a Cloud Function after verifying Telegram initData string
    const rawInitData = window?.Telegram?.WebApp?.initData || "";
    const token = await fetch("/verify-telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: rawInitData }),
    }).then(r => r.json()).then(r => r.token);
    const cred = await signInWithCustomToken(auth, token);
    return cred.user;
}

export function authState(callback) {
    onAuthStateChanged(auth, callback);
}



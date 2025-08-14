TRX Earn Model – Telegram Mini App

A Telegram Mini App with Earn, Refer, Wallet, Tasks, and Admin Panel. Frontend: HTML/CSS/JS. Backend: Firebase Realtime Database + Cloud Functions.

Features
- Earn: watch rewarded video placeholder with 30s cooldown, automatic balance credit via secure API
- Refer: referral link `https://t.me/<YourBot>?start=<userId>`, signup reward to referrer, 5% lifetime commissions
- Wallet: live balance, earnings breakdown, withdrawals (Binance UID), transaction history
- Tasks: auto-verified Telegram channel join or manual approval tasks
- Admin Panel: settings (rates, cooldown, min withdraw), tasks CRUD, submissions review, withdrawals approval/rejection, users ban

Structure
- `public/` – web app (index.html), admin panel (admin.html)
- `functions/` – Firebase Functions REST API
- `database.rules.json` – Realtime Database security rules
- `firebase.json` – hosting + rewrites for functions

Prerequisites
- Node.js 18+
- Firebase CLI: `npm i -g firebase-tools`
- A Firebase project with Realtime Database and Hosting enabled
- Your Telegram bot token and Bot Menu Web App configured

Setup
1. Install deps
   - `cd functions && npm i`
2. Configure project
   - Replace placeholders in `public/firebase.js` (firebaseConfig) and `.firebaserc` (default project id)
3. Set Telegram bot token for Functions
   - `firebase functions:config:set bot.token="<YOUR_BOT_TOKEN>"`
4. Deploy (or use emulators)
   - Deploy: `firebase deploy`
   - Emulators: `firebase emulators:start --only functions,hosting`

Database Rules
Deployed from `database.rules.json`. Users cannot change balances or statuses directly; only Functions or admins can.

Admin Access
- Mark your uid as admin by setting `admins/<your_uid>: true` in the database once you have a user record (sign in via Telegram Mini App once to create it).
- Admin Panel URL: `/admin.html`

Telegram Bot Configuration
- Set Bot Menu › Web App to your Hosting URL, e.g. `https://<project-id>.web.app`.
- Referral links use the bot username from Telegram `initData`.

Notes
- The ad player is a placeholder video; integrate your ad network or Telegram Ads SDK if available.
- For auto-verification of Telegram channel tasks, the Function calls `getChatMember` using your bot token.
- Minimum withdrawal and reward rates are managed under `settings` path by admins.



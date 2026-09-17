# Zyra WhatsApp Backend — Setup Guide

This is the "phone line" that connects your WhatsApp number to Zyra's AI brain.
Follow these steps in order.

## Step 1 — Deploy this to Render (free)

1. Go to https://render.com and sign up (free account is fine).
2. Click **New +** → **Web Service**.
3. When it asks for a repo, choose **"Deploy from a Git repository"** — if you don't
   have a GitHub account yet, create one free at github.com, create a new repository,
   and upload these 3 files (`server.js`, `package.json`, this README) to it. Then
   connect that repo to Render.
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Before clicking "Create Web Service", scroll to **Environment Variables** and add:
   - `VERIFY_TOKEN` → make up any password, e.g. `zyra2026secret`
   - `WHATSAPP_TOKEN` → (you'll get this from Meta in Step 2 below)
   - `PHONE_NUMBER_ID` → (you'll get this from Meta in Step 2 below)
   - `ANTHROPIC_API_KEY` → your Claude API key from console.anthropic.com
6. Click **Create Web Service**. Wait for it to finish deploying (a few minutes).
7. Render will give you a URL like `https://zyra-whatsapp.onrender.com` — copy it.

## Step 2 — Get your WhatsApp credentials

Back in developers.facebook.com, on the same "Step 2. Production setup" page you're on:

- Under **"Register your WhatsApp phone number"** → click **Add new number**, follow
  the prompts to verify your business phone number. This gives you a `PHONE_NUMBER_ID`.
- Somewhere on this dashboard (usually top of the WhatsApp setup page) you'll see a
  **Temporary access token** — for real production use later you'll generate a
  **permanent token** in Business Settings, but the temporary one works to test with.
- Go back to Render → your service → Environment → paste in `WHATSAPP_TOKEN` and
  `PHONE_NUMBER_ID` → save (Render will redeploy automatically).

## Step 3 — Fill in the Configure Webhooks box (where you are now)

- **Callback URL:** your Render URL + `/webhook`
  e.g. `https://zyra-whatsapp.onrender.com/webhook`
- **Verify token:** the exact same value you set for `VERIFY_TOKEN` in Render
  e.g. `zyra2026secret`
- Click **Verify and save**. It should turn green ✅.

## Step 4 — Test it

Send a WhatsApp message to your registered business number from your personal phone.
Within a few seconds, Zyra should reply automatically. Check the Render logs
(Render dashboard → your service → Logs) if something doesn't work — it'll show
exactly what's happening.

## Notes

- The free Render plan sleeps after inactivity, so the very first message after a
  quiet period may take ~30 seconds to get a reply. Fine for testing; upgrade to a
  paid plan ($7/mo) before going live with real customers so replies are instant.
- Conversation history currently resets if the server restarts. That's fine for
  testing — say the word if you want it saved permanently to a database later.

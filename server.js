// Zyra WhatsApp Backend
// Connects WhatsApp Cloud API <-> Claude AI, so Zyra can auto-reply to WhatsApp customers.

const express = require('express');
const app = express();
app.use(express.json());

// ---- CONFIG (set these as environment variables when you deploy) ----
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;           // any password you make up
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;       // from Meta developer dashboard
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;     // from Meta developer dashboard
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // from console.anthropic.com

// Simple in-memory chat history per customer phone number.
// (Fine to start with — swap for a real database later if you want history to survive restarts.)
const conversations = {};

// ---------- 1. WEBHOOK VERIFICATION (Meta calls this once, when you click "Verify and save") ----------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ---------- 2. INCOMING MESSAGES (Meta calls this every time a customer messages you) ----------
app.post('/webhook', async (req, res) => {
  // Always respond 200 fast so Meta doesn't retry/resend
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message) return; // could be a status update (delivered/read), not an actual message

    const from = message.from; // customer's WhatsApp number
    const text = message.text?.body;
    if (!text) return; // skip non-text messages for now (images, audio, etc.)

    console.log(`Message from ${from}: ${text}`);

    const reply = await getZyraReply(from, text);
    await sendWhatsAppMessage(from, reply);
  } catch (err) {
    console.error('Error handling incoming message:', err);
  }
});

// ---------- 3. ASK CLAUDE FOR A REPLY ----------
async function getZyraReply(customerNumber, incomingText) {
  if (!conversations[customerNumber]) conversations[customerNumber] = [];
  const history = conversations[customerNumber];

  history.push({ role: 'user', content: incomingText });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: `You are ZYRA, a warm, professional AI business assistant replying to a customer on WhatsApp on behalf of a small business.
Keep replies short, natural, and conversational — this is WhatsApp, not email. Be helpful and friendly. Use emojis sparingly.`,
      messages: history,
    }),
  });

  const data = await response.json();
  const reply = data?.content?.[0]?.text || "Sorry, I'm having trouble replying right now — someone from our team will follow up shortly.";

  history.push({ role: 'assistant', content: reply });

  // Keep history from growing forever
  if (history.length > 20) history.splice(0, history.length - 20);

  return reply;
}

// ---------- 4. SEND MESSAGE BACK VIA WHATSAPP ----------
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });

  const data = await res.json();
  if (data.error) {
    console.error('WhatsApp send error:', data.error);
  }
  return data;
}

// ---------- HEALTH CHECK ----------
app.get('/', (req, res) => {
  res.send('Zyra WhatsApp backend is running ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zyra WhatsApp server running on port ${PORT}`));

// ============================================================
// ZYRA BUSINESS - BACKEND SERVER
// ============================================================
// This is the "brain" that runs in the background 24/7.
// It does 3 jobs:
//   1. When you add a new customer, it sends them a WhatsApp
//      welcome message automatically.
//   2. When a customer replies on WhatsApp, this server receives
//      that message (via the "webhook").
//   3. It sends the customer's message to Groq (the AI), gets a
//      reply, and sends that reply back to the customer on
//      WhatsApp - all with no action from you.
// ============================================================

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Allow the ZYRA dashboard (or any site) to call this backend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ------------------------------------------------------------
// SETTINGS - these come from the .env file (kept secret, never
// visible to website visitors, unlike the old setup)
// ------------------------------------------------------------
const {
  GROQ_API_KEY,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
  BUSINESS_NAME,
  MONGODB_URI,
  PORT
} = process.env;

const PORT_TO_USE = PORT || 3000;

// ------------------------------------------------------------
// DATABASE - MongoDB Atlas (replaces the old JSON-file storage,
// which was wiped every time Render restarted the server).
// Data now survives restarts and redeploys.
// ------------------------------------------------------------
const mongoClient = new MongoClient(MONGODB_URI);
let customersCollection;
let businessInfoCollection;
let usersCollection;

async function connectToDatabase() {
  await mongoClient.connect();
  const db = mongoClient.db('zyra');
  customersCollection = db.collection('customers');
  businessInfoCollection = db.collection('business_info');
  usersCollection = db.collection('users');
  await usersCollection.createIndex({ email: 1 }, { unique: true });
  console.log('Connected to MongoDB ✅');
}

// Customers are stored one document per phone number, with
// _id set to the phone number so lookups/upserts are simple.
async function loadCustomers() {
  const docs = await customersCollection.find({}).toArray();
  const customers = {};
  for (const doc of docs) {
    customers[doc._id] = doc;
  }
  return customers;
}

async function getCustomer(phone) {
  return customersCollection.findOne({ _id: phone });
}

async function saveCustomer(phone, data) {
  await customersCollection.updateOne(
    { _id: phone },
    { $set: data },
    { upsert: true }
  );
}

// Business info (name, products, prices, hours, etc.) - set from the
// ZYRA dashboard's "Business Info" tab, so WhatsApp replies are accurate
// instead of the AI guessing. Stored as a single document.
async function loadBusinessInfo() {
  const doc = await businessInfoCollection.findOne({ _id: 'main' });
  return doc || {};
}

async function saveBusinessInfo(data) {
  await businessInfoCollection.updateOne(
    { _id: 'main' },
    { $set: data },
    { upsert: true }
  );
}

// ------------------------------------------------------------
// AUTH - account signup/login
// Passwords are NEVER stored as plain text. We use Node's built-in
// scrypt password hashing and only return safe user information.
// ------------------------------------------------------------
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, storedHash] = String(stored || '').split(':');
    if (!salt || !storedHash) return false;
    const derived = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(storedHash, 'hex');
    return expected.length === derived.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function safeUser(user) {
  return {
    id: user._id,
    firstname: user.firstname || '',
    lastname: user.lastname || '',
    fullname: user.fullname || '',
    email: user.email,
    business: user.business || '',
    plan: user.plan || 'free',
    joined: user.joined || user.createdAt || null
  };
}

app.post('/api/auth/signup', async (req, res) => {
  try {
    if (!usersCollection) return res.status(503).json({ error: 'Database is not ready yet. Please try again.' });

    const firstname = String(req.body.firstname || '').trim();
    const lastname = String(req.body.lastname || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const business = String(req.body.business || '').trim();

    if (!firstname || !email || !password) {
      return res.status(400).json({ error: 'First name, email and password are required.' });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const existing = await usersCollection.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
    }

    const now = new Date().toISOString();
    const user = {
      firstname,
      lastname,
      fullname: `${firstname} ${lastname}`.trim(),
      email,
      business,
      passwordHash: hashPassword(password),
      plan: 'free',
      joined: now,
      createdAt: now
    };

    const result = await usersCollection.insertOne(user);
    user._id = result.insertedId.toString();
    res.status(201).json({ success: true, user: safeUser(user) });
  } catch (err) {
    console.error('signup error:', err.message);
    if (err.code === 11000) return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
    res.status(500).json({ error: 'Could not create your account right now.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    if (!usersCollection) return res.status(503).json({ error: 'Database is not ready yet. Please try again.' });

    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await usersCollection.findOne({ email });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    res.json({ success: true, user: safeUser(user) });
  } catch (err) {
    console.error('login error:', err.message);
    res.status(500).json({ error: 'Could not log you in right now.' });
  }
});

// ------------------------------------------------------------
// GROQ - sends the conversation to the AI and gets a reply
// ------------------------------------------------------------
async function askGroq(customerName, conversationHistory) {
  const biz = await loadBusinessInfo();
  const bizName = biz.name || BUSINESS_NAME || 'this business';

  const bizContext = (biz.name || biz.what || biz.products || biz.extra) ? `

Real information about this business - use it to answer questions accurately
(especially prices and products). Do NOT make up prices or products that
aren't listed here. If something isn't listed, say you'll have the business
owner confirm, rather than guessing:
Business name: ${biz.name || '(not provided)'}
What they sell/offer: ${biz.what || '(not provided)'}
Products & prices:
${biz.products || '(not provided)'}
Other details (hours, delivery, policies, payment):
${biz.extra || '(not provided)'}` : `

Note: this business hasn't added their product/price details yet, so if a
customer asks about specific prices or products, let them know you'll get the
exact details confirmed for them rather than guessing.`;

  const systemPrompt = `You are ZYRA, the friendly AI assistant for "${bizName}".
You are chatting directly with a customer named ${customerName} on WhatsApp.
Be warm, helpful, and professional. Keep replies short and natural, like a real
WhatsApp message (2-4 sentences max unless the customer asks for detail).
Never say you are an AI language model - you are ZYRA, the business's assistant.${bizContext}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory
  ];

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'openai/gpt-oss-120b',
      messages
    },
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data.choices[0].message.content;
}

// ------------------------------------------------------------
// GROQ - for the DASHBOARD's own "ask ZYRA for business advice"
// chat (the owner talking to ZYRA, not a WhatsApp customer).
// Separate from askGroq() above, which is customer-facing.
// ------------------------------------------------------------
async function askGroqForDashboard(userName, history) {
  const biz = await loadBusinessInfo();
  const bizContext = (biz.name || biz.what || biz.products || biz.extra) ? `

Here is real information about this business — use it to answer any
questions accurately (like prices, products, or hours). Never make up
prices or products that aren't listed here:
Business name: ${biz.name || '(not provided)'}
What they sell/offer: ${biz.what || '(not provided)'}
Products & prices:
${biz.products || '(not provided)'}
Other details (hours, delivery, policies, payment):
${biz.extra || '(not provided)'}` : '';

  const systemPrompt = `You are ZYRA, a warm, intelligent, and professional AI business assistant. You were built to help small business owners in Nigeria and Africa grow their businesses.

Your personality:
- Friendly, warm and conversational - like a smart business friend
- Professional but never stiff or robotic
- If someone greets you (hi, hello, how are you), greet back warmly and ask how you can help
- You use the owner's name "${userName}" occasionally to make it personal
- You use emojis naturally but not excessively
- You give practical, actionable advice - not generic fluff
- You can help with: customer replies, social media content, business plans, product descriptions, pricing advice, marketing ideas, automation tips, and general business questions
- When you don't know something, you're honest about it${bizContext}

Keep responses conversational and not too long unless asked for detail. Always end with a follow-up question or offer to help more.`;

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'openai/gpt-oss-120b',
      max_tokens: 1000,
      messages: [{ role: 'system', content: systemPrompt }, ...history]
    },
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data.choices[0].message.content;
}

// ------------------------------------------------------------
// WHATSAPP - sending messages out
// ------------------------------------------------------------
async function sendWhatsAppText(toPhoneNumber, text) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: toPhoneNumber,
      type: 'text',
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// Sends the first message to a NEW customer. WhatsApp rules say
// the very first message to someone must use an approved
// "template" - you cannot just cold-message with free text.
// "hello_world" is Meta's built-in test template that always
// works immediately, so we start with that. Once your own
// custom template is approved by Meta, swap the template name
// below.
async function sendWhatsAppTemplate(toPhoneNumber, templateName = 'hello_world') {
  await axios.post(
    `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: toPhoneNumber,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'en_US' }
      }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// ------------------------------------------------------------
// ROUTE: Health check - so you can visit the URL and confirm
// the server is alive
// ------------------------------------------------------------
app.get('/', (req, res) => {
  res.send('ZYRA backend is running ✅');
});

// ------------------------------------------------------------
// ROUTE: Add a new customer (called from the ZYRA dashboard)
// Sends the WhatsApp welcome template automatically.
// ------------------------------------------------------------
app.post('/api/add-customer', async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'name and phone are required' });
    }

    // WhatsApp numbers must be in international format with no
    // leading 0 or +, e.g. Nigeria: 2348012345678
    const cleanPhone = phone.replace(/[^0-9]/g, '');

    await saveCustomer(cleanPhone, {
      name,
      phone: cleanPhone,
      conversation: [],
      addedAt: new Date().toISOString()
    });

    await sendWhatsAppTemplate(cleanPhone);

    res.json({ success: true, message: `Welcome message sent to ${name}` });
  } catch (err) {
    console.error('add-customer error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Something went wrong sending the WhatsApp message.' });
  }
});

// ------------------------------------------------------------
// ROUTE: List customers (handy for checking things are saved)
// ------------------------------------------------------------
app.get('/api/customers', async (req, res) => {
  res.json(await loadCustomers());
});

// ------------------------------------------------------------
// ROUTE: Get / save business info (products, prices, hours, etc.)
// The dashboard's "Business Info" tab calls these so that WhatsApp
// replies use the exact same information.
// ------------------------------------------------------------
app.get('/api/business-info', async (req, res) => {
  res.json(await loadBusinessInfo());
});

app.post('/api/business-info', async (req, res) => {
  const { name, what, products, extra } = req.body;
  await saveBusinessInfo({ name, what, products, extra });
  res.json({ success: true });
});

// ------------------------------------------------------------
// ROUTE: Dashboard's "ask ZYRA for advice" chat (owner-facing,
// separate from the WhatsApp customer conversations above).
// Keeps the Groq key safely on the server, never in the browser.
// ------------------------------------------------------------
app.post('/api/dashboard-chat', async (req, res) => {
  try {
    const { userName, history } = req.body;
    if (!Array.isArray(history)) {
      return res.status(400).json({ error: 'history must be an array of {role, content} messages' });
    }
    const reply = await askGroqForDashboard(userName || 'there', history.slice(-20));
    res.json({ reply });
  } catch (err) {
    console.error('dashboard-chat error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Something went wrong talking to the AI.' });
  }
});

// ------------------------------------------------------------
// ROUTE: Webhook verification (Meta calls this once, when you
// paste your URL into the Meta dashboard, to prove it's real)
// ------------------------------------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    console.log('Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ------------------------------------------------------------
// ROUTE: Webhook messages (Meta sends every incoming WhatsApp
// message here, automatically, in real time)
// ------------------------------------------------------------
app.post('/webhook', async (req, res) => {
  // Always reply 200 immediately so Meta doesn't retry/complain
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message || message.type !== 'text') return; // ignore non-text events (e.g. read receipts)

    const fromPhone = message.from;
    const text = message.text.body;

    let customer = await getCustomer(fromPhone);
    if (!customer) {
      // Unknown number messaged us first - create a basic record
      customer = { name: 'Customer', phone: fromPhone, conversation: [] };
    }

    customer.conversation.push({ role: 'user', content: text });

    // Keep only the last 10 messages so the AI stays fast and cheap
    const recentHistory = customer.conversation.slice(-10);

    const aiReply = await askGroq(customer.name, recentHistory);

    customer.conversation.push({ role: 'assistant', content: aiReply });
    await saveCustomer(fromPhone, customer);

    await sendWhatsAppText(fromPhone, aiReply);
  } catch (err) {
    console.error('webhook handling error:', err.response?.data || err.message);
  }
});

connectToDatabase()
  .then(() => {
    app.listen(PORT_TO_USE, () => {
      console.log(`ZYRA backend listening on port ${PORT_TO_USE}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(1);
  });

// server.js — pure Node http + ws (no Express)
import http from "http";
import { WebSocketServer } from "ws";
import twilio from "twilio";
import OpenAI from "openai";

// --- ENV (set in Render Dashboard) ---
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_BUSINESS_NUMBER = process.env.TWILIO_BUSINESS_NUMBER || "+19014464277";
const OWNER_ALERT_NUMBER     = process.env.OWNER_ALERT_NUMBER     || "+19012321362";
const HANDOFF_URL            = process.env.HANDOFF_URL || ""; // optional

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
  process.exit(1);
}
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.error("❌ Missing Twilio credentials (SID/TOKEN)");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const tclient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- simple HTTP for health ---
const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("MSPC AI Voice server is running.\n");
    return;
  }
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

// --- WebSocket server for Twilio ---
const wss = new WebSocketServer({ server, path: "/ai-voice" });

function say(ws, text) {
  ws.send(JSON.stringify({ event: "send", token: { type: "text", text } }));
}

wss.on("connection", (ws) => {
  console.log("🔗 ConversationRelay connected");

  const state = { fromNumber: null, callSid: null, misunderstandings: 0 };
  say(ws, "Thanks for calling MidSouth Premier Cleaning. Are you calling about residential or commercial service?");

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      state.callSid = msg.start?.callSid || null;
      state.fromNumber = msg.start?.from || null;
      console.log("☎️  Call SID:", state.callSid, " From:", state.fromNumber);
      return;
    }

    if (msg.event === "transcription") {
      const user = (msg.transcription?.text || "").trim();
      if (!user) return;
      console.log("👤 User:", user);

      const sys = [
        "You are the AI receptionist for MidSouth Premier Cleaning in Memphis.",
        "Be concise and friendly. Collect details for residential or commercial cleaning.",
        "Residential: name, phone, email, address, bedrooms/bathrooms OR sq ft, preferred time.",
        "Commercial: company, contact name, phone/email, building type, size, scope, frequency.",
        "Output {action:'RES_DONE'} or {action:'COMM_ALERT'} when enough info is collected.",
        "If confused twice, output {action:'HANDOFF'}."
      ].join("\n");

      let aiText = "";
      try {
        const resp = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.2,
          messages: [{ role: "system", content: sys }, { role: "user", content: user }]
        });
        aiText = resp.choices?.[0]?.message?.content?.trim() || "";
      } catch (e) {
        console.error("OpenAI error:", e?.message || e);
        say(ws, "Sorry, could you repeat that?");
        state.misunderstandings++;
        return;
      }

      let action = null;
      const m = aiText.match(/\{[\s\S]*\}$/);
      const spoken = m ? aiText.replace(m[0], "").trim() : aiText;
      if (spoken) say(ws, spoken);
      if (m) { try { action =

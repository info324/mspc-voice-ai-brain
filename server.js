// server.js — pure Node http + ws (no Express)
import http from "http";
import { WebSocketServer } from "ws";
import twilio from "twilio";
import OpenAI from "openai";

// --- ENV (set in Render dashboard) ---
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_BUSINESS_NUMBER = process.env.TWILIO_BUSINESS_NUMBER || "+19014464277";
const OWNER_ALERT_NUMBER     = process.env.OWNER_ALERT_NUMBER     || "+19012321362";
const HANDOFF_URL            = process.env.HANDOFF_URL || ""; // optional

if (!OPENAI_API_KEY) { console.error("❌ Missing OPENAI_API_KEY"); process.exit(1); }
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) { console.error("❌ Missing Twilio SID/TOKEN"); process.exit(1); }

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const tclient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- tiny HTTP server for health checks ---
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

// --- WebSocket endpoint for Twilio ConversationRelay ---
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
        "Be concise and friendly. Ask one question at a time.",
        "Residential: name, phone, email, address/ZIP, bedrooms+bathrooms OR sq ft, preferred date/time.",
        "Commercial: company, contact name, phone/email, building type & size, scope (one-time/recurring), desired start/frequency.",
        "When residential info is sufficient, output {action:'RES_DONE', summary:'...'}",
        "When commercial info is sufficient, output {action:'COMM_ALERT', summary:'...'}",
        "If the caller asks for a person or after two misunderstandings, output {action:'HANDOFF'}.",
        "Never take card details. Keep replies under 2 sentences."
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

      // speak the AI response and handle optional action JSON at the end
      let action = null;
      const m = aiText.match(/\{[\s\S]*\}$/);
      const spoken = m ? aiText.replace(m[0], "").trim() : aiText;
      if (spoken) say(ws, spoken);
      if (m) { try { action = JSON.parse(m[0].replace(/(\w+)\s*:/g, '"$1":')); } catch {} }

      if (action?.action === "RES_DONE" && state.fromNumber) {
        try {
          await tclient.messages.create({
            to: state.fromNumber,
            from: TWILIO_BUSINESS_NUMBER,
            body: "Thanks! We’ve received your residential details. We’ll confirm shortly."
          });
        } catch (e) { console.error("SMS to caller failed:", e?.message); }
      }

      if (action?.action === "COMM_ALERT") {
        try {
          await tclient.messages.create({
            to: OWNER_ALERT_NUMBER,
            from: TWILIO_BUSINESS_NUMBER,
            body: `New COMMERCIAL lead:\n${action.summary || "No summary"}`
          });
          say(ws, "Thanks! The owner will call you shortly.");
        } catch (e) { console.error("Owner alert SMS failed:", e?.message); }
      }

      if (action?.action === "HANDOFF" && HANDOFF_URL && state.callSid) {
        say(ws, "Connecting you to a person now.");
        try {
          await tclient.calls(state.callSid).update({ url: HANDOFF_URL, method: "POST" });
        } catch (e) {
          console.error("Handoff redirect failed:", e?.message);
        }
      }
    }

    if (msg.event === "stop") {
      console.log("🛑 Call ended");
    }
  });

  ws.on("close", () => console.log("🔌 WS closed"));
});

server.listen(PORT, () => {
  console.log(`🚀 MSPC AI Voice server listening on :${PORT}`);
  console.log("🔉 WebSocket endpoint ready at /ai-voice");
});

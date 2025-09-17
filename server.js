import http from "http";
import { WebSocketServer } from "ws";
import twilio from "twilio";
import OpenAI from "openai";

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_BUSINESS_NUMBER, // +19014464277
  OWNER_ALERT_NUMBER,     // +19012321362
  HANDOFF_URL,            // optional: your /handoff Twilio Function URL
  PORT = 8080
} = process.env;

const tclient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI();

const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); }
  else { res.writeHead(404); res.end(); }
});

const wss = new WebSocketServer({ server, path: "/ai-voice" });

function say(ws, text) {
  ws.send(JSON.stringify({ event: "send", token: { type: "text", text } }));
}

wss.on("connection", (ws) => {
  const state = { fromNumber: null, callSid: null };

  say(ws, "Thanks for calling. Are you calling about residential or commercial cleaning?");

  ws.on("message", async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      state.callSid = msg.start?.callSid || null;
      state.fromNumber = msg.start?.from || null;
      return;
    }

    if (msg.event === "transcription") {
      const user = msg.transcription?.text?.trim();
      if (!user) return;

      const sys = [
        "You are the AI receptionist for MidSouth Premier Cleaning (Memphis area).",
        "Be concise and friendly. Ask one question at a time.",
        "Residential: collect name, phone (confirm caller ID), email, address/ZIP, beds+baths OR sqft, preferred date/time. When complete: reply briefly and output {action:'RES_DONE'}.",
        "Commercial: collect company, contact name, phone/email, building type & size, scope (one-time/recurring), timeline. When complete: reply briefly and output {action:'COMM_ALERT', summary:'...'}.",
        "If user asks for a person or after 2 misunderstandings, output {action:'HANDOFF'}.",
        "Never take card details."
      ].join("\n");

      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ]
      });

      const ai = resp.choices?.[0]?.message?.content?.trim() || "";
      let action = null;
      const m = ai.match(/\{[\s\S]*\}$/);
      const spoken = m ? ai.replace(m[0], "").trim() : ai;
      if (spoken) say(ws, spoken);
      if (m) { try { action = JSON.parse(m[0].replace(/(\w+)\s*:/g, '"$1":')); } catch {} }

      if (action?.action === "RES_DONE") {
        if (state.fromNumber) {
          await tclient.messages.create({
            to: state.fromNumber,
            from: TWILIO_BUSINESS_NUMBER,
            body: "Thanks! We’ve received your residential details. We’ll confirm shortly."
          });
        }
      }

      if (action?.action === "COMM_ALERT") {
        await tclient.messages.create({
          to: OWNER_ALERT_NUMBER,
          from: TWILIO_BUSINESS_NUMBER,
          body: `New COMMERCIAL lead:\n${action.summary || "No summary"}`
        });
        say(ws, "Thanks! The owner will call you shortly.");
      }

      if (action?.action === "HANDOFF" && state.callSid && HANDOFF_URL) {
        say(ws, "One moment while I connect you to a person.");
        try {
          await tclient.calls(state.callSid).update({ url: HANDOFF_URL, method: "POST" });
        } catch (e) {
          await tclient.messages.create({
            to: OWNER_ALERT_NUMBER,
            from: TWILIO_BUSINESS_NUMBER,
            body: "Handoff requested but redirect failed. Please call the caller back."
          });
        }
      }
    }
  });
});

server.listen(PORT, () => console.log(`AI Voice server on :${PORT}`));

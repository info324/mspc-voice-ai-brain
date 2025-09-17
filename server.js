import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import OpenAI from "openai";

// Load environment variables (Render handles them in the dashboard)
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY environment variable.");
  process.exit(1);
}

// Initialize OpenAI
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Express app
const app = express();

// Health check route (important for testing in browser)
app.get("/health", (req, res) => {
  res.send("ok");
});

// Root route for browser testing
app.get("/", (req, res) => {
  res.send("✅ MSPC Voice AI server is running");
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server (for Twilio <-> AI streaming)
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("🔗 New WebSocket connection from Twilio");

  ws.on("message", async (message) => {
    console.log("📩 Incoming message:", message.toString());

    try {
      // Example: simple AI echo (replace later with full convo logic)
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are an AI receptionist for a cleaning company." },
          { role: "user", content: message.toString() },
        ],
      });

      const reply = response.choices[0].message.content;
      console.log("🤖 AI reply:", reply);

      ws.send(reply);
    } catch (err) {
      console.error("❌ Error from OpenAI:", err);
      ws.send("Sorry, I had trouble processing that.");
    }
  });

  ws.on("close", () => {
    console.log("❌ WebSocket connection closed");
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});

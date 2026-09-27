const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.json());

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

app.get("/", (req, res) => {
  res.send("CineFlow API fonctionne !");
});

app.post("/api/gemini", async (req, res) => {
  try {
    const prompt = req.body.prompt;

    if (!prompt) {
      return res.status(400).json({
        error: "Le prompt est obligatoire."
      });
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt
    });

    res.json({
      success: true,
      response: response.text
    });
  } catch (error) {
    console.error("Erreur Gemini :", error);

    res.status(500).json({
      success: false,
      error: "Impossible de contacter Gemini."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`CineFlow API démarrée sur le port ${PORT}`);
});

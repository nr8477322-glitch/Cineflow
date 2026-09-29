const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 10000;

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error("ERREUR : GEMINI_API_KEY n'est pas configurée.");
}

const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

// Page principale
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cineflow</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #111827;
      color: white;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }

    .container {
      width: 100%;
      max-width: 700px;
      background: #1f2937;
      padding: 30px;
      border-radius: 20px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
    }

    h1 {
      text-align: center;
      margin-top: 0;
    }

    .subtitle {
      text-align: center;
      color: #cbd5e1;
      margin-bottom: 30px;
    }

    button {
      width: 100%;
      padding: 15px;
      border: none;
      border-radius: 12px;
      background: #6366f1;
      color: white;
      font-size: 16px;
      font-weight: bold;
      cursor: pointer;
    }

    button:hover {
      background: #4f46e5;
    }

    #result {
      margin-top: 20px;
      padding: 15px;
      background: #111827;
      border-radius: 12px;
      white-space: pre-wrap;
      min-height: 50px;
    }
  </style>
</head>

<body>

  <div class="container">
    <h1>🎬 Cineflow</h1>

    <p class="subtitle">
      Ton espace de création assistée par intelligence artificielle
    </p>

    <button onclick="testGemini()">
      ✨ Tester Gemini
    </button>

    <div id="result">
      Clique sur le bouton pour lancer le test.
    </div>
  </div>

  <script>
    async function testGemini() {
      const result = document.getElementById("result");

      result.textContent = "⏳ Connexion à Gemini...";

      try {
        const response = await fetch("/api/test-gemini", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          }
        });

        const data = await response.json();

        if (data.success) {
          result.textContent = "✅ Gemini répond :\\n\\n" + data.message;
        } else {
          result.textContent = "❌ Erreur : " + data.error;
        }

      } catch (error) {
        result.textContent =
          "❌ Impossible de contacter le serveur : " + error.message;
      }
    }
  </script>

</body>
</html>
  `);
});

// Test de Gemini
app.post("/api/test-gemini", async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({
        success: false,
        error: "GEMINI_API_KEY n'est pas configurée sur Render."
      });
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: "Réponds simplement : Bonjour Cineflow, Gemini fonctionne !"
    });

    const message = response.text || "Gemini a répondu sans texte.";

    res.json({
      success: true,
      message: message
    });

  } catch (error) {
    console.error("Erreur Gemini :", error);

    res.status(500).json({
      success: false,
      error: error.message || "Erreur inconnue avec Gemini."
    });
  }
});

// Démarrage du serveur
app.listen(PORT, "0.0.0.0", () => {
  console.log("Cineflow est démarré sur le port " + PORT);
});

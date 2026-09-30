const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const MODEL = "gemini-3.8-flash";

// Petite pause entre les tentatives
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Appel Gemini avec 3 tentatives en cas de surcharge temporaire
async function askGemini() {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents:
          "Réponds simplement en français : confirme que Gemini est correctement connecté à Cineflow."
      });

      return response.text;

    } catch (error) {
      lastError = error;

      console.error(
        `Tentative Gemini ${attempt}/3 échouée :`,
        error.message || error
      );

      // Si Gemini est temporairement indisponible,
      // on attend avant de réessayer.
      if (attempt < 3) {
        await wait(attempt * 2000);
      }
    }
  }

  throw lastError;
}


// ─────────────────────────────────────────────
// PAGE PRINCIPALE
// ─────────────────────────────────────────────

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >

  <meta name="theme-color" content="#0b1020">

  <title>Cineflow</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: Arial, sans-serif;
      background: #0b1020;
      color: white;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }

    .container {
      width: 100%;
      max-width: 600px;
      text-align: center;
    }

    h1 {
      font-size: 42px;
      margin-bottom: 10px;
    }

    .subtitle {
      font-size: 18px;
      color: #b8c0d4;
      margin-bottom: 35px;
    }

    .card {
      background: #151c32;
      border-radius: 20px;
      padding: 30px 20px;
      box-shadow: 0 10px 35px rgba(0,0,0,0.3);
    }

    button {
      border: none;
      border-radius: 12px;
      padding: 15px 24px;
      font-size: 17px;
      font-weight: bold;
      cursor: pointer;
      background: #ffffff;
      color: #0b1020;
    }

    button:disabled {
      opacity: 0.6;
      cursor: wait;
    }

    #result {
      margin-top: 25px;
      padding: 15px;
      border-radius: 12px;
      background: #0f1527;
      color: #dce3f5;
      line-height: 1.5;
      word-break: break-word;
    }
  </style>
</head>

<body>

  <div class="container">

    <h1>Cineflow</h1>

    <div class="subtitle">
      Ton espace de création assistée par intelligence artificielle
    </div>

    <div class="card">

      <button id="testButton" onclick="testGemini()">
        ✨ Tester Gemini
      </button>

      <div id="result">
        Clique sur le bouton pour lancer le test.
      </div>

    </div>

  </div>


  <script>
    async function testGemini() {

      const button = document.getElementById("testButton");
      const result = document.getElementById("result");

      button.disabled = true;
      button.textContent = "⏳ Test en cours...";

      result.textContent = "Connexion à Gemini...";

      try {

        const response = await fetch("/test-gemini");

        const data = await response.json();

        if (response.ok && data.success) {

          result.innerHTML =
            "✅ Gemini répond :<br><br>" +
            data.message;

        } else {

          result.innerHTML =
            "❌ Erreur :<br><br>" +
            (data.error || "Erreur inconnue.");

        }

      } catch (error) {

        result.innerHTML =
          "❌ Impossible de contacter Cineflow.";

      } finally {

        button.disabled = false;
        button.textContent = "✨ Tester Gemini";

      }
    }
  </script>

</body>
</html>
  `);
});


// ─────────────────────────────────────────────
// TEST GEMINI
// ─────────────────────────────────────────────

app.get("/test-gemini", async (req, res) => {

  try {

    if (!process.env.GEMINI_API_KEY) {

      return res.status(500).json({
        success: false,
        error: "La variable GEMINI_API_KEY n'est pas configurée sur Render."
      });

    }

    const message = await askGemini();

    res.json({
      success: true,
      message: message
    });

  } catch (error) {

    console.error("Erreur Gemini finale :", error);

    res.status(503).json({
      success: false,
      error:
        "Gemini est temporairement indisponible. Cineflow a effectué plusieurs tentatives. Réessaie dans quelques instants."
    });

  }
});


// ─────────────────────────────────────────────
// DÉMARRAGE DU SERVEUR
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Cineflow API démarrée sur le port ${PORT}`);
});

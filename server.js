const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.json());

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Cineflow - Test Gemini</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          text-align: center;
          padding: 40px 20px;
          background: #111827;
          color: white;
        }

        .box {
          max-width: 500px;
          margin: auto;
          padding: 30px;
          border-radius: 20px;
          background: #1f2937;
        }

        button {
          margin-top: 15px;
          padding: 14px 22px;
          border: none;
          border-radius: 12px;
          background: #6366f1;
          color: white;
          font-size: 16px;
          font-weight: bold;
          cursor: pointer;
        }

        button:disabled {
          opacity: 0.6;
        }

        #result {
          margin-top: 20px;
          padding: 15px;
          border-radius: 12px;
          background: #374151;
          min-height: 30px;
          white-space: pre-wrap;
        }
      </style>
    </head>

    <body>
      <div class="box">
        <h1>🎬 Cineflow</h1>
        <p>Test de connexion Gemini</p>

        <button id="testButton">
          ✨ Tester Gemini
        </button>

        <div id="result">
          Clique sur le bouton pour lancer le test.
        </div>
      </div>

      <script>
        const button = document.getElementById("testButton");
        const result = document.getElementById("result");

        button.addEventListener("click", async () => {
          button.disabled = true;
          result.textContent = "⏳ Gemini réfléchit...";

          try {
            const response = await fetch("/api/gemini", {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                prompt: "Dis-moi en une phrase que tu es bien connecté à Cineflow."
              })
            });

            const data = await response.json();

            if (data.success) {
              result.textContent = "✅ Gemini répond :\\n\\n" + data.response;
            } else {
              result.textContent = "❌ Erreur : " + data.error;
            }
          } catch (error) {
            result.textContent = "❌ Impossible de contacter Cineflow.";
          }

          button.disabled = false;
        });
      </script>
    </body>
    </html>
  `);
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
  console.log(`Cineflow API démarrée sur le port ${PORT}`);
});

⚠️ Ne mets toujours pas ta clé Gemini dans le code. Elle reste dans Render.

Après avoir enregistré le fichier sur GitHub, attends que Render affiche Deploy succeeded / Live.

Ensuite ouvre :

"Cineflow" (https://reference-url-citation.invalid/0)

Tu devrais voir ✨ Tester Gemini.

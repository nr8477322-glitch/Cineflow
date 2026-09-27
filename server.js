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

  <title>Cineflow</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #0b1020;
      color: white;
    }

    header {
      padding: 22px;
      background: #111827;
      border-bottom: 1px solid #263043;
    }

    header h1 {
      margin: 0;
      font-size: 28px;
    }

    header p {
      margin: 6px 0 0;
      color: #9ca3af;
    }

    .container {
      max-width: 900px;
      margin: auto;
      padding: 25px 18px 50px;
    }

    .hero {
      text-align: center;
      padding: 35px 15px;
    }

    .hero h2 {
      font-size: 34px;
      margin-bottom: 10px;
    }

    .hero p {
      color: #aab3c5;
      font-size: 16px;
    }

    .card {
      background: #151d2e;
      border: 1px solid #273349;
      border-radius: 20px;
      padding: 24px;
      margin-top: 20px;
    }

    label {
      display: block;
      margin-bottom: 10px;
      font-weight: bold;
    }

    textarea {
      width: 100%;
      min-height: 140px;
      resize: vertical;
      padding: 15px;
      border-radius: 14px;
      border: 1px solid #374151;
      background: #0f172a;
      color: white;
      font-size: 16px;
      outline: none;
    }

    textarea:focus {
      border-color: #6366f1;
    }

    button {
      width: 100%;
      margin-top: 15px;
      padding: 15px;
      border: none;
      border-radius: 14px;
      background: #6366f1;
      color: white;
      font-size: 17px;
      font-weight: bold;
      cursor: pointer;
    }

    button:hover {
      opacity: 0.9;
    }

    button:disabled {
      opacity: 0.5;
      cursor: wait;
    }

    .result {
      display: none;
      margin-top: 20px;
      padding: 20px;
      background: #0f172a;
      border: 1px solid #273349;
      border-radius: 16px;
      white-space: pre-wrap;
      line-height: 1.6;
    }

    .loading {
      color: #aab3c5;
    }

    .error {
      color: #f87171;
    }

    .features {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
      margin-top: 20px;
    }

    .feature {
      background: #111827;
      padding: 18px;
      border-radius: 14px;
      border: 1px solid #273349;
    }

    .feature strong {
      display: block;
      margin-bottom: 5px;
    }

    .feature span {
      color: #9ca3af;
      font-size: 14px;
    }

    @media (max-width: 600px) {
      .hero h2 {
        font-size: 27px;
      }

      .features {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>

<body>

  <header>
    <h1>🎬 Cineflow</h1>
    <p>Ton studio de création vidéo assisté par IA</p>
  </header>

  <main class="container">

    <section class="hero">
      <h2>Transforme une idée en projet vidéo</h2>
      <p>
        Décris ton idée et laisse Gemini préparer le concept et le scénario.
      </p>
    </section>

    <section class="card">

      <label for="idea">
        💡 Quelle vidéo veux-tu créer ?
      </label>

      <textarea
        id="idea"
        placeholder="Exemple : Un jeune footballeur africain rêve de devenir professionnel..."
      ></textarea>

      <button id="generateButton">
        ✨ Générer avec Gemini
      </button>

      <div id="result" class="result"></div>

    </section>

    <section class="features">

      <div class="feature">
        <strong>🧠 IA</strong>
        <span>Gemini pour développer tes idées.</span>
      </div>

      <div class="feature">
        <strong>🎬 Scénario</strong>
        <span>Création de concepts et scénarios.</span>
      </div>

      <div class="feature">
        <strong>🎨 Visuels</strong>
        <span>Préparation future des éléments visuels.</span>
      </div>

      <div class="feature">
        <strong>📱 Réseaux</strong>
        <span>Préparation future pour plusieurs plateformes.</span>
      </div>

    </section>

  </main>

  <script>

    const button = document.getElementById("generateButton");
    const idea = document.getElementById("idea");
    const result = document.getElementById("result");

    button.addEventListener("click", async () => {

      const userIdea = idea.value.trim();

      if (!userIdea) {
        result.style.display = "block";
        result.className = "result error";
        result.textContent = "⚠️ Écris d'abord une idée de vidéo.";
        return;
      }

      button.disabled = true;

      result.style.display = "block";
      result.className = "result loading";
      result.textContent = "⏳ Cineflow prépare ton projet...";

      try {

        const response = await fetch("/api/gemini", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            prompt: \`
Tu es le cerveau créatif de Cineflow.

À partir de cette idée :

"\${userIdea}"

Crée un projet vidéo clair et professionnel.

Donne :

1. TITRE
2. CONCEPT
3. STYLE VISUEL
4. PERSONNAGES PRINCIPAUX
5. SCÉNARIO
6. DÉCOUPAGE EN 5 SCÈNES
7. DESCRIPTION DE LA PREMIÈRE SCÈNE
8. IDÉE POUR UNE MINIATURE
9. DESCRIPTION COURTE POUR LES RÉSEAUX SOCIAUX

Réponds en français.
Sois créatif, concret et facile à transformer ensuite en vidéo.
\`
          })
        });

        const data = await response.json();

        if (data.success) {

          result.className = "result";
          result.textContent = data.response;

        } else {

          result.className = "result error";
          result.textContent = "❌ " + data.error;

        }

      } catch (error) {

        result.className = "result error";
        result.textContent =
          "❌ Impossible de contacter Cineflow.";

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
        success: false,
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
  console.log(
    \`Cineflow API démarrée sur le port \${PORT}\`
  );
});


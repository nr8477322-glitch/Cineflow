const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

// --------------------------------------------------
// PAGE CINEFLOW
// --------------------------------------------------

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
      min-height: 100vh;
    }

    header {
      padding: 30px 20px 20px;
      text-align: center;
    }

    header h1 {
      margin: 0;
      font-size: 36px;
    }

    header p {
      color: #b9c1d9;
      font-size: 16px;
      margin-top: 10px;
    }

    .container {
      width: 92%;
      max-width: 900px;
      margin: auto;
      padding-bottom: 50px;
    }

    .card {
      background: #151c32;
      border: 1px solid #293452;
      border-radius: 18px;
      padding: 22px;
      margin-top: 20px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.25);
    }

    .card h2 {
      margin-top: 0;
      font-size: 22px;
    }

    textarea {
      width: 100%;
      min-height: 130px;
      resize: vertical;
      border: 1px solid #34405f;
      border-radius: 12px;
      background: #0d1427;
      color: white;
      padding: 15px;
      font-size: 16px;
      outline: none;
    }

    textarea:focus {
      border-color: #6d7cff;
    }

    button {
      width: 100%;
      margin-top: 15px;
      padding: 15px;
      border: none;
      border-radius: 12px;
      background: #5b6cff;
      color: white;
      font-size: 17px;
      font-weight: bold;
      cursor: pointer;
    }

    button:hover {
      background: #7180ff;
    }

    button:disabled {
      opacity: 0.6;
      cursor: wait;
    }

    .test-button {
      background: #26304d;
    }

    .test-button:hover {
      background: #34405f;
    }

    #status {
      margin-top: 15px;
      padding: 12px;
      border-radius: 10px;
      display: none;
      background: #0d1427;
    }

    #result {
      margin-top: 20px;
      white-space: pre-wrap;
      line-height: 1.7;
      color: #e7ebf7;
    }

    .loading {
      color: #c4cbff;
    }

    .success {
      color: #76e6a5;
    }

    .error {
      color: #ff8c8c;
    }

    .section-title {
      color: #aeb8ff;
      margin-top: 25px;
      margin-bottom: 8px;
    }

    footer {
      text-align: center;
      color: #707993;
      padding: 30px 10px;
      font-size: 13px;
    }
  </style>
</head>

<body>

<header>
  <h1>🎬 Cineflow</h1>
  <p>Ton espace de création assistée par intelligence artificielle</p>
</header>

<div class="container">

  <!-- TEST GEMINI -->

  <div class="card">
    <h2>🔌 Connexion Gemini</h2>

    <button class="test-button" onclick="testerGemini()">
      ✨ Tester Gemini
    </button>

    <div id="testStatus"></div>
  </div>

  <!-- GENERATEUR -->

  <div class="card">

    <h2>🎥 Créer une vidéo</h2>

    <p>
      Décris simplement ton idée de film, d'animation, d'action,
      de drama ou de football.
    </p>

    <textarea
      id="idea"
      placeholder="Exemple : Un jeune footballeur africain rêve de devenir professionnel malgré les difficultés..."
    ></textarea>

    <button id="generateButton" onclick="genererProjet()">
      🚀 Générer mon projet
    </button>

    <div id="status"></div>

    <div id="result"></div>

  </div>

</div>

<footer>
  Cineflow — Création assistée par intelligence artificielle
</footer>


<script>

async function testerGemini() {

  const box = document.getElementById("testStatus");

  box.style.display = "block";
  box.className = "loading";
  box.innerText = "⏳ Connexion à Gemini...";

  try {

    const response = await fetch("/api/test-gemini");

    const data = await response.json();

    if (data.success) {

      box.className = "success";

      box.innerText =
        "✅ Gemini répond :\\n\\n" + data.message;

    } else {

      box.className = "error";

      box.innerText =
        "❌ Erreur : " + data.error;
    }

  } catch (error) {

    box.className = "error";

    box.innerText =
      "❌ Impossible de contacter Cineflow.";
  }
}


async function genererProjet() {

  const idea = document.getElementById("idea").value.trim();

  const button = document.getElementById("generateButton");

  const status = document.getElementById("status");

  const result = document.getElementById("result");


  if (!idea) {

    status.style.display = "block";
    status.className = "error";
    status.innerText =
      "⚠️ Décris d'abord ton idée de vidéo.";

    return;
  }


  button.disabled = true;
  button.innerText = "⏳ Cineflow crée ton projet...";

  status.style.display = "block";
  status.className = "loading";
  status.innerText =
    "🤖 Gemini est en train de développer ton idée...";

  result.innerText = "";


  try {

    const response = await fetch("/api/generate", {

      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        idea: idea
      })

    });


    const data = await response.json();


    if (!response.ok || !data.success) {

      throw new Error(
        data.error || "Erreur pendant la génération."
      );

    }


    status.className = "success";

    status.innerText =
      "✅ Projet Cineflow généré avec succès !";

    result.innerText = data.result;


  } catch (error) {

    status.className = "error";

    status.innerText =
      "❌ " + error.message;

  } finally {

    button.disabled = false;

    button.innerText =
      "🚀 Générer mon projet";

  }
}

</script>

</body>
</html>
  `);
});


// --------------------------------------------------
// TEST GEMINI
// --------------------------------------------------

app.get("/api/test-gemini", async (req, res) => {

  try {

    if (!GEMINI_API_KEY) {

      return res.status(500).json({
        success: false,
        error: "GEMINI_API_KEY n'est pas configurée sur Render."
      });

    }


    const response = await ai.models.generateContent({

      model: "gemini-3.8-flash",

      contents:
        "Réponds simplement en français : Je confirme que Gemini est correctement connecté à Cineflow."

    });


    const text =
      response.text || "Gemini répond correctement.";


    res.json({
      success: true,
      message: text
    });


  } catch (error) {

    console.error("Erreur Gemini :", error);

    res.status(500).json({

      success: false,

      error:
        error.message ||
        "Erreur inconnue avec Gemini."

    });

  }

});


// --------------------------------------------------
// GENERATEUR CINEFLOW
// --------------------------------------------------

app.post("/api/generate", async (req, res) => {

  try {

    if (!GEMINI_API_KEY) {

      return res.status(500).json({

        success: false,

        error:
          "GEMINI_API_KEY n'est pas configurée sur Render."

      });

    }


    const idea = req.body.idea;


    if (!idea || typeof idea !== "string") {

      return res.status(400).json({

        success: false,

        error:
          "Aucune idée de vidéo n'a été fournie."

      });

    }


    const prompt = `
Tu es l'intelligence créative de Cineflow.

Ta mission est de transformer l'idée de l'utilisateur
en un projet vidéo clair, créatif et exploitable.

IDÉE DE L'UTILISATEUR :
${idea}

Crée le projet en français avec exactement les sections suivantes :

1. TITRE
Propose un titre accrocheur.

2. CONCEPT
Explique l'idée principale en quelques phrases.

3. STYLE VISUEL
Décris le style visuel, l'ambiance, les couleurs,
la lumière et le type d'image.

4. PERSONNAGES
Présente les personnages principaux avec leur rôle
et leurs caractéristiques importantes.

5. SCÉNARIO
Écris une histoire structurée avec un début,
un développement et une conclusion.

6. 5 SCÈNES
Présente exactement 5 scènes.
Pour chaque scène indique :
- Numéro de la scène
- Lieu
- Action
- Personnages présents
- Ambiance
- Description visuelle

7. MINIATURE
Propose une idée précise de miniature pour la vidéo.

8. RÉSEAUX SOCIAUX
Prépare :
- Une description courte
- Un texte pour publication
- 5 hashtags pertinents

9. PROMPT VIDÉO
À la fin, crée un prompt utilisable par
un futur générateur vidéo IA pour représenter
l'ensemble du projet.

Sois créatif, cohérent et concret.
Ne dis pas que tu es une IA.
Ne demande pas de précisions supplémentaires.
`;



    const response = await ai.models.generateContent({

      model: "gemini-3.8-flash",

      contents: prompt

    });


    const result =
      response.text ||
      "Aucun résultat n'a été retourné par Gemini.";


    res.json({

      success: true,

      result: result

    });


  } catch (error) {

    console.error(
      "Erreur génération Cineflow :",
      error
    );


    res.status(500).json({

      success: false,

      error:
        error.message ||
        "Impossible de générer le projet."

    });

  }

});


// --------------------------------------------------
// DEMARRAGE DU SERVEUR
// --------------------------------------------------

app.listen(PORT, () => {

  console.log(
    "Cineflow API démarrée sur le port " + PORT
  );

});

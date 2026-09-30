
const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;

const ai = new GoogleGenAI({
  apiKey: API_KEY
});

const MODEL = "gemini-3.8-flash";

// --------------------------------------------------
// Fonction Gemini avec nouvelle tentative automatique
// --------------------------------------------------

async function generateWithRetry(contents, attempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      console.log(`Tentative Gemini ${attempt}/${attempts}`);

      const response = await ai.models.generateContent({
        model: MODEL,
        contents: contents
      });

      return response;

    } catch (error) {
      lastError = error;

      const message = error?.message || String(error);

      console.error(`Erreur Gemini tentative ${attempt}:`, message);

      const isTemporary =
        message.includes("503") ||
        message.includes("UNAVAILABLE") ||
        message.includes("high demand") ||
        message.includes("429") ||
        message.includes("RESOURCE_EXHAUSTED");

      if (!isTemporary || attempt === attempts) {
        throw error;
      }

      const waitTime = attempt * 2500;

      console.log(
        `Gemini temporairement indisponible. Nouvelle tentative dans ${waitTime} ms...`
      );

      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  throw lastError;
}


// --------------------------------------------------
// PAGE PRINCIPALE
// --------------------------------------------------

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
      background: #0b1020;
      color: white;
      font-family: Arial, sans-serif;
    }

    header {
      text-align: center;
      padding: 32px 18px 20px;
    }

    header h1 {
      margin: 0;
      font-size: 38px;
    }

    header p {
      margin-top: 10px;
      color: #b9c1d9;
      font-size: 16px;
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

    .description {
      color: #b9c1d9;
      line-height: 1.6;
    }

    textarea {
      width: 100%;
      min-height: 150px;
      resize: vertical;

      background: #0d1427;
      color: white;

      border: 1px solid #34405f;
      border-radius: 12px;

      padding: 15px;

      font-size: 16px;
      line-height: 1.5;

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

    .status {
      margin-top: 15px;
      padding: 13px;

      border-radius: 10px;

      background: #0d1427;

      white-space: pre-wrap;
    }

    .success {
      color: #76e6a5;
    }

    .error {
      color: #ff8c8c;
    }

    .loading {
      color: #c4cbff;
    }

    #result {
      margin-top: 20px;

      color: #e7ebf7;

      line-height: 1.7;

      white-space: pre-wrap;
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

  <p>
    Ton espace de création assistée par intelligence artificielle
  </p>

</header>


<div class="container">


  <!-- CONNEXION -->

  <div class="card">

    <h2>🔌 Connexion Gemini</h2>

    <button
      class="test-button"
      id="testButton"
      onclick="testerGemini()"
    >
      ✨ Tester Gemini
    </button>

    <div
      id="testStatus"
      style="display:none"
    ></div>

  </div>


  <!-- CREATION -->

  <div class="card">

    <h2>🎥 Créer une vidéo</h2>

    <p class="description">
      Décris simplement ton idée de film, d'animation,
      d'action, de drama ou de football.
    </p>

    <textarea
      id="idea"
      placeholder="Exemple : Un jeune footballeur africain rêve de devenir professionnel malgré les difficultés..."
    ></textarea>

    <button
      id="generateButton"
      onclick="genererProjet()"
    >
      🚀 Générer mon projet
    </button>

    <div
      id="status"
      style="display:none"
    ></div>

    <div id="result"></div>

  </div>


</div>


<footer>
  Cineflow — Création assistée par intelligence artificielle
</footer>


<script>

async function testerGemini() {

  const button =
    document.getElementById("testButton");

  const box =
    document.getElementById("testStatus");

  button.disabled = true;

  box.style.display = "block";

  box.className = "status loading";

  box.innerText =
    "⏳ Connexion à Gemini...";


  try {

    const response =
      await fetch("/api/test-gemini");

    const data =
      await response.json();


    if (data.success) {

      box.className =
        "status success";

      box.innerText =
        "✅ Gemini répond :\\n\\n" +
        data.message;

    } else {

      box.className =
        "status error";

      box.innerText =
        "❌ " + data.error;

    }

  } catch (error) {

    box.className =
      "status error";

    box.innerText =
      "❌ Impossible de contacter Cineflow.";

  } finally {

    button.disabled = false;

  }

}


async function genererProjet() {

  const idea =
    document.getElementById("idea").value.trim();

  const button =
    document.getElementById("generateButton");

  const status =
    document.getElementById("status");

  const result =
    document.getElementById("result");


  if (!idea) {

    status.style.display = "block";

    status.className =
      "status error";

    status.innerText =
      "⚠️ Décris d'abord ton idée de vidéo.";

    return;

  }


  button.disabled = true;

  button.innerText =
    "⏳ Cineflow travaille...";


  status.style.display = "block";

  status.className =
    "status loading";

  status.innerText =
    "🤖 Gemini prépare ton projet...\\n" +
    "Une nouvelle tentative sera effectuée automatiquement si le serveur est momentanément chargé.";


  result.innerText = "";


  try {

    const response =
      await fetch("/api/generate", {

        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          idea: idea
        })

      });


    const data =
      await response.json();


    if (!response.ok || !data.success) {

      throw new Error(
        data.error ||
        "Erreur pendant la génération."
      );

    }


    status.className =
      "status success";

    status.innerText =
      "✅ Projet Cineflow généré !";


    result.innerText =
      data.result;


  } catch (error) {

    status.className =
      "status error";

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

    if (!API_KEY) {

      return res.status(500).json({

        success: false,

        error:
          "GEMINI_API_KEY n'est pas configurée sur Render."

      });

    }


    const response =
      await generateWithRetry(
        "Réponds simplement en français : Je confirme que Gemini est correctement connecté à Cineflow."
      );


    res.json({

      success: true,

      message:
        response.text ||
        "Gemini répond correctement."

    });


  } catch (error) {

    console.error(
      "Erreur test Gemini :",
      error
    );


    res.status(500).json({

      success: false,

      error:
        error?.message ||
        "Impossible de contacter Gemini."

    });

  }

});


// --------------------------------------------------
// GENERATION DU PROJET CINEFLOW
// --------------------------------------------------

app.post("/api/generate", async (req, res) => {

  try {

    if (!API_KEY) {

      return res.status(500).json({

        success: false,

        error:
          "GEMINI_API_KEY n'est pas configurée sur Render."

      });

    }


    const idea =
      typeof req.body.idea === "string"
        ? req.body.idea.trim()
        : "";


    if (!idea) {

      return res.status(400).json({

        success: false,

        error:
          "Aucune idée de vidéo n'a été fournie."

      });

    }


    const prompt = `
Tu es Cineflow, un assistant professionnel de création vidéo.

Transforme l'idée suivante en un projet vidéo complet,
créatif, cohérent et directement exploitable.

IDÉE :
${idea}

Réponds en français.

Utilise exactement cette structure :

🎬 1. TITRE

Donne un titre accrocheur.

💡 2. CONCEPT

Explique clairement le concept de la vidéo.

🎨 3. STYLE VISUEL

Décris :
- l'ambiance
- les couleurs
- la lumière
- le style cinématographique
- le type d'images

👥 4. PERSONNAGES

Présente les personnages principaux,
leur rôle et leurs caractéristiques.

📖 5. SCÉNARIO

Présente :
- le début
- le développement
- le conflit principal
- la résolution
- la fin

🎞️ 6. LES 5 SCÈNES

SCÈNE 1
Lieu :
Action :
Personnages :
Ambiance :
Description visuelle :

SCÈNE 2
Lieu :
Action :
Personnages :
Ambiance :
Description visuelle :

SCÈNE 3
Lieu :
Action :
Personnages :
Ambiance :
Description visuelle :

SCÈNE 4
Lieu :
Action :
Personnages :
Ambiance :
Description visuelle :

SCÈNE 5
Lieu :
Action :
Personnages :
Ambiance :
Description visuelle :

🖼️ 7. MINIATURE

Décris précisément l'image idéale pour la miniature.

📱 8. RÉSEAUX SOCIAUX

Description courte :
Texte de publication :
Hashtags :

🤖 9. PROMPT POUR GÉNÉRATEUR VIDÉO

Crée un prompt détaillé permettant à un futur
générateur vidéo IA de représenter le projet.

Sois créatif mais reste cohérent avec l'idée de départ.
`;


    const response =
      await generateWithRetry(prompt, 4);


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


    const message =
      error?.message ||
      "Erreur inconnue avec Gemini.";


    res.status(500).json({

      success: false,

      error:
        "Gemini est momentanément indisponible après plusieurs tentatives. Réessaie dans quelques instants. Détail : " +
        message

    });

  }

});


// --------------------------------------------------
// DEMARRAGE
// --------------------------------------------------

app.listen(PORT, () => {

  console.log(
    "Cineflow API démarrée sur le port " + PORT
  );

});

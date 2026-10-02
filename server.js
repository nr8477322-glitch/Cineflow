const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;

const ai = new GoogleGenAI({
  apiKey: API_KEY
});

const MODEL = "gemini-3.8-flash";
const IMAGE_MODEL = "gemini-3.1-flash-image";

// --------------------------------------------------
// OUTILS
// --------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanJson(text) {
  if (!text) return "";

  let result = text.trim();

  result = result
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const first = result.indexOf("{");
  const last = result.lastIndexOf("}");

  if (first !== -1 && last !== -1) {
    result = result.substring(first, last + 1);
  }

  return result;
}

// --------------------------------------------------
// GEMINI TEXTE
// --------------------------------------------------

async function generateWithRetry(contents, attempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      console.log(`Tentative Gemini ${attempt}/${attempts}`);

      const response = await ai.models.generateContent({
        model: MODEL,
        contents
      });

      return response;

    } catch (error) {
      lastError = error;

      const message = String(
        error?.message || error || ""
      );

      console.error(
        `❌ Gemini tentative ${attempt}: ${message}`
      );

      const isTemporary =
        message.includes("503") ||
        message.includes("UNAVAILABLE") ||
        message.includes("429") ||
        message.includes("RESOURCE_EXHAUSTED") ||
        message.includes("high demand");

      if (!isTemporary || attempt === attempts) {
        throw error;
      }

      await sleep(attempt * 3000);
    }
  }

  throw lastError;
}

// --------------------------------------------------
// GENERATION IMAGE
// --------------------------------------------------

async function generateImageWithRetry(prompt, attempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      console.log(
        `🎨 Génération image ${attempt}/${attempts}`
      );

      const interaction = await ai.interactions.create({
        model: IMAGE_MODEL,
        input: prompt
      });

      const output = interaction?.outputs || [];

      for (const item of output) {
        if (
          item?.type === "image" &&
          item?.data
        ) {
          return {
            mimeType: item.mime_type || "image/png",
            data: item.data
          };
        }

        if (
          item?.type === "image" &&
          item?.image?.data
        ) {
          return {
            mimeType:
              item.image.mime_type || "image/png",
            data: item.image.data
          };
        }
      }

      throw new Error(
        "Gemini n'a retourné aucune image."
      );

    } catch (error) {
      lastError = error;

      const message = String(
        error?.message || error || ""
      );

      console.error(
        `❌ Image tentative ${attempt}: ${message}`
      );

      const isTemporary =
        message.includes("503") ||
        message.includes("UNAVAILABLE") ||
        message.includes("429") ||
        message.includes("RESOURCE_EXHAUSTED") ||
        message.includes("high demand");

      if (!isTemporary || attempt === attempts) {
        throw error;
      }

      await sleep(attempt * 4000);
    }
  }

  throw lastError;
}

// --------------------------------------------------
// PAGE CINEFLOW
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

  <meta
    name="theme-color"
    content="#0b1020"
  >

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
      text-align: center;
      padding: 28px 20px;
    }

    h1 {
      margin: 0;
      font-size: 34px;
    }

    .subtitle {
      margin-top: 10px;
      color: #b9c2d0;
    }

    .container {
      width: min(950px, 92%);
      margin: auto;
      padding-bottom: 50px;
    }

    .card {
      background: #151c31;
      border: 1px solid #26314d;
      border-radius: 18px;
      padding: 22px;
      margin-top: 20px;
    }

    textarea {
      width: 100%;
      min-height: 150px;
      padding: 15px;
      border-radius: 12px;
      border: 1px solid #35415f;
      background: #0d1426;
      color: white;
      font-size: 16px;
      resize: vertical;
    }

    button {
      width: 100%;
      padding: 15px;
      margin-top: 14px;
      border: none;
      border-radius: 12px;
      background: #5b7cff;
      color: white;
      font-size: 16px;
      font-weight: bold;
      cursor: pointer;
    }

    button:disabled {
      opacity: 0.6;
    }

    .status {
      margin-top: 15px;
      padding: 12px;
      border-radius: 10px;
      background: #0d1426;
      white-space: pre-wrap;
    }

    .result {
      white-space: pre-wrap;
      line-height: 1.6;
    }

    .scene {
      margin-top: 20px;
      padding: 16px;
      background: #0d1426;
      border-radius: 14px;
    }

    .scene img {
      width: 100%;
      display: block;
      margin-top: 12px;
      border-radius: 12px;
    }

    .hidden {
      display: none;
    }

    .example {
      margin-top: 10px;
      color: #8f9ab0;
      font-size: 14px;
    }

    .footer {
      text-align: center;
      color: #7f8ba3;
      margin-top: 35px;
    }

  </style>
</head>

<body>

<header>

  <h1>🎬 Cineflow</h1>

  <div class="subtitle">
    Ton espace de création assistée par intelligence artificielle
  </div>

</header>

<main class="container">

  <!-- GEMINI -->

  <section class="card">

    <h2>🔌 Connexion Gemini</h2>

    <button
      id="testButton"
      onclick="testerGemini()"
    >
      ✨ Tester Gemini
    </button>

    <div
      id="testStatus"
      class="status"
    >
      Gemini n'a pas encore été testé.
    </div>

  </section>


  <!-- CREATION -->

  <section class="card">

    <h2>🎥 Créer une vidéo</h2>

    <p>
      Décris simplement ton idée de film,
      d'animation, d'action, de drama ou de football.
    </p>

    <textarea
      id="idea"
      placeholder="Exemple : Un jeune footballeur africain rêve de devenir professionnel malgré les difficultés..."
    ></textarea>

    <div class="example">
      Plus ton idée est précise,
      plus Cineflow pourra construire un projet cohérent.
    </div>

    <button
      id="generateButton"
      onclick="genererProjet()"
    >
      🚀 Générer mon projet
    </button>

  </section>


  <!-- PROJET -->

  <section
    id="projectCard"
    class="card hidden"
  >

    <h2>🎬 Projet Cineflow</h2>

    <div
      id="projectResult"
      class="result"
    ></div>

    <button onclick="preparerImages()">
      🎨 Préparer les 5 scènes
    </button>

  </section>


  <!-- PROMPTS -->

  <section
    id="promptCard"
    class="card hidden"
  >

    <h2>🎨 Préparer les images</h2>

    <div
      id="promptResult"
      class="result"
    ></div>

    <button onclick="genererImages()">
      🖼️ Générer les images
    </button>

  </section>


  <!-- GENERATION -->

  <section
    id="imageCard"
    class="card hidden"
  >

    <h2>⏳ Génération des images...</h2>

    <div
      id="imageStatus"
      class="status"
    >
      Cineflow prépare les images.
    </div>

  </section>


  <!-- RESULTATS -->

  <section
    id="realImageCard"
    class="card hidden"
  >

    <h2>🖼️ Les 5 scènes</h2>

    <div id="imagesResult"></div>

  </section>


  <div class="footer">
    Cineflow — Création assistée par intelligence artificielle
  </div>

</main>


<script>

let dernierProjet = "";
let derniersPrompts = [];

// --------------------------------------------------
// TEST GEMINI
// --------------------------------------------------

async function testerGemini() {

  const button =
    document.getElementById("testButton");

  const status =
    document.getElementById("testStatus");

  button.disabled = true;

  status.textContent =
    "⏳ Connexion à Gemini...";

  try {

    const response =
      await fetch("/api/test-gemini");

    const data =
      await response.json();

    if (!response.ok || !data.success) {
      throw new Error(
        data.error ||
        "Impossible de contacter Gemini."
      );
    }

    status.textContent =
      "✅ Gemini répond :\\n\\n" +
      data.text;

  } catch (error) {

    status.textContent =
      "❌ Erreur : " +
      error.message;

  }

  button.disabled = false;
}


// --------------------------------------------------
// GENERER PROJET
// --------------------------------------------------

async function genererProjet() {

  const idea =
    document.getElementById("idea")
      .value
      .trim();

  const button =
    document.getElementById("generateButton");

  if (!idea) {
    alert("Décris d'abord ton idée.");
    return;
  }

  button.disabled = true;

  button.textContent =
    "⏳ Cineflow travaille...";

  try {

    const response =
      await fetch("/api/generate", {

        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          idea
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

    dernierProjet =
      data.text;

    document.getElementById(
      "projectResult"
    ).textContent =
      data.text;

    document.getElementById(
      "projectCard"
    ).classList.remove("hidden");

  } catch (error) {

    alert(
      "❌ " + error.message
    );

  }

  button.disabled = false;

  button.textContent =
    "🚀 Générer mon projet";
}


// --------------------------------------------------
// PREPARER LES IMAGES
// --------------------------------------------------

async function preparerImages() {

  if (!dernierProjet) {
    alert("Génère d'abord un projet.");
    return;
  }

  const card =
    document.getElementById("promptCard");

  const result =
    document.getElementById("promptResult");

  card.classList.remove("hidden");

  result.textContent =
    "⏳ Cineflow prépare les 5 prompts visuels...";

  try {

    const response =
      await fetch(
        "/api/prepare-images",
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json"
          },

          body: JSON.stringify({
            project: dernierProjet
          })
        }
      );

    const data =
      await response.json();

    if (!response.ok || !data.success) {
      throw new Error(
        data.error ||
        "Erreur pendant la préparation."
      );
    }

    derniersPrompts =
      data.prompts;

    result.textContent =
      derniersPrompts
        .map((prompt, index) => {

          return (
            "🎬 SCÈNE " +
            (index + 1) +
            "\\n\\n" +
            prompt +
            "\\n\\n"
          );

        })
        .join("");

  } catch (error) {

    result.textContent =
      "❌ " + error.message;

  }
}


// --------------------------------------------------
// GENERER LES IMAGES
// --------------------------------------------------

async function genererImages() {

  if (derniersPrompts.length !== 5) {

    alert(
      "Cineflow doit préparer les 5 scènes avant de générer les images."
    );

    return;
  }

  document
    .getElementById("imageCard")
    .classList.remove("hidden");

  document
    .getElementById("realImageCard")
    .classList.add("hidden");

  const status =
    document.getElementById("imageStatus");

  status.textContent =
    "⏳ Génération des 5 images...\\n\\n" +
    "Cineflow travaille sur les scènes.";

  try {

    const response =
      await fetch(
        "/api/generate-images",
        {

          method: "POST",

          headers: {
            "Content-Type": "application/json"
          },

          body: JSON.stringify({
            prompts: derniersPrompts
          })

        }
      );

    const data =
      await response.json();

    if (!response.ok || !data.success) {

      throw new Error(
        data.error ||
        "Erreur pendant la génération des images."
      );

    }

    afficherImages(
      data.images
    );

    status.textContent =
      "✅ Les 5 images ont été générées.";

  } catch (error) {

    status.textContent =
      "❌ Erreur : " +
      error.message;

  }
}


// --------------------------------------------------
// AFFICHER LES IMAGES
// --------------------------------------------------

function afficherImages(images) {

  const container =
    document.getElementById(
      "imagesResult"
    );

  container.innerHTML = "";

  images.forEach(image => {

    const scene =
      document.createElement("div");

    scene.className =
      "scene";

    const title =
      document.createElement("h3");

    title.textContent =
      "🎬 Scène " +
      image.scene;

    const img =
      document.createElement("img");

    img.src =
      "data:" +
      image.mimeType +
      ";base64," +
      image.data;

    img.alt =
      "Image de la scène " +
      image.scene;

    scene.appendChild(title);
    scene.appendChild(img);

    container.appendChild(scene);

  });

  document
    .getElementById("realImageCard")
    .classList.remove("hidden");
}

</script>

</body>
</html>
  `);
});


// --------------------------------------------------
// TEST GEMINI
// --------------------------------------------------

app.get(
  "/api/test-gemini",
  async (req, res) => {

    try {

      const response =
        await generateWithRetry(
          "Réponds simplement en français : Je confirme que Gemini est correctement connecté à Cineflow."
        );

      res.json({

        success: true,

        text:
          response.text ||
          "Gemini répond."

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
          "Erreur Gemini."

      });

    }

  }
);


// --------------------------------------------------
// GENERATION DU PROJET
// --------------------------------------------------

app.post(
  "/api/generate",
  async (req, res) => {

    try {

      const idea =
        String(
          req.body?.idea || ""
        ).trim();

      if (!idea) {

        return res.status(400).json({

          success: false,

          error:
            "Aucune idée n'a été fournie."

        });

      }

      const prompt = `

Tu es Cineflow, une intelligence artificielle
spécialisée dans la création de projets vidéo.

À partir de cette idée :

"${idea}"

Crée un projet vidéo complet en français.

Respecte exactement cette structure :

1. TITRE
2. CONCEPT
3. STYLE VISUEL
4. PERSONNAGES
5. SCÉNARIO
6. LES 5 SCÈNES
7. MINIATURE
8. RÉSEAUX SOCIAUX
9. PROMPT POUR GÉNÉRATEUR VIDÉO

Pour les 5 scènes, donne suffisamment de détails
pour permettre ensuite de créer une image cohérente
pour chaque scène.

Les scènes doivent avoir une continuité
visuelle et narrative.

`;

      const response =
        await generateWithRetry(
          prompt
        );

      res.json({

        success: true,

        text:
          response.text || ""

      });

    } catch (error) {

      console.error(
        "Erreur génération projet :",
        error
      );

      res.status(500).json({

        success: false,

        error:
          error?.message ||
          "Impossible de générer le projet."

      });

    }

  }
);


// --------------------------------------------------
// PREPARATION DES 5 SCENES
// --------------------------------------------------

app.post(
  "/api/prepare-images",
  async (req, res) => {

    try {

      const project =
        String(
          req.body?.project || ""
        ).trim();

      if (!project) {

        return res.status(400).json({

          success: false,

          error:
            "Projet manquant."

        });

      }

      const prompt = `

À partir du projet Cineflow ci-dessous :

${project}

Crée exactement 5 prompts visuels,
un pour chacune des 5 scènes.

Chaque prompt doit contenir :

- la scène ;
- les personnages ;
- l'action ;
- le décor ;
- le style visuel ;
- la caméra ;
- la lumière ;
- l'ambiance ;
- le cadrage.

Les 5 scènes doivent conserver
la cohérence des personnages,
des vêtements, du décor et de l'univers.

Retourne exactement :

SCÈNE 1
SCÈNE 2
SCÈNE 3
SCÈNE 4
SCÈNE 5

`;

      const response =
        await generateWithRetry(
          prompt
        );

      const text =
        response.text || "";

      const sections =
        text
          .split(
            /SCÈNE\s*[1-5]\s*[:\-]?/i
          )
          .map(x => x.trim())
          .filter(Boolean);

      let prompts =
        sections.slice(0, 5);

      if (prompts.length !== 5) {

        prompts =
          text
            .split(/\n\s*\n/)
            .map(x => x.trim())
            .filter(Boolean)
            .slice(0, 5);

      }

      if (prompts.length !== 5) {

        return res.status(500).json({

          success: false,

          error:
            "Gemini n'a pas produit exactement 5 prompts."

        });

      }

      res.json({

        success: true,

        prompts

      });

    } catch (error) {

      console.error(
        "Erreur préparation images :",
        error
      );

      res.status(500).json({

        success: false,

        error:
          error?.message ||
          "Impossible de préparer les images."

      });

    }

  }
);


// --------------------------------------------------
// GENERATION DES 5 IMAGES
// --------------------------------------------------

app.post(
  "/api/generate-images",
  async (req, res) => {

    try {

      const prompts =
        Array.isArray(
          req.body?.prompts
        )
          ? req.body.prompts
          : [];

      if (prompts.length !== 5) {

        return res.status(400).json({

          success: false,

          error:
            "Cineflow doit recevoir exactement 5 prompts."

        });

      }

      const images = [];

      for (
        let i = 0;
        i < prompts.length;
        i++
      ) {

        console.log(
          `🎬 Génération scène ${i + 1}/5`
        );

        const imagePrompt = `

Crée une image cinématographique
pour la scène ${i + 1}.

PROMPT DE LA SCÈNE :

${prompts[i]}

CONSIGNES :

- image horizontale 16:9 ;
- style cinématographique ;
- haute qualité ;
- personnages cohérents ;
- décor cohérent ;
- éclairage cinématographique ;
- composition professionnelle ;
- profondeur de champ naturelle ;
- aucun texte ;
- aucun logo ;
- aucune interface ;
- représenter fidèlement la scène.

`;

        const image =
          await generateImageWithRetry(
            imagePrompt,
            3
          );

        images.push({

          scene: i + 1,

          mimeType:
            image.mimeType,

          data:
            image.data

        });

      }

      res.json({

        success: true,

        images

      });

    } catch (error) {

      console.error(
        "❌ Erreur génération images :",
        error
      );

      res.status(500).json({

        success: false,

        error:
          error?.message ||
          "Impossible de générer les images."

      });

    }

  }
);


// --------------------------------------------------
// DEMARRAGE
// --------------------------------------------------

app.listen(
  PORT,
  () => {

    console.log(
      `🎬 Cineflow API démarrée sur le port ${PORT}`
    );

  }
);

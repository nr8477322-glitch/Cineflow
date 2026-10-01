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
// GEMINI TEXTE AVEC NOUVELLES TENTATIVES
// --------------------------------------------------

async function generateWithRetry(contents, attempts = 4) {
let lastError;

for (let attempt = 1; attempt <= attempts; attempt++) {
try {
console.log("Tentative Gemini ${attempt}/${attempts}");

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: contents
  });

  return response;

} catch (error) {
  lastError = error;

  const message = error?.message || String(error);

  console.error(
    `Erreur Gemini tentative ${attempt}:`,
    message
  );

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
    `Nouvelle tentative dans ${waitTime} ms...`
  );

  await new Promise(resolve =>
    setTimeout(resolve, waitTime)
  );
}

}

throw lastError;
}

// --------------------------------------------------
// GENERATION D'UNE IMAGE
// --------------------------------------------------

async function generateImageWithRetry(prompt, attempts = 3) {
let lastError;

for (let attempt = 1; attempt <= attempts; attempt++) {
try {
console.log(
"Génération image ${attempt}/${attempts}"
);

  const response =
    await ai.models.generateContent({
      model: IMAGE_MODEL,
      contents: prompt
    });

  const candidates =
    response?.candidates || [];

  for (const candidate of candidates) {
    const parts =
      candidate?.content?.parts || [];

    for (const part of parts) {

      if (part.inlineData?.data) {

        return {
          mimeType:
            part.inlineData.mimeType ||
            "image/png",

          data:
            part.inlineData.data
        };
      }
    }
  }

  throw new Error(
    "Gemini n'a retourné aucune image."
  );

} catch (error) {

  lastError = error;

  const message =
    error?.message || String(error);

  console.error(
    `Erreur génération image ${attempt}:`,
    message
  );

  const isTemporary =
    message.includes("503") ||
    message.includes("UNAVAILABLE") ||
    message.includes("high demand") ||
    message.includes("429") ||
    message.includes("RESOURCE_EXHAUSTED");

  if (!isTemporary || attempt === attempts) {
    throw error;
  }

  const waitTime = attempt * 3000;

  await new Promise(resolve =>
    setTimeout(resolve, waitTime)
  );
}

}

throw lastError;
}

// --------------------------------------------------
// PAGE PRINCIPALE
// --------------------------------------------------

app.get("/", (req, res) => {

res.send(`

<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta
name="viewport"
content="width=device-width, initial-scale=1.0"

«»

<meta name="theme-color" content="#0b1020"><title>Cineflow</title><style>

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

.image-button {
  background: #8b5cf6;
}

.image-button:hover {
  background: #9d72ff;
}

.generate-real-button {
  background: #10b981;
}

.generate-real-button:hover {
  background: #18c997;
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

#result,
#imageResult,
#realImageResult {
  margin-top: 20px;
  color: #e7ebf7;
  line-height: 1.7;
  white-space: pre-wrap;
}

#imageCard,
#realImageCard {
  display: none;
}

.scene-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 18px;
  margin-top: 20px;
}

.scene-image-card {
  background: #0d1427;
  border: 1px solid #293452;
  border-radius: 14px;
  padding: 12px;
}

.scene-image-card h3 {
  margin: 5px 0 12px;
}

.scene-image-card img {
  display: block;
  width: 100%;
  border-radius: 10px;
}

.scene-label {
  color: #aeb8d5;
  font-size: 14px;
  margin-bottom: 10px;
}

footer {
  text-align: center;
  color: #707993;
  padding: 30px 10px;
  font-size: 13px;
}

</style></head><body><header><h1>🎬 Cineflow</h1><p>
Ton espace de création assistée par intelligence artificielle
</p></header><div class="container"><!-- CONNEXION GEMINI --><div class="card"><h2>🔌 Connexion Gemini</h2><button
class="test-button"
id="testButton"
onclick="testerGemini()"

«»

✨ Tester Gemini
</button>

<div
  id="testStatus"
  style="display:none"
></div></div><!-- CREATION --><div class="card"><h2>🎥 Créer une vidéo</h2><p class="description">
Décris simplement ton idée de film,
d'animation, d'action, de drama ou de football.
</p><textarea
  id="idea"
  placeholder="Exemple : Un jeune footballeur africain rêve de devenir professionnel malgré les difficultés..."
></textarea><button
id="generateButton"
onclick="genererProjet()"

«»

🚀 Générer mon projet
</button>

<div
  id="status"
  style="display:none"
></div><div id="result"></div></div><!-- PREPARATION DES PROMPTS --><div
  class="card"
  id="imageCard"
><h2>🎨 Préparer les images</h2><p class="description">
Cineflow transforme ton projet en 5 prompts
visuels cohérents.
</p><button
class="image-button"
id="imageButton"
onclick="preparerImages()"

«»

🎨 Préparer les 5 scènes
</button>

<div
  id="imageStatus"
  style="display:none"
></div><div id="imageResult"></div></div><!-- GENERATION REELLE --><div
  class="card"
  id="realImageCard"
><h2>🖼️ Générer les images</h2><p class="description">
Cineflow utilise les prompts préparés pour
générer réellement les images des 5 scènes.
</p><button
class="generate-real-button"
id="realImageButton"
onclick="genererImages()"

«»

🖼️ Générer les 5 images
</button>

<div
  id="realImageStatus"
  style="display:none"
></div><div
  id="realImageResult"
></div></div></div><footer>
Cineflow — Création assistée par intelligence artificielle
</footer><script>

let dernierProjet = "";
let derniersPrompts = "";


// --------------------------------------------------
// TEST GEMINI
// --------------------------------------------------

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


// --------------------------------------------------
// GENERER LE PROJET
// --------------------------------------------------

async function genererProjet() {

  const idea =
    document.getElementById("idea").value.trim();

  const button =
    document.getElementById("generateButton");

  const status =
    document.getElementById("status");

  const result =
    document.getElementById("result");

  const imageCard =
    document.getElementById("imageCard");

  const realImageCard =
    document.getElementById("realImageCard");


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
    "🤖 Gemini prépare ton projet...";

  result.innerText = "";

  imageCard.style.display = "none";

  realImageCard.style.display = "none";


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


    dernierProjet =
      data.result;

    status.className =
      "status success";

    status.innerText =
      "✅ Projet Cineflow généré !";

    result.innerText =
      data.result;

    imageCard.style.display =
      "block";

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


// --------------------------------------------------
// PREPARER LES PROMPTS VISUELS
// --------------------------------------------------

async function preparerImages() {

  const button =
    document.getElementById("imageButton");

  const status =
    document.getElementById("imageStatus");

  const result =
    document.getElementById("imageResult");

  const realImageCard =
    document.getElementById("realImageCard");


  if (!dernierProjet) {

    status.style.display = "block";

    status.className =
      "status error";

    status.innerText =
      "⚠️ Génère d'abord un projet Cineflow.";

    return;

  }


  button.disabled = true;

  button.innerText =
    "⏳ Préparation des scènes...";

  status.style.display = "block";

  status.className =
    "status loading";

  status.innerText =
    "🎨 Gemini prépare les prompts visuels...";

  result.innerText = "";

  realImageCard.style.display = "none";


  try {

    const response =
      await fetch("/api/prepare-images", {

        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          project: dernierProjet
        })

      });


    const data =
      await response.json();


    if (!response.ok || !data.success) {

      throw new Error(
        data.error ||
        "Erreur pendant la préparation des images."
      );

    }


    derniersPrompts =
      data.result;

    status.className =
      "status success";

    status.innerText =
      "✅ Les 5 scènes sont prêtes !";

    result.innerText =
      data.result;

    realImageCard.style.display =
      "block";

  } catch (error) {

    status.className =
      "status error";

    status.innerText =
      "❌ " + error.message;

  } finally {

    button.disabled = false;

    button.innerText =
      "🎨 Préparer les 5 scènes";

  }

}


// --------------------------------------------------
// GENERER LES 5 IMAGES REELLES
// --------------------------------------------------

async function genererImages() {

  const button =
    document.getElementById("realImageButton");

  const status =
    document.getElementById("realImageStatus");

  const result =
    document.getElementById("realImageResult");


  if (!derniersPrompts) {

    status.style.display = "block";

    status.className =
      "status error";

    status.innerText =
      "⚠️ Prépare d'abord les 5 scènes.";

    return;

  }


  button.disabled = true;

  button.innerText =
    "⏳ Génération des images...";

  status.style.display = "block";

  status.className =
    "status loading";

  status.innerText =
    "🖼️ Cineflow génère les images...";

  result.innerHTML = "";


  try {

    const response =
      await fetch("/api/generate-images", {

        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          prompts: derniersPrompts
        })

      });


    const data =
      await response.json();


    if (!response.ok || !data.success) {

      throw new Error(
        data.error ||
        "Erreur pendant la génération des images."
      );

    }


    status.className =
      "status success";

    status.innerText =
      "✅ Les images Cineflow sont générées !";


    const grid =
      document.createElement("div");

    grid.className =
      "scene-grid";


    data.images.forEach((image, index) => {

      const card =
        document.createElement("div");

      card.className =
        "scene-image-card";

      const title =
        document.createElement("h3");

      title.innerText =
        "🎞️ Scène " + (index + 1);

      const label =
        document.createElement("div");

      label.className =
        "scene-label";

      label.innerText =
        "Image générée par Cineflow";

      const img =
        document.createElement("img");

      img.src =
        "data:" +
        image.mimeType +
        ";base64," +
        image.data;

      img.alt =
        "Image générée pour la scène " +
        (index + 1);

      card.appendChild(title);
      card.appendChild(label);
      card.appendChild(img);

      grid.appendChild(card);

    });


    result.appendChild(grid);


  } catch (error) {

    status.className =
      "status error";

    status.innerText =
      "❌ " + error.message;

  } finally {

    button.disabled = false;

    button.innerText =
      "🖼️ Générer les 5 images";

  }

}

</script></body></html>
  `);
});// --------------------------------------------------
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
// GENERATION DU PROJET
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
// PREPARATION DES PROMPTS VISUELS
// --------------------------------------------------

app.post("/api/prepare-images", async (req, res) => {

try {

if (!API_KEY) {

  return res.status(500).json({

    success: false,

    error:
      "GEMINI_API_KEY n'est pas configurée sur Render."

  });

}


const project =
  typeof req.body.project === "string"
    ? req.body.project.trim()
    : "";


if (!project) {

  return res.status(400).json({

    success: false,

    error:
      "Aucun projet Cineflow n'a été fourni."

  });

}


const prompt = `

Tu es le directeur artistique de Cineflow.

À partir du projet vidéo ci-dessous, crée exactement
5 prompts visuels, un pour chacune des 5 scènes.

Les 5 images doivent représenter le même film.
La cohérence des personnages, des vêtements,
des lieux, de l'âge et de l'ambiance doit être
maintenue d'une scène à l'autre.

Réponds en français.

Pour chaque scène, utilise exactement :

🎞️ SCÈNE 1
PROMPT VISUEL :
FORMAT :
CAMÉRA :
LUMIÈRE :
AMBIANCE :

Puis fais la même chose pour les scènes 2, 3, 4 et 5.

IMPORTANT :

- Décris précisément les personnages.
- Maintiens leur apparence d'une scène à l'autre.
- Décris le lieu.
- Décris l'action.
- Décris la composition de l'image.
- Utilise un style cinématographique réaliste.
- Prépare les prompts pour un futur générateur d'images ou de vidéos.
- Ne crée pas encore les images.
- Ne change pas l'histoire.

PROJET CINEFLOW :
${project}
`;

const response =
  await generateWithRetry(prompt, 4);


const result =
  response.text ||
  "Aucun prompt visuel n'a été généré.";


res.json({

  success: true,

  result: result

});

} catch (error) {

console.error(
  "Erreur préparation images :",
  error
);


const message =
  error?.message ||
  "Erreur inconnue.";


res.status(500).json({

  success: false,

  error:
    "Impossible de préparer les scènes. Détail : " +
    message

});

}

});

// --------------------------------------------------
// GENERATION REELLE DES 5 IMAGES
// --------------------------------------------------

app.post("/api/generate-images", async (req, res) => {

try {

if (!API_KEY) {

  return res.status(500).json({

    success: false,

    error:
      "GEMINI_API_KEY n'est pas configurée sur Render."

  });

}


const prompts =
  typeof req.body.prompts === "string"
    ? req.body.prompts.trim()
    : "";


if (!prompts) {

  return res.status(400).json({

    success: false,

    error:
      "Aucun prompt visuel n'a été fourni."

  });

}


/*
  On demande d'abord à Gemini texte
  d'extraire exactement les 5 prompts.
*/

const extractionPrompt = `

Tu es Cineflow.

Voici les prompts visuels préparés pour un projet vidéo :

${prompts}

Extrais exactement les 5 prompts correspondant
aux scènes 1 à 5.

Réponds UNIQUEMENT avec un JSON valide
de cette forme :

{
"scenes": [
{"scene": 1, "prompt": "..."},
{"scene": 2, "prompt": "..."},
{"scene": 3, "prompt": "..."},
{"scene": 4, "prompt": "..."},
{"scene": 5, "prompt": "..."}
]
}

Ne mets aucun texte avant ou après le JSON.
`;

const extractionResponse =
  await generateWithRetry(
    extractionPrompt,
    4
  );


const extractionText =
  extractionResponse.text || "";


let parsed;


try {

  const clean =
    extractionText
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

  parsed =
    JSON.parse(clean);

} catch (error) {

  console.error(
    "JSON prompts invalide :",
    extractionText
  );

  throw new Error(
    "Cineflow n'a pas réussi à préparer correctement les 5 prompts."
  );

}


if (
  !parsed.scenes ||
  !Array.isArray(parsed.scenes) ||
  parsed.scenes.length !== 5
) {

  throw new Error(
    "Cineflow n'a pas obtenu exactement 5 scènes."
  );

}


const images = [];


/*
  Génération séquentielle :
  une image après l'autre pour éviter
  de surcharger l'API.
*/

for (let i = 0; i < 5; i++) {

  const scene =
    parsed.scenes[i];


  const imagePrompt = `

Crée une image cinématographique réaliste
pour la scène ${i + 1} d'un film.

IMPORTANT :

- Respecte exactement le personnage décrit.
- Respecte son âge et son apparence.
- Respecte les vêtements.
- Respecte le lieu.
- Respecte l'action.
- Respecte l'ambiance.
- Garde une continuité visuelle avec les autres scènes.
- Rendu cinématographique réaliste.
- Composition 16:9.
- Qualité élevée.
- Aucun texte, aucune légende, aucun logo ajouté à l'image.

PROMPT DE LA SCÈNE :
${scene.prompt}
`;

  console.log(
    `Génération de la scène ${i + 1}/5`
  );


  const image =
    await generateImageWithRetry(
      imagePrompt,
      3
    );


  images.push({
    scene: i + 1,
    mimeType: image.mimeType,
    data: image.data
  });

}


res.json({

  success: true,

  images: images

});

} catch (error) {

console.error(
  "Erreur génération des images :",
  error
);


const message =
  error?.message ||
  "Erreur inconnue.";


res.status(500).json({

  success: false,

  error:
    "Impossible de générer les images. Détail : " +
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

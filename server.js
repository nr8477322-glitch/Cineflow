const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;

const ai = new GoogleGenAI({
  apiKey: API_KEY
});

const MODEL = "gemini-3.7-flash";

/* =========================================================
   GEMINI - RETRY
========================================================= */

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

/* =========================================================
   PAGE PRINCIPALE
========================================================= */

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="fr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
/>

<meta
  name="theme-color"
  content="#0b1020"
/>

<title>Cineflow</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family:
    Arial,
    Helvetica,
    sans-serif;
  background: #0b1020;
  color: white;
}

header {
  padding: 35px 20px 25px;
  text-align: center;
}

header h1 {
  margin: 0;
  font-size: 34px;
}

header p {
  margin-top: 10px;
  color: #aeb8d0;
  line-height: 1.5;
}

.container {
  width: min(900px, 94%);
  margin: auto;
  padding-bottom: 50px;
}

.card {
  background: #11182b;
  border: 1px solid #202b45;
  border-radius: 18px;
  padding: 20px;
  margin-bottom: 18px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.18);
}

.card h2 {
  margin-top: 0;
}

.description {
  color: #aeb8d0;
  line-height: 1.5;
}

textarea {
  width: 100%;
  min-height: 130px;
  resize: vertical;
  border: 1px solid #303d5c;
  border-radius: 12px;
  background: #0b1020;
  color: white;
  padding: 15px;
  font-size: 16px;
  outline: none;
}

textarea:focus {
  border-color: #7c8cff;
}

button {
  width: 100%;
  border: none;
  border-radius: 12px;
  padding: 14px 18px;
  margin-top: 12px;
  background: #5865f2;
  color: white;
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
}

button:hover {
  opacity: 0.92;
}

button.secondary {
  background: #202b45;
}

button.success {
  background: #16875c;
}

button.warning {
  background: #9a6b16;
}

.status {
  margin-top: 12px;
  padding: 12px;
  border-radius: 10px;
  background: #0b1020;
  color: #aeb8d0;
  line-height: 1.5;
  white-space: pre-wrap;
}

.result {
  margin-top: 15px;
  padding: 16px;
  background: #0b1020;
  border-radius: 12px;
  border: 1px solid #202b45;
  white-space: pre-wrap;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.hidden {
  display: none;
}

.progress-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  margin-top: 18px;
}

.step {
  background: #0d1427;
  border: 1px solid #202b45;
  border-radius: 12px;
  padding: 15px;
  text-align: center;
}

.step .icon {
  font-size: 25px;
}

.step strong {
  display: block;
  margin-top: 7px;
}

.step span {
  display: block;
  color: #7f8ba8;
  font-size: 13px;
  margin-top: 5px;
}

.step.active {
  border-color: #5865f2;
  background: #151d38;
}

.step.done {
  border-color: #16875c;
}

.actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.info-box {
  padding: 13px;
  border-radius: 10px;
  background: #0d1427;
  color: #aeb8d0;
  margin-top: 12px;
  line-height: 1.5;
}

footer {
  text-align: center;
  color: #65718e;
  padding: 20px;
  font-size: 13px;
}

@media (max-width: 600px) {

  header h1 {
    font-size: 29px;
  }

  .card {
    padding: 16px;
  }

  .progress-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .actions {
    grid-template-columns: 1fr;
  }

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

<!-- =====================================================
     PARCOURS
===================================================== -->

<div class="card">

<h2>🚀 Parcours Cineflow</h2>

<p class="description">
Transforme ton idée en contenu vidéo étape par étape.
</p>

<div class="progress-grid">

<div class="step active" id="stepIdea">
<div class="icon">💡</div>
<strong>Idée</strong>
<span>Ton concept</span>
</div>

<div class="step" id="stepProject">
<div class="icon">🎬</div>
<strong>Projet</strong>
<span>Structure complète</span>
</div>

<div class="step" id="stepScenes">
<div class="icon">🎞️</div>
<strong>5 scènes</strong>
<span>Découpage</span>
</div>

<div class="step" id="stepImages">
<div class="icon">🖼️</div>
<strong>Images</strong>
<span>Prompts visuels</span>
</div>

<div class="step" id="stepVideo">
<div class="icon">🎥</div>
<strong>Vidéo</strong>
<span>Préparation</span>
</div>

<div class="step" id="stepSocial">
<div class="icon">📱</div>
<strong>Réseaux</strong>
<span>Publication</span>
</div>

</div>

</div>


<!-- =====================================================
     CONNEXION GEMINI
===================================================== -->

<div class="card">

<h2>🤖 Connexion IA</h2>

<p class="description">
Vérifie la connexion entre Cineflow et Gemini.
</p>

<button onclick="testerGemini()">
✨ Tester Gemini
</button>

<div id="geminiStatus" class="status">
Clique sur le bouton pour lancer le test.
</div>

</div>


<!-- =====================================================
     CREATION
===================================================== -->

<div class="card">

<h2>💡 Créer un projet</h2>

<p class="description">
Décris ton idée. Cineflow va préparer la structure de ton projet.
</p>

<textarea
  id="idea"
  placeholder="Exemple : Un jeune footballeur de Ouagadougou rêve de devenir professionnel..."
></textarea>

<button
  id="generateButton"
  onclick="genererProjet()"
>
🚀 Générer mon projet
</button>

<div id="status" class="status">
Ton projet apparaîtra ici.
</div>

</div>


<!-- =====================================================
     PROJET
===================================================== -->

<div id="projectCard" class="card hidden">

<h2>🎬 Projet Cineflow</h2>

<div class="actions">

<button
  class="secondary"
  onclick="copierProjet()"
>
📋 Copier le projet
</button>

<button
  class="secondary"
  onclick="sauvegarderProjet()"
>
💾 Sauvegarder
</button>

</div>

<div id="result" class="result"></div>

</div>


<!-- =====================================================
     IMAGES
===================================================== -->

<div id="imageCard" class="card hidden">

<h2>🖼️ Préparer les images</h2>

<p class="description">
Cineflow prépare les prompts visuels des 5 scènes en gardant
une cohérence entre les personnages, les lieux et le style.
</p>

<button
  onclick="preparerImages()"
>
🎨 Préparer les 5 scènes
</button>

<div id="imageStatus" class="status">
Les prompts visuels apparaîtront ici.
</div>

<div id="imageResult" class="result"></div>

</div>


<!-- =====================================================
     VIDEO
===================================================== -->

<div id="videoCard" class="card hidden">

<h2>🎥 Préparer la vidéo</h2>

<p class="description">
Cette étape prépare les informations nécessaires à la génération
de la vidéo à partir des 5 scènes.
</p>

<div class="info-box">
🎞️ Les scènes sont prêtes à être utilisées dans un générateur vidéo.
<br><br>
Cineflow séparera ensuite les scènes, leurs mouvements, leurs
transitions et leur ambiance sonore.
</div>

<button
  class="success"
  onclick="preparerVideo()"
>
🎥 Préparer le projet vidéo
</button>

<div id="videoResult" class="result hidden"></div>

</div>


<!-- =====================================================
     RESEAUX
===================================================== -->

<div id="socialCard" class="card hidden">

<h2>📱 Réseaux sociaux</h2>

<p class="description">
Prépare les contenus nécessaires pour publier ton projet.
</p>

<button
  onclick="preparerReseaux()"
>
📱 Préparer les publications
</button>

<div id="socialResult" class="result hidden"></div>

</div>


<!-- =====================================================
     OUTILS
===================================================== -->

<div class="card">

<h2>🛠️ Outils</h2>

<button
  class="secondary"
  onclick="chargerProjet()"
>
📂 Charger mon dernier projet
</button>

<button
  class="warning"
  onclick="nouveauProjet()"
>
🔄 Nouveau projet
</button>

</div>

</div>

<footer>
Cineflow — Création vidéo assistée par intelligence artificielle
</footer>


<script>

/* =========================================================
   VARIABLES
========================================================= */

let dernierProjet = "";
let derniersPromptsImages = "";


/* =========================================================
   OUTILS
========================================================= */

function afficherEtape(id) {

  const element = document.getElementById(id);

  if (element) {
    element.classList.add("active");
  }

}

function terminerEtape(id) {

  const element = document.getElementById(id);

  if (element) {
    element.classList.remove("active");
    element.classList.add("done");
  }

}

async function copierTexte(texte) {

  try {

    await navigator.clipboard.writeText(texte);

    alert("✅ Copié !");

  } catch (error) {

    alert("Impossible de copier automatiquement.");

  }

}


/* =========================================================
   TEST GEMINI
========================================================= */

async function testerGemini() {

  const status =
    document.getElementById("geminiStatus");

  status.textContent =
    "⏳ Test de connexion à Gemini...";

  try {

    const response =
      await fetch("/api/test-gemini");

    const data =
      await response.json();

    if (data.success) {

      status.textContent =
        "✅ Gemini répond :\\n\\n" +
        data.message;

    } else {

      status.textContent =
        "❌ Erreur : " +
        JSON.stringify(data);

    }

  } catch (error) {

    status.textContent =
      "❌ Impossible de contacter Cineflow.";

  }

}


/* =========================================================
   GENERER PROJET
========================================================= */

async function genererProjet() {

  const idea =
    document.getElementById("idea").value.trim();

  const status =
    document.getElementById("status");

  const button =
    document.getElementById("generateButton");

  if (!idea) {

    status.textContent =
      "⚠️ Écris d'abord ton idée.";

    return;
  }

  button.disabled = true;

  status.textContent =
    "⏳ Cineflow prépare ton projet...";

  afficherEtape("stepProject");

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
      data.result || "";

    document.getElementById("projectCard")
      .classList.remove("hidden");

    document.getElementById("result")
      .textContent = dernierProjet;

    document.getElementById("imageCard")
      .classList.remove("hidden");

    document.getElementById("videoCard")
      .classList.remove("hidden");

    document.getElementById("socialCard")
      .classList.remove("hidden");

    status.textContent =
      "✅ Projet généré avec succès.";

    terminerEtape("stepIdea");
    terminerEtape("stepProject");
    afficherEtape("stepScenes");

    document.getElementById("projectCard")
      .scrollIntoView({
        behavior: "smooth"
      });

  } catch (error) {

    console.error(error);

    status.textContent =
      "❌ " +
      (error.message ||
      "Une erreur est survenue.");

  } finally {

    button.disabled = false;

  }

}


/* =========================================================
   COPIER PROJET
========================================================= */

function copierProjet() {

  if (!dernierProjet) {

    alert("Aucun projet à copier.");

    return;

  }

  copierTexte(dernierProjet);

}


/* =========================================================
   SAUVEGARDER
========================================================= */

function sauvegarderProjet() {

  if (!dernierProjet) {

    alert("Aucun projet à sauvegarder.");

    return;

  }

  localStorage.setItem(
    "cineflowProjet",
    dernierProjet
  );

  alert(
    "💾 Projet sauvegardé sur cet appareil."
  );

}


/* =========================================================
   CHARGER
========================================================= */

function chargerProjet() {

  const projet =
    localStorage.getItem(
      "cineflowProjet"
    );

  if (!projet) {

    alert(
      "Aucun projet sauvegardé."
    );

    return;

  }

  dernierProjet = projet;

  document.getElementById("projectCard")
    .classList.remove("hidden");

  document.getElementById("result")
    .textContent = projet;

  document.getElementById("imageCard")
    .classList.remove("hidden");

  document.getElementById("videoCard")
    .classList.remove("hidden");

  document.getElementById("socialCard")
    .classList.remove("hidden");

  alert(
    "📂 Projet chargé."
  );

}


/* =========================================================
   PREPARER IMAGES
========================================================= */

async function preparerImages() {

  const status =
    document.getElementById("imageStatus");

  const result =
    document.getElementById("imageResult");

  if (!dernierProjet) {

    status.textContent =
      "⚠️ Génère d'abord un projet.";

    return;

  }

  status.textContent =
    "⏳ Préparation des 5 scènes...";

  afficherEtape("stepImages");

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
        "Impossible de préparer les images."
      );

    }

    derniersPromptsImages =
      data.result || "";

    result.textContent =
      derniersPromptsImages;

    status.textContent =
      "✅ Les 5 prompts visuels sont prêts.";

    terminerEtape("stepScenes");
    terminerEtape("stepImages");

    document.getElementById("imageCard")
      .scrollIntoView({
        behavior: "smooth"
      });

  } catch (error) {

    console.error(error);

    status.textContent =
      "❌ " +
      (error.message ||
      "Erreur.");

  }

}


/* =========================================================
   PREPARER VIDEO
========================================================= */

function preparerVideo() {

  const result =
    document.getElementById("videoResult");

  if (!dernierProjet) {

    alert(
      "Génère d'abord un projet."
    );

    return;

  }

  const texte =
`🎥 PROJET VIDÉO CINEFLOW

Le projet contient :

✅ Concept
✅ Personnages
✅ Scénario
✅ 5 scènes
✅ Direction visuelle
✅ Prompts d'images
✅ Informations pour les réseaux sociaux

PROCHAINE ÉTAPE

Utiliser les 5 scènes pour créer les séquences vidéo,
puis assembler les séquences dans l'ordre.

Cineflow est prêt pour l'étape de génération vidéo.`;

  result.textContent = texte;

  result.classList.remove("hidden");

  terminerEtape("stepVideo");

  result.scrollIntoView({
    behavior: "smooth"
  });

}


/* =========================================================
   RESEAUX SOCIAUX
========================================================= */

function preparerReseaux() {

  const result =
    document.getElementById("socialResult");

  if (!dernierProjet) {

    alert(
      "Génère d'abord un projet."
    );

    return;

  }

  const texte =
`📱 PUBLICATION CINEFLOW

Utilise les informations de la section
« RÉSEAUX SOCIAUX » de ton projet.

Préparation :

🎬 TikTok
🎬 YouTube Shorts
🎬 Instagram Reels
🎬 Facebook

Le titre, la description, les hashtags et le concept
peuvent être adaptés à chaque plateforme.`;

  result.textContent = texte;

  result.classList.remove("hidden");

  terminerEtape("stepSocial");

  result.scrollIntoView({
    behavior: "smooth"
  });

}


/* =========================================================
   NOUVEAU PROJET
========================================================= */

function nouveauProjet() {

  const confirmation =
    confirm(
      "Créer un nouveau projet ?"
    );

  if (!confirmation) {
    return;
  }

  dernierProjet = "";
  derniersPromptsImages = "";

  document.getElementById("idea").value = "";

  document.getElementById("status").textContent =
    "Ton projet apparaîtra ici.";

  document.getElementById("result").textContent =
    "";

  document.getElementById("imageResult").textContent =
    "";

  document.getElementById("videoResult").textContent =
    "";

  document.getElementById("socialResult").textContent =
    "";

  document.getElementById("projectCard")
    .classList.add("hidden");

  document.getElementById("imageCard")
    .classList.add("hidden");

  document.getElementById("videoCard")
    .classList.add("hidden");

  document.getElementById("socialCard")
    .classList.add("hidden");

  document.querySelectorAll(".step")
    .forEach(step => {

      step.classList.remove("active");
      step.classList.remove("done");

    });

  document.getElementById("stepIdea")
    .classList.add("active");

}


/* =========================================================
   CHARGER AUTOMATIQUEMENT LE PROJET
========================================================= */

window.addEventListener(
  "load",
  () => {

    const projet =
      localStorage.getItem(
        "cineflowProjet"
      );

    if (projet) {

      console.log(
        "Un projet Cineflow est sauvegardé sur cet appareil."
      );

    }

  }
);

</script>

</body>

</html>
  `);
});


/* =========================================================
   TEST GEMINI
========================================================= */

app.get("/api/test-gemini", async (req, res) => {

  try {

    if (!API_KEY) {

      return res.status(500).json({
        success: false,
        error: "GEMINI_API_KEY est absente."
      });

    }

    const response =
      await generateWithRetry(
        "Réponds simplement : Je suis connecté à Cineflow."
      );

    res.json({
      success: true,
      message:
        response.text ||
        "Gemini répond correctement."
    });

  } catch (error) {

    console.error(
      "Erreur /api/test-gemini:",
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


/* =========================================================
   GENERATION DU PROJET
========================================================= */

app.post("/api/generate", async (req, res) => {

  try {

    const idea =
      String(req.body.idea || "").trim();

    if (!idea) {

      return res.status(400).json({
        success: false,
        error: "L'idée est obligatoire."
      });

    }

    const prompt = `
Tu es l'intelligence créative de Cineflow.

À partir de cette idée :

"${idea}"

Crée un projet vidéo complet en français.

Réponds exactement avec ces sections :

1. TITRE

2. CONCEPT

3. STYLE VISUEL

4. PERSONNAGES

5. SCÉNARIO

6. LES 5 SCÈNES

Pour chaque scène indique :
- Numéro
- Lieu
- Personnages
- Action
- Ambiance
- Cadrage caméra
- Mouvement caméra
- Description visuelle

7. MINIATURE

Décris une miniature forte et cinématographique.

8. RÉSEAUX SOCIAUX

Prépare :
- Titre
- Description courte
- Hashtags
- Version TikTok
- Version YouTube Shorts
- Version Instagram Reels
- Version Facebook

9. PROMPT POUR GÉNÉRATEUR VIDÉO

Crée un prompt détaillé permettant de transformer
les 5 scènes en vidéo.

Règles :

- Tout doit être en français.
- Garde les personnages cohérents.
- Garde les lieux cohérents.
- Garde le style visuel cohérent.
- Le résultat doit être directement exploitable par Cineflow.
- Ne demande pas d'informations supplémentaires.
`;

    const response =
      await generateWithRetry(prompt);

    const result =
      response.text ||
      "Aucun résultat généré.";

    res.json({
      success: true,
      result: result
    });

  } catch (error) {

    console.error(
      "Erreur /api/generate:",
      error
    );

    res.status(500).json({
      success: false,
      error:
        error?.message ||
        "Impossible de générer le projet."
    });

  }

});


/* =========================================================
   PREPARATION DES IMAGES
========================================================= */

app.post("/api/prepare-images", async (req, res) => {

  try {

    const project =
      String(req.body.project || "").trim();

    if (!project) {

      return res.status(400).json({
        success: false,
        error: "Le projet est obligatoire."
      });

    }

    const prompt = `
Tu travailles pour Cineflow.

Voici un projet vidéo :

${project}

Prépare exactement 5 prompts d'images,
un pour chacune des 5 scènes.

Pour chaque scène indique :

SCÈNE 1
- Sujet
- Personnages
- Décor
- Action
- Éclairage
- Caméra
- Style
- Prompt final

Puis fais la même chose pour les scènes 2, 3, 4 et 5.

IMPORTANT :

Les personnages doivent rester identiques
d'une scène à l'autre.

Le style visuel doit rester identique.

Les vêtements, l'âge apparent, les caractéristiques
visuelles et les lieux doivent rester cohérents.

Les prompts doivent être suffisamment détaillés
pour être utilisés dans un générateur d'images.
`;

    const response =
      await generateWithRetry(prompt);

    const result =
      response.text ||
      "Aucun prompt généré.";

    res.json({
      success: true,
      result: result
    });

  } catch (error) {

    console.error(
      "Erreur /api/prepare-images:",
      error
    );

    res.status(500).json({
      success: false,
      error:
        error?.message ||
        "Impossible de préparer les images."
    });

  }

});


/* =========================================================
   DEMARRAGE
========================================================= */

app.listen(PORT, () => {

  console.log(
    "Cineflow API démarrée sur le port " +
    PORT
  );

});

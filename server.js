const express = require("express");
const { GoogleGenAI } = require("@google/genai");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const app = express();

app.use(express.json({ limit: "120mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;

const ai = new GoogleGenAI({
  apiKey: API_KEY
});

// ======================================================
// MODÈLES
// ======================================================

const MODEL = "gemini-3.8-flash";
const IMAGE_MODEL = "gemini-3.1-flash-image";
const VIDEO_MODEL = "veo-3.1-generate-preview";

// ======================================================
// OUTILS
// ======================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanJson(text) {
  if (!text) return "";

  return text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function getInteractionText(interaction) {
  try {
    if (!interaction) return "";

    if (interaction.text) {
      return interaction.text;
    }

    if (
      interaction.response &&
      typeof interaction.response.text === "string"
    ) {
      return interaction.response.text;
    }

    if (
      interaction.response &&
      interaction.response.candidates &&
      interaction.response.candidates[0] &&
      interaction.response.candidates[0].content
    ) {
      const parts =
        interaction.response.candidates[0].content.parts || [];

      return parts
        .map(part => part.text || "")
        .join("");
    }

    return "";
  } catch (error) {
    return "";
  }
}

// ======================================================
// GEMINI TEXTE
// ======================================================

async function generateTextInteraction(prompt) {
  if (!API_KEY) {
    throw new Error("GEMINI_API_KEY n'est pas configurée sur Render.");
  }

  const interaction = await ai.models.generateContent({
    model: MODEL,
    contents: prompt
  });

  return getInteractionText(interaction);
}

// ======================================================
// GÉNÉRATION IMAGE
// ======================================================

async function generateImage(prompt) {
  if (!API_KEY) {
    throw new Error("GEMINI_API_KEY n'est pas configurée.");
  }

  const response = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: prompt
  });

  if (!response || !response.candidates) {
    throw new Error("Aucune image retournée par Gemini.");
  }

  const candidate = response.candidates[0];

  if (
    candidate.content &&
    candidate.content.parts
  ) {
    for (const part of candidate.content.parts) {
      if (part.inlineData && part.inlineData.data) {
        return {
          mimeType:
            part.inlineData.mimeType || "image/png",
          data: part.inlineData.data
        };
      }
    }
  }

  throw new Error("Gemini n'a pas retourné de données image.");
}

// ======================================================
// VIDÉO VEO
// ======================================================

async function generateVideoFromImage(imageBase64, mimeType, prompt) {
  if (!API_KEY) {
    throw new Error("GEMINI_API_KEY n'est pas configurée.");
  }

  const operation = await ai.models.generateVideos({
    model: VIDEO_MODEL,
    prompt,
    image: {
      imageBytes: imageBase64,
      mimeType: mimeType || "image/png"
    }
  });

  let currentOperation = operation;

  for (let i = 0; i < 60; i++) {
    if (currentOperation.done) {
      break;
    }

    await sleep(10000);

    currentOperation =
      await ai.operations.getVideosOperation({
        operation: currentOperation
      });
  }

  if (!currentOperation.done) {
    throw new Error(
      "La génération Veo prend trop de temps."
    );
  }

  if (
    currentOperation.error
  ) {
    throw new Error(
      currentOperation.error.message ||
      "Erreur pendant la génération Veo."
    );
  }

  const generatedVideo =
    currentOperation.response &&
    currentOperation.response.generatedVideos &&
    currentOperation.response.generatedVideos[0];

  if (!generatedVideo) {
    throw new Error(
      "Veo n'a retourné aucune vidéo."
    );
  }

  const videoFile =
    generatedVideo.video;

  if (!videoFile) {
    throw new Error(
      "Fichier vidéo Veo introuvable."
    );
  }

  const tempFile = path.join(
    os.tmpdir(),
    `cineflow-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.mp4`
  );

  await ai.files.download({
    file: videoFile,
    downloadPath: tempFile
  });

  const buffer = fs.readFileSync(tempFile);

  try {
    fs.unlinkSync(tempFile);
  } catch (_) {}

  return buffer.toString("base64");
}

// ======================================================
// FFMPEG
// ======================================================

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      args,
      {
        maxBuffer: 20 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              stderr ||
              error.message ||
              "Erreur FFmpeg."
            )
          );
          return;
        }

        resolve({
          stdout,
          stderr
        });
      }
    );
  });
}

// ======================================================
// DÉTECTION DU STYLE / AMBIANCE
// ======================================================

function detectMood(project) {
  const text = JSON.stringify(project || {})
    .toLowerCase();

  if (
    text.includes("action") ||
    text.includes("combat") ||
    text.includes("course")
  ) {
    return "action intense et énergique";
  }

  if (
    text.includes("drama") ||
    text.includes("drame") ||
    text.includes("triste")
  ) {
    return "émotionnel et dramatique";
  }

  if (
    text.includes("football") ||
    text.includes("match") ||
    text.includes("joueur")
  ) {
    return "sportif, dynamique et motivant";
  }

  if (
    text.includes("suspense") ||
    text.includes("mystère") ||
    text.includes("mystere")
  ) {
    return "tendu, mystérieux et suspense";
  }

  if (
    text.includes("animation") ||
    text.includes("animé") ||
    text.includes("anime")
  ) {
    return "créatif, vivant et aventureux";
  }

  return "cinématographique et immersif";
}

// ======================================================
// PLAN AUDIO
// ======================================================

function buildAudioPlan(project) {
  const mood = detectMood(project);

  let music = "Musique cinématographique adaptée à l'histoire.";

  if (mood.includes("action")) {
    music =
      "Musique énergique, rythmée, percussions puissantes et montée de tension.";
  } else if (mood.includes("émotionnel")) {
    music =
      "Musique émotionnelle avec piano, nappes douces et progression dramatique.";
  } else if (mood.includes("sportif")) {
    music =
      "Musique sportive motivante, rythmée et dynamique.";
  } else if (mood.includes("suspense")) {
    music =
      "Musique de suspense avec tension progressive et ambiance mystérieuse.";
  } else if (mood.includes("créatif")) {
    music =
      "Musique aventureuse et imaginative adaptée à l'animation.";
  }

  return {
    mood,
    music,
    voice: {
      enabled: true,
      style:
        "Voix narrative claire, naturelle et adaptée au ton du scénario.",
      language: "français"
    },
    soundEffects: [
      "Effets sonores synchronisés avec les actions.",
      "Ambiance de lieu adaptée à chaque scène.",
      "Transitions sonores cinématographiques."
    ]
  };
}

// ======================================================
// PLAN MINIATURE
// ======================================================

function buildThumbnailPlan(project) {
  return {
    title:
      project?.title ||
      "Cineflow — Projet vidéo",
    concept:
      "Miniature cinématographique avec le personnage principal au premier plan.",
    composition:
      "Sujet principal très visible, arrière-plan dynamique et contraste clair.",
    text:
      project?.title ||
      "UNE NOUVELLE AVENTURE",
    format: "16:9",
    objective:
      "Créer une miniature accrocheuse adaptée aux plateformes vidéo."
  };
}

// ======================================================
// PLAN RÉSEAUX SOCIAUX
// ======================================================

function buildSocialPlan(project) {
  const title =
    project?.title ||
    "Nouveau projet Cineflow";

  const concept =
    project?.concept ||
    "Une nouvelle histoire créée avec Cineflow.";

  return {
    youtube: {
      title,
      description:
        `${concept}\n\nCréé avec Cineflow.`,
      hashtags: [
        "#Cineflow",
        "#Film",
        "#Video",
        "#AI"
      ]
    },

    tiktok: {
      caption:
        `${title} 🎬 Découvrez cette nouvelle histoire créée avec Cineflow !`,
      hashtags: [
        "#Cineflow",
        "#TikTok",
        "#FilmTok",
        "#Video"
      ]
    },

    instagram: {
      caption:
        `🎬 ${title}\n\n${concept}\n\n#Cineflow #Film #Video`
    },

    facebook: {
      text:
        `🎬 ${title}\n\n${concept}\n\nDécouvrez le projet créé avec Cineflow.`
    }
  };
}

// ======================================================
// PLAN AUTO-PILOTE
// ======================================================

function buildAutoPilotPlan(project) {
  return {
    enabled: true,

    workflow: [
      "Analyser l'idée",
      "Créer l'histoire",
      "Créer le scénario",
      "Préparer 5 scènes",
      "Générer les visuels",
      "Animer les scènes",
      "Assembler la vidéo",
      "Préparer la musique",
      "Préparer la narration",
      "Préparer les effets sonores",
      "Préparer la miniature",
      "Préparer les publications",
      "Suivre les statistiques",
      "Suivre les revenus",
      "Préparer le prochain projet"
    ],

    project:
      project?.title ||
      "Projet Cineflow",

    frequency:
      "Organisation hebdomadaire",

    verification: [
      "Vérifier les vidéos produites",
      "Vérifier les publications",
      "Analyser vues et interactions",
      "Suivre les abonnés",
      "Suivre les revenus",
      "Préparer de nouvelles idées"
    ]
  };
}

// ======================================================
// PAGE PRINCIPALE
// ======================================================

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport"
content="width=device-width,initial-scale=1.0">

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
  padding: 28px 18px;
  text-align: center;
  background:
    linear-gradient(
      135deg,
      #101936,
      #0b1020
    );
  border-bottom: 1px solid #26304d;
}

.logo {
  font-size: 32px;
  font-weight: bold;
}

.subtitle {
  margin-top: 8px;
  color: #aeb8d4;
}

.container {
  width: min(1100px, 94%);
  margin: auto;
  padding: 25px 0 50px;
}

.card {
  background: #11182d;
  border: 1px solid #26304d;
  border-radius: 18px;
  padding: 20px;
  margin-bottom: 18px;
  box-shadow:
    0 10px 30px rgba(0,0,0,.2);
}

h2 {
  margin-top: 0;
}

textarea {
  width: 100%;
  min-height: 130px;
  padding: 15px;
  border-radius: 12px;
  border: 1px solid #303b5c;
  background: #080d1b;
  color: white;
  resize: vertical;
}

button {
  border: 0;
  border-radius: 12px;
  padding: 13px 18px;
  margin-top: 12px;
  font-size: 15px;
  font-weight: bold;
  cursor: pointer;
  background: #4f7cff;
  color: white;
}

button:hover {
  opacity: .9;
}

button.secondary {
  background: #202a46;
}

.status {
  margin-top: 14px;
  padding: 12px;
  border-radius: 10px;
  background: #080d1b;
  color: #b9c4df;
  white-space: pre-wrap;
}

.scene {
  padding: 15px;
  margin-top: 12px;
  background: #0b1123;
  border: 1px solid #26304d;
  border-radius: 12px;
}

.scene img {
  max-width: 100%;
  border-radius: 12px;
  margin-top: 10px;
}

video {
  width: 100%;
  border-radius: 15px;
  margin-top: 15px;
}

.badge {
  display: inline-block;
  padding: 7px 10px;
  border-radius: 999px;
  background: #202a46;
  color: #cbd5f0;
  margin: 4px;
  font-size: 13px;
}

.progress {
  height: 10px;
  background: #202a46;
  border-radius: 999px;
  overflow: hidden;
  margin-top: 12px;
}

.progressBar {
  height: 100%;
  width: 0%;
  background: #4f7cff;
  transition: width .3s;
}

.small {
  color: #9aa6c5;
  font-size: 14px;
}

</style>
</head>

<body>

<header>
  <div class="logo">🎬 Cineflow</div>
  <div class="subtitle">
    Ton espace de création assistée par intelligence artificielle
  </div>
</header>

<div class="container">

<div class="card">

<h2>🔌 Connexion Gemini</h2>

<button onclick="testerGemini()">
✨ Tester Gemini
</button>

<div id="geminiStatus" class="status">
Connexion non testée.
</div>

</div>


<div class="card">

<h2>🎥 Créer une vidéo</h2>

<p class="small">
Décris simplement ton idée de film, d'animation,
d'action, de drama ou de football.
</p>

<textarea id="idea"
placeholder="Exemple : Un jeune footballeur africain rêve de devenir professionnel malgré les difficultés..."></textarea>

<button onclick="genererProjet()">
🚀 Générer mon projet
</button>

<div class="progress">
  <div id="progressBar" class="progressBar"></div>
</div>

<div id="projectStatus" class="status">
En attente de ton idée.
</div>

</div>


<div class="card">

<h2>📖 Projet généré</h2>

<div id="project"></div>

</div>


<div class="card">

<h2>🧩 5 scènes</h2>

<p class="small">
Cineflow transforme automatiquement ton projet
en 5 scènes visuelles cohérentes.
</p>

<button onclick="preparerScenes()">
🧩 Préparer les 5 scènes
</button>

<div id="sceneStatus" class="status">
Les scènes ne sont pas encore préparées.
</div>

<div id="scenes"></div>

</div>


<div class="card">

<h2>🖼️ Génération des images</h2>

<p class="small">
Lorsque les 5 scènes sont prêtes,
Cineflow peut générer leurs images.
</p>

<button onclick="genererImages()">
🎨 Générer les images
</button>

<div id="imageStatus" class="status">
Aucune image générée.
</div>

</div>


<div class="card">

<h2>🎞️ Veo 3.1</h2>

<p class="small">
Cineflow transforme les images des scènes
en clips vidéo animés.
</p>

<button onclick="animerScenes()">
🎞️ Animer les 5 scènes
</button>

<div id="videoStatus" class="status">
Aucune animation générée.
</div>

</div>


<div class="card">

<h2>🎬 Vidéo finale</h2>

<p class="small">
Cineflow assemble les 5 clips en une seule
vidéo MP4 16:9.
</p>

<button onclick="creerVideo()">
🎬 Créer ma vidéo
</button>

<div id="finalStatus" class="status">
La vidéo finale apparaîtra ici.
</div>

<div id="finalVideo"></div>

</div>


<div class="card">

<h2>🎧 Audio Cineflow</h2>

<p class="small">
Préparation automatique de la musique,
de la narration et des effets sonores
selon l'histoire.
</p>

<button onclick="preparerAudio()">
🎧 Préparer l'audio
</button>

<div id="audioStatus" class="status">
Audio non préparé.
</div>

</div>


<div class="card">

<h2>🖼️ Miniature</h2>

<button onclick="preparerThumbnail()">
🖼️ Préparer la miniature
</button>

<div id="thumbnailStatus" class="status">
Miniature non préparée.
</div>

</div>


<div class="card">

<h2>📱 Réseaux sociaux</h2>

<button onclick="preparerSocial()">
📱 Préparer les publications
</button>

<div id="socialStatus" class="status">
Publications non préparées.
</div>

</div>


<div class="card">

<h2>🤖 Auto-Pilote Cineflow</h2>

<p class="small">
Organisation automatique du cycle de création,
publication, suivi et préparation du prochain projet.
</p>

<button onclick="preparerAutoPilot()">
🤖 Préparer l'Auto-Pilote
</button>

<div id="autoStatus" class="status">
Auto-Pilote non configuré.
</div>

</div>


<div class="card">

<h2>📊 Statistiques & revenus</h2>

<div>
  <span class="badge">👁️ Vues</span>
  <span class="badge">❤️ Likes</span>
  <span class="badge">👤 Abonnés</span>
  <span class="badge">💰 Revenus</span>
</div>

<p class="small">
Structure prévue pour connecter plus tard
les statistiques réelles des plateformes.
</p>

</div>

</div>


<script>

let dernierProjet = null;
let derniersPrompts = [];
let dernieresImages = [];
let derniersClips = [];

function setProgress(value) {
  document.getElementById("progressBar").style.width =
    value + "%";
}


async function testerGemini() {

  const box =
    document.getElementById("geminiStatus");

  box.textContent =
    "⏳ Test de Gemini...";

  try {

    const response =
      await fetch("/api/test-gemini");

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Erreur Gemini"
      );
    }

    box.textContent =
      "✅ Gemini répond :\\n\\n" +
      data.message;

  } catch (error) {

    box.textContent =
      "❌ Erreur : " +
      error.message;
  }
}


async function genererProjet() {

  const idea =
    document.getElementById("idea").value.trim();

  if (!idea) {
    alert("Écris d'abord ton idée.");
    return;
  }

  const status =
    document.getElementById("projectStatus");

  status.textContent =
    "⏳ Cineflow prépare ton projet...";

  setProgress(10);

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

    if (!response.ok) {
      throw new Error(
        data.error || "Erreur de génération."
      );
    }

    dernierProjet = data.project;

    document.getElementById("project").innerHTML =
      "<h3>" +
      (dernierProjet.title || "") +
      "</h3>" +
      "<p><b>Concept :</b> " +
      (dernierProjet.concept || "") +
      "</p>" +
      "<p><b>Style :</b> " +
      (dernierProjet.style || "") +
      "</p>" +
      "<p><b>Personnages :</b> " +
      JSON.stringify(
        dernierProjet.characters || []
      ) +
      "</p>" +
      "<p><b>Scénario :</b> " +
      (dernierProjet.scenario || "") +
      "</p>";

    status.textContent =
      "✅ Projet généré.";

    setProgress(25);

  } catch (error) {

    status.textContent =
      "❌ " + error.message;
  }
}


async function preparerScenes() {

  if (!dernierProjet) {
    alert("Génère d'abord ton projet.");
    return;
  }

  const status =
    document.getElementById("sceneStatus");

  status.textContent =
    "⏳ Préparation des 5 scènes...";

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

    if (!response.ok) {
      throw new Error(
        data.error || "Erreur scènes."
      );
    }

    derniersPrompts =
      data.prompts || [];

    document.getElementById("scenes").innerHTML =
      derniersPrompts
        .map(
          (prompt, index) => `
          <div class="scene">
            <b>🎬 Scène ${index + 1}</b>
            <p>${prompt}</p>
          </div>
          `
        )
        .join("");

    status.textContent =
      "✅ 5 scènes préparées.";

    setProgress(40);

  } catch (error) {

    status.textContent =
      "❌ " + error.message;
  }
}


async function genererImages() {

  if (!derniersPrompts.length) {
    alert(
      "Prépare d'abord les 5 scènes."
    );
    return;
  }

  const status =
    document.getElementById("imageStatus");

  status.textContent =
    "⏳ Génération des 5 images...";

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

    if (!response.ok) {
      throw new Error(
        data.error || "Erreur images."
      );
    }

    dernieresImages =
      data.images || [];

    status.textContent =
      "✅ Images générées.";

    setProgress(55);

  } catch (error) {

    status.textContent =
      "❌ " + error.message;
  }
}


async function animerScenes() {

  if (!dernieresImages.length) {
    alert(
      "Génère d'abord les images."
    );
    return;
  }

  const status =
    document.getElementById("videoStatus");

  status.textContent =
    "⏳ Animation des 5 scènes...";

  try {

    const response =
      await fetch("/api/animate-scenes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          images: dernieresImages,
          prompts: derniersPrompts
        })
      });

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Erreur Veo."
      );
    }

    derniersClips =
      data.clips || [];

    status.textContent =
      "✅ Les 5 scènes sont animées.";

    setProgress(75);

  } catch (error) {

    status.textContent =
      "❌ " + error.message;
  }
}


async function creerVideo() {

  if (derniersClips.length !== 5) {
    alert(
      "Il faut avoir les 5 clips Veo."
    );
    return;
  }

  const status =
    document.getElementById("finalStatus");

  status.textContent =
    "⏳ Assemblage de la vidéo finale...";

  try {

    const response =
      await fetch("/api/create-video", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          clips: derniersClips
        })
      });

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Erreur assemblage vidéo."
      );
    }

    status.textContent =
      "✅ Vidéo finale créée.";

    document.getElementById("finalVideo").innerHTML =
      `
      <video controls>
        <source
          src="data:video/mp4;base64,${data.video}"
          type="video/mp4"
        >
      </video>
      `;

    setProgress(100);

  } catch (error) {

    status.textContent =
      "❌ " + error.message;
  }
}


async function preparerAudio() {

  if (!dernierProjet) {
    alert("Génère d'abord ton projet.");
    return;
  }

  const box =
    document.getElementById("audioStatus");

  box.textContent =
    "⏳ Préparation audio...";

  try {

    const response =
      await fetch("/api/prepare-audio", {
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

    if (!response.ok) {
      throw new Error(
        data.error || "Erreur audio."
      );
    }

    box.textContent =
      JSON.stringify(
        data.audio,
        null,
        2
      );

  } catch (error) {

    box.textContent =
      "❌ " + error.message;
  }
}


async function preparerThumbnail() {

  if (!dernierProjet) {
    alert("Génère d'abord ton projet.");
    return;
  }

  const box =
    document.getElementById(
      "thumbnailStatus"
    );

  box.textContent =
    "⏳ Préparation de la miniature...";

  try {

    const response =
      await fetch("/api/prepare-thumbnail", {
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

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Erreur miniature."
      );
    }

    box.textContent =
      JSON.stringify(
        data.thumbnail,
        null,
        2
      );

  } catch (error) {

    box.textContent =
      "❌ " + error.message;
  }
}


async function preparerSocial() {

  if (!dernierProjet) {
    alert("Génère d'abord ton projet.");
    return;
  }

  const box =
    document.getElementById(
      "socialStatus"
    );

  box.textContent =
    "⏳ Préparation des publications...";

  try {

    const response =
      await fetch("/api/prepare-social", {
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

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Erreur réseaux sociaux."
      );
    }

    box.textContent =
      JSON.stringify(
        data.social,
        null,
        2
      );

  } catch (error) {

    box.textContent =
      "❌ " + error.message;
  }
}


async function preparerAutoPilot() {

  if (!dernierProjet) {
    alert("Génère d'abord ton projet.");
    return;
  }

  const box =
    document.getElementById(
      "autoStatus"
    );

  box.textContent =
    "⏳ Préparation de l'Auto-Pilote...";

  try {

    const response =
      await fetch("/api/autopilot-plan", {
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

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Erreur Auto-Pilote."
      );
    }

    box.textContent =
      JSON.stringify(
        data.autopilot,
        null,
        2
      );

  } catch (error) {

    box.textContent =
      "❌ " + error.message;
  }
}

</script>

</body>
</html>
  `);
});

// ======================================================
// TEST GEMINI
// ======================================================

app.get("/api/test-gemini", async (req, res) => {

  try {

    const text =
      await generateTextInteraction(
        "Réponds très brièvement en français pour confirmer que tu es connecté à Cineflow."
      );

    res.json({
      success: true,
      message:
        text ||
        "Gemini est connecté à Cineflow."
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      error:
        error.message ||
        "Impossible de contacter Gemini."
    });
  }
});

// ======================================================
// GÉNÉRER LE PROJET
// ======================================================

app.post("/api/generate", async (req, res) => {

  try {

    const idea =
      String(req.body.idea || "").trim();

    if (!idea) {
      return res.status(400).json({
        error: "L'idée est obligatoire."
      });
    }

    const prompt = `
Tu es le moteur créatif de Cineflow.

À partir de cette idée :

${idea}

Crée un projet vidéo complet.

Réponds UNIQUEMENT avec un JSON valide.

Format obligatoire :

{
  "title": "",
  "concept": "",
  "style": "",
  "characters": [],
  "scenario": "",
  "scenes": [
    {
      "number": 1,
      "title": "",
      "description": ""
    },
    {
      "number": 2,
      "title": "",
      "description": ""
    },
    {
      "number": 3,
      "title": "",
      "description": ""
    },
    {
      "number": 4,
      "title": "",
      "description": ""
    },
    {
      "number": 5,
      "title": "",
      "description": ""
    }
  ],
  "thumbnail": "",
  "social": ""
}

Il doit y avoir exactement 5 scènes.
`;

    const raw =
      await generateTextInteraction(prompt);

    const project =
      JSON.parse(cleanJson(raw));

    if (
      !project.scenes ||
      project.scenes.length !== 5
    ) {
      throw new Error(
        "Le projet généré ne contient pas exactement 5 scènes."
      );
    }

    res.json({
      success: true,
      project
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      error:
        error.message ||
        "Erreur pendant la génération du projet."
    });
  }
});

// ======================================================
// PRÉPARER LES 5 SCÈNES
// ======================================================

app.post(
  "/api/prepare-images",
  async (req, res) => {

    try {

      const project =
        req.body.project;

      if (!project) {
        return res.status(400).json({
          error: "Projet manquant."
        });
      }

      const prompt = `
Transforme ce projet vidéo en exactement
5 prompts visuels cinématographiques.

Projet :

${JSON.stringify(project, null, 2)}

Les 5 prompts doivent être cohérents entre eux.

Conserve :
- les mêmes personnages
- les mêmes vêtements
- la même identité visuelle
- la même époque
- le même univers

Chaque prompt doit décrire précisément :
- personnage
- environnement
- action
- caméra
- lumière
- ambiance
- style cinématographique

Réponds UNIQUEMENT avec un JSON :

{
  "prompts": [
    "...",
    "...",
    "...",
    "...",
    "..."
  ]
}
`;

      const raw =
        await generateTextInteraction(prompt);

      const result =
        JSON.parse(cleanJson(raw));

      if (
        !result.prompts ||
        result.prompts.length !== 5
      ) {
        throw new Error(
          "Il faut exactement 5 prompts."
        );
      }

      res.json({
        success: true,
        prompts: result.prompts
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        success: false,
        error:
          error.message ||
          "Erreur pendant la préparation des scènes."
      });
    }
  }
);

// ======================================================
// GÉNÉRER LES 5 IMAGES
// ======================================================

app.post(
  "/api/generate-images",
  async (req, res) => {

    try {

      const prompts =
        req.body.prompts;

      if (
        !Array.isArray(prompts) ||
        prompts.length !== 5
      ) {
        return res.status(400).json({
          error:
            "Il faut exactement 5 prompts."
        });
      }

      const images = [];

      for (let i = 0; i < prompts.length; i++) {

        console.log(
          `Génération image ${i + 1}/5`
        );

        const image =
          await generateImage(
            prompts[i]
          );

        images.push({
          scene: i + 1,
          mimeType: image.mimeType,
          data: image.data
        });
      }

      res.json({
        success: true,
        images
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        success: false,
        error:
          error.message ||
          "Erreur pendant la génération des images."
      });
    }
  }
);

// ======================================================
// ANIMER UNE SCÈNE
// ======================================================

app.post(
  "/api/animate-scene",
  async (req, res) => {

    try {

      const image =
        req.body.image;

      const prompt =
        req.body.prompt;

      if (!image || !image.data) {
        return res.status(400).json({
          error: "Image manquante."
        });
      }

      const clip =
        await generateVideoFromImage(
          image.data,
          image.mimeType,
          prompt ||
            "Animation cinématographique naturelle."
        );

      res.json({
        success: true,
        clip
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        success: false,
        error:
          error.message ||
          "Erreur pendant l'animation."
      });
    }
  }
);

// ======================================================
// ANIMER LES 5 SCÈNES
// ======================================================

app.post(
  "/api/animate-scenes",
  async (req, res) => {

    try {

      const images =
        req.body.images || [];

      const prompts =
        req.body.prompts || [];

      if (images.length !== 5) {
        return res.status(400).json({
          error:
            "Il faut exactement 5 images."
        });
      }

      const clips = [];

      for (let i = 0; i < 5; i++) {

        console.log(
          `Animation scène ${i + 1}/5`
        );

        const prompt =
          prompts[i] ||
          "Animation cinématographique fluide.";

        const clip =
          await generateVideoFromImage(
            images[i].data,
            images[i].mimeType,
            prompt
          );

        clips.push({
          scene: i + 1,
          data: clip
        });
      }

      res.json({
        success: true,
        clips
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        success: false,
        error:
          error.message ||
          "Erreur pendant l'animation des scènes."
      });
    }
  }
);

// ======================================================
// ASSEMBLER LES 5 CLIPS
// ======================================================

app.post(
  "/api/create-video",
  async (req, res) => {

    const workingDir =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "cineflow-"
        )
      );

    try {

      const clips =
        req.body.clips || [];

      if (clips.length !== 5) {
        return res.status(400).json({
          error:
            "Il faut exactement 5 clips."
        });
      }

      const normalizedFiles = [];

      for (let i = 0; i < clips.length; i++) {

        const inputFile =
          path.join(
            workingDir,
            `input-${i}.mp4`
          );

        const outputFile =
          path.join(
            workingDir,
            `normalized-${i}.mp4`
          );

        fs.writeFileSync(
          inputFile,
          Buffer.from(
            clips[i].data,
            "base64"
          )
        );

        await runFFmpeg([
          "-y",
          "-i",
          inputFile,
          "-vf",
          "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
          "-r",
          "24",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-ar",
          "48000",
          outputFile
        ]);

        normalizedFiles.push(
          outputFile
        );
      }

      const concatFile =
        path.join(
          workingDir,
          "concat.txt"
        );

      fs.writeFileSync(
        concatFile,
        normalizedFiles
          .map(
            file =>
              `file '${file.replace(/'/g, "'\\''")}'`
          )
          .join("\n")
      );

      const finalFile =
        path.join(
          workingDir,
          "cineflow-final.mp4"
        );

      await runFFmpeg([
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatFile,
        "-c",
        "copy",
        finalFile
      ]);

      const finalBuffer =
        fs.readFileSync(finalFile);

      res.json({
        success: true,
        video:
          finalBuffer.toString("base64")
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        success: false,
        error:
          error.message ||
          "Erreur pendant la création de la vidéo."
      });

    } finally {

      try {
        fs.rmSync(
          workingDir,
          {
            recursive: true,
            force: true
          }
        );
      } catch (_) {}
    }
  }
);

// ======================================================
// AUDIO
// ======================================================

app.post(
  "/api/prepare-audio",
  (req, res) => {

    try {

      const project =
        req.body.project;

      if (!project) {
        return res.status(400).json({
          error: "Projet manquant."
        });
      }

      res.json({
        success: true,
        audio:
          buildAudioPlan(project)
      });

    } catch (error) {

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// ======================================================
// MINIATURE
// ======================================================

app.post(
  "/api/prepare-thumbnail",
  (req, res) => {

    try {

      const project =
        req.body.project;

      if (!project) {
        return res.status(400).json({
          error: "Projet manquant."
        });
      }

      res.json({
        success: true,
        thumbnail:
          buildThumbnailPlan(project)
      });

    } catch (error) {

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// ======================================================
// RÉSEAUX SOCIAUX
// ======================================================

app.post(
  "/api/prepare-social",
  (req, res) => {

    try {

      const project =
        req.body.project;

      if (!project) {
        return res.status(400).json({
          error: "Projet manquant."
        });
      }

      res.json({
        success: true,
        social:
          buildSocialPlan(project)
      });

    } catch (error) {

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// ======================================================
// AUTO-PILOTE
// ======================================================

app.post(
  "/api/autopilot-plan",
  (req, res) => {

    try {

      const project =
        req.body.project;

      if (!project) {
        return res.status(400).json({
          error: "Projet manquant."
        });
      }

      res.json({
        success: true,
        autopilot:
          buildAutoPilotPlan(project)
      });

    } catch (error) {

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// ======================================================
// 404
// ======================================================

app.use((req, res) => {

  res.status(404).json({
    error: "Route introuvable."
  });

});

// ======================================================
// DÉMARRAGE
// ======================================================

app.listen(PORT, () => {

  console.log(
    `Cineflow API démarrée sur le port ${PORT}`
  );

});

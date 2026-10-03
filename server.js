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

function getInteractionText(response) {
  if (!response) return "";

  if (typeof response.text === "string") {
    return response.text;
  }

  if (response.text) {
    return String(response.text);
  }

  try {
    if (response.candidates) {
      return response.candidates
        .flatMap(candidate => candidate.content?.parts || [])
        .map(part => part.text || "")
        .join("\n");
    }
  } catch (error) {
    console.log("Lecture réponse impossible :", error.message);
  }

  return "";
}

async function generateTextInteraction(prompt) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt
  });

  return getInteractionText(response);
}

async function generateImage(prompt) {
  const response = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: prompt
  });

  if (!response.candidates) {
    throw new Error("Aucune image générée.");
  }

  for (const candidate of response.candidates) {
    const parts = candidate.content?.parts || [];

    for (const part of parts) {
      if (part.inlineData?.data) {
        return {
          mimeType: part.inlineData.mimeType || "image/png",
          data: part.inlineData.data
        };
      }
    }
  }

  throw new Error("Gemini n'a retourné aucune image.");
}

async function generateVideoFromImage(imageBase64, mimeType, prompt) {
  const operation = await ai.models.generateVideos({
    model: VIDEO_MODEL,
    prompt,
    image: {
      imageBytes: imageBase64,
      mimeType: mimeType || "image/png"
    },
    config: {
      aspectRatio: "16:9",
      resolution: "720p"
    }
  });

  let currentOperation = operation;

  for (let i = 0; i < 60; i++) {
    if (currentOperation.done) {
      break;
    }

    await sleep(5000);

    currentOperation =
      await ai.operations.getVideosOperation({
        operation: currentOperation
      });
  }

  if (!currentOperation.done) {
    throw new Error("La génération Veo a pris trop de temps.");
  }

  const generatedVideos =
    currentOperation.response?.generatedVideos ||
    currentOperation.result?.generatedVideos ||
    [];

  if (!generatedVideos.length) {
    throw new Error("Veo n'a retourné aucune vidéo.");
  }

  const video = generatedVideos[0];

  if (!video.video) {
    throw new Error("Fichier vidéo Veo introuvable.");
  }

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cineflow-veo-")
  );

  const outputPath = path.join(tempDir, "scene.mp4");

  await ai.files.download({
    file: video.video,
    downloadPath: outputPath
  });

  const data = fs.readFileSync(outputPath).toString("base64");

  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });

  return data;
}

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
          console.error("FFmpeg :", stderr);
          reject(error);
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
// ANALYSE AUTOMATIQUE DU STYLE
// ======================================================

function detectMood(project = {}) {
  const text = [
    project.title,
    project.concept,
    project.style,
    project.scenario,
    ...(project.scenes || []).map(scene =>
      typeof scene === "string"
        ? scene
        : JSON.stringify(scene)
    )
  ]
    .join(" ")
    .toLowerCase();

  if (
    text.includes("action") ||
    text.includes("combat") ||
    text.includes("course") ||
    text.includes("aventure")
  ) {
    return {
      name: "Action / Aventure",
      energy: "élevée",
      music: "rythmique et cinématique",
      instruments: "percussions, basses, synthés cinématiques",
      voice: "énergique et déterminée",
      effects: "impacts, mouvements, transitions, ambiance dynamique"
    };
  }

  if (
    text.includes("football") ||
    text.includes("footballeur") ||
    text.includes("match") ||
    text.includes("stade")
  ) {
    return {
      name: "Football / Sport",
      energy: "élevée",
      music: "sportive, motivante et dynamique",
      instruments: "percussions, basses, synthés et claps",
      voice: "motivée et enthousiaste",
      effects: "public, stade, ballon, sifflet, mouvements"
    };
  }

  if (
    text.includes("drama") ||
    text.includes("drame") ||
    text.includes("émotion") ||
    text.includes("famille")
  ) {
    return {
      name: "Drame / Émotion",
      energy: "faible à moyenne",
      music: "émotionnelle et cinématique",
      instruments: "piano, cordes, pads doux",
      voice: "calme, expressive et narrative",
      effects: "ambiance naturelle, portes, pas, environnement"
    };
  }

  if (
    text.includes("suspense") ||
    text.includes("mystère") ||
    text.includes("myster")
  ) {
    return {
      name: "Suspense / Mystère",
      energy: "progressive",
      music: "tendue et mystérieuse",
      instruments: "pads sombres, pulsations, cordes",
      voice: "calme et légèrement mystérieuse",
      effects: "ambiances, mouvements, transitions, tension"
    };
  }

  if (
    text.includes("animation") ||
    text.includes("animé") ||
    text.includes("anime")
  ) {
    return {
      name: "Animation",
      energy: "moyenne à élevée",
      music: "ludique et cinématique",
      instruments: "percussions légères, synthés, piano",
      voice: "claire et expressive",
      effects: "transitions, mouvements et effets cartoon"
    };
  }

  return {
    name: "Cinématique",
    energy: "moyenne",
    music: "cinématique moderne",
    instruments: "piano, cordes, pads et percussions légères",
    voice: "naturelle et narrative",
    effects: "ambiances et transitions cinématiques"
  };
}

// ======================================================
// AUDIO
// ======================================================

function buildAudioPlan(project) {
  const mood = detectMood(project);

  return {
    mood,
    music: {
      enabled: true,
      direction: mood.music,
      instruments: mood.instruments,
      energy: mood.energy,
      instruction:
        `Créer une musique ${mood.music}, adaptée à une histoire de type ${mood.name}.`
    },
    narration: {
      enabled: true,
      style: mood.voice,
      instruction:
        `Voix off ${mood.voice}, avec un rythme naturel et une bonne articulation.`
    },
    soundEffects: {
      enabled: true,
      direction: mood.effects,
      instruction:
        `Ajouter des effets sonores cohérents avec chaque scène : ${mood.effects}.`
    }
  };
}

// ======================================================
// MINIATURE
// ======================================================

function buildThumbnailPlan(project) {
  const mood = detectMood(project);

  return {
    title: project.title || "Cineflow",
    style: mood.name,
    prompt:
      `Miniature YouTube cinématique pour "${project.title || "un film"}". ` +
      `Style ${mood.name}. Sujet principal clairement visible, ` +
      `composition dynamique, lumière cinématique, image très lisible, ` +
      `sans texte excessif, format 16:9.`
  };
}

// ======================================================
// RÉSEAUX SOCIAUX
// ======================================================

function buildSocialPlan(project) {
  const title = project.title || "Mon nouveau projet Cineflow";
  const concept = project.concept || "";
  const social = project.social || {};

  return {
    youtube: {
      title,
      description:
        social.youtubeDescription ||
        `${concept}\n\nCréé avec Cineflow.`,
      hashtags: "#Cineflow #Film #AI #Video"
    },

    tiktok: {
      caption:
        social.tiktokCaption ||
        `${title} 🎬 Découvrez cette création réalisée avec Cineflow.`,
      hashtags:
        "#Cineflow #AI #Video #Film #Story"
    },

    instagram: {
      caption:
        social.instagramCaption ||
        `${title} 🎬\n\nUne nouvelle création Cineflow.`,
      hashtags:
        "#Cineflow #AIvideo #Film #Creation"
    },

    facebook: {
      text:
        social.facebookText ||
        `${title}\n\n${concept}\n\nCréé avec Cineflow.`
    }
  };
}

// ======================================================
// AUTO-PILOTE
// ======================================================

function buildAutoPilotPlan(project) {
  return {
    status: "ready",
    project: project.title || "Projet Cineflow",

    workflow: [
      {
        id: 1,
        name: "Idée",
        status: "completed"
      },
      {
        id: 2,
        name: "Histoire",
        status: project.scenario ? "completed" : "pending"
      },
      {
        id: 3,
        name: "5 scènes",
        status:
          Array.isArray(project.scenes) &&
          project.scenes.length === 5
            ? "completed"
            : "pending"
      },
      {
        id: 4,
        name: "Images",
        status: "pending"
      },
      {
        id: 5,
        name: "Vidéo",
        status: "pending"
      },
      {
        id: 6,
        name: "Audio",
        status: "pending"
      },
      {
        id: 7,
        name: "Miniature",
        status: "pending"
      },
      {
        id: 8,
        name: "Réseaux sociaux",
        status: "pending"
      },
      {
        id: 9,
        name: "Publication",
        status: "manual"
      },
      {
        id: 10,
        name: "Statistiques",
        status: "pending"
      }
    ],

    weeklyRoutine: [
      "Vérifier les vidéos publiées",
      "Vérifier les vues et interactions",
      "Suivre les abonnés",
      "Suivre les revenus disponibles",
      "Identifier les contenus qui fonctionnent",
      "Préparer de nouvelles idées",
      "Lancer le prochain cycle Cineflow"
    ],

    note:
      "L'Auto-Pilote prépare et organise le travail. " +
      "La publication réelle sur les plateformes nécessite leurs APIs " +
      "et les autorisations du compte."
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
      content="width=device-width, initial-scale=1.0">

<title>Cineflow</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, sans-serif;
  color: #f7f8ff;
  background:
    radial-gradient(circle at top left, #18265c 0, transparent 35%),
    radial-gradient(circle at top right, #351c5e 0, transparent 35%),
    #070b16;
}

button,
input,
textarea {
  font: inherit;
}

button {
  cursor: pointer;
}

.container {
  width: min(1120px, calc(100% - 28px));
  margin: auto;
}

.hero {
  padding: 38px 0 24px;
}

.hero-box {
  border: 1px solid rgba(255,255,255,.1);
  background: rgba(15,20,39,.78);
  backdrop-filter: blur(18px);
  border-radius: 28px;
  padding: 28px;
  box-shadow: 0 25px 80px rgba(0,0,0,.35);
}

.logo {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 30px;
  font-weight: 800;
}

.logo-icon {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border-radius: 15px;
  background: linear-gradient(135deg,#7c5cff,#00d4ff);
}

.subtitle {
  color: #aeb8d7;
  margin-top: 10px;
  font-size: 16px;
}

.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
}

.badge {
  border: 1px solid rgba(255,255,255,.1);
  background: rgba(255,255,255,.05);
  border-radius: 999px;
  padding: 7px 12px;
  font-size: 12px;
  color: #cbd4f4;
}

.progress {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 7px;
  margin: 22px 0;
}

.progress-step {
  height: 6px;
  border-radius: 99px;
  background: #252c43;
}

.progress-step.active {
  background: linear-gradient(90deg,#7c5cff,#00d4ff);
}

.card {
  background: rgba(15,20,39,.82);
  border: 1px solid rgba(255,255,255,.08);
  border-radius: 22px;
  padding: 22px;
  margin: 16px 0;
  box-shadow: 0 15px 50px rgba(0,0,0,.18);
}

.card h2 {
  margin: 0 0 8px;
}

.card p {
  color: #aeb8d7;
  line-height: 1.6;
}

textarea {
  width: 100%;
  min-height: 125px;
  resize: vertical;
  color: white;
  background: #0a0f20;
  border: 1px solid #29324d;
  border-radius: 15px;
  padding: 15px;
  outline: none;
}

textarea:focus,
input:focus {
  border-color: #7c5cff;
}

input {
  width: 100%;
  color: white;
  background: #0a0f20;
  border: 1px solid #29324d;
  border-radius: 12px;
  padding: 12px;
  outline: none;
}

button {
  border: 0;
  border-radius: 13px;
  padding: 12px 18px;
  color: white;
  background: linear-gradient(135deg,#7257ff,#367dff);
  font-weight: 700;
  margin-top: 12px;
  transition: .2s;
}

button:hover {
  transform: translateY(-2px);
  filter: brightness(1.08);
}

button.secondary {
  background: #202842;
}

button.success {
  background: linear-gradient(135deg,#00a878,#00c98b);
}

button.warning {
  background: linear-gradient(135deg,#c97800,#f2a900);
}

button:disabled {
  opacity: .45;
  cursor: not-allowed;
  transform: none;
}

.status {
  margin-top: 14px;
  padding: 14px;
  border-radius: 13px;
  background: #0b1122;
  border: 1px solid #202a46;
  white-space: pre-wrap;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2,1fr);
  gap: 16px;
}

.small-grid {
  display: grid;
  grid-template-columns: repeat(3,1fr);
  gap: 12px;
}

.scene {
  padding: 15px;
  background: #0b1122;
  border: 1px solid #202a46;
  border-radius: 14px;
  margin-top: 10px;
}

.scene strong {
  color: #fff;
}

.scene p {
  margin-bottom: 0;
}

.image-grid {
  display: grid;
  grid-template-columns: repeat(2,1fr);
  gap: 12px;
}

.image-grid img {
  width: 100%;
  border-radius: 15px;
  display: block;
}

video {
  width: 100%;
  border-radius: 18px;
  margin-top: 15px;
  background: black;
}

.workflow-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 13px;
  margin-top: 9px;
  border-radius: 13px;
  background: #0b1122;
}

.workflow-ok {
  color: #48e0a2;
}

.workflow-pending {
  color: #9ca8c9;
}

.workflow-manual {
  color: #ffc857;
}

.stat-box {
  background: #0b1122;
  border: 1px solid #202a46;
  border-radius: 15px;
  padding: 16px;
}

.stat-number {
  font-size: 25px;
  font-weight: 800;
  margin-top: 6px;
}

.footer {
  color: #687494;
  text-align: center;
  padding: 35px 0;
}

@media(max-width: 750px) {

  .grid,
  .small-grid,
  .image-grid {
    grid-template-columns: 1fr;
  }

  .progress {
    grid-template-columns: repeat(4,1fr);
  }

  .hero-box {
    padding: 21px;
  }

  .logo {
    font-size: 25px;
  }
}

</style>
</head>

<body>

<div class="container">

<section class="hero">
  <div class="hero-box">

    <div class="logo">
      <div class="logo-icon">🎬</div>
      <div>Cineflow</div>
    </div>

    <div class="subtitle">
      Ton espace de création vidéo assistée par intelligence artificielle.
    </div>

    <div class="badges">
      <span class="badge">🤖 IA</span>
      <span class="badge">🎬 Vidéo</span>
      <span class="badge">🎨 Images</span>
      <span class="badge">🎵 Audio</span>
      <span class="badge">📱 Réseaux sociaux</span>
      <span class="badge">⚙️ Auto-Pilote</span>
    </div>

  </div>
</section>

<div class="progress">
  <div class="progress-step active"></div>
  <div class="progress-step"></div>
  <div class="progress-step"></div>
  <div class="progress-step"></div>
  <div class="progress-step"></div>
  <div class="progress-step"></div>
  <div class="progress-step"></div>
  <div class="progress-step"></div>
</div>

<!-- GEMINI -->

<section class="card">

  <h2>🔌 Connexion Gemini</h2>

  <p>
    Vérifie la connexion de Cineflow à Gemini.
  </p>

  <button onclick="testerGemini()">
    ✨ Tester Gemini
  </button>

  <div id="geminiStatus" class="status">
    En attente...
  </div>

</section>

<!-- PROJET -->

<section class="card">

  <h2>🎥 1. Créer ton projet</h2>

  <p>
    Décris ton idée de film, animation, action, drama ou football.
  </p>

  <textarea
    id="idea"
    placeholder="Exemple : Un jeune footballeur africain rêve de devenir professionnel malgré les difficultés..."
  ></textarea>

  <button onclick="genererProjet()">
    🚀 Générer mon projet
  </button>

  <div id="projectStatus" class="status">
    Aucun projet généré.
  </div>

</section>

<!-- PROJET RESULTAT -->

<section id="projectCard" class="card" style="display:none">

  <h2>🎬 Projet Cineflow</h2>

  <div id="projectResult"></div>

</section>

<!-- SCENES -->

<section class="card">

  <h2>🧩 2. Préparer les 5 scènes</h2>

  <p>
    Cineflow transforme ton projet en cinq scènes visuelles cohérentes.
  </p>

  <button
    id="prepareScenesButton"
    onclick="preparerImages()"
    disabled
  >
    🧩 Préparer les 5 scènes
  </button>

  <div id="promptsStatus" class="status">
    En attente du projet.
  </div>

</section>

<!-- IMAGES -->

<section class="card">

  <h2>🎨 3. Générer les images</h2>

  <p>
    Chaque scène reçoit son image de référence.
  </p>

  <button
    id="generateImagesButton"
    onclick="genererImages()"
    disabled
  >
    🖼️ Générer les images
  </button>

  <div id="imagesStatus" class="status">
    En attente des scènes.
  </div>

  <div id="imagesResult" class="image-grid"></div>

</section>

<!-- VIDEO -->

<section class="card">

  <h2>🎞️ 4. Animer avec Veo</h2>

  <p>
    Les images deviennent de véritables clips vidéo.
  </p>

  <button
    id="animateButton"
    onclick="animerScenes()"
    disabled
  >
    🎞️ Animer les 5 scènes
  </button>

  <div id="videoStatus" class="status">
    En attente des images.
  </div>

  <div id="clipsResult"></div>

</section>

<!-- FINAL VIDEO -->

<section class="card">

  <h2>🎬 5. Créer la vidéo finale</h2>

  <p>
    Cineflow assemble automatiquement les cinq clips en une vidéo MP4 16:9.
  </p>

  <button
    id="createVideoButton"
    onclick="creerVideo()"
    disabled
  >
    🎬 Créer ma vidéo
  </button>

  <div id="finalVideoStatus" class="status">
    En attente des clips.
  </div>

  <div id="finalVideo"></div>

</section>

<!-- AUDIO -->

<section class="card">

  <h2>🎵 6. Audio intelligent</h2>

  <p>
    Cineflow adapte la direction musicale, la narration et les effets
    sonores au style de ton histoire.
  </p>

  <button
    id="audioButton"
    onclick="preparerAudio()"
    disabled
  >
    🎧 Préparer l'audio
  </button>

  <div id="audioResult" class="status">
    En attente du projet.
  </div>

</section>

<!-- MINIATURE -->

<section class="card">

  <h2>🖼️ 7. Miniature</h2>

  <p>
    Cineflow prépare automatiquement le concept de miniature.
  </p>

  <button
    id="thumbnailButton"
    onclick="preparerMiniature()"
    disabled
  >
    🖼️ Préparer ma miniature
  </button>

  <div id="thumbnailResult" class="status">
    En attente du projet.
  </div>

</section>

<!-- SOCIAL -->

<section class="card">

  <h2>📱 8. Réseaux sociaux</h2>

  <p>
    Prépare les textes adaptés à YouTube, TikTok, Instagram et Facebook.
  </p>

  <button
    id="socialButton"
    onclick="preparerSocial()"
    disabled
  >
    📱 Préparer les publications
  </button>

  <div id="socialResult" class="status">
    En attente du projet.
  </div>

</section>

<!-- AUTO PILOTE -->

<section class="card">

  <h2>⚙️ Cineflow Auto-Pilote</h2>

  <p>
    Le centre de contrôle du pipeline Cineflow.
  </p>

  <button
    id="autoPilotButton"
    onclick="chargerAutoPilot()"
    disabled
  >
    ⚙️ Voir le plan Auto-Pilote
  </button>

  <div id="autoPilotResult"></div>

</section>

<!-- STATS -->

<section class="card">

  <h2>📊 Statistiques & revenus</h2>

  <p>
    Entre tes statistiques pour suivre l'évolution de tes vidéos.
  </p>

  <div class="small-grid">

    <div class="stat-box">
      <div>👁️ Vues</div>
      <input id="viewsInput" type="number" min="0" value="0">
      <div id="viewsTotal" class="stat-number">0</div>
    </div>

    <div class="stat-box">
      <div>❤️ Likes</div>
      <input id="likesInput" type="number" min="0" value="0">
      <div id="likesTotal" class="stat-number">0</div>
    </div>

    <div class="stat-box">
      <div>👥 Abonnés</div>
      <input id="subsInput" type="number" min="0" value="0">
      <div id="subsTotal" class="stat-number">0</div>
    </div>

  </div>

  <div style="margin-top:15px">

    <label>💰 Revenus estimés</label>

    <input
      id="revenueInput"
      type="number"
      min="0"
      step="0.01"
      value="0"
    >

    <button
      class="success"
      onclick="calculerStats()"
    >
      📊 Mettre à jour
    </button>

  </div>

  <div id="statsResult" class="status">
    Aucune statistique enregistrée.
  </div>

</section>

<div class="footer">
  Cineflow — création vidéo intelligente 🎬
</div>

</div>

<script>

let dernierProjet = null;
let derniersPrompts = [];
let dernieresImages = [];
let derniersClips = [];

let workflowStep = 1;

// ======================================================
// OUTILS FRONTEND
// ======================================================

function escapeHtml(value) {

  if (value === null || value === undefined) {
    return "";
  }

  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setStatus(id, text) {

  const element = document.getElementById(id);

  if (element) {
    element.textContent = text;
  }
}

function setWorkflow(step) {

  workflowStep = step;

  const elements =
    document.querySelectorAll(".progress-step");

  elements.forEach((element, index) => {

    if (index < step) {
      element.classList.add("active");
    } else {
      element.classList.remove("active");
    }

  });
}

function enable(id) {

  const element = document.getElementById(id);

  if (element) {
    element.disabled = false;
  }
}

// ======================================================
// GEMINI
// ======================================================

async function testerGemini() {

  setStatus(
    "geminiStatus",
    "⏳ Test de connexion..."
  );

  try {

    const response =
      await fetch("/api/test-gemini");

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Erreur Gemini"
      );
    }

    setStatus(
      "geminiStatus",
      "✅ " + data.message
    );

  } catch (error) {

    setStatus(
      "geminiStatus",
      "❌ " + error.message
    );

  }
}

// ======================================================
// GÉNÉRER PROJET
// ======================================================

async function genererProjet() {

  const idea =
    document.getElementById("idea").value.trim();

  if (!idea) {

    setStatus(
      "projectStatus",
      "⚠️ Décris d'abord ton idée."
    );

    return;
  }

  setStatus(
    "projectStatus",
    "⏳ Cineflow prépare ton histoire..."
  );

  try {

    const response = await fetch(
      "/api/generate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ idea })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Erreur pendant la génération."
      );
    }

    dernierProjet = data.project;

    afficherProjet();

    enable("prepareScenesButton");
    enable("audioButton");
    enable("thumbnailButton");
    enable("socialButton");
    enable("autoPilotButton");

    setWorkflow(2);

    setStatus(
      "projectStatus",
      "✅ Projet généré."
    );

  } catch (error) {

    setStatus(
      "projectStatus",
      "❌ " + error.message
    );

  }
}

// ======================================================
// AFFICHAGE PROJET
// ======================================================

function afficherProjet() {

  const card =
    document.getElementById("projectCard");

  const result =
    document.getElementById("projectResult");

  card.style.display = "block";

  const scenes =
    Array.isArray(dernierProjet.scenes)
      ? dernierProjet.scenes
      : [];

  result.innerHTML = `

    <h3>
      ${escapeHtml(dernierProjet.title)}
    </h3>

    <p>
      <strong>Concept :</strong><br>
      ${escapeHtml(dernierProjet.concept)}
    </p>

    <p>
      <strong>Style :</strong>
      ${escapeHtml(dernierProjet.style)}
    </p>

    <p>
      <strong>Personnages :</strong><br>
      ${escapeHtml(dernierProjet.characters)}
    </p>

    <p>
      <strong>Scénario :</strong><br>
      ${escapeHtml(dernierProjet.scenario)}
    </p>

    <h3>🎬 Les 5 scènes</h3>

    ${scenes.map((scene, index) => {

      const text =
        typeof scene === "string"
          ? scene
          : JSON.stringify(scene);

      return `
        <div class="scene">
          <strong>Scène ${index + 1}</strong>
          <p>${escapeHtml(text)}</p>
        </div>
      `;

    }).join("")}

  `;
}

// ======================================================
// PRÉPARER LES 5 SCÈNES
// ======================================================

async function preparerImages() {

  if (!dernierProjet) {
    return;
  }

  setStatus(
    "promptsStatus",
    "⏳ Préparation des cinq scènes..."
  );

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

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Impossible de préparer les scènes."
      );
    }

    derniersPrompts = data.prompts || [];

    setStatus(
      "promptsStatus",
      derniersPrompts
        .map((prompt, index) =>
          `🎬 Scène ${index + 1}\n${prompt}`
        )
        .join("\n\n")
    );

    enable("generateImagesButton");

    setWorkflow(3);

  } catch (error) {

    setStatus(
      "promptsStatus",
      "❌ " + error.message
    );

  }
}

// ======================================================
// GÉNÉRER IMAGES
// ======================================================

async function genererImages() {

  if (derniersPrompts.length !== 5) {

    setStatus(
      "imagesStatus",
      "⚠️ Il faut d'abord préparer les 5 scènes."
    );

    return;
  }

  setStatus(
    "imagesStatus",
    "⏳ Génération des images 1/5..."
  );

  document.getElementById("imagesResult").innerHTML = "";

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

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Impossible de générer les images."
      );
    }

    dernieresImages = data.images || [];

    const container =
      document.getElementById("imagesResult");

    container.innerHTML =
      dernieresImages
        .map((image, index) => `
          <div>
            <div class="scene">
              <strong>Scène ${index + 1}</strong>
            </div>

            <img
              src="data:${image.mimeType};base64,${image.data}"
              alt="Scène ${index + 1}"
            >
          </div>
        `)
        .join("");

    setStatus(
      "imagesStatus",
      "✅ Les 5 images sont prêtes."
    );

    enable("animateButton");

    setWorkflow(4);

  } catch (error) {

    setStatus(
      "imagesStatus",
      "❌ " + error.message
    );

  }
}

// ======================================================
// ANIMATION VEO
// ======================================================

async function animerScenes() {

  if (dernieresImages.length !== 5) {

    setStatus(
      "videoStatus",
      "⚠️ Les 5 images sont nécessaires."
    );

    return;
  }

  setStatus(
    "videoStatus",
    "⏳ Animation des 5 scènes..."
  );

  try {

    const clips = [];

    for (let i = 0; i < 5; i++) {

      setStatus(
        "videoStatus",
        `⏳ Animation de la scène ${i + 1}/5...`
      );

      const response =
        await fetch("/api/animate-scene", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            image: dernieresImages[i],
            prompt: derniersPrompts[i]
          })
        });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
          `Erreur sur la scène ${i + 1}`
        );
      }

      clips.push(data.clip);
    }

    derniersClips = clips;

    setStatus(
      "videoStatus",
      "✅ Les 5 clips Veo sont prêts."
    );

    document.getElementById("clipsResult").innerHTML =
      clips.map((clip, index) => `
        <div class="scene">
          <strong>🎞️ Clip ${index + 1}</strong>
          <video
            controls
            src="data:video/mp4;base64,${clip}"
          ></video>
        </div>
      `).join("");

    enable("createVideoButton");

    setWorkflow(5);

  } catch (error) {

    setStatus(
      "videoStatus",
      "❌ " + error.message
    );

  }
}

// ======================================================
// CRÉER VIDÉO FINALE
// ======================================================

async function creerVideo() {

  if (derniersClips.length !== 5) {

    setStatus(
      "finalVideoStatus",
      "⚠️ Les cinq clips sont nécessaires."
    );

    return;
  }

  setStatus(
    "finalVideoStatus",
    "⏳ Cineflow assemble la vidéo finale..."
  );

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

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Impossible de créer la vidéo."
      );
    }

    document.getElementById(
      "finalVideo"
    ).innerHTML = `
      <video
        controls
        src="data:video/mp4;base64,${data.video}"
      ></video>
    `;

    setStatus(
      "finalVideoStatus",
      "✅ Vidéo finale créée."
    );

    setWorkflow(6);

  } catch (error) {

    setStatus(
      "finalVideoStatus",
      "❌ " + error.message
    );

  }
}

// ======================================================
// AUDIO
// ======================================================

async function preparerAudio() {

  if (!dernierProjet) {
    return;
  }

  setStatus(
    "audioResult",
    "⏳ Analyse de l'ambiance..."
  );

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

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Erreur audio."
      );
    }

    const audio = data.audio;

    document.getElementById(
      "audioResult"
    ).innerHTML = `

      <strong>🎼 Ambiance :</strong>
      ${escapeHtml(audio.mood.name)}

      <br><br>

      <strong>🎵 Musique :</strong>
      ${escapeHtml(audio.music.direction)}

      <br>

      <strong>🎹 Instruments :</strong>
      ${escapeHtml(audio.music.instruments)}

      <br>

      <strong>⚡ Énergie :</strong>
      ${escapeHtml(audio.music.energy)}

      <br><br>

      <strong>🎙️ Narration :</strong>
      ${escapeHtml(audio.narration.style)}

      <br><br>

      <strong>🔊 Effets sonores :</strong>
      ${escapeHtml(audio.soundEffects.direction)}

    `;

  } catch (error) {

    setStatus(
      "audioResult",
      "❌ " + error.message
    );

  }
}

// ======================================================
// MINIATURE
// ======================================================

async function preparerMiniature() {

  if (!dernierProjet) {
    return;
  }

  setStatus(
    "thumbnailResult",
    "⏳ Préparation de la miniature..."
  );

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

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Erreur miniature."
      );
    }

    document.getElementById(
      "thumbnailResult"
    ).innerHTML = `
      <strong>🖼️ Direction :</strong>
      ${escapeHtml(data.thumbnail.style)}

      <br><br>

      <strong>Prompt :</strong><br>
      ${escapeHtml(data.thumbnail.prompt)}
    `;

  } catch (error) {

    setStatus(
      "thumbnailResult",
      "❌ " + error.message
    );

  }
}

// ======================================================
// RÉSEAUX SOCIAUX
// ======================================================

async function preparerSocial() {

  if (!dernierProjet) {
    return;
  }

  setStatus(
    "socialResult",
    "⏳ Préparation des publications..."
  );

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

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Erreur réseaux sociaux."
      );
    }

    const social = data.social;

    document.getElementById(
      "socialResult"
    ).innerHTML = `

      <strong>▶️ YouTube</strong>
      <p>${escapeHtml(social.youtube.title)}</p>
      <p>${escapeHtml(social.youtube.description)}</p>
      <p>${escapeHtml(social.youtube.hashtags)}</p>

      <hr>

      <strong>🎵 TikTok</strong>
      <p>${escapeHtml(social.tiktok.caption)}</p>
      <p>${escapeHtml(social.tiktok.hashtags)}</p>

      <hr>

      <strong>📸 Instagram</strong>
      <p>${escapeHtml(social.instagram.caption)}</p>
      <p>${escapeHtml(social.instagram.hashtags)}</p>

      <hr>

      <strong>📘 Facebook</strong>
      <p>${escapeHtml(social.facebook.text)}</p>

    `;

  } catch (error) {

    setStatus(
      "socialResult",
      "❌ " + error.message
    );

  }
}

// ======================================================
// AUTO PILOTE
// ======================================================

async function chargerAutoPilot() {

  if (!dernierProjet) {
    return;
  }

  const container =
    document.getElementById("autoPilotResult");

  container.innerHTML =
    `<div class="status">⏳ Préparation du plan...</div>`;

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

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Erreur Auto-Pilote."
      );
    }

    const workflow =
      data.plan.workflow || [];

    container.innerHTML = `

      <div class="status">

        <strong>⚙️ Pipeline Cineflow</strong>

        ${workflow.map(item => {

          let label = "En attente";
          let className = "workflow-pending";

          if (item.status === "completed") {
            label = "✓ Terminé";
            className = "workflow-ok";
          }

          if (item.status === "manual") {
            label = "À connecter";
            className = "workflow-manual";
          }

          return `
            <div class="workflow-item">

              <span>
                ${item.id}. ${escapeHtml(item.name)}
              </span>

              <span class="${className}">
                ${label}
              </span>

            </div>
          `;

        }).join("")}

        <br>

        <strong>📅 Routine hebdomadaire</strong>

        <ul>
          ${data.plan.weeklyRoutine.map(
            item => `<li>${escapeHtml(item)}</li>`
          ).join("")}
        </ul>

        <p>
          ${escapeHtml(data.plan.note)}
        </p>

      </div>
    `;

  } catch (error) {

    container.innerHTML =
      `<div class="status">❌ ${escapeHtml(error.message)}</div>`;

  }
}

// ======================================================
// STATISTIQUES
// ======================================================

function calculerStats() {

  const views =
    Number(
      document.getElementById("viewsInput").value
    ) || 0;

  const likes =
    Number(
      document.getElementById("likesInput").value
    ) || 0;

  const subs =
    Number(
      document.getElementById("subsInput").value
    ) || 0;

  const revenue =
    Number(
      document.getElementById("revenueInput").value
    ) || 0;

  document.getElementById(
    "viewsTotal"
  ).textContent = views.toLocaleString("fr-FR");

  document.getElementById(
    "likesTotal"
  ).textContent = likes.toLocaleString("fr-FR");

  document.getElementById(
    "subsTotal"
  ).textContent = subs.toLocaleString("fr-FR");

  document.getElementById(
    "statsResult"
  ).textContent =
    `📊 ${views.toLocaleString("fr-FR")} vues • ` +
    `${likes.toLocaleString("fr-FR")} likes • ` +
    `${subs.toLocaleString("fr-FR")} abonnés • ` +
    `${revenue.toFixed(2)} de revenus estimés.`;
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

    if (!API_KEY) {
      return res.status(500).json({
        error:
          "GEMINI_API_KEY n'est pas configurée sur Render."
      });
    }

    const response =
      await generateTextInteraction(
        "Réponds très brièvement : confirme que Gemini est connecté à Cineflow."
      );

    res.json({
      success: true,
      message:
        response ||
        "Gemini est correctement connecté à Cineflow."
    });

  } catch (error) {

    console.error("TEST GEMINI :", error);

    res.status(500).json({
      error:
        error.message ||
        "Impossible de contacter Gemini."
    });

  }
});

// ======================================================
// GÉNÉRATION DU PROJET
// ======================================================

app.post("/api/generate", async (req, res) => {

  try {

    const { idea } = req.body;

    if (!idea) {
      return res.status(400).json({
        error: "L'idée du projet est obligatoire."
      });
    }

    const prompt = `
Tu es le moteur créatif de Cineflow.

À partir de cette idée :

"${idea}"

Crée un projet vidéo complet.

Retourne UNIQUEMENT un JSON valide.

Structure obligatoire :

{
  "title": "",
  "concept": "",
  "style": "",
  "characters": "",
  "scenario": "",
  "scenes": [
    "",
    "",
    "",
    "",
    ""
  ],
  "thumbnail": "",
  "social": {
    "youtubeDescription": "",
    "tiktokCaption": "",
    "instagramCaption": "",
    "facebookText": ""
  }
}

Règles :

- exactement 5 scènes
- scènes cohérentes entre elles
- descriptions visuelles claires
- continuité des personnages
- continuité des lieux
- histoire adaptée à une vidéo
- français
`;

    const text =
      await generateTextInteraction(prompt);

    const project =
      JSON.parse(cleanJson(text));

    if (
      !Array.isArray(project.scenes) ||
      project.scenes.length !== 5
    ) {
      throw new Error(
        "Gemini n'a pas généré exactement 5 scènes."
      );
    }

    res.json({
      success: true,
      project
    });

  } catch (error) {

    console.error("GENERATE :", error);

    res.status(500).json({
      error:
        error.message ||
        "Erreur pendant la génération du projet."
    });

  }
});

// ======================================================
// PRÉPARER LES PROMPTS DES IMAGES
// ======================================================

app.post("/api/prepare-images", async (req, res) => {

  try {

    const { project } = req.body;

    if (!project) {
      return res.status(400).json({
        error: "Projet manquant."
      });
    }

    const prompt = `
Tu es le directeur artistique de Cineflow.

Transforme ce projet en exactement 5 prompts
visuels cohérents.

PROJET :
${JSON.stringify(project, null, 2)}

Retourne UNIQUEMENT un JSON :

{
  "prompts": [
    "",
    "",
    "",
    "",
    ""
  ]
}

Chaque prompt doit :
- décrire précisément la scène
- conserver les mêmes personnages
- conserver leurs vêtements
- conserver leur apparence
- conserver les lieux
- être cinématique
- être adapté à une génération d'image
- ne pas contenir de texte ou logo
- être en français
`;

    const text =
      await generateTextInteraction(prompt);

    const result =
      JSON.parse(cleanJson(text));

    if (
      !Array.isArray(result.prompts) ||
      result.prompts.length !== 5
    ) {
      throw new Error(
        "Les 5 prompts n'ont pas été générés."
      );
    }

    res.json({
      success: true,
      prompts: result.prompts
    });

  } catch (error) {

    console.error("PREPARE IMAGES :", error);

    res.status(500).json({
      error:
        error.message ||
        "Erreur lors de la préparation des scènes."
    });

  }
});

// ======================================================
// GÉNÉRER LES IMAGES
// ======================================================

app.post("/api/generate-images", async (req, res) => {

  try {

    const { prompts } = req.body;

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
        await generateImage(prompts[i]);

      images.push(image);
    }

    res.json({
      success: true,
      images
    });

  } catch (error) {

    console.error("GENERATE IMAGES :", error);

    res.status(500).json({
      error:
        error.message ||
        "Erreur pendant la génération des images."
    });

  }
});

// ======================================================
// ANIMER UNE SCÈNE
// ======================================================

app.post("/api/animate-scene", async (req, res) => {

  try {

    const {
      image,
      prompt
    } = req.body;

    if (!image || !image.data) {
      return res.status(400).json({
        error: "Image manquante."
      });
    }

    const clip =
      await generateVideoFromImage(
        image.data,
        image.mimeType,
        prompt
      );

    res.json({
      success: true,
      clip
    });

  } catch (error) {

    console.error("ANIMATE SCENE :", error);

    res.status(500).json({
      error:
        error.message ||
        "Erreur pendant l'animation de la scène."
    });

  }
});

// ======================================================
// CRÉER VIDÉO FINALE
// ======================================================

app.post("/api/create-video", async (req, res) => {

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cineflow-final-")
  );

  try {

    const { clips } = req.body;

    if (
      !Array.isArray(clips) ||
      clips.length !== 5
    ) {
      return res.status(400).json({
        error:
          "Il faut exactement 5 clips."
      });
    }

    const normalizedFiles = [];

    for (let i = 0; i < clips.length; i++) {

      const input =
        path.join(
          tempDir,
          `input-${i}.mp4`
        );

      const output =
        path.join(
          tempDir,
          `normalized-${i}.mp4`
        );

      fs.writeFileSync(
        input,
        Buffer.from(clips[i], "base64")
      );

      await runFFmpeg([
        "-y",
        "-i",
        input,
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
        "-b:a",
        "128k",
        output
      ]);

      normalizedFiles.push(output);
    }

    const concatFile =
      path.join(
        tempDir,
        "concat.txt"
      );

    fs.writeFileSync(
      concatFile,
      normalizedFiles
        .map(file =>
          `file '${file.replace(/'/g, "'\\\\''")}'`
        )
        .join("\n")
    );

    const finalFile =
      path.join(
        tempDir,
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

    const video =
      fs.readFileSync(finalFile)
        .toString("base64");

    res.json({
      success: true,
      video
    });

  } catch (error) {

    console.error(
      "CREATE VIDEO :",
      error
    );

    res.status(500).json({
      error:
        error.message ||
        "Erreur lors de l'assemblage vidéo."
    });

  } finally {

    fs.rmSync(
      tempDir,
      {
        recursive: true,
        force: true
      }
    );

  }
});

// ======================================================
// AUDIO — SANS GEMINI
// ======================================================

app.post("/api/prepare-audio", (req, res) => {

  try {

    const { project } = req.body;

    if (!project) {
      return res.status(400).json({
        error: "Projet manquant."
      });
    }

    const audio =
      buildAudioPlan(project);

    res.json({
      success: true,
      audio
    });

  } catch (error) {

    res.status(500).json({
      error:
        error.message ||
        "Impossible de préparer l'audio."
    });

  }
});

// ======================================================
// MINIATURE — SANS GEMINI
// ======================================================

app.post("/api/prepare-thumbnail", (req, res) => {

  try {

    const { project } = req.body;

    if (!project) {
      return res.status(400).json({
        error: "Projet manquant."
      });
    }

    const thumbnail =
      buildThumbnailPlan(project);

    res.json({
      success: true,
      thumbnail
    });

  } catch (error) {

    res.status(500).json({
      error:
        error.message ||
        "Impossible de préparer la miniature."
    });

  }
});

// ======================================================
// RÉSEAUX SOCIAUX — SANS GEMINI
// ======================================================

app.post("/api/prepare-social", (req, res) => {

  try {

    const { project } = req.body;

    if (!project) {
      return res.status(400).json({
        error: "Projet manquant."
      });
    }

    const social =
      buildSocialPlan(project);

    res.json({
      success: true,
      social
    });

  } catch (error) {

    res.status(500).json({
      error:
        error.message ||
        "Impossible de préparer les publications."
    });

  }
});

// ======================================================
// AUTO PILOTE — SANS GEMINI
// ======================================================

app.post("/api/autopilot-plan", (req, res) => {

  try {

    const { project } = req.body;

    if (!project) {
      return res.status(400).json({
        error: "Projet manquant."
      });
    }

    const plan =
      buildAutoPilotPlan(project);

    res.json({
      success: true,
      plan
    });

  } catch (error) {

    res.status(500).json({
      error:
        error.message ||
        "Impossible de préparer l'Auto-Pilote."
    });

  }
});

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
    `🎬 Cineflow API démarrée sur le port ${PORT}`
  );

});

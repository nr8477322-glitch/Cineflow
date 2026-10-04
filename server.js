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


// ============================================================
// OUTILS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanJson(text) {
  if (!text) return "";

  let value = String(text).trim();

  value = value
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");

  if (first !== -1 && last !== -1 && last > first) {
    value = value.slice(first, last + 1);
  }

  return value;
}

function getInteractionText(response) {
  if (!response) return "";

  if (typeof response.text === "string") {
    return response.text;
  }

  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      if (typeof item === "string") return item;

      if (item && typeof item.text === "string") {
        return item.text;
      }

      if (item && Array.isArray(item.content)) {
        for (const content of item.content) {
          if (typeof content === "string") return content;

          if (content && typeof content.text === "string") {
            return content.text;
          }
        }
      }
    }
  }

  if (response.response && typeof response.response.text === "string") {
    return response.response.text;
  }

  return "";
}


// ============================================================
// GEMINI TEXTE
// ============================================================

async function generateTextInteraction(prompt) {
  if (!API_KEY) {
    throw new Error(
      "GEMINI_API_KEY n'est pas configurée sur Render."
    );
  }

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt
  });

  const text = getInteractionText(response);

  if (!text) {
    throw new Error(
      "Gemini n'a retourné aucun texte."
    );
  }

  return text;
}


// ============================================================
// GENERATION IMAGE
// ============================================================

async function generateImage(prompt) {
  if (!API_KEY) {
    throw new Error(
      "GEMINI_API_KEY n'est pas configurée."
    );
  }

  const interaction = await ai.interactions.create({
    model: IMAGE_MODEL,
    input: prompt,
    response_format: {
      type: "image",
      mime_type: "image/jpeg",
      aspect_ratio: "16:9",
      image_size: "1K"
    }
  });

  if (
    !interaction ||
    !interaction.output_image ||
    !interaction.output_image.data
  ) {
    throw new Error(
      "Gemini n'a pas retourné d'image."
    );
  }

  return {
    mimeType:
      interaction.output_image.mime_type ||
      "image/jpeg",

    data:
      interaction.output_image.data
  };
}


// ============================================================
// GENERATION VIDEO VEO
// ============================================================

async function generateVideoFromImage(
  imageBase64,
  mimeType,
  prompt
) {
  if (!API_KEY) {
    throw new Error(
      "GEMINI_API_KEY n'est pas configurée."
    );
  }

  let operation =
    await ai.models.generateVideos({
      model: VIDEO_MODEL,

      prompt:
        prompt +
        "\n\nCréer une animation cinématographique fluide. " +
        "Conserver les personnages, les vêtements, " +
        "le décor et la composition de l'image source. " +
        "Mouvement naturel de caméra.",

      image: {
        imageBytes: imageBase64,
        mimeType: mimeType || "image/jpeg"
      }
    });

  let attempts = 0;

  while (!operation.done && attempts < 60) {
    await sleep(10000);

    operation =
      await ai.operations.getVideosOperation(
        operation
      );

    attempts++;
  }

  if (!operation.done) {
    throw new Error(
      "Veo n'a pas terminé dans le délai prévu."
    );
  }

  if (operation.error) {
    throw new Error(
      operation.error.message ||
      "Veo a rencontré une erreur."
    );
  }

  const generated =
    operation.response?.generatedVideos ||
    operation.result?.generatedVideos ||
    [];

  if (!generated.length) {
    throw new Error(
      "Veo n'a retourné aucun clip vidéo."
    );
  }

  const video =
    generated[0].video;

  if (!video) {
    throw new Error(
      "Le clip vidéo généré est introuvable."
    );
  }

  const tempDir =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        "cineflow-veo-"
      )
    );

  const outputPath =
    path.join(
      tempDir,
      "scene.mp4"
    );

  try {
    await ai.files.download({
      file: video,
      downloadPath: outputPath
    });

    const buffer =
      fs.readFileSync(outputPath);

    return buffer.toString("base64");

  } finally {

    try {
      fs.rmSync(
        tempDir,
        {
          recursive: true,
          force: true
        }
      );
    } catch {}
  }
}


// ============================================================
// FFMPEG
// ============================================================

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


// ============================================================
// FILE D'ANIMATION
// ============================================================

const animationQueue = [];

let animationRunning = false;

let animationJobId = 0;


function createJobId() {
  animationJobId++;

  return (
    "cineflow-" +
    Date.now() +
    "-" +
    animationJobId
  );
}


function createAnimationJob(
  images,
  prompts
) {

  const job = {

    id: createJobId(),

    status: "queued",

    createdAt:
      new Date().toISOString(),

    startedAt: null,

    finishedAt: null,

    images,

    prompts,

    scenes: Array.from(
      { length: 5 },
      (_, index) => ({

        scene: index + 1,

        status: "pending",

        attempts: 0,

        clip: null,

        error: null,

        startedAt: null,

        finishedAt: null

      })
    )

  };

  animationQueue.push(job);

  return job;
}


function getJob(jobId) {

  return animationQueue.find(
    job => job.id === jobId
  );
}


async function processOneAnimationScene(
  job,
  index
) {

  const scene =
    job.scenes[index];

  if (!scene) return;

  if (
    scene.status === "completed" ||
    scene.status === "processing"
  ) {
    return;
  }

  const image =
    job.images[index];

  const prompt =
    job.prompts[index];

  if (
    !image ||
    !image.data
  ) {

    scene.status = "error";

    scene.error =
      "Image de la scène introuvable.";

    return;
  }

  scene.status = "processing";

  scene.attempts++;

  scene.startedAt =
    new Date().toISOString();

  try {

    const clip =
      await generateVideoFromImage(
        image.data,
        image.mimeType,
        prompt
      );

    scene.clip = clip;

    scene.status = "completed";

    scene.error = null;

    scene.finishedAt =
      new Date().toISOString();

  } catch (error) {

    scene.status = "error";

    scene.error =
      error.message ||
      "Erreur pendant l'animation.";

    scene.finishedAt =
      new Date().toISOString();
  }
}


async function processAnimationQueue() {

  if (animationRunning) return;

  animationRunning = true;

  try {

    while (true) {

      const job =
        animationQueue.find(
          item =>
            item.status === "queued" ||
            item.status === "running"
        );

      if (!job) break;

      job.status = "running";

      if (!job.startedAt) {
        job.startedAt =
          new Date().toISOString();
      }

      const index =
        job.scenes.findIndex(
          scene =>
            scene.status === "pending"
        );

      if (index === -1) {

        const hasError =
          job.scenes.some(
            scene =>
              scene.status === "error"
          );

        job.status =
          hasError
            ? "waiting_for_retry"
            : "completed";

        job.finishedAt =
          new Date().toISOString();

        continue;
      }

      await processOneAnimationScene(
        job,
        index
      );

      const remaining =
        job.scenes.some(
          scene =>
            scene.status === "pending" ||
            scene.status === "processing"
        );

      if (!remaining) {

        const hasError =
          job.scenes.some(
            scene =>
              scene.status === "error"
          );

        job.status =
          hasError
            ? "waiting_for_retry"
            : "completed";

        job.finishedAt =
          new Date().toISOString();
      }
    }

  } catch (error) {

    console.error(
      "Erreur file animation:",
      error
    );

  } finally {

    animationRunning = false;

    const waiting =
      animationQueue.some(
        job =>
          job.status === "queued"
      );

    if (waiting) {
      setTimeout(
        processAnimationQueue,
        100
      );
    }
  }
}


function retryScene(
  job,
  sceneNumber
) {

  const scene =
    job.scenes.find(
      item =>
        item.scene === sceneNumber
    );

  if (!scene) {
    throw new Error(
      "Scène introuvable."
    );
  }

  if (
    scene.status === "processing"
  ) {
    throw new Error(
      "Cette scène est déjà en cours de génération."
    );
  }

  scene.status = "pending";

  scene.error = null;

  scene.clip = null;

  scene.finishedAt = null;

  if (job.status !== "running") {
    job.status = "queued";
  }

  processAnimationQueue();
}


// ============================================================
// PLAN AUDIO
// ============================================================

function detectMood(project) {

  const text = JSON.stringify(
    project
  ).toLowerCase();

  if (text.includes("action")) {
    return "action";
  }

  if (text.includes("drama")) {
    return "drama";
  }

  if (text.includes("football")) {
    return "football";
  }

  if (text.includes("suspense")) {
    return "suspense";
  }

  if (text.includes("animation")) {
    return "animation";
  }

  return "cinematic";
}


function buildAudioPlan(project) {

  const mood =
    detectMood(project);

  const music = {

    cinematic:
      "Musique cinématique émotionnelle, progressive et inspirante.",

    action:
      "Musique dynamique avec percussions et montée d'énergie.",

    drama:
      "Musique émotionnelle au piano et cordes.",

    football:
      "Musique motivante et sportive avec montée progressive.",

    suspense:
      "Ambiance mystérieuse et tension progressive.",

    animation:
      "Musique légère, expressive et dynamique."
  };

  return {

    mood,

    music:
      music[mood] ||
      music.cinematic,

    voice: {

      enabled: true,

      language: "fr-FR",

      style:
        "Voix narrative naturelle et cinématographique."
    },

    soundEffects: [

      "Ambiances de décor",

      "Effets de mouvement",

      "Transitions",

      "Effets cinématiques"
    ]
  };
}


// ============================================================
// PLAN MINIATURE
// ============================================================

function buildThumbnailPlan(project) {

  return {

    title:
      project.title || "",

    concept:
      project.concept || "",

    composition:
      "Sujet principal clairement visible, composition cinématographique, profondeur de champ.",

    text:
      project.title || "",

    format:
      "16:9",

    objective:
      "Créer une miniature immédiatement reconnaissable et adaptée aux plateformes."
  };
}


// ============================================================
// PLAN RESEAUX SOCIAUX
// ============================================================

function buildSocialPlan(project) {

  const title =
    project.title ||
    "Nouvelle vidéo Cineflow";

  const concept =
    project.concept ||
    "";

  return {

    youtube: {

      title,

      description:
        concept,

      hashtags:
        "#Cineflow #Video #IA"
    },

    tiktok: {

      caption:
        title + " 🎬",

      hashtags:
        "#Cineflow #VideoIA #TikTok"
    },

    instagram: {

      caption:
        concept,

      hashtags:
        "#Cineflow #CreationVideo #IA"
    },

    facebook: {

      text:
        concept
    }
  };
}


// ============================================================
// AUTO-PILOTE
// ============================================================

function buildAutoPilotPlan(project) {

  return {

    enabled: true,

    frequency: "weekly",

    workflow: [

      "Analyser l'idée",

      "Créer l'histoire",

      "Créer le scénario",

      "Préparer 5 scènes",

      "Générer les visuels",

      "Animer les scènes",

      "Assembler la vidéo",

      "Adapter la musique",

      "Ajouter la narration",

      "Ajouter les effets sonores",

      "Créer la miniature",

      "Préparer les publications",

      "Suivre les statistiques",

      "Suivre les revenus",

      "Préparer le prochain projet"
    ],

    verification: [

      "Vérifier les erreurs",

      "Vérifier les scènes",

      "Vérifier la vidéo finale",

      "Vérifier les éléments audio",

      "Vérifier les publications"
    ]
  };
}


// ============================================================
// PAGE CINEFLOW — INTERFACE STUDIO
// ============================================================

app.get("/", (req, res) => {

res.send(`<!DOCTYPE html>

<html lang="fr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>Cineflow Studio</title>

<style>

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

:root {

  --bg: #070b14;

  --panel: #0d1320;

  --panel2: #111827;

  --border: rgba(255,255,255,.08);

  --text: #f5f7fb;

  --muted: #8d98aa;

  --primary: #7c5cff;

  --primary2: #5b8cff;

  --success: #27d17f;

  --warning: #ffb84d;

  --danger: #ff5d73;

}

body {

  font-family:
    Inter,
    Arial,
    sans-serif;

  background:

    radial-gradient(
      circle at 70% -10%,
      rgba(124,92,255,.18),
      transparent 35%
    ),

    radial-gradient(
      circle at 10% 20%,
      rgba(91,140,255,.08),
      transparent 30%
    ),

    var(--bg);

  color: var(--text);

  min-height: 100vh;

}

button,
textarea {
  font: inherit;
}

button {
  cursor: pointer;
}

button:disabled {
  opacity: .45;
  cursor: not-allowed;
}

/* SIDEBAR */

.sidebar {

  width: 255px;

  min-height: 100vh;

  position: fixed;

  left: 0;
  top: 0;
  bottom: 0;

  padding: 22px 16px;

  background:
    rgba(8,12,22,.95);

  border-right:
    1px solid var(--border);

  backdrop-filter:
    blur(20px);

  z-index: 20;

}

.logo {

  display: flex;

  align-items: center;

  gap: 11px;

  padding:
    6px 10px 24px;

}

.logo-icon {

  width: 42px;
  height: 42px;

  border-radius: 13px;

  display: grid;

  place-items: center;

  font-size: 21px;

  background:
    linear-gradient(
      135deg,
      #7c5cff,
      #5b8cff
    );

  box-shadow:
    0 8px 30px
    rgba(124,92,255,.3);

}

.logo strong {
  font-size: 20px;
}

.logo small {

  display: block;

  color: var(--muted);

  font-size: 9px;

  margin-top: 2px;

}

.new-project {

  width: 100%;

  border: 0;

  border-radius: 12px;

  padding: 12px;

  color: white;

  font-weight: 700;

  background:
    linear-gradient(
      135deg,
      var(--primary),
      var(--primary2)
    );

  margin-bottom: 22px;

}

.nav-title {

  color: #5f6a7d;

  text-transform: uppercase;

  font-size: 10px;

  font-weight: 800;

  letter-spacing: 1px;

  padding:
    0 10px 10px;

}

.nav {

  display: flex;

  flex-direction: column;

  gap: 4px;

}

.nav-item {

  display: flex;

  align-items: center;

  gap: 12px;

  padding:
    10px 11px;

  color: #9aa4b6;

  border-radius: 10px;

  font-size: 13px;

}

.nav-item:hover,
.nav-item.active {

  color: white;

  background:
    rgba(124,92,255,.12);

}

.nav-number {

  width: 25px;
  height: 25px;

  display: grid;

  place-items: center;

  border-radius: 7px;

  background:
    rgba(255,255,255,.05);

  font-size: 11px;

}

.sidebar-bottom {

  position: absolute;

  left: 16px;
  right: 16px;
  bottom: 18px;

  padding: 13px;

  border:
    1px solid var(--border);

  border-radius: 13px;

  background:
    rgba(255,255,255,.025);

}

.gemini-dot {

  display: inline-block;

  width: 8px;
  height: 8px;

  background:
    var(--warning);

  border-radius: 50%;

  margin-right: 7px;

}

/* MAIN */

.main {

  margin-left: 255px;

  width:
    calc(100% - 255px);

  padding: 25px;

}

.topbar {

  display: flex;

  align-items: center;

  justify-content: space-between;

  margin-bottom: 24px;

  gap: 15px;

}

.project-name {

  color: #aab3c2;

  font-size: 14px;

}

.project-name strong {

  color: white;

  font-size: 18px;

}

.top-actions {

  display: flex;

  align-items: center;

  gap: 10px;

}

.connection {

  border:
    1px solid var(--border);

  padding:
    8px 12px;

  border-radius: 20px;

  color: #aeb8c8;

  font-size: 12px;

  background:
    rgba(255,255,255,.025);

}

.connection span:first-child {

  width: 7px;
  height: 7px;

  display: inline-block;

  border-radius: 50%;

  background:
    var(--warning);

  margin-right: 6px;

}

.progress-mini {

  width: 120px;

  height: 6px;

  background:
    #202839;

  border-radius: 10px;

  overflow: hidden;

}

.progress-mini div {

  height: 100%;

  width: 0%;

  background:
    linear-gradient(
      90deg,
      var(--primary),
      var(--primary2)
    );

  transition:
    width .4s;

}

/* HERO */

.hero {

  padding: 30px;

  border:
    1px solid var(--border);

  border-radius: 22px;

  background:

    linear-gradient(
      135deg,
      rgba(124,92,255,.13),
      rgba(91,140,255,.04)
    ),

    rgba(13,19,32,.9);

  margin-bottom: 22px;

}

.hero-label {

  color:
    #a99aff;

  font-size: 12px;

  font-weight: 800;

  text-transform: uppercase;

  letter-spacing: 1.5px;

  margin-bottom: 9px;

}

.hero h1 {

  font-size:
    clamp(28px,4vw,44px);

  line-height: 1.05;

  letter-spacing: -1.5px;

  margin-bottom: 10px;

}

.hero p {

  color:
    var(--muted);

  max-width: 700px;

  line-height: 1.6;

  font-size: 14px;

  margin-bottom: 22px;

}

textarea {

  width: 100%;

  min-height: 115px;

  resize: vertical;

  color: white;

  background:
    rgba(4,7,14,.65);

  border:
    1px solid
    rgba(255,255,255,.09);

  border-radius: 15px;

  padding: 16px;

  outline: none;

  line-height: 1.5;

}

textarea:focus {

  border-color:
    rgba(124,92,255,.7);

}

.categories {

  display: flex;

  flex-wrap: wrap;

  gap: 8px;

  margin: 13px 0;

}

.category {

  padding:
    8px 13px;

  border-radius: 20px;

  border:
    1px solid var(--border);

  background:
    rgba(255,255,255,.03);

  color:
    #aab4c5;

  font-size: 12px;

}

.category.selected {

  color: white;

  border-color:
    rgba(124,92,255,.5);

  background:
    rgba(124,92,255,.13);

}

.primary-btn {

  border: 0;

  padding:
    12px 18px;

  border-radius: 11px;

  color: white;

  font-weight: 800;

  background:
    linear-gradient(
      135deg,
      var(--primary),
      var(--primary2)
    );

}

.secondary-btn {

  border:
    1px solid var(--border);

  padding:
    10px 14px;

  border-radius: 10px;

  color: #d5dbea;

  background:
    rgba(255,255,255,.035);

}

/* SECTIONS */

.section {
  margin-bottom: 24px;
}

.section-header {

  display: flex;

  justify-content:
    space-between;

  align-items:
    center;

  margin-bottom: 12px;

  gap: 10px;

}

.section-header h2 {
  font-size: 18px;
}

.section-header p {

  color:
    var(--muted);

  font-size: 12px;

  margin-top: 4px;

}

.status-text {

  color:
    #98a4b8;

  font-size: 12px;

}

/* PROJECT */

.project-overview {

  display: grid;

  grid-template-columns:
    1.5fr 1fr 1fr;

  gap: 13px;

}

.card {

  border:
    1px solid var(--border);

  border-radius: 16px;

  background:
    rgba(13,19,32,.82);

  padding: 17px;

}

.card p {

  color:
    var(--muted);

  line-height: 1.5;

  font-size: 12px;

}

.big-value {

  font-size: 17px;

  font-weight: 800;

  margin-top: 5px;

}

.pill-list {

  display: flex;

  flex-wrap: wrap;

  gap: 6px;

  margin-top: 9px;

}

.pill {

  padding:
    6px 9px;

  border-radius: 8px;

  background:
    rgba(124,92,255,.1);

  color:
    #c7c0ff;

  font-size: 11px;

}

/* SCENES */

.scene-grid {

  display: grid;

  grid-template-columns:
    repeat(5,minmax(0,1fr));

  gap: 11px;

}

.scene-card {

  border:
    1px solid var(--border);

  border-radius: 14px;

  overflow: hidden;

  background:
    #0c121e;

}

.scene-image {

  height: 125px;

  background:
    linear-gradient(
      135deg,
      rgba(124,92,255,.12),
      rgba(255,255,255,.025)
    );

  display: grid;

  place-items: center;

  color:
    #5f6a7d;

  font-size: 25px;

  overflow: hidden;

}

.scene-image img {

  width: 100%;
  height: 100%;

  object-fit: cover;

}

.scene-content {
  padding: 11px;
}

.scene-number {

  color:
    #a99aff;

  font-size: 10px;

  font-weight: 800;

  text-transform: uppercase;

}

.scene-title {

  font-size: 12px;

  font-weight: 700;

  margin: 4px 0;

  min-height: 30px;

}

.scene-status {

  font-size: 10px;

  color:
    var(--muted);

}

/* PROGRESS */

.progress-box {

  padding: 16px;

  border:
    1px solid var(--border);

  border-radius: 15px;

  background:
    rgba(255,255,255,.025);

  margin-bottom: 13px;

}

.progress-row {

  display: flex;

  justify-content:
    space-between;

  font-size: 12px;

  margin-bottom: 8px;

}

.progress-bar {

  height: 8px;

  background:
    #202838;

  border-radius: 20px;

  overflow: hidden;

}

.progress-bar div {

  height: 100%;

  width: 0%;

  background:
    linear-gradient(
      90deg,
      var(--primary),
      var(--primary2)
    );

  transition:
    width .4s;

}

/* QUEUE */

.queue-list {

  display: grid;

  gap: 9px;

}

.queue-item {

  display: flex;

  align-items: center;

  justify-content:
    space-between;

  gap: 12px;

  padding: 12px;

  border:
    1px solid var(--border);

  border-radius: 11px;

  background:
    rgba(255,255,255,.02);

}

.queue-left {

  display: flex;

  align-items: center;

  gap: 10px;

}

.queue-icon {

  width: 34px;
  height: 34px;

  border-radius: 9px;

  display: grid;

  place-items: center;

  background:
    rgba(124,92,255,.1);

}

.queue-title {

  font-size: 12px;

  font-weight: 700;

}

.queue-state {

  color:
    var(--muted);

  font-size: 10px;

  margin-top: 3px;

}

/* VIDEO */

.video-card {

  min-height: 280px;

  border-radius: 18px;

  border:
    1px solid var(--border);

  background:
    #0c121e;

  display: grid;

  place-items: center;

  overflow: hidden;

}

.video-card video {

  width: 100%;

  max-height: 500px;

  display: block;

  background: black;

}

.video-empty {

  text-align: center;

  color:
    #697488;

  padding: 30px;

}

.video-empty-icon {

  font-size: 45px;

  margin-bottom: 10px;

}

/* TOOLS */

.tools-grid {

  display: grid;

  grid-template-columns:
    repeat(4,minmax(0,1fr));

  gap: 12px;

}

.tool {

  border:
    1px solid var(--border);

  background:
    rgba(13,19,32,.8);

  border-radius: 15px;

  padding: 16px;

}

.tool-icon {

  font-size: 23px;

  margin-bottom: 10px;

}

.tool strong {

  display: block;

  font-size: 13px;

  margin-bottom: 5px;

}

.tool span {

  color:
    var(--muted);

  font-size: 11px;

  line-height: 1.5;

}

.tool button {

  margin-top: 12px;

  width: 100%;

}

/* STATS */

.stats {

  display: grid;

  grid-template-columns:
    repeat(4,1fr);

  gap: 12px;

}

.stat {

  padding: 17px;

  border:
    1px solid var(--border);

  border-radius: 15px;

  background:
    rgba(13,19,32,.8);

}

.stat-label {

  color:
    var(--muted);

  font-size: 11px;

}

.stat-value {

  font-size: 24px;

  font-weight: 900;

  margin-top: 7px;

}

/* MOBILE */

.mobile-nav {
  display: none;
}

@media(max-width:1100px) {

  .scene-grid {
    grid-template-columns:
      repeat(3,1fr);
  }

  .tools-grid {
    grid-template-columns:
      repeat(2,1fr);
  }

  .project-overview {
    grid-template-columns:
      1fr 1fr;
  }

}

@media(max-width:800px) {

  .sidebar {
    display: none;
  }

  .main {

    margin-left: 0;

    width: 100%;

    padding: 15px;

    padding-bottom: 90px;

  }

  .mobile-nav {

    display: flex;

    position: fixed;

    left: 10px;
    right: 10px;
    bottom: 10px;

    z-index: 50;

    padding: 8px;

    border:
      1px solid var(--border);

    border-radius: 16px;

    background:
      rgba(8,12,22,.94);

    backdrop-filter:
      blur(20px);

    justify-content:
      space-around;

  }

  .mobile-nav button {

    background: none;

    border: 0;

    color:
      #8893a5;

    font-size: 10px;

    padding: 7px;

  }

  .mobile-nav button span {

    display: block;

    font-size: 18px;

    margin-bottom: 2px;

  }

  .connection {
    display: none;
  }

  .progress-mini {
    width: 75px;
  }

  .hero {
    padding: 20px;
  }

  .project-overview {
    grid-template-columns: 1fr;
  }

  .scene-grid {
    grid-template-columns:
      repeat(2,1fr);
  }

  .stats {
    grid-template-columns:
      repeat(2,1fr);
  }

}

@media(max-width:480px) {

  .topbar {
    flex-wrap: wrap;
  }

  .hero h1 {
    font-size: 29px;
  }

  .scene-grid {
    grid-template-columns: 1fr;
  }

  .tools-grid {
    grid-template-columns: 1fr;
  }

}

</style>

</head>

<body>

<div class="app">

<aside class="sidebar">

  <div class="logo">

    <div class="logo-icon">
      🎬
    </div>

    <div>

      <strong>
        Cineflow
      </strong>

      <small>
        STUDIO
      </small>

    </div>

  </div>

  <button
    class="new-project"
    onclick="nouveauProjet()"
  >
    ＋ Nouveau projet
  </button>

  <div class="nav-title">
    Production
  </div>

  <nav class="nav">

    <div class="nav-item active">
      <span class="nav-number">1</span>
      <span>Idée</span>
    </div>

    <div class="nav-item">
      <span class="nav-number">2</span>
      <span>Scénario</span>
    </div>

    <div class="nav-item">
      <span class="nav-number">3</span>
      <span>Scènes</span>
    </div>

    <div class="nav-item">
      <span class="nav-number">4</span>
      <span>Images</span>
    </div>

    <div class="nav-item">
      <span class="nav-number">5</span>
      <span>Animation</span>
    </div>

    <div class="nav-item">
      <span class="nav-number">6</span>
      <span>Montage</span>
    </div>

    <div class="nav-item">
      <span class="nav-number">7</span>
      <span>Audio</span>
    </div>

    <div class="nav-item">
      <span class="nav-number">8</span>
      <span>Publication</span>
    </div>

    <div class="nav-item">
      <span class="nav-number">9</span>
      <span>Auto-Pilote</span>
    </div>

  </nav>

  <div class="sidebar-bottom">

    <div
      style="
        font-size:12px;
        font-weight:700;
        margin-bottom:5px;
      "
    >

      <span class="gemini-dot"></span>

      <span id="sidebarGemini">
        Gemini non testé
      </span>

    </div>

    <div
      style="
        font-size:10px;
        color:#697488;
      "
    >
      Cineflow Studio
    </div>

  </div>

</aside>


<main class="main">

  <div class="topbar">

    <div class="project-name">

      <strong id="topProjectName">
        Nouveau projet
      </strong>

      <div style="margin-top:3px;">
        Espace de création Cineflow
      </div>

    </div>

    <div class="top-actions">

      <div class="connection">

        <span id="connectionDot"></span>

        <span id="geminiStatus">
          Gemini non testé
        </span>

      </div>

      <div class="progress-mini">

        <div id="progressBar"></div>

      </div>

      <span
        style="
          font-size:11px;
          color:#8893a5;
        "
        id="progressText"
      >
        0%
      </span>

    </div>

  </div>


  <!-- HERO -->

  <section class="hero">

    <div class="hero-label">
      Cineflow Studio
    </div>

    <h1>
      Transforme une idée en vidéo.
    </h1>

    <p>
      Ton espace de création assistée par intelligence artificielle.
      Cineflow construit ton projet, prépare les scènes,
      génère les visuels et prépare l'animation.
    </p>

    <textarea
      id="idea"
      placeholder="Décris ton idée de vidéo... Exemple : un jeune footballeur africain qui surmonte les difficultés pour devenir professionnel."
    ></textarea>

    <div class="categories">

      <button
        class="category"
        onclick="choisirCategorie(this,'Film')"
      >
        🎬 Film
      </button>

      <button
        class="category"
        onclick="choisirCategorie(this,'Animation')"
      >
        🧸 Animation
      </button>

      <button
        class="category"
        onclick="choisirCategorie(this,'Action')"
      >
        💥 Action
      </button>

      <button
        class="category"
        onclick="choisirCategorie(this,'Drama')"
      >
        🎭 Drama
      </button>

      <button
        class="category"
        onclick="choisirCategorie(this,'Football')"
      >
        ⚽ Football
      </button>

    </div>

    <button
      class="primary-btn"
      id="generateButton"
      onclick="genererProjet()"
    >
      ✨ Créer mon projet
    </button>

  </section>


  <!-- PROJET -->

  <section class="section">

    <div class="section-header">

      <div>

        <h2>
          Projet
        </h2>

        <p>
          Ton histoire générée par Cineflow.
        </p>

      </div>

      <span
        class="status-text"
        id="projectStatus"
      >
        En attente
      </span>

    </div>


    <div class="project-overview">

      <div class="card">

        <div
          style="
            color:#788397;
            font-size:10px;
            text-transform:uppercase;
          "
        >
          Titre
        </div>

        <div
          class="big-value"
          id="projectTitle"
        >
          Aucun projet
        </div>

        <p
          id="projectConcept"
          style="margin-top:8px;"
        >
          Crée ton premier projet pour commencer.
        </p>

      </div>


      <div class="card">

        <div
          style="
            color:#788397;
            font-size:10px;
            text-transform:uppercase;
          "
        >
          Style
        </div>

        <div
          class="big-value"
          id="projectStyle"
        >
          —
        </div>

      </div>


      <div class="card">

        <div
          style="
            color:#788397;
            font-size:10px;
            text-transform:uppercase;
          "
        >
          Personnages
        </div>

        <div
          class="pill-list"
          id="characters"
        >
          <span class="pill">
            En attente
          </span>
        </div>

      </div>

    </div>

  </section>


  <!-- SCENES -->

  <section class="section">

    <div class="section-header">

      <div>

        <h2>
          🎞️ Les 5 scènes
        </h2>

        <p>
          Cineflow transforme ton scénario en scènes visuelles cohérentes.
        </p>

      </div>

      <button
        class="secondary-btn"
        id="prepareScenesButton"
        onclick="preparerScenes()"
        disabled
      >
        🧩 Préparer les 5 scènes
      </button>

    </div>


    <div
      class="scene-grid"
      id="scenes"
    >

      ${[1,2,3,4,5].map(number => `

        <div class="scene-card">

          <div class="scene-image">
            ${String(number).padStart(2,"0")}
          </div>

          <div class="scene-content">

            <div class="scene-number">
              Scène ${number}
            </div>

            <div class="scene-title">
              En attente
            </div>

            <div class="scene-status">
              Aucun scénario
            </div>

          </div>

        </div>

      `).join("")}

    </div>

  </section>


  <!-- IMAGES -->

  <section class="section">

    <div class="section-header">

      <div>

        <h2>
          🖼️ Génération des images
        </h2>

        <p>
          Génère les 5 visuels de ton projet en conservant
          la cohérence des personnages et du style.
        </p>

      </div>

      <button
        class="primary-btn"
        id="generateImagesButton"
        onclick="genererImages()"
        disabled
      >
        🎨 Générer les images
      </button>

    </div>


    <div class="progress-box">

      <div class="progress-row">

        <span id="imageStatus">
          En attente
        </span>

        <span id="imageCount">
          0 / 5
        </span>

      </div>

      <div class="progress-bar">

        <div id="imageProgress"></div>

      </div>

    </div>


    <div
      class="scene-grid"
      id="images"
    >

      ${[1,2,3,4,5].map(number => `

        <div class="scene-card">

          <div class="scene-image">
            🖼️
          </div>

          <div class="scene-content">

            <div class="scene-number">
              Visuel ${number}
            </div>

            <div class="scene-title">
              En attente
            </div>

            <div class="scene-status">
              —
            </div>

          </div>

        </div>

      `).join("")}

    </div>

  </section>


  <!-- ANIMATION -->

  <section class="section">

    <div class="section-header">

      <div>

        <h2>
          🎞️ Animation Veo 3.1
        </h2>

        <p>
          Transforme les images en clips vidéo.
        </p>

      </div>

      <button
        class="primary-btn"
        id="animateButton"
        onclick="animerScenes()"
        disabled
      >
        🎞️ Animer les 5 scènes
      </button>

    </div>


    <div class="card">

      <div
        style="
          display:flex;
          align-items:center;
          gap:12px;
        "
      >

        <div
          style="
            width:44px;
            height:44px;
            border-radius:12px;
            display:grid;
            place-items:center;
            background:rgba(124,92,255,.12);
            font-size:22px;
          "
        >
          🤖
        </div>

        <div>

          <strong>
            File d'animation Cineflow
          </strong>

          <p
            id="queueStatus"
            style="margin-top:4px;"
          >
            Les 5 scènes seront traitées automatiquement.
          </p>

        </div>

      </div>


      <div
        id="queueScenes"
        class="queue-list"
        style="margin-top:15px;"
      ></div>

    </div>

  </section>


  <!-- VIDEO -->

  <section class="section">

    <div class="section-header">

      <div>

        <h2>
          🎬 Vidéo finale
        </h2>

        <p>
          Montage des 5 clips en une vidéo 16:9.
        </p>

      </div>

      <button
        class="primary-btn"
        id="createVideoButton"
        onclick="creerVideo()"
        disabled
      >
        🎬 Créer ma vidéo
      </button>

    </div>


    <div
      class="video-card"
      id="finalVideo"
    >

      <div class="video-empty">

        <div class="video-empty-icon">
          🎬
        </div>

        <div id="finalStatus">
          La vidéo finale apparaîtra ici.
        </div>

      </div>

    </div>

  </section>


  <!-- OUTILS -->

  <section class="section">

    <div class="section-header">

      <div>

        <h2>
          🛠️ Outils de production
        </h2>

        <p>
          Prépare les éléments complémentaires de ton projet.
        </p>

      </div>

    </div>


    <div class="tools-grid">


      <div class="tool">

        <div class="tool-icon">
          🎧
        </div>

        <strong>
          Audio Cineflow
        </strong>

        <span id="audioStatus">
          Musique, voix et effets sonores adaptés à l'histoire.
        </span>

        <button
          class="secondary-btn"
          onclick="preparerAudio()"
        >
          🎧 Préparer l'audio
        </button>

      </div>


      <div class="tool">

        <div class="tool-icon">
          🖼️
        </div>

        <strong>
          Miniature
        </strong>

        <span id="thumbnailStatus">
          Préparation d'une miniature adaptée au projet.
        </span>

        <button
          class="secondary-btn"
          onclick="preparerThumbnail()"
        >
          🖼️ Préparer
        </button>

      </div>


      <div class="tool">

        <div class="tool-icon">
          📱
        </div>

        <strong>
          Réseaux sociaux
        </strong>

        <span id="socialStatus">
          Prépare les textes et formats pour les plateformes.
        </span>

        <button
          class="secondary-btn"
          onclick="preparerSocial()"
        >
          📱 Préparer
        </button>

      </div>


      <div class="tool">

        <div class="tool-icon">
          🤖
        </div>

        <strong>
          Auto-Pilote
        </strong>

        <span id="autoStatus">
          Prépare le workflow automatisé de Cineflow.
        </span>

        <button
          class="secondary-btn"
          onclick="preparerAutoPilot()"
        >
          🤖 Préparer
        </button>

      </div>

    </div>

  </section>


  <!-- STATS -->

  <section class="section">

    <div class="section-header">

      <div>

        <h2>
          📊 Statistiques
        </h2>

        <p>
          Zone prévue pour le suivi des performances.
        </p>

      </div>

    </div>


    <div class="stats">

      <div class="stat">

        <div class="stat-label">
          Vidéos
        </div>

        <div class="stat-value">
          0
        </div>

      </div>


      <div class="stat">

        <div class="stat-label">
          Vues
        </div>

        <div class="stat-value">
          0
        </div>

      </div>


      <div class="stat">

        <div class="stat-label">
          Abonnés
        </div>

        <div class="stat-value">
          0
        </div>

      </div>


      <div class="stat">

        <div class="stat-label">
          Revenus
        </div>

        <div class="stat-value">
          —
        </div>

      </div>

    </div>

  </section>

</main>

</div>


<!-- MOBILE -->

<div class="mobile-nav">

  <button onclick="window.scrollTo({top:0,behavior:'smooth'})">
    <span>💡</span>
    Idée
  </button>

  <button onclick="document.getElementById('scenes').scrollIntoView({behavior:'smooth'})">
    <span>🎞️</span>
    Scènes
  </button>

  <button onclick="document.getElementById('images').scrollIntoView({behavior:'smooth'})">
    <span>🖼️</span>
    Images
  </button>

  <button onclick="document.getElementById('finalVideo').scrollIntoView({behavior:'smooth'})">
    <span>🎬</span>
    Vidéo
  </button>

  <button onclick="document.querySelector('.tools-grid').scrollIntoView({behavior:'smooth'})">
    <span>🛠️</span>
    Outils
  </button>

</div>


<script>

// ============================================================
// ETAT
// ============================================================

let dernierProjet = null;

let derniersPrompts = [];

let dernieresImages = [];

let derniersClips = [];

let animationJobId = null;

let queueTimer = null;

let categorieChoisie = "";


// ============================================================
// UTILITAIRES
// ============================================================

function escapeHtml(value) {

  return String(value ?? "")

    .replace(/&/g, "&amp;")

    .replace(/</g, "&lt;")

    .replace(/>/g, "&gt;")

    .replace(/"/g, "&quot;")

    .replace(/'/g, "&#039;");

}


function setProgress(value) {

  value =
    Math.max(
      0,
      Math.min(
        100,
        Number(value) || 0
      )
    );

  document.getElementById(
    "progressBar"
  ).style.width =
    value + "%";

  document.getElementById(
    "progressText"
  ).textContent =
    Math.round(value) + "%";

}


// ============================================================
// CATEGORIE
// ============================================================

function choisirCategorie(
  button,
  categorie
) {

  document
    .querySelectorAll(".category")
    .forEach(
      btn =>
        btn.classList.remove(
          "selected"
        )
    );

  button.classList.add(
    "selected"
  );

  categorieChoisie =
    categorie;

}


// ============================================================
// NOUVEAU PROJET
// ============================================================

function nouveauProjet() {

  dernierProjet = null;

  derniersPrompts = [];

  dernieresImages = [];

  derniersClips = [];

  animationJobId = null;

  if (queueTimer) {

    clearInterval(
      queueTimer
    );

    queueTimer = null;

  }

  document.getElementById(
    "idea"
  ).value = "";

  document.getElementById(
    "topProjectName"
  ).textContent =
    "Nouveau projet";

  document.getElementById(
    "projectTitle"
  ).textContent =
    "Aucun projet";

  document.getElementById(
    "projectConcept"
  ).textContent =
    "Crée ton premier projet pour commencer.";

  document.getElementById(
    "projectStyle"
  ).textContent =
    "—";

  document.getElementById(
    "characters"
  ).innerHTML =
    '<span class="pill">En attente</span>';

  document.getElementById(
    "projectStatus"
  ).textContent =
    "En attente";

  document.getElementById(
    "prepareScenesButton"
  ).disabled = true;

  document.getElementById(
    "generateImagesButton"
  ).disabled = true;

  document.getElementById(
    "animateButton"
  ).disabled = true;

  document.getElementById(
    "createVideoButton"
  ).disabled = true;

  setProgress(0);

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });

}


// ============================================================
// TEST GEMINI
// ============================================================

async function testerGemini() {

  try {

    document.getElementById(
      "geminiStatus"
    ).textContent =
      "Test Gemini...";

    document.getElementById(
      "sidebarGemini"
    ).textContent =
      "Test Gemini...";

    const response =
      await fetch(
        "/api/test-gemini"
      );

    const data =
      await response.json();

    if (!response.ok) {

      throw new Error(
        data.error ||
        "Gemini indisponible."
      );

    }

    document.getElementById(
      "geminiStatus"
    ).textContent =
      "Gemini connecté";

    document.getElementById(
      "sidebarGemini"
    ).textContent =
      "Gemini connecté";

    document.getElementById(
      "connectionDot"
    ).style.background =
      "#27d17f";

    document.querySelector(
      ".gemini-dot"
    ).style.background =
      "#27d17f";

    return true;

  } catch (error) {

    document.getElementById(
      "geminiStatus"
    ).textContent =
      "Gemini indisponible";

    document.getElementById(
      "sidebarGemini"
    ).textContent =
      "Gemini indisponible";

    document.getElementById(
      "connectionDot"
    ).style.background =
      "#ff5d73";

    document.querySelector(
      ".gemini-dot"
    ).style.background =
      "#ff5d73";

    alert(
      error.message
    );

    return false;

  }

}


// ============================================================
// GENERER PROJET
// ============================================================

async function genererProjet() {

  const idea =
    document.getElementById(
      "idea"
    ).value.trim();

  if (!idea) {

    alert(
      "Décris d'abord ton idée de vidéo."
    );

    return;
  }

  const button =
    document.getElementById(
      "generateButton"
    );

  button.disabled = true;

  button.textContent =
    "⏳ Création...";

  document.getElementById(
    "projectStatus"
  ).textContent =
    "Génération du projet...";

  setProgress(10);

  try {

    const response =
      await fetch(
        "/api/generate",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              idea,
              category:
                categorieChoisie
            })
        }
      );

    const data =
      await response.json();

    if (!response.ok) {

      throw new Error(
        data.error ||
        "Impossible de générer le projet."
      );

    }

    dernierProjet =
      data.project ||
      data;

    afficherProjet(
      dernierProjet
    );

    setProgress(25);

    document.getElementById(
      "projectStatus"
    ).textContent =
      "Projet généré ✓";

    document.getElementById(
      "prepareScenesButton"
    ).disabled = false;

  } catch (error) {

    document.getElementById(
      "projectStatus"
    ).textContent =
      "Erreur";

    alert(
      error.message
    );

  } finally {

    button.disabled = false;

    button.textContent =
      "✨ Créer mon projet";

  }

}


// ============================================================
// AFFICHER PROJET
// ============================================================

function afficherProjet(
  project
) {

  if (!project) return;

  document.getElementById(
    "topProjectName"
  ).textContent =
    project.title ||
    "Projet Cineflow";

  document.getElementById(
    "projectTitle"
  ).textContent =
    project.title ||
    "Sans titre";

  document.getElementById(
    "projectConcept"
  ).textContent =
    project.concept ||
    "Concept non disponible.";

  document.getElementById(
    "projectStyle"
  ).textContent =
    project.style ||
    "Cinématique";

  const characters =
    document.getElementById(
      "characters"
    );

  if (
    Array.isArray(
      project.characters
    ) &&
    project.characters.length
  ) {

    characters.innerHTML =
      project.characters
        .map(
          character =>
            '<span class="pill">' +
            escapeHtml(
              typeof character ===
              "string"
                ? character
                : character.name ||
                  "Personnage"
            ) +
            "</span>"
        )
        .join("");

  }

}


// ============================================================
// PREPARER SCENES
// ============================================================

async function preparerScenes() {

  if (!dernierProjet) {

    alert(
      "Crée d'abord un projet."
    );

    return;
  }

  const button =
    document.getElementById(
      "prepareScenesButton"
    );

  button.disabled = true;

  button.textContent =
    "⏳ Préparation...";

  try {

    const response =
      await fetch(
        "/api/prepare-images",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              project:
                dernierProjet
            })
        }
      );

    const data =
      await response.json();

    if (!response.ok) {

      throw new Error(
        data.error ||
        "Impossible de préparer les scènes."
      );

    }

    derniersPrompts =
      data.prompts ||
      data.scenePrompts ||
      [];

    if (
      derniersPrompts.length !== 5
    ) {

      throw new Error(
        "Cineflow doit préparer exactement 5 scènes."
      );

    }

    afficherScenes();

    document.getElementById(
      "generateImagesButton"
    ).disabled = false;

    setProgress(40);

  } catch (error) {

    alert(
      error.message
    );

  } finally {

    button.disabled = false;

    button.textContent =
      "🧩 Préparer les 5 scènes";

  }

}


// ============================================================
// AFFICHER SCENES
// ============================================================

function afficherScenes() {

  const container =
    document.getElementById(
      "scenes"
    );

  container.innerHTML = "";

  for (
    let i = 0;
    i < 5;
    i++
  ) {

    const scene =
      dernierProjet.scenes?.[i] ||
      {};

    const prompt =
      derniersPrompts[i] ||
      "";

    container.innerHTML += `

      <div class="scene-card">

        <div class="scene-image">
          ${String(i + 1).padStart(2,"0")}
        </div>

        <div class="scene-content">

          <div class="scene-number">
            Scène ${i + 1}
          </div>

          <div class="scene-title">
            ${escapeHtml(
              scene.title ||
              "Scène " +
              (i + 1)
            )}
          </div>

          <div class="scene-status">
            ${escapeHtml(
              prompt.substring(
                0,
                100
              )
            )}
          </div>

        </div>

      </div>

    `;

  }

}


// ============================================================
// GENERER IMAGES
// ============================================================

async function genererImages() {

  if (
    derniersPrompts.length !== 5
  ) {

    alert(
      "Prépare d'abord les 5 scènes."
    );

    return;
  }

  const button =
    document.getElementById(
      "generateImagesButton"
    );

  button.disabled = true;

  button.textContent =
    "⏳ Génération...";

  dernieresImages = [];

  document.getElementById(
    "images"
  ).innerHTML = "";

  try {

    for (
      let i = 0;
      i < 5;
      i++
    ) {

      document.getElementById(
        "imageStatus"
      ).textContent =
        "Génération de l'image " +
        (i + 1) +
        " / 5...";

      const response =
        await fetch(
          "/api/generate-image",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                prompt:
                  derniersPrompts[i],

                scene:
                  i + 1
              })
          }
        );

      const data =
        await response.json();

      if (!response.ok) {

        throw new Error(
          data.error ||
          "Impossible de générer l'image."
        );

      }

      dernieresImages[i] =
        data;

      const percent =
        ((i + 1) / 5) * 100;

      document.getElementById(
        "imageProgress"
      ).style.width =
        percent + "%";

      document.getElementById(
        "imageCount"
      ).textContent =
        (i + 1) +
        " / 5";

      afficherImages();

      setProgress(
        40 +
        percent * .25
      );

    }

    document.getElementById(
      "imageStatus"
    ).textContent =
      "5 images générées ✓";

    document.getElementById(
      "animateButton"
    ).disabled = false;

  } catch (error) {

    document.getElementById(
      "imageStatus"
    ).textContent =
      "Erreur";

    alert(
      error.message
    );

  } finally {

    button.disabled = false;

    button.textContent =
      "🎨 Générer les images";

  }

}


// ============================================================
// AFFICHER IMAGES
// ============================================================

function afficherImages() {

  const container =
    document.getElementById(
      "images"
    );

  container.innerHTML = "";

  for (
    let i = 0;
    i < 5;
    i++
  ) {

    const image =
      dernieresImages[i];

    let visual =
      "🖼️";

    if (
      image &&
      image.data
    ) {

      const mime =
        image.mimeType ||
        "image/jpeg";

      visual =
        '<img src="data:' +
        mime +
        ';base64,' +
        image.data +
        '" alt="Scène ' +
        (i + 1) +
        '">';

    }

    container.innerHTML += `

      <div class="scene-card">

        <div class="scene-image">
          ${visual}
        </div>

        <div class="scene-content">

          <div class="scene-number">
            Visuel ${i + 1}
          </div>

          <div class="scene-title">
            ${
              image
                ? "Image prête ✓"
                : "En attente"
            }
          </div>

          <div class="scene-status">
            ${
              image
                ? "Généré par Gemini"
                : "—"
            }
          </div>

        </div>

      </div>

    `;

  }

}


// ============================================================
// ANIMER
// ============================================================

async function animerScenes() {

  if (
    dernieresImages.length !== 5
  ) {

    alert(
      "Génère d'abord les 5 images."
    );

    return;
  }

  const button =
    document.getElementById(
      "animateButton"
    );

  button.disabled = true;

  button.textContent =
    "⏳ Mise en file...";

  try {

    const response =
      await fetch(
        "/api/animate-scenes",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              images:
                dernieresImages,

              prompts:
                derniersPrompts
            })
        }
      );

    const data =
      await response.json();

    if (!response.ok) {

      throw new Error(
        data.error ||
        "Impossible de lancer l'animation."
      );

    }

    animationJobId =
      data.jobId ||
      data.job?.id;

    afficherQueue(
      data.job ||
      data
    );

    document.getElementById(
      "queueStatus"
    ).textContent =
      "Les scènes sont dans la file d'animation.";

    setProgress(70);

    demarrerSurveillanceQueue();

  } catch (error) {

    alert(
      error.message
    );

  } finally {

    button.disabled = false;

    button.textContent =
      "🎞️ Animer les 5 scènes";

  }

}


// ============================================================
// SURVEILLANCE
// ============================================================

function demarrerSurveillanceQueue() {

  if (queueTimer) {

    clearInterval(
      queueTimer
    );

  }

  verifierQueue();

  queueTimer =
    setInterval(
      verifierQueue,
      5000
    );

}


async function verifierQueue() {

  if (!animationJobId) return;

  try {

    const response =
      await fetch(
        "/api/animation-status/" +
        encodeURIComponent(
          animationJobId
        )
      );

    const data =
      await response.json();

    if (!response.ok) {

      throw new Error(
        data.error ||
        "Impossible de vérifier la file."
      );

    }

    afficherQueue(data);

    const completed =
      data.scenes?.filter(
        scene =>
          scene.status ===
          "completed"
      ).length || 0;

    setProgress(
      70 +
      (completed / 5) * 20
    );

    if (
      completed === 5
    ) {

      derniersClips =
        data.scenes
          .sort(
            (a,b) =>
              a.scene - b.scene
          )
          .map(
            scene =>
              scene.clip
          )
          .filter(Boolean);

      document.getElementById(
        "createVideoButton"
      ).disabled =
        derniersClips.length !== 5;

      document.getElementById(
        "queueStatus"
      ).textContent =
        "Les 5 scènes sont animées ✓";

      setProgress(92);

      clearInterval(
        queueTimer
      );

      queueTimer = null;

    }

  } catch (error) {

    console.error(
      error
    );

  }

}


// ============================================================
// AFFICHER QUEUE
// ============================================================

function afficherQueue(job) {

  const container =
    document.getElementById(
      "queueScenes"
    );

  if (
    !job ||
    !Array.isArray(
      job.scenes
    )
  ) {

    container.innerHTML = "";

    return;
  }

  container.innerHTML = "";

  job.scenes.forEach(
    scene => {

      let label =
        "En attente";

      let icon =
        "⏳";

      if (
        scene.status ===
        "processing"
      ) {

        label =
          "Animation en cours...";

        icon =
          "🎞️";

      }

      if (
        scene.status ===
        "completed"
      ) {

        label =
          "Animation terminée";

        icon =
          "✅";

      }

      if (
        scene.status ===
        "error"
      ) {

        label =
          "Erreur";

        icon =
          "❌";

      }

      if (
        scene.status ===
        "waiting_for_retry"
      ) {

        label =
          "En attente de reprise";

        icon =
          "🔄";

      }

      container.innerHTML += `

        <div class="queue-item">

          <div class="queue-left">

            <div class="queue-icon">
              ${icon}
            </div>

            <div>

              <div class="queue-title">
                Scène ${scene.scene}
              </div>

              <div class="queue-state">

                ${escapeHtml(label)}

                · Tentatives :
                ${scene.attempts || 0}

              </div>

            </div>

          </div>

          ${
            scene.status === "error"
              ? `
                <button
                  class="secondary-btn"
                  onclick="reprendreScene(${scene.scene})"
                >
                  🔄 Réessayer
                </button>
              `
              : ""
          }

        </div>

      `;

    }
  );

}


// ============================================================
// REPRENDRE SCENE
// ============================================================

async function reprendreScene(
  sceneNumber
) {

  if (!animationJobId) return;

  try {

    const response =
      await fetch(
        "/api/animation-retry",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              jobId:
                animationJobId,

              scene:
                sceneNumber
            })
        }
      );

    const data =
      await response.json();

    if (!response.ok) {

      throw new Error(
        data.error ||
        "Impossible de reprendre la scène."
      );

    }

    afficherQueue(
      data.job ||
      data
    );

    demarrerSurveillanceQueue();

  } catch (error) {

    alert(
      error.message
    );

  }

}


// ============================================================
// CREER VIDEO
// ============================================================

async function creerVideo() {

  if (
    derniersClips.length !== 5
  ) {

    alert(
      "Les 5 animations doivent être terminées avant de créer la vidéo."
    );

    return;
  }

  const button =
    document.getElementById(
      "createVideoButton"
    );

  button.disabled = true;

  button.textContent =
    "⏳ Montage...";

  document.getElementById(
    "finalStatus"
  ).textContent =
    "Cineflow assemble les 5 scènes...";

  try {

    const response =
      await fetch(
        "/api/create-video",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              clips:
                derniersClips
            })
        }
      );

    const data =
      await response.json();

    if (!response.ok) {

      throw new Error(
        data.error ||
        "Impossible de créer la vidéo."
      );

    }

    if (!data.data) {

      throw new Error(
        "La vidéo finale n'a pas été retournée."
      );

    }

    const video =
      document.getElementById(
        "finalVideo"
      );

    video.innerHTML = `

      <video
        controls
        playsinline
        src="data:video/mp4;base64,${data.data}"
      ></video>

    `;

    document.getElementById(
      "finalStatus"
    ).textContent =
      "Vidéo finale créée ✓";

    setProgress(100);

  } catch (error) {

    document.getElementById(
      "finalStatus"
    ).textContent =
      "Erreur pendant le montage.";

    alert(
      error.message
    );

  } finally {

    button.disabled = false;

    button.textContent =
      "🎬 Créer ma vidéo";

  }

}


// ============================================================
// AUDIO
// ============================================================

async function preparerAudio() {

  if (!dernierProjet) {

    alert(
      "Crée d'abord un projet."
    );

    return;
  }

  try {

    const response =
      await fetch(
        "/api/prepare-audio",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              project:
                dernierProjet
            })
        }
      );

    const data =
      await response.json();

    if (!response.ok) {

      throw new Error(
        data.error ||
        "Impossible de préparer l'audio."
      );

    }

    document.getElementById(
      "audioStatus"
    ).textContent =
      "Audio préparé : " +
      data.music;

  } catch (error) {

    alert(
      error.message
    );

  }

}


// ============================================================
// MINIATURE
// ============================================================

async function preparerThumbnail() {

  if (!dernierProjet) {

    alert(
      "Crée d'abord un projet."
    );

    return;
  }

  try {

    const response =
      await fetch(
        "/api/prepare-thumbnail",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              project:
                dernierProjet
            })
        }
      );

    const data =
      await response.json();

    if (!response.ok) {

      throw new Error(
        data.error ||
        "Impossible de préparer la miniature."
      );

    }

    document.getElementById(
      "thumbnailStatus"
    ).textContent =
      "Miniature prête : " +
      data.composition;

  } catch (error) {

    alert(
      error.message
    );

  }

}


// ============================================================
// RESEAUX SOCIAUX
// ============================================================

async function preparerSocial() {

  if (!dernierProjet) {

    alert(
      "Crée d'abord un projet."
    );

    return;
  }

  try {

    const response =
      await fetch(
        "/api/prepare-social",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              project:
                dernierProjet
            })
          }
      );

    const data =
      await response.json();

    if (!response.ok) {

      throw new Error(
        data.error ||
        "Impossible de préparer les réseaux sociaux."
      );

    }

    document.getElementById(
      "socialStatus"
    ).textContent =
      "YouTube, TikTok, Instagram et Facebook préparés ✓";

  } catch (error) {

    alert(
      error.message
    );

  }

}


// ============================================================
// AUTO-PILOTE
// ============================================================

async function preparerAutoPilot() {

  if (!dernierProjet) {

    alert(
      "Crée d'abord un projet."
    );

    return;
  }

  try {

    const response =
      await fetch(
        "/api/autopilot-plan",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              project:
                dernierProjet
            })
          }
      );

    const data =
      await response.json();

    if (!response.ok) {

      throw new Error(
        data.error ||
        "Impossible de préparer Auto-Pilote."
      );

    }

    document.getElementById(
      "autoStatus"
    ).textContent =
      "Workflow Auto-Pilote préparé ✓";

  } catch (error) {

    alert(
      error.message
    );

  }

}


// ============================================================
// TEST AUTOMATIQUE DE CONNEXION
// ============================================================

window.addEventListener(
  "load",
  () => {

    testerGemini();

  }
);

</script>

</body>

</html>`);

});


// ============================================================
// TEST GEMINI
// ============================================================

app.get(
  "/api/test-gemini",
  async (req, res) => {

    try {

      if (!API_KEY) {

        return res.status(500).json({
          success: false,

          error:
            "GEMINI_API_KEY n'est pas configurée sur Render."
        });

      }

      const text =
        await generateTextInteraction(
          "Réponds exactement : Je confirme que Gemini est correctement connecté à Cineflow."
        );

      res.json({
        success: true,
        message: text
      });

    } catch (error) {

      console.error(
        "Erreur test Gemini:",
        error
      );

      res.status(500).json({

        success: false,

        error:
          error.message ||
          "Impossible de contacter Gemini."
      });

    }

  }
);


// ============================================================
// GENERER PROJET
// ============================================================

app.post(
  "/api/generate",
  async (req, res) => {

    try {

      const idea =
        String(
          req.body.idea || ""
        ).trim();

      const category =
        String(
          req.body.category || ""
        ).trim();

      if (!idea) {

        return res.status(400).json({

          success: false,

          error:
            "L'idée de vidéo est obligatoire."
        });

      }

      const prompt = `

Tu es le moteur créatif de Cineflow.

Crée un projet vidéo cinématographique
à partir de cette idée :

${idea}

Catégorie :
${category || "cinématique"}

Le projet doit être cohérent,
visuel, émotionnel et réalisable
en 5 scènes.

Retourne UNIQUEMENT un JSON valide.

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

Il doit y avoir exactement
5 scènes.

`;

      const raw =
        await generateTextInteraction(
          prompt
        );

      const json =
        cleanJson(raw);

      let project;

      try {

        project =
          JSON.parse(json);

      } catch {

        throw new Error(
          "Gemini a retourné un JSON invalide."
        );

      }

      if (
        !Array.isArray(
          project.scenes
        ) ||
        project.scenes.length !== 5
      ) {

        throw new Error(
          "Le projet doit contenir exactement 5 scènes."
        );

      }

      res.json({

        success: true,

        project

      });

    } catch (error) {

      console.error(
        "Erreur /api/generate:",
        error
      );

      res.status(500).json({

        success: false,

        error:
          error.message ||
          "Impossible de générer le projet."
      });

    }

  }
);


// ============================================================
// PREPARER LES PROMPTS DES IMAGES
// ============================================================

app.post(
  "/api/prepare-images",
  async (req, res) => {

    try {

      const project =
        req.body.project;

      if (!project) {

        return res.status(400).json({

          success: false,

          error:
            "Projet manquant."
        });

      }

      if (
        !Array.isArray(
          project.scenes
        ) ||
        project.scenes.length !== 5
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Le projet doit contenir exactement 5 scènes."
        });

      }

      const style =
        project.style ||
        "cinématographique";

      const characters =
        Array.isArray(
          project.characters
        )
          ? project.characters.join(", ")
          : "";

      const prompts =
        project.scenes.map(
          (scene, index) => {

            return `

Image cinématographique pour
la scène ${index + 1} sur 5.

Titre du projet :
${project.title || ""}

Style :
${style}

Personnages :
${characters}

Scène :
${scene.title || ""}

Description :
${scene.description || ""}

Créer une image 16:9
très cinématographique.

Conserver exactement
la cohérence des personnages,
leurs vêtements,
leurs caractéristiques,
les couleurs et l'univers
d'une scène à l'autre.

Inclure :

- environnement détaillé
- action claire
- composition cinématographique
- profondeur de champ
- éclairage réaliste
- caméra dynamique
- ambiance adaptée à l'histoire

Pas de texte.
Pas de logo.
Pas de watermark.

`;

          }
        );

      res.json({

        success: true,

        prompts

      });

    } catch (error) {

      console.error(
        "Erreur prepare-images:",
        error
      );

      res.status(500).json({

        success: false,

        error:
          error.message ||
          "Impossible de préparer les images."
      });

    }

  }
);


// ============================================================
// GENERER UNE IMAGE
// ============================================================

app.post(
  "/api/generate-image",
  async (req, res) => {

    try {

      const prompt =
        String(
          req.body.prompt || ""
        ).trim();

      const scene =
        Number(
          req.body.scene || 0
        );

      if (!prompt) {

        return res.status(400).json({

          success: false,

          error:
            "Prompt image manquant."
        });

      }

      if (
        scene < 1 ||
        scene > 5
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Numéro de scène invalide."
        });

      }

      const image =
        await generateImage(
          prompt
        );

      res.json({

        success: true,

        scene,

        mimeType:
          image.mimeType,

        data:
          image.data

      });

    } catch (error) {

      console.error(
        "Erreur generate-image:",
        error
      );

      res.status(500).json({

        success: false,

        error:
          error.message ||
          "Impossible de générer l'image."
      });

    }

  }
);


// ============================================================
// ANIMER UNE SEULE SCENE
// ============================================================

app.post(
  "/api/animate-scene",
  async (req, res) => {

    try {

      const image =
        req.body.image;

      const prompt =
        String(
          req.body.prompt || ""
        );

      if (
        !image ||
        !image.data
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Image manquante."
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

      console.error(
        "Erreur animate-scene:",
        error
      );

      res.status(500).json({

        success: false,

        error:
          error.message ||
          "Impossible d'animer la scène."
      });

    }

  }
);


// ============================================================
// LANCER LES 5 SCENES
// ============================================================

app.post(
  "/api/animate-scenes",
  async (req, res) => {

    try {

      const images =
        req.body.images;

      const prompts =
        req.body.prompts;

      if (
        !Array.isArray(images) ||
        images.length !== 5
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Il faut exactement 5 images."
        });

      }

      if (
        !Array.isArray(prompts) ||
        prompts.length !== 5
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Il faut exactement 5 prompts."
        });

      }

      const job =
        createAnimationJob(
          images,
          prompts
        );

      processAnimationQueue();

      res.json({

        success: true,

        jobId:
          job.id,

        job:
          getPublicJob(job)

      });

    } catch (error) {

      console.error(
        "Erreur animate-scenes:",
        error
      );

      res.status(500).json({

        success: false,

        error:
          error.message ||
          "Impossible de lancer l'animation."
      });

    }

  }
);


// ============================================================
// REGENERER UNE SCENE TERMINEE
// ============================================================

app.post(
  "/api/animation-regenerate",
  async (req, res) => {

    try {

      const jobId =
        String(
          req.body.jobId || ""
        );

      const sceneNumber =
        Number(
          req.body.scene || 0
        );

      if (!jobId) {

        return res.status(400).json({

          success: false,

          error:
            "ID de file manquant."
        });

      }

      if (
        sceneNumber < 1 ||
        sceneNumber > 5
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Numéro de scène invalide."
        });

      }

      const job =
        getJob(jobId);

      if (!job) {

        return res.status(404).json({

          success: false,

          error:
            "File d'animation introuvable."
        });

      }

      retryScene(
        job,
        sceneNumber
      );

      res.json({

        success: true,

        message:
          "Scène " +
          sceneNumber +
          " remise en génération.",

        job:
          getPublicJob(job)

      });

    } catch (error) {

      console.error(
        error
      );

      res.status(500).json({

        success: false,

        error:
          error.message ||
          "Impossible de régénérer la scène."
      });

    }

  }
);


// ============================================================
// INFOS PUBLIQUES D'UNE FILE
// ============================================================

function getPublicJob(job) {

  return {

    id:
      job.id,

    status:
      job.status,

    createdAt:
      job.createdAt,

    startedAt:
      job.startedAt,

    finishedAt:
      job.finishedAt,

    scenes:
      job.scenes.map(
        scene => ({

          scene:
            scene.scene,

          status:
            scene.status,

          attempts:
            scene.attempts,

          error:
            scene.error,

          startedAt:
            scene.startedAt,

          finishedAt:
            scene.finishedAt,

          clip:
            scene.status ===
            "completed"
              ? scene.clip
              : null

        })
      )

  };

}


// ============================================================
// STATUT ANIMATION
// ============================================================

app.get(
  "/api/animation-status/:jobId",
  (req, res) => {

    const job =
      getJob(
        req.params.jobId
      );

    if (!job) {

      return res.status(404).json({

        success: false,

        error:
          "File d'animation introuvable."
      });

    }

    res.json(
      getPublicJob(job)
    );

  }
);


// ============================================================
// RETRY
// ============================================================

app.post(
  "/api/animation-retry",
  async (req, res) => {

    try {

      const jobId =
        String(
          req.body.jobId || ""
        );

      const sceneNumber =
        Number(
          req.body.scene || 0
        );

      if (!jobId) {

        return res.status(400).json({

          success: false,

          error:
            "ID de file manquant."
        });

      }

      const job =
        getJob(jobId);

      if (!job) {

        return res.status(404).json({

          success: false,

          error:
            "File d'animation introuvable."
        });

      }

      retryScene(
        job,
        sceneNumber
      );

      res.json({

        success: true,

        job:
          getPublicJob(job)

      });

    } catch (error) {

      console.error(
        error
      );

      res.status(500).json({

        success: false,

        error:
          error.message ||
          "Impossible de reprendre la scène."
      });

    }

  }
);


// ============================================================
// CREER VIDEO FINALE
// ============================================================

app.post(
  "/api/create-video",
  async (req, res) => {

    const clips =
      req.body.clips;

    let tempDir = null;

    try {

      if (
        !Array.isArray(clips) ||
        clips.length !== 5
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Il faut exactement 5 clips."
        });

      }

      if (
        clips.some(
          clip =>
            !clip ||
            typeof clip !==
            "string"
        )
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Un ou plusieurs clips sont invalides."
        });

      }

      tempDir =
        fs.mkdtempSync(
          path.join(
            os.tmpdir(),
            "cineflow-final-"
          )
        );

      const normalizedFiles = [];

      for (
        let i = 0;
        i < clips.length;
        i++
      ) {

        const input =
          path.join(
            tempDir,
            `input-${i + 1}.mp4`
          );

        const output =
          path.join(
            tempDir,
            `normalized-${i + 1}.mp4`
          );

        fs.writeFileSync(
          input,
          Buffer.from(
            clips[i],
            "base64"
          )
        );

        await runFFmpeg([

          "-y",

          "-i",
          input,

          "-vf",
          "scale=1280:720:force_original_aspect_ratio=decrease," +
          "pad=1280:720:(ow-iw)/2:(oh-ih)/2",

          "-r",
          "24",

          "-c:v",
          "libx264",

          "-pix_fmt",
          "yuv420p",

          "-c:a",
          "aac",

          "-b:a",
          "128k",

          output

        ]);

        normalizedFiles.push(
          output
        );

      }

      const concatFile =
        path.join(
          tempDir,
          "concat.txt"
        );

      const concatContent =
        normalizedFiles
          .map(
            file =>
              "file '" +
              file.replace(
                /'/g,
                "'\\\\''"
              ) +
              "'"
          )
          .join("\n");

      fs.writeFileSync(
        concatFile,
        concatContent
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

      const finalBuffer =
        fs.readFileSync(
          finalFile
        );

      res.json({

        success: true,

        mimeType:
          "video/mp4",

        data:
          finalBuffer.toString(
            "base64"
          )

      });

    } catch (error) {

      console.error(
        "Erreur create-video:",
        error
      );

      res.status(500).json({

        success: false,

        error:
          error.message ||
          "Impossible de créer la vidéo finale."
      });

    } finally {

      if (tempDir) {

        try {

          fs.rmSync(
            tempDir,
            {
              recursive: true,
              force: true
            }
          );

        } catch {}

      }

    }

  }
);


// ============================================================
// AUDIO
// ============================================================

app.post(
  "/api/prepare-audio",
  (req, res) => {

    try {

      const project =
        req.body.project;

      if (!project) {

        return res.status(400).json({

          success: false,

          error:
            "Projet manquant."
        });

      }

      res.json(
        buildAudioPlan(
          project
        )
      );

    } catch (error) {

      res.status(500).json({

        success: false,

        error:
          error.message
      });

    }

  }
);


// ============================================================
// MINIATURE
// ============================================================

app.post(
  "/api/prepare-thumbnail",
  (req, res) => {

    try {

      const project =
        req.body.project;

      if (!project) {

        return res.status(400).json({

          success: false,

          error:
            "Projet manquant."
        });

      }

      res.json(
        buildThumbnailPlan(
          project
        )
      );

    } catch (error) {

      res.status(500).json({

        success: false,

        error:
          error.message
      });

    }

  }
);


// ============================================================
// RESEAUX SOCIAUX
// ============================================================

app.post(
  "/api/prepare-social",
  (req, res) => {

    try {

      const project =
        req.body.project;

      if (!project) {

        return res.status(400).json({

          success: false,

          error:
            "Projet manquant."
        });

      }

      res.json(
        buildSocialPlan(
          project
        )
      );

    } catch (error) {

      res.status(500).json({

        success: false,

        error:
          error.message
      });

    }

  }
);


// ============================================================
// AUTO-PILOTE
// ============================================================

app.post(
  "/api/autopilot-plan",
  (req, res) => {

    try {

      const project =
        req.body.project;

      if (!project) {

        return res.status(400).json({

          success: false,

          error:
            "Projet manquant."
        });

      }

      res.json(
        buildAutoPilotPlan(
          project
        )
      );

    } catch (error) {

      res.status(500).json({

        success: false,

        error:
          error.message
      });

    }

  }
);


// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {

    res.status(404).json({

      success: false,

      error:
        "Route introuvable."

    });

  }
);


// ============================================================
// DEMARRAGE
// ============================================================

app.listen(
  PORT,
  () => {

    console.log(
      "🎬 Cineflow démarré sur le port " +
      PORT
    );

    console.log(
      "Gemini : " +
      (
        API_KEY
          ? "clé configurée"
          : "clé absente"
      )
    );

  }
);

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

/* =========================================================
   OUTILS
========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanJson(text) {
  if (!text) return "";

  let cleaned = String(text).trim();

  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  }

  if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }

  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }

  return cleaned.trim();
}

function getInteractionText(response) {
  if (!response) return "";

  if (typeof response.text === "string") {
    return response.text;
  }

  if (response.text && typeof response.text === "function") {
    try {
      return response.text();
    } catch (e) {}
  }

  if (response.output_text) {
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
          if (content && typeof content.text === "string") {
            return content.text;
          }
        }
      }
    }
  }

  if (response.candidates) {
    try {
      return response.candidates
        .flatMap(c => c.content?.parts || [])
        .map(p => p.text || "")
        .join("\n")
        .trim();
    } catch (e) {}
  }

  return "";
}

/* =========================================================
   GEMINI TEXTE
========================================================= */

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
    throw new Error("Gemini n'a retourné aucun texte.");
  }

  return text;
}

/* =========================================================
   GENERATION IMAGE
========================================================= */

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
    data: interaction.output_image.data
  };
}

/* =========================================================
   VIDEO VEO
========================================================= */

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

  let operation = await ai.models.generateVideos({
    model: VIDEO_MODEL,
    prompt:
      prompt +
      "\n\nCréer une animation cinématographique fluide. " +
      "Conserver les personnages, les vêtements, le décor " +
      "et la composition de l'image source. Mouvement naturel de caméra.",
    image: {
      imageBytes: imageBase64,
      mimeType: mimeType || "image/jpeg"
    }
  });

  let loops = 0;

  while (!operation.done && loops < 60) {
    await sleep(10000);

    operation =
      await ai.operations.getVideosOperation({
        operation
      });

    loops++;
  }

  if (!operation.done) {
    throw new Error(
      "La génération Veo prend trop de temps."
    );
  }

  if (operation.error) {
    throw new Error(
      operation.error.message ||
      "Erreur pendant la génération Veo."
    );
  }

  const generated =
    operation.response?.generatedVideos ||
    operation.generatedVideos;

  if (!generated || !generated.length) {
    throw new Error(
      "Veo n'a retourné aucune vidéo."
    );
  }

  const video =
    generated[0].video;

  if (!video) {
    throw new Error(
      "La vidéo Veo est introuvable."
    );
  }

  const tempFile = path.join(
    os.tmpdir(),
    "cineflow-" +
      Date.now() +
      "-" +
      Math.random()
        .toString(36)
        .slice(2) +
      ".mp4"
  );

  try {
    await ai.files.download({
      file: video,
      downloadPath: tempFile
    });

    const buffer =
      fs.readFileSync(tempFile);

    return buffer.toString("base64");
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch (e) {}
  }
}

/* =========================================================
   FFMPEG
========================================================= */

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

/* =========================================================
   FILE D'ANIMATION
========================================================= */

let animationQueue = [];
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
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    scenes: []
  };

  for (let i = 0; i < 5; i++) {
    const image = images[i];

    job.scenes.push({
      scene: i + 1,
      status: "pending",
      attempts: 0,
      image:
        image?.data ||
        image?.image ||
        image,
      mimeType:
        image?.mimeType ||
        "image/jpeg",
      prompt:
        prompts[i] || "",
      clip: null,
      error: null,
      startedAt: null,
      completedAt: null
    });
  }

  animationQueue.push(job);

  processAnimationQueue();

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
  const scene = job.scenes[index];

  if (!scene) return;

  if (
    scene.status === "completed" &&
    scene.clip
  ) {
    return;
  }

  scene.status = "processing";
  scene.attempts++;
  scene.error = null;
  scene.startedAt =
    new Date().toISOString();

  try {
    if (!scene.image) {
      throw new Error(
        "Image absente pour cette scène."
      );
    }

    const clip =
      await generateVideoFromImage(
        scene.image,
        scene.mimeType,
        scene.prompt
      );

    scene.clip = clip;
    scene.status = "completed";
    scene.completedAt =
      new Date().toISOString();
  } catch (error) {
    scene.status = "error";
    scene.error =
      error.message ||
      "Erreur inconnue.";
  }
}

async function processAnimationQueue() {
  if (animationRunning) return;

  animationRunning = true;

  try {
    let job =
      animationQueue.find(
        j =>
          j.status === "queued" ||
          j.status === "running"
      );

    if (!job) return;

    job.status = "running";

    if (!job.startedAt) {
      job.startedAt =
        new Date().toISOString();
    }

    for (
      let i = 0;
      i < job.scenes.length;
      i++
    ) {
      const scene = job.scenes[i];

      if (
        scene.status === "completed"
      ) {
        continue;
      }

      if (
        scene.status === "processing"
      ) {
        continue;
      }

      if (
        scene.status === "error"
      ) {
        continue;
      }

      await processOneAnimationScene(
        job,
        i
      );
    }

    const completed =
      job.scenes.filter(
        s => s.status === "completed"
      ).length;

    const errors =
      job.scenes.filter(
        s => s.status === "error"
      ).length;

    if (completed === 5) {
      job.status = "completed";
      job.completedAt =
        new Date().toISOString();
    } else if (errors > 0) {
      job.status =
        "waiting_for_retry";
    } else {
      job.status = "queued";
    }
  } catch (error) {
    if (job) {
      job.status = "waiting_for_retry";
    }
  } finally {
    animationRunning = false;

    setTimeout(() => {
      processAnimationQueue();
    }, 1000);
  }
}

function retryScene(
  job,
  sceneNumber
) {
  const scene =
    job.scenes.find(
      s => s.scene === sceneNumber
    );

  if (!scene) {
    throw new Error(
      "Scène introuvable."
    );
  }

  scene.status = "pending";
  scene.error = null;
  scene.clip = null;
  scene.completedAt = null;

  job.status = "queued";

  if (!animationQueue.includes(job)) {
    animationQueue.push(job);
  }

  processAnimationQueue();

  return job;
}

function getPublicJob(job) {
  if (!job) return null;

  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    scenes: job.scenes.map(scene => ({
      scene: scene.scene,
      status: scene.status,
      attempts: scene.attempts,
      error: scene.error,
      startedAt: scene.startedAt,
      completedAt: scene.completedAt,
      clip:
        scene.status === "completed"
          ? scene.clip
          : null
    }))
  };
}

/* =========================================================
   PLANS
========================================================= */

function detectMood(project) {
  const text = (
    (project.title || "") +
    " " +
    (project.concept || "") +
    " " +
    (project.style || "")
  ).toLowerCase();

  if (text.includes("action")) {
    return "action";
  }

  if (
    text.includes("drama") ||
    text.includes("triste")
  ) {
    return "drama";
  }

  if (
    text.includes("football") ||
    text.includes("foot")
  ) {
    return "football";
  }

  if (
    text.includes("suspense") ||
    text.includes("mystère")
  ) {
    return "suspense";
  }

  if (
    text.includes("animation") ||
    text.includes("animé")
  ) {
    return "animation";
  }

  return "cinematic";
}

function buildAudioPlan(project) {
  const mood =
    detectMood(project);

  const music = {
    action:
      "Musique cinématographique énergique, percussions puissantes et montée progressive.",
    drama:
      "Musique émotionnelle au piano et cordes douces.",
    football:
      "Musique sportive motivante avec percussion et montée héroïque.",
    suspense:
      "Musique de suspense sombre et progressive.",
    animation:
      "Musique dynamique et expressive adaptée à l'animation.",
    cinematic:
      "Musique cinématographique moderne avec montée émotionnelle."
  };

  return {
    mood,
    music:
      music[mood] ||
      music.cinematic,
    voice: {
      enabled: true,
      language: "fr-FR",
      tone: "cinématographique"
    },
    soundEffects: true
  };
}

function buildThumbnailPlan(project) {
  return {
    title:
      project.title || "Cineflow",
    concept:
      project.concept || "",
    composition:
      "Personnage principal au premier plan, environnement cinématographique, lumière dramatique.",
    text:
      project.title || "CINEFLOW",
    aspectRatio: "16:9",
    objective:
      "Créer une miniature attractive pour la vidéo."
  };
}

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
      description: concept,
      hashtags: [
        "#Cineflow",
        "#Video",
        "#AI"
      ]
    },
    tiktok: {
      caption:
        title + " — " + concept,
      hashtags: [
        "#Cineflow",
        "#TikTok",
        "#Video"
      ]
    },
    instagram: {
      caption:
        title + "\n\n" + concept,
      hashtags: [
        "#Cineflow",
        "#Reels",
        "#Video"
      ]
    },
    facebook: {
      title,
      description: concept
    }
  };
}

function buildAutoPilotPlan(project) {
  return {
    workflow: [
      "Analyser l'idée",
      "Créer l'histoire",
      "Créer le scénario",
      "Préparer 5 scènes",
      "Générer les visuels",
      "Animer les scènes",
      "Assembler la vidéo",
      "Adapter la musique",
      "Préparer la narration",
      "Ajouter les effets sonores",
      "Préparer la miniature",
      "Préparer les publications",
      "Suivre les statistiques",
      "Suivre les revenus",
      "Préparer le prochain projet"
    ],
    frequency: "weekly",
    verification: [
      "Vérifier les générations terminées",
      "Vérifier les erreurs",
      "Vérifier les publications",
      "Vérifier les statistiques",
      "Préparer le prochain contenu"
    ]
  };
}

/* =========================================================
   INTERFACE CINEFLOW STUDIO
========================================================= */

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Cineflow Studio</title>

<style>
* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  font-family:
    Inter,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  background:
    radial-gradient(
      circle at top right,
      rgba(99,102,241,.18),
      transparent 32%
    ),
    #070b16;
  color: #f8fafc;
}

button,
textarea,
input {
  font: inherit;
}

button {
  cursor: pointer;
}

.app {
  min-height: 100vh;
  display: flex;
}

.sidebar {
  width: 250px;
  min-height: 100vh;
  position: fixed;
  left: 0;
  top: 0;
  padding: 22px 16px;
  background: rgba(10,15,30,.94);
  border-right: 1px solid rgba(255,255,255,.08);
  backdrop-filter: blur(20px);
  z-index: 20;
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px 22px;
}

.logo-icon {
  width: 42px;
  height: 42px;
  border-radius: 13px;
  display: grid;
  place-items: center;
  background:
    linear-gradient(
      135deg,
      #7c3aed,
      #2563eb
    );
  box-shadow:
    0 12px 35px rgba(99,102,241,.3);
  font-size: 21px;
}

.logo strong {
  font-size: 20px;
}

.logo span {
  display: block;
  color: #94a3b8;
  font-size: 10px;
  margin-top: 2px;
}

.new-btn {
  width: 100%;
  border: 0;
  border-radius: 13px;
  padding: 13px;
  color: white;
  background:
    linear-gradient(
      135deg,
      #7c3aed,
      #2563eb
    );
  font-weight: 800;
  margin-bottom: 22px;
}

.nav-title {
  color: #64748b;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: .12em;
  margin: 0 10px 8px;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border-radius: 10px;
  color: #94a3b8;
  font-size: 13px;
}

.nav-item.active,
.nav-item:hover {
  color: white;
  background: rgba(255,255,255,.06);
}

.nav-number {
  width: 25px;
  height: 25px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: rgba(255,255,255,.06);
  font-size: 11px;
}

.gemini-side {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 20px;
  padding: 12px;
  border: 1px solid rgba(34,197,94,.2);
  background: rgba(34,197,94,.06);
  border-radius: 12px;
}

.gemini-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  background: #22c55e;
  border-radius: 50%;
  margin-right: 6px;
  box-shadow: 0 0 12px #22c55e;
}

.main {
  margin-left: 250px;
  width: calc(100% - 250px);
  padding: 24px;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 22px;
}

.project-name {
  font-size: 18px;
  font-weight: 800;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.connection {
  border: 1px solid rgba(34,197,94,.2);
  background: rgba(34,197,94,.07);
  color: #86efac;
  border-radius: 999px;
  padding: 8px 12px;
  font-size: 12px;
}

.progress-mini {
  min-width: 130px;
}

.progress-line {
  height: 6px;
  background: #172033;
  border-radius: 999px;
  overflow: hidden;
  margin-top: 5px;
}

.progress-fill {
  height: 100%;
  width: 0%;
  border-radius: 999px;
  background:
    linear-gradient(
      90deg,
      #7c3aed,
      #2563eb
    );
  transition: width .3s;
}

.card {
  border: 1px solid rgba(255,255,255,.08);
  background:
    linear-gradient(
      145deg,
      rgba(20,27,48,.95),
      rgba(11,17,31,.95)
    );
  border-radius: 20px;
  padding: 22px;
  box-shadow:
    0 18px 55px rgba(0,0,0,.18);
}

.hero {
  position: relative;
  overflow: hidden;
  margin-bottom: 22px;
}

.hero::before {
  content: "";
  position: absolute;
  width: 280px;
  height: 280px;
  right: -80px;
  top: -120px;
  border-radius: 50%;
  background: rgba(124,58,237,.16);
  filter: blur(10px);
}

.eyebrow {
  color: #a78bfa;
  font-size: 12px;
  font-weight: 800;
  margin-bottom: 8px;
}

h1 {
  font-size: clamp(28px, 5vw, 46px);
  margin: 0 0 8px;
  line-height: 1.05;
}

.subtitle {
  color: #94a3b8;
  max-width: 700px;
  line-height: 1.6;
  margin-bottom: 20px;
}

textarea {
  width: 100%;
  min-height: 125px;
  resize: vertical;
  border: 1px solid rgba(255,255,255,.08);
  background: #080d19;
  color: white;
  border-radius: 15px;
  padding: 16px;
  outline: none;
}

textarea:focus {
  border-color: #6366f1;
}

.categories {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 13px 0;
}

.category {
  border: 1px solid rgba(255,255,255,.08);
  background: rgba(255,255,255,.04);
  color: #cbd5e1;
  padding: 8px 12px;
  border-radius: 999px;
  font-size: 12px;
}

.category.active {
  color: white;
  border-color: #6366f1;
  background: rgba(99,102,241,.18);
}

.primary {
  border: 0;
  color: white;
  padding: 13px 18px;
  border-radius: 12px;
  background:
    linear-gradient(
      135deg,
      #7c3aed,
      #2563eb
    );
  font-weight: 800;
}

.secondary {
  border: 1px solid rgba(255,255,255,.1);
  color: #e2e8f0;
  padding: 11px 15px;
  border-radius: 11px;
  background: rgba(255,255,255,.04);
}

.section {
  margin-top: 22px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.section-title {
  font-size: 18px;
  font-weight: 850;
}

.section-subtitle {
  color: #64748b;
  font-size: 12px;
}

.grid {
  display: grid;
  gap: 14px;
}

.overview-grid {
  grid-template-columns:
    repeat(4, minmax(0,1fr));
}

.metric {
  padding: 17px;
  border-radius: 15px;
  background: rgba(255,255,255,.035);
  border: 1px solid rgba(255,255,255,.06);
}

.metric-label {
  color: #64748b;
  font-size: 11px;
  margin-bottom: 7px;
}

.metric-value {
  font-size: 15px;
  font-weight: 750;
}

.pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pill {
  border-radius: 999px;
  padding: 5px 8px;
  font-size: 10px;
  color: #c4b5fd;
  background: rgba(124,58,237,.13);
}

.scene-grid {
  grid-template-columns:
    repeat(5, minmax(0,1fr));
}

.scene-card {
  min-width: 0;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.07);
  border-radius: 16px;
  background: rgba(255,255,255,.035);
}

.scene-image {
  height: 145px;
  display: grid;
  place-items: center;
  background:
    radial-gradient(
      circle,
      rgba(99,102,241,.18),
      rgba(7,11,22,.8)
    );
  color: #64748b;
  overflow: hidden;
}

.scene-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.scene-body {
  padding: 12px;
}

.scene-number {
  color: #a78bfa;
  font-size: 10px;
  font-weight: 800;
  text-transform: uppercase;
}

.scene-title {
  font-weight: 750;
  margin: 5px 0;
  font-size: 13px;
}

.scene-description {
  color: #64748b;
  font-size: 11px;
  line-height: 1.45;
}

.status {
  display: inline-flex;
  align-items: center;
  margin-top: 8px;
  padding: 5px 8px;
  border-radius: 999px;
  background: rgba(255,255,255,.05);
  color: #94a3b8;
  font-size: 10px;
}

.status.done {
  color: #86efac;
  background: rgba(34,197,94,.08);
}

.status.error {
  color: #fca5a5;
  background: rgba(239,68,68,.08);
}

.image-grid {
  grid-template-columns:
    repeat(5, minmax(0,1fr));
}

.image-card {
  min-width: 0;
  border: 1px solid rgba(255,255,255,.07);
  border-radius: 15px;
  overflow: hidden;
  background: rgba(255,255,255,.03);
}

.image-preview {
  height: 150px;
  background: #080d19;
  display: grid;
  place-items: center;
  color: #64748b;
}

.image-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.image-info {
  padding: 10px;
}

.queue {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.queue-row {
  display: grid;
  grid-template-columns: 50px 1fr auto auto;
  gap: 10px;
  align-items: center;
  padding: 12px;
  border-radius: 12px;
  background: rgba(255,255,255,.035);
}

.queue-scene {
  color: #a78bfa;
  font-weight: 800;
}

.queue-status {
  color: #94a3b8;
  font-size: 12px;
}

.small-btn {
  border: 1px solid rgba(255,255,255,.08);
  background: rgba(255,255,255,.04);
  color: #cbd5e1;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 11px;
}

.video-box {
  min-height: 330px;
  display: grid;
  place-items: center;
  background: #030712;
  border-radius: 15px;
  overflow: hidden;
}

.video-box video {
  width: 100%;
  max-height: 600px;
}

.tools-grid {
  grid-template-columns:
    repeat(4, minmax(0,1fr));
}

.tool {
  padding: 16px;
  border-radius: 15px;
  background: rgba(255,255,255,.035);
  border: 1px solid rgba(255,255,255,.06);
}

.tool-icon {
  font-size: 24px;
  margin-bottom: 8px;
}

.tool-title {
  font-weight: 800;
  margin-bottom: 4px;
}

.tool-text {
  color: #64748b;
  font-size: 11px;
  line-height: 1.5;
  margin-bottom: 10px;
}

.stats-grid {
  grid-template-columns:
    repeat(4, minmax(0,1fr));
}

.stat-number {
  font-size: 24px;
  font-weight: 900;
}

.stat-label {
  color: #64748b;
  font-size: 11px;
}

.mobile-nav {
  display: none;
}

.empty {
  padding: 30px;
  text-align: center;
  color: #64748b;
}

.hidden {
  display: none !important;
}

@media(max-width:1100px) {
  .scene-grid,
  .image-grid {
    grid-template-columns:
      repeat(3, minmax(0,1fr));
  }

  .tools-grid {
    grid-template-columns:
      repeat(2, minmax(0,1fr));
  }

  .overview-grid,
  .stats-grid {
    grid-template-columns:
      repeat(2, minmax(0,1fr));
  }
}

@media(max-width:760px) {
  .sidebar {
    display: none;
  }

  .main {
    margin-left: 0;
    width: 100%;
    padding: 14px;
    padding-bottom: 85px;
  }

  .topbar {
    align-items: flex-start;
    gap: 8px;
  }

  .top-actions {
    flex-direction: column;
    align-items: flex-end;
  }

  .progress-mini {
    min-width: 90px;
  }

  .scene-grid,
  .image-grid,
  .overview-grid,
  .tools-grid,
  .stats-grid {
    grid-template-columns: 1fr;
  }

  .queue-row {
    grid-template-columns:
      42px 1fr;
  }

  .queue-row .small-btn,
  .queue-row .status {
    grid-column: 2;
    width: max-content;
  }

  .mobile-nav {
    position: fixed;
    display: flex;
    left: 10px;
    right: 10px;
    bottom: 10px;
    z-index: 30;
    justify-content: space-around;
    padding: 10px;
    border: 1px solid rgba(255,255,255,.08);
    background: rgba(9,14,27,.94);
    backdrop-filter: blur(18px);
    border-radius: 17px;
  }

  .mobile-nav a {
    color: #94a3b8;
    text-decoration: none;
    font-size: 10px;
    text-align: center;
  }

  .mobile-nav span {
    display: block;
    font-size: 17px;
    margin-bottom: 3px;
  }

  .card {
    padding: 16px;
    border-radius: 16px;
  }
}
</style>
</head>

<body>

<div class="app">

<aside class="sidebar">

  <div class="logo">
    <div class="logo-icon">🎬</div>
    <div>
      <strong>Cineflow</strong>
      <span>Studio</span>
    </div>
  </div>

  <button class="new-btn" onclick="nouveauProjet()">
    ＋ Nouveau projet
  </button>

  <div class="nav-title">
    Production
  </div>

  <nav class="nav">
    <div class="nav-item active">
      <span class="nav-number">1</span>
      Idée
    </div>

    <div class="nav-item">
      <span class="nav-number">2</span>
      Scénario
    </div>

    <div class="nav-item">
      <span class="nav-number">3</span>
      Scènes
    </div>

    <div class="nav-item">
      <span class="nav-number">4</span>
      Images
    </div>

    <div class="nav-item">
      <span class="nav-number">5</span>
      Animation
    </div>

    <div class="nav-item">
      <span class="nav-number">6</span>
      Montage
    </div>

    <div class="nav-item">
      <span class="nav-number">7</span>
      Audio
    </div>

    <div class="nav-item">
      <span class="nav-number">8</span>
      Publication
    </div>

    <div class="nav-item">
      <span class="nav-number">9</span>
      Auto-Pilote
    </div>
  </nav>

  <div class="gemini-side">
    <div style="font-size:12px;font-weight:800;">
      <span class="gemini-dot"></span>
      Gemini
    </div>
    <div id="sideGeminiText"
         style="font-size:10px;color:#64748b;margin-top:5px;">
      Vérification...
    </div>
  </div>

</aside>

<main class="main">

  <header class="topbar">
    <div>
      <div class="project-name">
        Cineflow Studio
      </div>
      <div style="font-size:11px;color:#64748b;">
        Ton espace de création assistée par intelligence artificielle
      </div>
    </div>

    <div class="top-actions">

      <div class="connection">
        <span class="gemini-dot"></span>
        Gemini connecté
      </div>

      <div class="progress-mini">
        <div style="font-size:10px;color:#64748b;">
          Progression
          <strong id="progressText"
                  style="color:#cbd5e1;">
            0%
          </strong>
        </div>
        <div class="progress-line">
          <div
            class="progress-fill"
            id="progressFill">
          </div>
        </div>
      </div>

    </div>
  </header>

  <section class="hero card">

    <div class="eyebrow">
      CINEFLOW STUDIO
    </div>

    <h1>
      Transforme une idée<br>
      en vidéo.
    </h1>

    <div class="subtitle">
      Décris simplement ton projet.
      Cineflow prépare automatiquement
      l'histoire, le scénario, les scènes
      et les visuels.
    </div>

    <textarea
      id="idea"
      placeholder="Exemple : un jeune footballeur africain veut devenir professionnel malgré les difficultés..."
    ></textarea>

    <div class="categories">

      <button
        class="category"
        onclick="choisirCategorie(this,'Film')">
        🎬 Film
      </button>

      <button
        class="category"
        onclick="choisirCategorie(this,'Animation')">
        ✨ Animation
      </button>

      <button
        class="category"
        onclick="choisirCategorie(this,'Action')">
        💥 Action
      </button>

      <button
        class="category"
        onclick="choisirCategorie(this,'Drama')">
        🎭 Drama
      </button>

      <button
        class="category"
        onclick="choisirCategorie(this,'Football')">
        ⚽ Football
      </button>

    </div>

    <button
      class="primary"
      onclick="genererProjet()">
      🚀 Créer mon projet
    </button>

  </section>

  <section
    id="projectSection"
    class="section hidden">

    <div class="section-head">
      <div>
        <div class="section-title">
          Projet généré
        </div>
        <div class="section-subtitle">
          Ton idée transformée en production.
        </div>
      </div>
    </div>

    <div class="card">

      <div class="grid overview-grid">

        <div class="metric">
          <div class="metric-label">
            TITRE
          </div>
          <div
            class="metric-value"
            id="projectTitle">
            —
          </div>
        </div>

        <div class="metric">
          <div class="metric-label">
            STYLE
          </div>
          <div
            class="metric-value"
            id="projectStyle">
            —
          </div>
        </div>

        <div class="metric">
          <div class="metric-label">
            PERSONNAGES
          </div>
          <div
            class="pills"
            id="projectCharacters">
          </div>
        </div>

        <div class="metric">
          <div class="metric-label">
            CONCEPT
          </div>
          <div
            class="metric-value"
            id="projectConcept">
            —
          </div>
        </div>

      </div>

      <div style="margin-top:15px;color:#94a3b8;font-size:13px;line-height:1.6;"
           id="projectScenario">
      </div>

      <button
        class="primary"
        style="margin-top:15px;"
        onclick="preparerScenes()">
        🧩 Préparer les 5 scènes
      </button>

    </div>

  </section>

  <section
    id="scenesSection"
    class="section hidden">

    <div class="section-head">
      <div>
        <div class="section-title">
          🎬 5 scènes
        </div>
        <div class="section-subtitle">
          Structure visuelle de ton histoire.
        </div>
      </div>
    </div>

    <div
      class="grid scene-grid"
      id="scenesContainer">
    </div>

    <div style="margin-top:14px;">
      <button
        class="primary"
        onclick="genererImages()">
        🎨 Générer les images
      </button>
    </div>

  </section>

  <section
    id="imagesSection"
    class="section hidden">

    <div class="section-head">
      <div>
        <div class="section-title">
          🖼️ Génération des images
        </div>
        <div class="section-subtitle">
          5 visuels cohérents en 16:9.
        </div>
      </div>
    </div>

    <div class="card">

      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:#94a3b8;">
          <span id="imageProgressText">
            0 / 5 images
          </span>
          <span id="imageProgressPercent">
            0%
          </span>
        </div>

        <div class="progress-line">
          <div
            id="imageProgressFill"
            class="progress-fill">
          </div>
        </div>
      </div>

      <div
        class="grid image-grid"
        id="imagesContainer">
      </div>

      <div style="margin-top:15px;">
        <button
          class="primary"
          id="animateButton"
          onclick="animerScenes()"
          disabled>
          🎞️ Animer les 5 scènes
        </button>
      </div>

    </div>

  </section>

  <section
    id="animationSection"
    class="section hidden">

    <div class="section-head">
      <div>
        <div class="section-title">
          🎞️ Animation Veo 3.1
        </div>
        <div class="section-subtitle">
          Chaque scène est traitée séparément.
        </div>
      </div>
    </div>

    <div class="card">

      <div
        class="queue"
        id="queueContainer">
      </div>

      <div style="margin-top:14px;color:#64748b;font-size:11px;">
        Une scène en erreur peut être régénérée sans recommencer les autres.
      </div>

    </div>

  </section>

  <section
    id="videoSection"
    class="section hidden">

    <div class="section-head">
      <div>
        <div class="section-title">
          🎬 Vidéo finale
        </div>
        <div class="section-subtitle">
          Assemblage des 5 scènes.
        </div>
      </div>
    </div>

    <div class="card">

      <div
        class="video-box"
        id="videoContainer">
        <div class="empty">
          La vidéo finale apparaîtra ici.
        </div>
      </div>

      <button
        class="primary"
        style="margin-top:14px;"
        onclick="creerVideo()">
        🎬 Créer ma vidéo
      </button>

    </div>

  </section>

  <section
    class="section">

    <div class="section-head">
      <div>
        <div class="section-title">
          🧰 Production
        </div>
        <div class="section-subtitle">
          Outils préparatoires de Cineflow.
        </div>
      </div>
    </div>

    <div class="grid tools-grid">

      <div class="tool">
        <div class="tool-icon">🎧</div>
        <div class="tool-title">
          Audio
        </div>
        <div class="tool-text">
          Musique adaptée à l'ambiance,
          narration et effets sonores.
        </div>
        <button
          class="small-btn"
          onclick="preparerAudio()">
          Préparer
        </button>
      </div>

      <div class="tool">
        <div class="tool-icon">🖼️</div>
        <div class="tool-title">
          Miniature
        </div>
        <div class="tool-text">
          Préparer une miniature
          adaptée à la vidéo.
        </div>
        <button
          class="small-btn"
          onclick="preparerThumbnail()">
          Préparer
        </button>
      </div>

      <div class="tool">
        <div class="tool-icon">📱</div>
        <div class="tool-title">
          Réseaux sociaux
        </div>
        <div class="tool-text">
          Préparer les textes pour
          YouTube, TikTok, Instagram et Facebook.
        </div>
        <button
          class="small-btn"
          onclick="preparerSocial()">
          Préparer
        </button>
      </div>

      <div class="tool">
        <div class="tool-icon">🤖</div>
        <div class="tool-title">
          Auto-Pilote
        </div>
        <div class="tool-text">
          Organiser automatiquement
          le futur workflow Cineflow.
        </div>
        <button
          class="small-btn"
          onclick="preparerAutoPilot()">
          Préparer
        </button>
      </div>

    </div>

  </section>

  <section class="section">

    <div class="section-head">
      <div>
        <div class="section-title">
          📊 Stats & revenus
        </div>
        <div class="section-subtitle">
          Tableau prévu pour le suivi futur.
        </div>
      </div>
    </div>

    <div class="grid stats-grid">

      <div class="metric">
        <div class="stat-number">0</div>
        <div class="stat-label">
          Vidéos publiées
        </div>
      </div>

      <div class="metric">
        <div class="stat-number">0</div>
        <div class="stat-label">
          Vues
        </div>
      </div>

      <div class="metric">
        <div class="stat-number">0</div>
        <div class="stat-label">
          Abonnés
        </div>
      </div>

      <div class="metric">
        <div class="stat-number">0 FCFA</div>
        <div class="stat-label">
          Revenus suivis
        </div>
      </div>

    </div>

  </section>

</main>

</div>

<div class="mobile-nav">
  <a href="#">
    <span>🏠</span>
    Studio
  </a>

  <a href="#scenesSection">
    <span>🎬</span>
    Scènes
  </a>

  <a href="#imagesSection">
    <span>🖼️</span>
    Images
  </a>

  <a href="#animationSection">
    <span>🎞️</span>
    Animation
  </a>

  <a href="#videoSection">
    <span>🎥</span>
    Vidéo
  </a>
</div>

<script>
let dernierProjet = null;
let derniersPrompts = [];
let dernieresImages = [];
let derniersClips = [];
let animationJobId = null;
let queueTimer = null;
let categorieChoisie = "";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setProgress(percent) {
  const safe =
    Math.max(
      0,
      Math.min(100, Number(percent) || 0)
    );

  document.getElementById(
    "progressFill"
  ).style.width = safe + "%";

  document.getElementById(
    "progressText"
  ).textContent = safe + "%";
}

function choisirCategorie(button, categorie) {
  document
    .querySelectorAll(".category")
    .forEach(btn =>
      btn.classList.remove("active")
    );

  button.classList.add("active");
  categorieChoisie = categorie;
}

function nouveauProjet() {
  dernierProjet = null;
  derniersPrompts = [];
  dernieresImages = [];
  derniersClips = [];
  animationJobId = null;

  document.getElementById(
    "idea"
  ).value = "";

  document.getElementById(
    "projectSection"
  ).classList.add("hidden");

  document.getElementById(
    "scenesSection"
  ).classList.add("hidden");

  document.getElementById(
    "imagesSection"
  ).classList.add("hidden");

  document.getElementById(
    "animationSection"
  ).classList.add("hidden");

  document.getElementById(
    "videoSection"
  ).classList.add("hidden");

  setProgress(0);

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}

async function testerGemini() {
  try {
    const response =
      await fetch("/api/test-gemini");

    const data =
      await response.json();

    const text =
      data.ok
        ? "Gemini opérationnel"
        : "Quota ou erreur Gemini";

    document.getElementById(
      "sideGeminiText"
    ).textContent = text;

  } catch (error) {
    document.getElementById(
      "sideGeminiText"
    ).textContent =
      "Connexion impossible";
  }
}

async function genererProjet() {
  const idea =
    document.getElementById(
      "idea"
    ).value.trim();

  if (!idea) {
    alert(
      "Écris d'abord ton idée de vidéo."
    );
    return;
  }

  setProgress(10);

  try {
    const response =
      await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          idea,
          category:
            categorieChoisie
        })
      });

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Erreur pendant la génération."
      );
    }

    dernierProjet =
      data.project;

    afficherProjet(
      dernierProjet
    );

    setProgress(25);

  } catch (error) {
    alert(
      error.message ||
      "Erreur Gemini."
    );
  }
}

function afficherProjet(project) {
  document.getElementById(
    "projectSection"
  ).classList.remove("hidden");

  document.getElementById(
    "projectTitle"
  ).textContent =
    project.title || "Sans titre";

  document.getElementById(
    "projectStyle"
  ).textContent =
    project.style || "Cinématographique";

  document.getElementById(
    "projectConcept"
  ).textContent =
    project.concept || "—";

  document.getElementById(
    "projectScenario"
  ).textContent =
    project.scenario || "";

  const characters =
    document.getElementById(
      "projectCharacters"
    );

  characters.innerHTML = "";

  const list =
    Array.isArray(project.characters)
      ? project.characters
      : [];

  list.forEach(character => {
    const pill =
      document.createElement("span");

    pill.className = "pill";
    pill.textContent =
      character;

    characters.appendChild(
      pill
    );
  });

  document.getElementById(
    "projectSection"
  ).scrollIntoView({
    behavior: "smooth"
  });
}

async function preparerScenes() {
  if (!dernierProjet) {
    alert(
      "Crée d'abord un projet."
    );
    return;
  }

  setProgress(32);

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
          body: JSON.stringify({
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
      data.prompts || [];

    afficherScenes(
      dernierProjet,
      derniersPrompts
    );

    setProgress(40);

  } catch (error) {
    alert(
      error.message
    );
  }
}

function afficherScenes(
  project,
  prompts
) {
  const container =
    document.getElementById(
      "scenesContainer"
    );

  container.innerHTML = "";

  const scenes =
    Array.isArray(project.scenes)
      ? project.scenes
      : [];

  for (let i = 0; i < 5; i++) {
    const scene =
      scenes[i] || {};

    const prompt =
      prompts[i] ||
      scene.description ||
      "";

    const card =
      document.createElement(
        "div"
      );

    card.className =
      "scene-card";

    card.innerHTML =
      '<div class="scene-image">🎬</div>' +
      '<div class="scene-body">' +
      '<div class="scene-number">SCÈNE ' +
      (i + 1) +
      '</div>' +
      '<div class="scene-title">' +
      escapeHtml(
        scene.title ||
        "Scène " + (i + 1)
      ) +
      '</div>' +
      '<div class="scene-description">' +
      escapeHtml(prompt) +
      '</div>' +
      '<div class="status">' +
      'Prompt prêt' +
      '</div>' +
      '</div>';

    container.appendChild(
      card
    );
  }

  document.getElementById(
    "scenesSection"
  ).classList.remove("hidden");

  document.getElementById(
    "scenesSection"
  ).scrollIntoView({
    behavior: "smooth"
  });
}

async function genererImages() {
  if (
    derniersPrompts.length !== 5
  ) {
    alert(
      "Les 5 prompts doivent être prêts."
    );
    return;
  }

  document.getElementById(
    "imagesSection"
  ).classList.remove("hidden");

  const container =
    document.getElementById(
      "imagesContainer"
    );

  container.innerHTML = "";

  for (let i = 0; i < 5; i++) {
    const card =
      document.createElement(
        "div"
      );

    card.className =
      "image-card";

    card.id =
      "image-card-" +
      (i + 1);

    card.innerHTML =
      '<div class="image-preview">' +
      '<span>⏳ Génération...</span>' +
      '</div>' +
      '<div class="image-info">' +
      '<strong>Scène ' +
      (i + 1) +
      '</strong>' +
      '<div style="font-size:10px;color:#64748b;margin-top:4px;">En attente</div>' +
      '</div>';

    container.appendChild(
      card
    );
  }

  let successCount = 0;

  for (let i = 0; i < 5; i++) {
    try {
      const response =
        await fetch(
          "/api/generate-image",
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json"
            },
            body: JSON.stringify({
              prompt:
                derniersPrompts[i],
              scene: i + 1
            })
          }
        );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
          "Erreur image."
        );
      }

      dernieresImages[i] = {
        scene: i + 1,
        mimeType:
          data.mimeType ||
          "image/jpeg",
        data: data.data
      };

      successCount++;

      afficherImage(
        i + 1,
        dernieresImages[i]
      );

    } catch (error) {
      afficherImageErreur(
        i + 1,
        error.message
      );
    }

    const percent =
      Math.round(
        ((i + 1) / 5) * 100
      );

    document.getElementById(
      "imageProgressText"
    ).textContent =
      successCount +
      " / 5 images";

    document.getElementById(
      "imageProgressPercent"
    ).textContent =
      percent + "%";

    document.getElementById(
      "imageProgressFill"
    ).style.width =
      percent + "%";
  }

  if (
    dernieresImages.filter(Boolean)
      .length === 5
  ) {
    document.getElementById(
      "animateButton"
    ).disabled = false;

    setProgress(55);
  } else {
    alert(
      "Certaines images n'ont pas pu être générées. Vérifie le quota Gemini."
    );
  }

  document.getElementById(
    "imagesSection"
  ).scrollIntoView({
    behavior: "smooth"
  });
}

function afficherImage(
  scene,
  image
) {
  const card =
    document.getElementById(
      "image-card-" +
      scene
    );

  if (!card) return;

  card.querySelector(
    ".image-preview"
  ).innerHTML =
    '<img src="data:' +
    image.mimeType +
    ';base64,' +
    image.data +
    '" alt="Scène ' +
    scene +
    '">';

  card.querySelector(
    ".image-info"
  ).innerHTML =
    '<strong>Scène ' +
    scene +
    '</strong>' +
    '<div style="font-size:10px;color:#86efac;margin-top:4px;">✓ Image prête</div>';
}

function afficherImageErreur(
  scene,
  message
) {
  const card =
    document.getElementById(
      "image-card-" +
      scene
    );

  if (!card) return;

  card.querySelector(
    ".image-preview"
  ).innerHTML =
    '<span style="color:#fca5a5;">❌ Erreur</span>';

  card.querySelector(
    ".image-info"
  ).innerHTML =
    '<strong>Scène ' +
    scene +
    '</strong>' +
    '<div style="font-size:10px;color:#fca5a5;margin-top:4px;">' +
    escapeHtml(message) +
    '</div>';
}

async function animerScenes() {
  if (
    dernieresImages.filter(Boolean)
      .length !== 5 ||
    derniersPrompts.length !== 5
  ) {
    alert(
      "Les 5 images doivent être disponibles."
    );
    return;
  }

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
          body: JSON.stringify({
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

    document.getElementById(
      "animationSection"
    ).classList.remove("hidden");

    afficherQueue(
      data.job
    );

    setProgress(65);

    demarrerSurveillanceQueue();

    document.getElementById(
      "animationSection"
    ).scrollIntoView({
      behavior: "smooth"
    });

  } catch (error) {
    alert(
      error.message
    );
  }
}

function demarrerSurveillanceQueue() {
  if (queueTimer) {
    clearInterval(queueTimer);
  }

  queueTimer =
    setInterval(
      verifierQueue,
      5000
    );

  verifierQueue();
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
        "Erreur de surveillance."
      );
    }

    afficherQueue(data);

    const completed =
      (data.scenes || [])
        .filter(
          s =>
            s.status ===
            "completed"
        ).length;

    const percent =
      65 +
      Math.round(
        (completed / 5) * 20
      );

    setProgress(percent);

    if (
      data.status ===
      "completed"
    ) {
      clearInterval(
        queueTimer
      );

      derniersClips =
        data.scenes.map(
          scene => ({
            scene:
              scene.scene,
            data:
              scene.clip
          })
        );

      setProgress(85);

      document.getElementById(
        "videoSection"
      ).classList.remove(
        "hidden"
      );
    }

  } catch (error) {
    console.error(error);
  }
}

function afficherQueue(job) {
  const container =
    document.getElementById(
      "queueContainer"
    );

  if (!job || !job.scenes) {
    container.innerHTML =
      '<div class="empty">Préparation de la file...</div>';

    return;
  }

  container.innerHTML = "";

  job.scenes.forEach(scene => {
    const row =
      document.createElement(
        "div"
      );

    row.className =
      "queue-row";

    let statusText =
      "En attente";

    if (
      scene.status ===
      "processing"
    ) {
      statusText =
        "⏳ Génération en cours...";
    }

    if (
      scene.status ===
      "completed"
    ) {
      statusText =
        "✓ Terminée";
    }

    if (
      scene.status ===
      "error"
    ) {
      statusText =
        "❌ " +
        (scene.error ||
          "Erreur");
    }

    let buttonHtml = "";

    if (
      scene.status ===
      "error"
    ) {
      buttonHtml =
        '<button class="small-btn" onclick="reprendreScene(' +
        scene.scene +
        ')">↻ Régénérer</button>';
    }

    row.innerHTML =
      '<div class="queue-scene">S' +
      scene.scene +
      '</div>' +
      '<div class="queue-status">' +
      escapeHtml(statusText) +
      '</div>' +
      '<div class="status">' +
      'Tentative ' +
      (scene.attempts || 0) +
      '</div>' +
      buttonHtml;

    container.appendChild(
      row
    );
  });
}

async function reprendreScene(
  sceneNumber
) {
  if (!animationJobId) return;

  try {
    const response =
      await fetch(
        "/api/animation-regenerate",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
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
        "Impossible de relancer la scène."
      );
    }

    afficherQueue(
      data.job
    );

    demarrerSurveillanceQueue();

  } catch (error) {
    alert(
      error.message
    );
  }
}

async function creerVideo() {
  if (
    derniersClips.length !== 5
  ) {
    alert(
      "Les 5 scènes doivent être animées."
    );
    return;
  }

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
          body: JSON.stringify({
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

    const mime =
      data.mimeType ||
      "video/mp4";

    document.getElementById(
      "videoContainer"
    ).innerHTML =
      '<video controls playsinline src="data:' +
      mime +
      ';base64,' +
      data.data +
      '"></video>';

    setProgress(100);

    alert(
      "🎬 Vidéo finale créée !"
    );

  } catch (error) {
    alert(
      error.message
    );
  }
}

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
          body: JSON.stringify({
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
        "Erreur audio."
      );
    }

    alert(
      "🎧 Plan audio préparé : " +
      data.plan.mood
    );

  } catch (error) {
    alert(
      error.message
    );
  }
}

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
          body: JSON.stringify({
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
        "Erreur miniature."
      );
    }

    alert(
      "🖼️ Plan de miniature préparé."
    );

  } catch (error) {
    alert(
      error.message
    );
  }
}

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
          body: JSON.stringify({
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
        "Erreur réseaux sociaux."
      );
    }

    alert(
      "📱 Publications préparées pour les réseaux."
    );

  } catch (error) {
    alert(
      error.message
    );
  }
}

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
          body: JSON.stringify({
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
        "Erreur Auto-Pilote."
      );
    }

    alert(
      "🤖 Plan Auto-Pilote préparé."
    );

  } catch (error) {
    alert(
      error.message
    );
  }
}

window.addEventListener(
  "load",
  () => {
    testerGemini();
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

app.get(
  "/api/test-gemini",
  async (req, res) => {
    try {
      const text =
        await generateTextInteraction(
          "Réponds uniquement par : Je confirme que Gemini est correctement connecté à Cineflow."
        );

      res.json({
        ok: true,
        message: text
      });

    } catch (error) {
      console.error(
        "TEST GEMINI:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur Gemini."
      });
    }
  }
);

/* =========================================================
   GENERATION PROJET
========================================================= */

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
          error:
            "L'idée de vidéo est obligatoire."
        });
      }

      const prompt =
        "Tu es Cineflow, un studio de création vidéo assisté par IA. " +
        "À partir de cette idée, crée un projet cinématographique complet. " +
        "Catégorie : " +
        category +
        ". " +
        "Idée : " +
        idea +
        ". " +
        "Réponds UNIQUEMENT avec un JSON valide, sans markdown, avec exactement cette structure : " +
        JSON.stringify({
          title: "",
          concept: "",
          style: "",
          characters: [],
          scenario: "",
          scenes: [
            {
              number: 1,
              title: "",
              description: ""
            },
            {
              number: 2,
              title: "",
              description: ""
            },
            {
              number: 3,
              title: "",
              description: ""
            },
            {
              number: 4,
              title: "",
              description: ""
            },
            {
              number: 5,
              title: "",
              description: ""
            }
          ],
          thumbnail: "",
          social: ""
        });

      const text =
        await generateTextInteraction(
          prompt
        );

      const cleaned =
        cleanJson(text);

      let project;

      try {
        project =
          JSON.parse(cleaned);
      } catch (error) {
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
        ok: true,
        project
      });

    } catch (error) {
      console.error(
        "GENERATE:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur pendant la génération du projet."
      });
    }
  }
);

/* =========================================================
   PREPARER IMAGES
========================================================= */

app.post(
  "/api/prepare-images",
  async (req, res) => {
    try {
      const project =
        req.body.project;

      if (!project) {
        return res.status(400).json({
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
          error:
            "Le projet doit contenir exactement 5 scènes."
        });
      }

      const prompts =
        project.scenes.map(
          (scene, index) => {
            return (
              "Créer un visuel cinématographique " +
              "pour la scène " +
              (index + 1) +
              " du projet \"" +
              (project.title || "") +
              "\". " +
              "Style : " +
              (project.style || "") +
              ". " +
              "Personnages : " +
              JSON.stringify(
                project.characters || []
              ) +
              ". " +
              "Description de la scène : " +
              (scene.description || "") +
              ". " +
              "Titre de scène : " +
              (scene.title || "") +
              ". " +
              "Image réaliste et cinématographique, " +
              "composition 16:9, lumière cohérente, " +
              "décor détaillé, profondeur de champ, " +
              "personnages cohérents entre les scènes. " +
              "Conserver les vêtements, l'apparence, " +
              "le décor et l'ambiance pour assurer la continuité."
            );
          }
        );

      res.json({
        ok: true,
        prompts
      });

    } catch (error) {
      console.error(
        "PREPARE IMAGES:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur de préparation des images."
      });
    }
  }
);

/* =========================================================
   GENERER UNE IMAGE
========================================================= */

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
          req.body.scene
        );

      if (!prompt) {
        return res.status(400).json({
          error:
            "Prompt image manquant."
        });
      }

      if (
        !Number.isInteger(scene) ||
        scene < 1 ||
        scene > 5
      ) {
        return res.status(400).json({
          error:
            "Le numéro de scène doit être compris entre 1 et 5."
        });
      }

      const image =
        await generateImage(
          prompt
        );

      res.json({
        ok: true,
        scene,
        mimeType:
          image.mimeType,
        data:
          image.data
      });

    } catch (error) {
      console.error(
        "GENERATE IMAGE:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur pendant la génération de l'image."
      });
    }
  }
);

/* =========================================================
   ANIMER UNE SCENE
========================================================= */

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

      if (!image) {
        return res.status(400).json({
          error:
            "Image manquante."
        });
      }

      const imageData =
        image.data ||
        image.image ||
        image;

      const mimeType =
        image.mimeType ||
        "image/jpeg";

      const clip =
        await generateVideoFromImage(
          imageData,
          mimeType,
          prompt
        );

      res.json({
        ok: true,
        clip
      });

    } catch (error) {
      console.error(
        "ANIMATE SCENE:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur pendant l'animation."
      });
    }
  }
);

/* =========================================================
   ANIMER LES 5 SCENES
========================================================= */

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
          error:
            "Il faut exactement 5 images."
        });
      }

      if (
        !Array.isArray(prompts) ||
        prompts.length !== 5
      ) {
        return res.status(400).json({
          error:
            "Il faut exactement 5 prompts."
        });
      }

      const job =
        createAnimationJob(
          images,
          prompts
        );

      res.json({
        ok: true,
        jobId: job.id,
        job:
          getPublicJob(job)
      });

    } catch (error) {
      console.error(
        "ANIMATE SCENES:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur de création de la file d'animation."
      });
    }
  }
);

/* =========================================================
   STATUT ANIMATION
========================================================= */

app.get(
  "/api/animation-status/:jobId",
  (req, res) => {
    try {
      const job =
        getJob(
          req.params.jobId
        );

      if (!job) {
        return res.status(404).json({
          error:
            "Job introuvable."
        });
      }

      res.json(
        getPublicJob(job)
      );

    } catch (error) {
      res.status(500).json({
        error:
          error.message ||
          "Erreur de statut."
      });
    }
  }
);

/* =========================================================
   RETRY SCENE
========================================================= */

app.post(
  "/api/animation-retry",
  async (req, res) => {
    try {
      const job =
        getJob(
          req.body.jobId
        );

      const scene =
        Number(
          req.body.scene
        );

      if (!job) {
        return res.status(404).json({
          error:
            "Job introuvable."
        });
      }

      if (
        !Number.isInteger(scene) ||
        scene < 1 ||
        scene > 5
      ) {
        return res.status(400).json({
          error:
            "Scène invalide."
        });
      }

      retryScene(
        job,
        scene
      );

      res.json({
        ok: true,
        job:
          getPublicJob(job)
      });

    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur de régénération."
      });
    }
  }
);

/* =========================================================
   REGENERER UNE SCENE
========================================================= */

app.post(
  "/api/animation-regenerate",
  async (req, res) => {
    try {
      const job =
        getJob(
          req.body.jobId
        );

      const scene =
        Number(
          req.body.scene
        );

      if (!job) {
        return res.status(404).json({
          error:
            "Job introuvable."
        });
      }

      if (
        !Number.isInteger(scene) ||
        scene < 1 ||
        scene > 5
      ) {
        return res.status(400).json({
          error:
            "Scène invalide."
        });
      }

      retryScene(
        job,
        scene
      );

      res.json({
        ok: true,
        job:
          getPublicJob(job)
      });

    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur de régénération."
      });
    }
  }
);

/* =========================================================
   CREER VIDEO FINALE
========================================================= */

app.post(
  "/api/create-video",
  async (req, res) => {
    const workDir =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "cineflow-video-"
        )
      );

    try {
      const clips =
        req.body.clips;

      if (
        !Array.isArray(clips) ||
        clips.length !== 5
      ) {
        return res.status(400).json({
          error:
            "Il faut exactement 5 clips."
        });
      }

      const files = [];

      for (let i = 0; i < 5; i++) {
        const clip =
          clips[i];

        const data =
          clip?.data ||
          clip?.clip;

        if (!data) {
          throw new Error(
            "Le clip de la scène " +
            (i + 1) +
            " est manquant."
          );
        }

        const input =
          path.join(
            workDir,
            "scene-" +
              (i + 1) +
              "-raw.mp4"
          );

        const output =
          path.join(
            workDir,
            "scene-" +
              (i + 1) +
              ".mp4"
          );

        fs.writeFileSync(
          input,
          Buffer.from(
            data,
            "base64"
          )
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
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          output
        ]);

        files.push(output);
      }

      const concatFile =
        path.join(
          workDir,
          "concat.txt"
        );

      const concatContent =
        files
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
          workDir,
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
        ok: true,
        mimeType:
          "video/mp4",
        data:
          finalBuffer.toString(
            "base64"
          )
      });

    } catch (error) {
      console.error(
        "CREATE VIDEO:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur pendant la création de la vidéo."
      });

    } finally {
      try {
        fs.rmSync(
          workDir,
          {
            recursive: true,
            force: true
          }
        );
      } catch (e) {}
    }
  }
);

/* =========================================================
   AUDIO
========================================================= */

app.post(
  "/api/prepare-audio",
  (req, res) => {
    try {
      const project =
        req.body.project;

      if (!project) {
        return res.status(400).json({
          error:
            "Projet manquant."
        });
      }

      const plan =
        buildAudioPlan(
          project
        );

      res.json({
        ok: true,
        plan
      });

    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   MINIATURE
========================================================= */

app.post(
  "/api/prepare-thumbnail",
  (req, res) => {
    try {
      const project =
        req.body.project;

      if (!project) {
        return res.status(400).json({
          error:
            "Projet manquant."
        });
      }

      const plan =
        buildThumbnailPlan(
          project
        );

      res.json({
        ok: true,
        plan
      });

    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   SOCIAL
========================================================= */

app.post(
  "/api/prepare-social",
  (req, res) => {
    try {
      const project =
        req.body.project;

      if (!project) {
        return res.status(400).json({
          error:
            "Projet manquant."
        });
      }

      const plan =
        buildSocialPlan(
          project
        );

      res.json({
        ok: true,
        plan
      });

    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   AUTO-PILOTE
========================================================= */

app.post(
  "/api/autopilot-plan",
  (req, res) => {
    try {
      const project =
        req.body.project;

      if (!project) {
        return res.status(400).json({
          error:
            "Projet manquant."
        });
      }

      const plan =
        buildAutoPilotPlan(
          project
        );

      res.json({
        ok: true,
        plan
      });

    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      error:
        "Route introuvable."
    });
  }
);

/* =========================================================
   DEMARRAGE
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      "Cineflow est lancé sur le port " +
      PORT
    );
  }
);

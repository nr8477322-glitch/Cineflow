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

const MODEL = "gemini-3.8-flash";
const IMAGE_MODEL = "gemini-3.1-flash-image";
const VIDEO_MODEL = "veo-3.1-generate-preview";
const MUSIC_MODEL = "lyria-3.5";

const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

/* =========================================================
   UTILITAIRES
========================================================= */

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

  return value;
}

function getInteractionText(interaction) {
  if (!interaction) return "";

  if (typeof interaction.text === "string") {
    return interaction.text;
  }

  if (interaction.output_text) {
    return interaction.output_text;
  }

  if (interaction.output && Array.isArray(interaction.output)) {
    for (const item of interaction.output) {
      if (typeof item.text === "string") {
        return item.text;
      }

      if (item.content && Array.isArray(item.content)) {
        for (const content of item.content) {
          if (typeof content.text === "string") {
            return content.text;
          }
        }
      }
    }
  }

  return "";
}

async function generateTextInteraction(prompt) {
  if (!ai) {
    throw new Error("GEMINI_API_KEY est absente.");
  }

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json"
    }
  });

  return cleanJson(response.text || "");
}

/* =========================================================
   GENERATION IMAGE
========================================================= */

async function generateImage(prompt) {
  if (!ai) {
    throw new Error("GEMINI_API_KEY est absente.");
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

  let imageData = null;

  if (
    interaction &&
    interaction.output &&
    Array.isArray(interaction.output)
  ) {
    for (const item of interaction.output) {
      if (item.result && item.result.data) {
        imageData = item.result.data;
        break;
      }

      if (item.data) {
        imageData = item.data;
        break;
      }

      if (item.image && item.image.data) {
        imageData = item.image.data;
        break;
      }
    }
  }

  if (!imageData && interaction.output_image) {
    imageData =
      interaction.output_image.data ||
      interaction.output_image.base64 ||
      null;
  }

  if (!imageData) {
    throw new Error("Aucune image n'a été retournée par Gemini.");
  }

  return {
    base64: imageData,
    mimeType: "image/jpeg"
  };
}

/* =========================================================
   GENERATION VIDEO VEO
========================================================= */

async function generateVideoFromImage(imageBase64, mimeType, prompt) {
  if (!ai) {
    throw new Error("GEMINI_API_KEY est absente.");
  }

  const operation = await ai.models.generateVideos({
    model: VIDEO_MODEL,
    prompt,
    image: {
      imageBytes: imageBase64,
      mimeType: mimeType || "image/jpeg"
    },
    config: {
      aspectRatio: "16:9"
    }
  });

  let currentOperation = operation;

  for (let attempt = 0; attempt < 60; attempt++) {
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
    throw new Error("La génération vidéo prend trop de temps.");
  }

  const generated =
    currentOperation.response &&
    currentOperation.response.generatedVideos &&
    currentOperation.response.generatedVideos[0];

  if (!generated || !generated.video) {
    throw new Error("Veo n'a retourné aucune vidéo.");
  }

  const videoFile = generated.video;

  const tempFile = path.join(
    os.tmpdir(),
    "cineflow-" + Date.now() + ".mp4"
  );

  await ai.files.download({
    file: videoFile,
    downloadPath: tempFile
  });

  const buffer = fs.readFileSync(tempFile);

  try {
    fs.unlinkSync(tempFile);
  } catch (_) {}

  return {
    base64: buffer.toString("base64"),
    mimeType: "video/mp4"
  };
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
          const message =
            stderr ||
            error.message ||
            "Erreur FFmpeg inconnue.";

          reject(new Error(message));
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
   MUSIQUE CINEFLOW — LYRIA 3.5
========================================================= */

function detectMood(project) {
  const text = (
    (project && project.style ? project.style : "") +
    " " +
    (project && project.concept ? project.concept : "") +
    " " +
    (project && project.title ? project.title : "")
  ).toLowerCase();

  if (
    text.includes("action") ||
    text.includes("football") ||
    text.includes("combat") ||
    text.includes("aventure")
  ) {
    return "action";
  }

  if (
    text.includes("drame") ||
    text.includes("drama") ||
    text.includes("triste") ||
    text.includes("émotion")
  ) {
    return "drama";
  }

  if (
    text.includes("suspense") ||
    text.includes("mystère") ||
    text.includes("thriller")
  ) {
    return "suspense";
  }

  if (
    text.includes("animation") ||
    text.includes("enfant") ||
    text.includes("comédie")
  ) {
    return "animation";
  }

  return "cinematic";
}

function buildAudioPlan(project) {
  const mood = detectMood(project);

  const descriptions = {
    action:
      "musique cinématique énergique, percussions puissantes, tension et montée héroïque",
    drama:
      "musique cinématique émotionnelle, piano doux, cordes et ambiance profonde",
    football:
      "musique sportive cinématique, énergie, percussions, montée motivante et héroïque",
    suspense:
      "musique cinématique mystérieuse, tension progressive, basses profondes et atmosphère inquiétante",
    animation:
      "musique joyeuse, légère, aventureuse et cinématique",
    cinematic:
      "musique cinématique moderne, émotionnelle et immersive"
  };

  return {
    mood,
    musicDescription:
      descriptions[mood] || descriptions.cinematic,
    voice: {
      enabled: true,
      language: "fr-FR",
      tone: "cinématographique"
    },
    soundEffects: true
  };
}

/* =========================================================
   FALLBACK MUSIQUE FFMPEG
========================================================= */

async function generateFallbackAudio(
  mood,
  duration,
  outputFile
) {
  const frequencies = {
    action: [110, 165, 220],
    drama: [220, 277, 330],
    football: [130, 196, 260],
    suspense: [82, 110, 146],
    animation: [262, 330, 392],
    cinematic: [196, 247, 294]
  };

  const freq =
    frequencies[mood] || frequencies.cinematic;

  const safeDuration = Math.max(
    5,
    Number(duration) || 120
  );

  const input1 =
    "sine=frequency=" +
    freq[0] +
    ":duration=" +
    safeDuration;

  const input2 =
    "sine=frequency=" +
    freq[1] +
    ":duration=" +
    safeDuration;

  const input3 =
    "sine=frequency=" +
    freq[2] +
    ":duration=" +
    safeDuration;

  await runFFmpeg([
    "-y",

    "-f",
    "lavfi",
    "-i",
    input1,

    "-f",
    "lavfi",
    "-i",
    input2,

    "-f",
    "lavfi",
    "-i",
    input3,

    "-filter_complex",
    "[0:a]volume=0.20[a0];" +
      "[1:a]volume=0.12[a1];" +
      "[2:a]volume=0.08[a2];" +
      "[a0][a1][a2]" +
      "amix=inputs=3:duration=longest," +
      "afade=t=in:st=0:d=2," +
      "afade=t=out:st=" +
      Math.max(2, safeDuration - 3) +
      ":d=3",

    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-ac",
    "2",

    outputFile
  ]);
}

/* =========================================================
   LYRIA 3.5 + FALLBACK
========================================================= */

async function generateAudioTrack(
  mood,
  duration,
  outputFile,
  project
) {
  const safeDuration = Math.max(
    10,
    Number(duration) || 120
  );

  const title =
    project && project.title
      ? project.title
      : "Cineflow";

  const concept =
    project && project.concept
      ? project.concept
      : "";

  const style =
    project && project.style
      ? project.style
      : "";

  const musicDescriptions = {
    action:
      "energetic cinematic action music with powerful percussion, driving rhythm, heroic progression and strong impact",
    drama:
      "emotional cinematic music with expressive piano, warm strings, deep atmosphere and a touching progression",
    football:
      "epic cinematic sports music with energetic percussion, motivational rhythm, heroic build-up and stadium energy",
    suspense:
      "dark cinematic suspense music with deep bass, subtle pulses, mysterious atmosphere and gradual tension",
    animation:
      "playful cinematic animation music with joyful melody, light percussion, adventure feeling and uplifting energy",
    cinematic:
      "modern cinematic instrumental music with emotional melody, atmospheric textures and a strong film-score feeling"
  };

  const description =
    musicDescriptions[mood] ||
    musicDescriptions.cinematic;

  const musicPrompt =
    "Create an instrumental cinematic soundtrack for a video project. " +
    "Do not use vocals or lyrics. " +
    "The soundtrack should naturally support the story and remain suitable under dialogue. " +
    "Project title: " +
    title +
    ". " +
    "Story concept: " +
    concept +
    ". " +
    "Visual style: " +
    style +
    ". " +
    "Mood: " +
    mood +
    ". " +
    "Music direction: " +
    description +
    ". " +
    "Make it coherent, immersive and professional.";

  const lyriaMp3 =
    path.join(
      os.tmpdir(),
      "cineflow-lyria-" +
        Date.now() +
        "-" +
        Math.random()
          .toString(36)
          .slice(2) +
        ".mp3"
    );

  try {
    if (!ai) {
      throw new Error("Gemini non connecté.");
    }

    console.log(
      "🎵 Génération de la musique avec Lyria 3.5..."
    );

    const interaction =
      await ai.interactions.create({
        model: MUSIC_MODEL,
        input: musicPrompt,
        response_format: {
          type: "audio"
        }
      });

    const audioData =
      interaction &&
      interaction.output_audio &&
      interaction.output_audio.data;

    if (!audioData) {
      throw new Error(
        "Lyria 3.5 n'a retourné aucune donnée audio."
      );
    }

    fs.writeFileSync(
      lyriaMp3,
      Buffer.from(audioData, "base64")
    );

    console.log(
      "✅ Musique Lyria 3.5 reçue."
    );

    await runFFmpeg([
      "-y",

      "-stream_loop",
      "-1",

      "-i",
      lyriaMp3,

      "-t",
      String(safeDuration),

      "-af",
      "afade=t=in:st=0:d=2," +
        "afade=t=out:st=" +
        Math.max(2, safeDuration - 4) +
        ":d=4",

      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-ac",
      "2",

      outputFile
    ]);

    try {
      fs.unlinkSync(lyriaMp3);
    } catch (_) {}

    return {
      provider: "Lyria 3.5",
      mood,
      duration: safeDuration
    };
  } catch (error) {
    console.error(
      "⚠️ Lyria 3.5 indisponible :",
      error.message
    );

    console.log(
      "🎵 Utilisation du générateur musical de secours..."
    );

    try {
      if (fs.existsSync(lyriaMp3)) {
        fs.unlinkSync(lyriaMp3);
      }
    } catch (_) {}

    await generateFallbackAudio(
      mood,
      safeDuration,
      outputFile
    );

    return {
      provider: "FFmpeg fallback",
      mood,
      duration: safeDuration
    };
  }
}

/* =========================================================
   THUMBNAIL / SOCIAL / AUTOPILOTE
========================================================= */

function buildThumbnailPlan(project) {
  return {
    title:
      project && project.title
        ? project.title
        : "Cineflow",
    format: "16:9",
    description:
      "Miniature cinématique avec le personnage principal et un élément visuel fort."
  };
}

function buildSocialPlan(project) {
  const title =
    project && project.title
      ? project.title
      : "Ma vidéo Cineflow";

  return {
    platforms: [
      "YouTube",
      "TikTok",
      "Instagram",
      "Facebook"
    ],
    title,
    caption:
      "Une nouvelle création réalisée avec Cineflow.",
    hashtags: [
      "#Cineflow",
      "#VideoAI",
      "#CreationVideo"
    ]
  };
}

function buildAutoPilotPlan(project) {
  return {
    enabled: true,
    steps: [
      "Créer le projet",
      "Préparer les scènes",
      "Générer les images",
      "Animer les scènes",
      "Assembler la vidéo",
      "Préparer la musique",
      "Préparer la miniature",
      "Préparer les publications",
      "Préparer les statistiques"
    ]
  };
}

/* =========================================================
   FILES VIDEO
========================================================= */

const finalVideoFiles = new Map();

function createVideoFileId() {
  return (
    "cineflow-" +
    Date.now() +
    "-" +
    Math.random()
      .toString(36)
      .slice(2, 10)
  );
}

setInterval(() => {
  const now = Date.now();

  for (const [id, item] of finalVideoFiles.entries()) {
    if (
      !item ||
      now - item.createdAt > 30 * 60 * 1000
    ) {
      try {
        if (
          item &&
          item.file &&
          fs.existsSync(item.file)
        ) {
          fs.unlinkSync(item.file);
        }
      } catch (_) {}

      finalVideoFiles.delete(id);
    }
  }
}, 5 * 60 * 1000);

/* =========================================================
   ANIMATION QUEUE
========================================================= */

const animationQueue = [];
let animationRunning = false;
let animationJobId = null;

function createJobId() {
  return (
    "job-" +
    Date.now() +
    "-" +
    Math.random()
      .toString(36)
      .slice(2, 8)
  );
}

function createAnimationJob(scenes) {
  const job = {
    id: createJobId(),
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    scenes: scenes.map((scene, index) => ({
      index,
      prompt: scene.prompt || "",
      imageBase64: scene.imageBase64 || "",
      mimeType:
        scene.mimeType || "image/jpeg",
      status: "queued",
      attempts: 0,
      videoBase64: null,
      error: null
    }))
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
  scene
) {
  scene.status = "processing";
  scene.attempts += 1;
  scene.error = null;

  job.updatedAt = Date.now();

  try {
    if (!scene.imageBase64) {
      throw new Error(
        "Image absente pour cette scène."
      );
    }

    const result =
      await generateVideoFromImage(
        scene.imageBase64,
        scene.mimeType,
        scene.prompt
      );

    scene.videoBase64 = result.base64;
    scene.status = "done";
  } catch (error) {
    scene.status = "error";
    scene.error = error.message;
  }

  job.updatedAt = Date.now();
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
            item.status === "processing"
        );

      if (!job) break;

      animationJobId = job.id;
      job.status = "running";
      job.updatedAt = Date.now();

      for (const scene of job.scenes) {
        if (scene.status === "done") {
          continue;
        }

        await processOneAnimationScene(
          job,
          scene
        );
      }

      const hasErrors =
        job.scenes.some(
          scene => scene.status === "error"
        );

      job.status = hasErrors
        ? "completed_with_errors"
        : "completed";

      job.updatedAt = Date.now();
    }
  } finally {
    animationRunning = false;
    animationJobId = null;
  }
}

function retryScene(jobId, sceneIndex) {
  const job = getJob(jobId);

  if (!job) {
    throw new Error("Job introuvable.");
  }

  const scene =
    job.scenes[Number(sceneIndex)];

  if (!scene) {
    throw new Error("Scène introuvable.");
  }

  scene.status = "queued";
  scene.error = null;

  job.status = "queued";
  job.updatedAt = Date.now();

  processAnimationQueue();

  return job;
}

function getPublicJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    scenes: job.scenes.map(scene => ({
      index: scene.index,
      status: scene.status,
      attempts: scene.attempts,
      error: scene.error,
      hasVideo: Boolean(
        scene.videoBase64
      )
    }))
  };
}

/* =========================================================
   PAGE CINEFLOW
========================================================= */

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1.0">

<title>Cineflow Studio</title>

<style>
*{
  box-sizing:border-box;
}

body{
  margin:0;
  font-family:Arial,Helvetica,sans-serif;
  background:#080b14;
  color:#f5f7ff;
}

button,
textarea,
input{
  font:inherit;
}

button{
  cursor:pointer;
}

.app{
  min-height:100vh;
  display:flex;
}

.sidebar{
  width:250px;
  min-height:100vh;
  padding:22px 16px;
  border-right:1px solid #202638;
  background:#0c101c;
  position:fixed;
  left:0;
  top:0;
  bottom:0;
}

.logo{
  font-size:24px;
  font-weight:800;
  margin-bottom:8px;
}

.tagline{
  color:#8d96aa;
  font-size:12px;
  line-height:1.4;
  margin-bottom:25px;
}

.new-project{
  width:100%;
  padding:13px;
  border:0;
  border-radius:12px;
  background:linear-gradient(135deg,#7c5cff,#5c8cff);
  color:white;
  font-weight:700;
  margin-bottom:20px;
}

.nav{
  display:flex;
  flex-direction:column;
  gap:7px;
}

.nav-item{
  padding:11px 12px;
  border-radius:10px;
  color:#8992a8;
  font-size:14px;
}

.nav-item.active{
  background:#171d2d;
  color:white;
}

.main{
  width:calc(100% - 250px);
  margin-left:250px;
  padding:22px;
}

.topbar{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:15px;
  margin-bottom:22px;
}

.project-name{
  font-size:14px;
  color:#9ca5b9;
}

.connection{
  display:flex;
  align-items:center;
  gap:8px;
  color:#69e6a5;
  font-size:13px;
}

.dot{
  width:8px;
  height:8px;
  border-radius:50%;
  background:#4de49a;
}

.progress{
  font-weight:700;
}

.hero{
  padding:28px;
  border:1px solid #252c3d;
  border-radius:22px;
  background:
    radial-gradient(circle at top right,#1c2650,transparent 45%),
    #101522;
  margin-bottom:20px;
}

.hero h1{
  margin:0 0 10px;
  font-size:32px;
}

.hero p{
  color:#969fb3;
  margin-bottom:20px;
}

textarea{
  width:100%;
  min-height:130px;
  resize:vertical;
  background:#090d17;
  color:white;
  border:1px solid #293147;
  border-radius:14px;
  padding:15px;
  outline:none;
}

textarea:focus{
  border-color:#667cff;
}

.chips{
  display:flex;
  flex-wrap:wrap;
  gap:8px;
  margin:14px 0;
}

.chip{
  border:1px solid #2b3449;
  background:#111725;
  color:#cbd1df;
  padding:8px 12px;
  border-radius:999px;
}

.chip.active{
  border-color:#6979ff;
  background:#202a55;
  color:white;
}

.primary{
  border:0;
  padding:13px 18px;
  border-radius:12px;
  background:linear-gradient(135deg,#755bff,#4e8dff);
  color:white;
  font-weight:700;
}

.secondary{
  border:1px solid #30394e;
  padding:12px 16px;
  border-radius:12px;
  background:#121827;
  color:white;
}

.section{
  display:none;
  margin-bottom:20px;
}

.section.visible{
  display:block;
}

.card{
  background:#101521;
  border:1px solid #252c3d;
  border-radius:18px;
  padding:20px;
}

.card h2{
  margin-top:0;
}

.info-grid{
  display:grid;
  grid-template-columns:repeat(2,1fr);
  gap:12px;
}

.info{
  background:#0b101a;
  padding:14px;
  border-radius:12px;
}

.label{
  color:#7e879b;
  font-size:12px;
  margin-bottom:5px;
}

.value{
  font-weight:600;
}

.scene-grid{
  display:grid;
  grid-template-columns:repeat(5,1fr);
  gap:12px;
}

.scene{
  background:#0b101a;
  border:1px solid #252d40;
  border-radius:14px;
  overflow:hidden;
}

.scene-image{
  width:100%;
  aspect-ratio:16/9;
  background:#151b29;
  display:flex;
  align-items:center;
  justify-content:center;
  color:#677087;
  font-size:12px;
}

.scene-image img{
  width:100%;
  height:100%;
  object-fit:cover;
}

.scene-body{
  padding:12px;
}

.scene-number{
  font-size:12px;
  color:#8790a5;
}

.scene-prompt{
  font-size:12px;
  color:#b9c0cf;
  margin-top:6px;
  line-height:1.4;
}

.status{
  margin-top:9px;
  font-size:12px;
  color:#7edda7;
}

.tool-grid{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:12px;
}

.tool{
  background:#101521;
  border:1px solid #252c3d;
  border-radius:16px;
  padding:16px;
}

.tool h3{
  margin-top:0;
}

.tool p{
  color:#838da1;
  font-size:13px;
  line-height:1.4;
}

.actions{
  display:flex;
  flex-wrap:wrap;
  gap:10px;
  margin-top:16px;
}

.video-box video{
  width:100%;
  border-radius:14px;
  background:black;
}

.bottom-nav{
  display:none;
}

.small{
  color:#7f899e;
  font-size:12px;
}

.error{
  color:#ff7e8b;
}

.success{
  color:#69e6a5;
}

@media(max-width:900px){
  .sidebar{
    display:none;
  }

  .main{
    width:100%;
    margin-left:0;
    padding:15px;
    padding-bottom:80px;
  }

  .scene-grid{
    grid-template-columns:repeat(2,1fr);
  }

  .tool-grid{
    grid-template-columns:repeat(2,1fr);
  }

  .bottom-nav{
    display:flex;
    position:fixed;
    bottom:0;
    left:0;
    right:0;
    height:62px;
    background:#0d111c;
    border-top:1px solid #252c3d;
    z-index:10;
    justify-content:space-around;
    align-items:center;
  }

  .bottom-nav div{
    color:#8891a5;
    font-size:11px;
    text-align:center;
  }

  .hero h1{
    font-size:25px;
  }
}

@media(max-width:550px){
  .scene-grid,
  .tool-grid,
  .info-grid{
    grid-template-columns:1fr;
  }

  .topbar{
    align-items:flex-start;
    flex-direction:column;
  }
}
</style>
</head>

<body>

<div class="app">

<aside class="sidebar">

  <div class="logo">🎬 Cineflow</div>

  <div class="tagline">
    Ton espace de création assistée par intelligence artificielle
  </div>

  <button
    class="new-project"
    onclick="window.scrollTo({top:0,behavior:'smooth'})">
    ＋ Nouveau projet
  </button>

  <div class="nav">
    <div class="nav-item active">💡 Idée</div>
    <div class="nav-item">📖 Scénario</div>
    <div class="nav-item">🧩 Scènes</div>
    <div class="nav-item">🖼️ Images</div>
    <div class="nav-item">🎞️ Animation</div>
    <div class="nav-item">🎬 Montage</div>
    <div class="nav-item">🎧 Audio</div>
    <div class="nav-item">📱 Publication</div>
    <div class="nav-item">🤖 Auto-Pilote</div>
  </div>

</aside>

<main class="main">

<div class="topbar">

  <div>
    <div class="project-name">
      Cineflow Studio
    </div>
  </div>

  <div class="connection">
    <span class="dot"></span>
    Gemini connecté
    <span class="progress" id="progressText">
      0%
    </span>
  </div>

</div>

<section class="hero">

  <h1>Transforme une idée en vidéo.</h1>

  <p>
    Décris ton idée et Cineflow prépare automatiquement
    ton projet vidéo.
  </p>

  <textarea
    id="idea"
    placeholder="Exemple : un jeune footballeur africain veut devenir professionnel malgré les difficultés..."></textarea>

  <div class="chips">

    <button class="chip" onclick="selectCategory(this,'Film')">
      🎬 Film
    </button>

    <button class="chip" onclick="selectCategory(this,'Animation')">
      ✨ Animation
    </button>

    <button class="chip" onclick="selectCategory(this,'Action')">
      ⚡ Action
    </button>

    <button class="chip" onclick="selectCategory(this,'Drama')">
      🎭 Drama
    </button>

    <button class="chip" onclick="selectCategory(this,'Football')">
      ⚽ Football
    </button>

  </div>

  <button
    class="primary"
    id="generateProjectButton"
    onclick="genererProjet()">
    🚀 Créer mon projet
  </button>

  <div
    id="projectMessage"
    class="small"
    style="margin-top:12px;">
  </div>

</section>

<section
  id="projectSection"
  class="section">

  <div class="card">

    <h2>📖 Projet généré</h2>

    <div class="info-grid">

      <div class="info">
        <div class="label">Titre</div>
        <div class="value" id="projectTitle">
          —
        </div>
      </div>

      <div class="info">
        <div class="label">Style</div>
        <div class="value" id="projectStyle">
          —
        </div>
      </div>

      <div class="info">
        <div class="label">Concept</div>
        <div class="value" id="projectConcept">
          —
        </div>
      </div>

      <div class="info">
        <div class="label">Personnages</div>
        <div class="value" id="projectCharacters">
          —
        </div>
      </div>

    </div>

    <div class="actions">

      <button
        class="primary"
        onclick="preparerScenes()">
        🧩 Préparer les 5 scènes
      </button>

    </div>

    <div
      id="sceneMessage"
      class="small"
      style="margin-top:10px;">
    </div>

  </div>

</section>

<section
  id="scenesSection"
  class="section">

  <div class="card">

    <h2>🧩 5 scènes</h2>

    <div
      id="sceneGrid"
      class="scene-grid">
    </div>

    <div class="actions">

      <button
        class="primary"
        onclick="genererImages()">
        🎨 Générer les images
      </button>

    </div>

    <div
      id="imageMessage"
      class="small"
      style="margin-top:10px;">
    </div>

  </div>

</section>

<section
  id="imagesSection"
  class="section">

  <div class="card">

    <h2>🖼️ Génération des images</h2>

    <p class="small">
      Cineflow génère les images des 5 scènes
      et conserve celles déjà terminées.
    </p>

    <div
      id="imageProgress"
      class="small">
      0 / 5
    </div>

    <div
      id="imageGrid"
      class="scene-grid"
      style="margin-top:14px;">
    </div>

    <div class="actions">

      <button
        class="secondary"
        onclick="genererImages()">
        🔄 Reprendre les images
      </button>

      <button
        id="animateButton"
        class="primary"
        onclick="animerScenes()"
        disabled>
        🎞️ Animer les 5 scènes
      </button>

    </div>

  </div>

</section>

<section
  id="animationSection"
  class="section">

  <div class="card">

    <h2>🎞️ Animation Veo 3.1</h2>

    <div
      id="animationStatus"
      class="small">
      En attente...
    </div>

    <div
      id="animationGrid"
      class="scene-grid"
      style="margin-top:14px;">
    </div>

    <div class="actions">

      <button
        class="secondary"
        onclick="animerScenes()">
        🔄 Reprendre l'animation
      </button>

      <button
        id="createVideoButton"
        class="primary"
        onclick="creerVideo()"
        disabled>
        🎬 Créer ma vidéo
      </button>

    </div>

  </div>

</section>

<section
  id="videoSection"
  class="section">

  <div class="card">

    <h2>🎬 Vidéo finale</h2>

    <div
      id="videoContainer"
      class="video-box">
    </div>

    <div
      id="videoMessage"
      class="small"
      style="margin-top:12px;">
    </div>

  </div>

</section>

<section
  id="productionSection"
  class="section visible">

  <div class="card">

    <h2>🛠️ Production Cineflow</h2>

    <div class="tool-grid">

      <div class="tool">
        <h3>🎧 Audio</h3>
        <p>
          Musique adaptée automatiquement
          à l'histoire avec Lyria 3.5.
        </p>
        <button
          class="secondary"
          onclick="preparerAudio()">
          Préparer l'audio
        </button>
      </div>

      <div class="tool">
        <h3>🖼️ Miniature</h3>
        <p>
          Préparation de la miniature
          de la vidéo.
        </p>
        <button
          class="secondary"
          onclick="preparerThumbnail()">
          Préparer
        </button>
      </div>

      <div class="tool">
        <h3>📱 Réseaux sociaux</h3>
        <p>
          Préparation des textes et hashtags
          pour les plateformes.
        </p>
        <button
          class="secondary"
          onclick="preparerSocial()">
          Préparer
        </button>
      </div>

      <div class="tool">
        <h3>🤖 Auto-Pilote</h3>
        <p>
          Prépare les étapes automatiques
          de production.
        </p>
        <button
          class="secondary"
          onclick="preparerAutopilot()">
          Préparer
        </button>
      </div>

    </div>

    <div
      id="productionMessage"
      class="small"
      style="margin-top:15px;">
    </div>

  </div>

</section>

</main>

</div>

<div class="bottom-nav">
  <div>🎬<br>Studio</div>
  <div>🧩<br>Scènes</div>
  <div>🖼️<br>Images</div>
  <div>🎞️<br>Animation</div>
  <div>🎬<br>Vidéo</div>
</div>

<script>

let selectedCategory = "Film";
let currentProject = null;
let currentScenes = [];
let currentImages = [];
let currentClips = [];
let currentJobId = null;

function selectCategory(button, category) {
  document
    .querySelectorAll(".chip")
    .forEach(function(item) {
      item.classList.remove("active");
    });

  button.classList.add("active");
  selectedCategory = category;
}

function showSection(id) {
  var element = document.getElementById(id);

  if (element) {
    element.classList.add("visible");

    setTimeout(function() {
      element.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    }, 100);
  }
}

function setProgress(value) {
  document.getElementById(
    "progressText"
  ).textContent = value + "%";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function genererProjet() {

  var idea =
    document.getElementById("idea").value.trim();

  var message =
    document.getElementById("projectMessage");

  if (!idea) {
    message.innerHTML =
      '<span class="error">Écris ton idée de vidéo.</span>';
    return;
  }

  var button =
    document.getElementById(
      "generateProjectButton"
    );

  button.disabled = true;
  button.textContent = "⏳ Génération...";

  message.textContent =
    "Cineflow prépare ton projet...";

  try {

    var response =
      await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          idea: idea,
          category: selectedCategory
        })
      });

    var data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Erreur de génération."
      );
    }

    currentProject = data.project;

    document.getElementById(
      "projectTitle"
    ).textContent =
      currentProject.title || "Sans titre";

    document.getElementById(
      "projectStyle"
    ).textContent =
      currentProject.style || selectedCategory;

    document.getElementById(
      "projectConcept"
    ).textContent =
      currentProject.concept || idea;

    document.getElementById(
      "projectCharacters"
    ).textContent =
      Array.isArray(
        currentProject.characters
      )
        ? currentProject.characters.join(", ")
        : (
          currentProject.characters ||
          "À définir"
        );

    showSection("projectSection");

    setProgress(15);

    message.innerHTML =
      '<span class="success">Projet généré avec succès.</span>';

  } catch (error) {

    message.innerHTML =
      '<span class="error">' +
      escapeHtml(error.message) +
      "</span>";

  } finally {

    button.disabled = false;
    button.textContent =
      "🚀 Créer mon projet";
  }
}

async function preparerScenes() {

  if (!currentProject) {
    return;
  }

  var message =
    document.getElementById(
      "sceneMessage"
    );

  message.textContent =
    "Préparation des 5 scènes...";

  try {

    var response =
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
              currentProject,
            prepareOnly: true
          })
        }
      );

    var data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Impossible de préparer les scènes."
      );
    }

    currentScenes =
      data.scenes || [];

    afficherScenes();

    showSection("scenesSection");

    setProgress(30);

    message.innerHTML =
      '<span class="success">Les 5 scènes sont prêtes.</span>';

  } catch (error) {

    message.innerHTML =
      '<span class="error">' +
      escapeHtml(error.message) +
      "</span>";
  }
}

function afficherScenes() {

  var grid =
    document.getElementById(
      "sceneGrid"
    );

  grid.innerHTML = "";

  currentScenes.forEach(
    function(scene, index) {

      var card =
        document.createElement("div");

      card.className = "scene";

      card.innerHTML =
        '<div class="scene-image">' +
        "Scène " +
        (index + 1) +
        "</div>" +

        '<div class="scene-body">' +
        '<div class="scene-number">' +
        "SCÈNE " +
        (index + 1) +
        "</div>" +

        '<div class="scene-prompt">' +
        escapeHtml(
          scene.prompt || ""
        ) +
        "</div>" +

        '<div class="status">⏳ Image en attente</div>' +
        "</div>";

      grid.appendChild(card);
    }
  );
}

async function genererImages() {

  if (!currentScenes.length) {
    await preparerScenes();

    if (!currentScenes.length) {
      return;
    }
  }

  showSection("imagesSection");

  var grid =
    document.getElementById(
      "imageGrid"
    );

  grid.innerHTML = "";

  currentImages =
    new Array(currentScenes.length);

  for (
    var i = 0;
    i < currentScenes.length;
    i++
  ) {

    var scene =
      currentScenes[i];

    var card =
      document.createElement("div");

    card.className = "scene";

    card.innerHTML =
      '<div class="scene-image" id="image-' +
      i +
      '">' +
      "⏳ Génération..." +
      "</div>" +

      '<div class="scene-body">' +
      '<div class="scene-number">SCÈNE ' +
      (i + 1) +
      "</div>" +

      '<div class="scene-prompt">' +
      escapeHtml(
        scene.prompt || ""
      ) +
      "</div>" +

      '<div class="status" id="image-status-' +
      i +
      '">' +
      "⏳ En cours..." +
      "</div>" +

      "</div>";

    grid.appendChild(card);
  }

  var message =
    document.getElementById(
      "imageMessage"
    );

  var completed = 0;

  for (
    var i = 0;
    i < currentScenes.length;
    i++
  ) {

    var scene =
      currentScenes[i];

    if (
      scene.imageBase64 ||
      scene.image
    ) {

      currentImages[i] = {
        base64:
          scene.imageBase64 ||
          scene.image,
        mimeType:
          scene.mimeType ||
          "image/jpeg"
      };

      afficherImage(
        i,
        currentImages[i]
      );

      completed++;
      continue;
    }

    try {

      message.textContent =
        "Génération de l'image " +
        (i + 1) +
        "/5...";

      var response =
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
                scene.prompt,
              sceneIndex: i,
              project:
                currentProject
            })
          }
        );

      var data =
        await response.json();

      if (!response.ok) {

        if (
          response.status === 429
        ) {
          throw new Error(
            data.error ||
            "Quota Gemini atteint."
          );
        }

        throw new Error(
          data.error ||
          "Erreur image."
        );
      }

      currentImages[i] = {
        base64:
          data.imageBase64,
        mimeType:
          data.mimeType ||
          "image/jpeg"
      };

      currentScenes[i].imageBase64 =
        data.imageBase64;

      currentScenes[i].mimeType =
        data.mimeType ||
        "image/jpeg";

      afficherImage(
        i,
        currentImages[i]
      );

      completed++;

    } catch (error) {

      document.getElementById(
        "image-status-" + i
      ).innerHTML =
        '<span class="error">❌ ' +
        escapeHtml(
          error.message
        ) +
        "</span>";

      message.innerHTML =
        '<span class="error">' +
        escapeHtml(
          error.message
        ) +
        "</span>";

      break;
    }

    document.getElementById(
      "imageProgress"
    ).textContent =
      completed + " / " +
      currentScenes.length;
  }

  document.getElementById(
    "imageProgress"
  ).textContent =
    completed + " / " +
    currentScenes.length;

  if (
    completed ===
    currentScenes.length
  ) {

    message.innerHTML =
      '<span class="success">✅ Les 5 images sont prêtes.</span>';

    document.getElementById(
      "animateButton"
    ).disabled = false;

    setProgress(50);
  }
}

function afficherImage(
  index,
  image
) {

  var box =
    document.getElementById(
      "image-" + index
    );

  var status =
    document.getElementById(
      "image-status-" + index
    );

  if (!box || !image) {
    return;
  }

  box.innerHTML =
    '<img src="data:' +
    (image.mimeType ||
      "image/jpeg") +
    ";base64," +
    image.base64 +
    '" alt="Scène ' +
    (index + 1) +
    '">';

  if (status) {
    status.innerHTML =
      '<span class="success">✅ Image prête</span>';
  }
}

async function animerScenes() {

  var validImages =
    currentImages.filter(
      function(item) {
        return item &&
          item.base64;
      }
    );

  if (
    validImages.length !==
    currentScenes.length
  ) {
    alert(
      "Les 5 images doivent être prêtes."
    );
    return;
  }

  showSection(
    "animationSection"
  );

  var grid =
    document.getElementById(
      "animationGrid"
    );

  grid.innerHTML = "";

  for (
    var i = 0;
    i < currentScenes.length;
    i++
  ) {

    var card =
      document.createElement("div");

    card.className = "scene";

    card.innerHTML =
      '<div class="scene-image">' +
      "🎞️ Scène " +
      (i + 1) +
      "</div>" +

      '<div class="scene-body">' +
      '<div class="scene-number">SCÈNE ' +
      (i + 1) +
      "</div>" +

      '<div class="status" id="animation-status-' +
      i +
      '">' +
      "⏳ En attente..." +
      "</div>" +

      "</div>";

    grid.appendChild(card);
  }

  var status =
    document.getElementById(
      "animationStatus"
    );

  status.textContent =
    "Création de la file d'animation...";

  try {

    var scenes =
      currentScenes.map(
        function(scene, index) {

          return {
            index: index,
            prompt:
              scene.prompt || "",
            imageBase64:
              currentImages[index].base64,
            mimeType:
              currentImages[index].mimeType ||
              "image/jpeg"
          };
        }
      );

    var response =
      await fetch(
        "/api/animate-scenes",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            scenes: scenes,
            project:
              currentProject
          })
        }
      );

    var data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Impossible de lancer l'animation."
      );
    }

    currentJobId =
      data.jobId;

    status.textContent =
      "Animation en cours...";

    pollAnimation();

  } catch (error) {

    status.innerHTML =
      '<span class="error">' +
      escapeHtml(
        error.message
      ) +
      "</span>";
  }
}

async function pollAnimation() {

  if (!currentJobId) {
    return;
  }

  try {

    var response =
      await fetch(
        "/api/animation-status/" +
        encodeURIComponent(
          currentJobId
        )
      );

    var data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Erreur de suivi."
      );
    }

    data.scenes.forEach(
      function(scene) {

        var status =
          document.getElementById(
            "animation-status-" +
            scene.index
          );

        if (!status) {
          return;
        }

        if (
          scene.status === "done"
        ) {
          status.innerHTML =
            '<span class="success">✅ Animation terminée</span>';
        } else if (
          scene.status === "processing"
        ) {
          status.textContent =
            "🎞️ Animation en cours...";
        } else if (
          scene.status === "error"
        ) {
          status.innerHTML =
            '<span class="error">❌ ' +
            escapeHtml(
              scene.error ||
              "Erreur"
            ) +
            "</span>";
        } else {
          status.textContent =
            "⏳ En attente...";
        }
      }
    );

    var done =
      data.scenes.filter(
        function(scene) {
          return scene.status === "done";
        }
      ).length;

    document.getElementById(
      "animationStatus"
    ).textContent =
      done +
      " / " +
      data.scenes.length +
      " scènes animées";

    if (
      data.status === "completed"
    ) {

      currentClips = [];

      for (
        var i = 0;
        i < data.scenes.length;
        i++
      ) {

        var clipResponse =
          await fetch(
            "/api/animation-scene/" +
            encodeURIComponent(
              currentJobId
            ) +
            "/" +
            i
          );

        if (
          clipResponse.ok
        ) {

          var clip =
            await clipResponse.json();

          currentClips.push({
            index: i,
            base64:
              clip.videoBase64
          });
        }
      }

      document.getElementById(
        "createVideoButton"
      ).disabled =
        currentClips.length !==
        currentScenes.length;

      setProgress(70);

      return;
    }

    setTimeout(
      pollAnimation,
      5000
    );

  } catch (error) {

    document.getElementById(
      "animationStatus"
    ).innerHTML =
      '<span class="error">' +
      escapeHtml(
        error.message
      ) +
      "</span>";
  }
}

async function creerVideo() {

  if (
    currentClips.length !==
    5
  ) {
    alert(
      "Les 5 animations doivent être prêtes."
    );
    return;
  }

  var message =
    document.getElementById(
      "videoMessage"
    );

  showSection("videoSection");

  message.textContent =
    "Montage de la vidéo finale...";

  try {

    var response =
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
              currentClips,
            project:
              currentProject
          })
        }
      );

    var data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Erreur de montage."
      );
    }

    var container =
      document.getElementById(
        "videoContainer"
      );

    container.innerHTML =
      '<video controls playsinline src="' +
      data.downloadUrl +
      '"></video>' +

      '<div class="actions">' +
      '<a class="primary" href="' +
      data.downloadUrl +
      '" download>' +
      "⬇️ Télécharger la vidéo" +
      "</a>" +
      "</div>";

    message.innerHTML =
      '<span class="success">🎬 Vidéo finale créée.</span>' +
      "<br>Musique : " +
      escapeHtml(
        data.audio &&
        data.audio.provider
          ? data.audio.provider
          : "Cineflow"
      );

    setProgress(100);

  } catch (error) {

    message.innerHTML =
      '<span class="error">' +
      escapeHtml(
        error.message
      ) +
      "</span>";
  }
}

async function preparerAudio() {

  if (!currentProject) {
    alert(
      "Crée d'abord un projet."
    );
    return;
  }

  var message =
    document.getElementById(
      "productionMessage"
    );

  message.textContent =
    "Préparation de l'audio...";

  try {

    var response =
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
              currentProject
          })
        }
      );

    var data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Erreur audio."
      );
    }

    message.innerHTML =
      '<span class="success">🎧 Audio préparé.</span> ' +
      escapeHtml(
        data.plan &&
        data.plan.musicDescription
          ? data.plan.musicDescription
          : ""
      );

  } catch (error) {

    message.innerHTML =
      '<span class="error">' +
      escapeHtml(
        error.message
      ) +
      "</span>";
  }
}

async function preparerThumbnail() {

  if (!currentProject) {
    alert(
      "Crée d'abord un projet."
    );
    return;
  }

  var message =
    document.getElementById(
      "productionMessage"
    );

  try {

    var response =
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
              currentProject
          })
        }
      );

    var data =
      await response.json();

    message.innerHTML =
      '<span class="success">🖼️ Miniature préparée.</span> ' +
      escapeHtml(
        data.plan &&
        data.plan.description
          ? data.plan.description
          : ""
      );

  } catch (error) {

    message.innerHTML =
      '<span class="error">' +
      escapeHtml(
        error.message
      ) +
      "</span>";
  }
}

async function preparerSocial() {

  if (!currentProject) {
    alert(
      "Crée d'abord un projet."
    );
    return;
  }

  var message =
    document.getElementById(
      "productionMessage"
    );

  try {

    var response =
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
              currentProject
          })
        }
      );

    var data =
      await response.json();

    message.innerHTML =
      '<span class="success">📱 Publication préparée.</span> ' +
      escapeHtml(
        data.plan &&
        data.plan.platforms
          ? data.plan.platforms.join(", ")
          : ""
      );

  } catch (error) {

    message.innerHTML =
      '<span class="error">' +
      escapeHtml(
        error.message
      ) +
      "</span>";
  }
}

async function preparerAutopilot() {

  if (!currentProject) {
    alert(
      "Crée d'abord un projet."
    );
    return;
  }

  var message =
    document.getElementById(
      "productionMessage"
    );

  try {

    var response =
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
              currentProject
          })
        }
      );

    var data =
      await response.json();

    message.innerHTML =
      '<span class="success">🤖 Auto-Pilote préparé.</span> ' +
      escapeHtml(
        data.plan &&
        data.plan.steps
          ? data.plan.steps.join(" → ")
          : ""
      );

  } catch (error) {

    message.innerHTML =
      '<span class="error">' +
      escapeHtml(
        error.message
      ) +
      "</span>";
  }
}

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

    if (!ai) {
      return res.status(500).json({
        success: false,
        error:
          "GEMINI_API_KEY absente."
      });
    }

    const response =
      await ai.models.generateContent({
        model: MODEL,
        contents:
          "Réponds exactement : Je confirme que Gemini est correctement connecté à Cineflow."
      });

    res.json({
      success: true,
      message:
        response.text ||
        "Gemini est connecté à Cineflow."
    });

  } catch (error) {

    res.status(
      error.status || 500
    ).json({
      success: false,
      error:
        error.message ||
        "Erreur Gemini."
    });
  }
});

/* =========================================================
   GENERATE PROJECT
========================================================= */

app.post("/api/generate", async (req, res) => {

  try {

    const idea =
      String(req.body.idea || "").trim();

    const category =
      String(
        req.body.category || "Film"
      );

    if (!idea) {
      return res.status(400).json({
        error:
          "L'idée de vidéo est obligatoire."
      });
    }

    const prompt = `
Tu es le moteur créatif de Cineflow.

Crée un projet vidéo professionnel à partir de cette idée :

IDÉE :
${idea}

CATÉGORIE :
${category}

Retourne UNIQUEMENT un JSON valide avec cette structure :

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
      "description": "",
      "prompt": ""
    },
    {
      "number": 2,
      "title": "",
      "description": "",
      "prompt": ""
    },
    {
      "number": 3,
      "title": "",
      "description": "",
      "prompt": ""
    },
    {
      "number": 4,
      "title": "",
      "description": "",
      "prompt": ""
    },
    {
      "number": 5,
      "title": "",
      "description": "",
      "prompt": ""
    }
  ]
}

Les prompts visuels doivent conserver la cohérence
des personnages, des vêtements, de l'environnement
et du style cinématographique.
`;

    const raw =
      await generateTextInteraction(
        prompt
      );

    const project =
      JSON.parse(raw);

    if (
      !project.scenes ||
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

    res.status(
      error.status || 500
    ).json({
      error:
        error.message ||
        "Erreur lors de la génération du projet."
    });
  }
});

/* =========================================================
   PREPARE SCENES
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
        Array.isArray(project.scenes) &&
        project.scenes.length === 5
      ) {

        const scenes =
          project.scenes.map(
            function(scene, index) {

              return {
                number:
                  index + 1,
                title:
                  scene.title ||
                  "Scène " +
                  (index + 1),
                description:
                  scene.description ||
                  "",
                prompt:
                  scene.prompt ||
                  (
                    "Cinematic scene " +
                    (index + 1) +
                    ": " +
                    (
                      scene.description ||
                      ""
                    )
                  ),
                imageBase64:
                  scene.imageBase64 ||
                  null,
                mimeType:
                  scene.mimeType ||
                  "image/jpeg"
              };
            }
          );

        return res.json({
          success: true,
          scenes
        });
      }

      const prompt = `
Prépare exactement 5 scènes visuelles cohérentes
pour ce projet Cineflow.

Projet :
${JSON.stringify(project)}

Retourne uniquement un JSON valide sous la forme :

{
  "scenes": [
    {
      "number": 1,
      "title": "",
      "description": "",
      "prompt": ""
    },
    {
      "number": 2,
      "title": "",
      "description": "",
      "prompt": ""
    },
    {
      "number": 3,
      "title": "",
      "description": "",
      "prompt": ""
    },
    {
      "number": 4,
      "title": "",
      "description": "",
      "prompt": ""
    },
    {
      "number": 5,
      "title": "",
      "description": "",
      "prompt": ""
    }
  ]
}
`;

      const raw =
        await generateTextInteraction(
          prompt
        );

      const parsed =
        JSON.parse(raw);

      if (
        !parsed.scenes ||
        parsed.scenes.length !== 5
      ) {
        throw new Error(
          "Impossible de créer 5 scènes."
        );
      }

      res.json({
        success: true,
        scenes: parsed.scenes
      });

    } catch (error) {

      res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          "Erreur lors de la préparation des scènes."
      });
    }
  }
);

/* =========================================================
   GENERATE IMAGE
========================================================= */

app.post(
  "/api/generate-image",
  async (req, res) => {

    try {

      const prompt =
        String(
          req.body.prompt || ""
        ).trim();

      if (!prompt) {
        return res.status(400).json({
          error:
            "Prompt image manquant."
        });
      }

      const result =
        await generateImage(
          prompt
        );

      res.json({
        success: true,
        imageBase64:
          result.base64,
        mimeType:
          result.mimeType
      });

    } catch (error) {

      console.error(
        "Erreur image:",
        error
      );

      res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          "Erreur lors de la génération de l'image."
      });
    }
  }
);

/* =========================================================
   ANIMATE SINGLE SCENE
========================================================= */

app.post(
  "/api/animate-scene",
  async (req, res) => {

    try {

      const result =
        await generateVideoFromImage(
          req.body.imageBase64,
          req.body.mimeType ||
            "image/jpeg",
          req.body.prompt ||
            "Animate this cinematic scene."
        );

      res.json({
        success: true,
        videoBase64:
          result.base64,
        mimeType:
          result.mimeType
      });

    } catch (error) {

      res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          "Erreur animation."
      });
    }
  }
);

/* =========================================================
   ANIMATE 5 SCENES
========================================================= */

app.post(
  "/api/animate-scenes",
  async (req, res) => {

    try {

      const scenes =
        req.body.scenes;

      if (
        !Array.isArray(scenes) ||
        scenes.length !== 5
      ) {
        return res.status(400).json({
          error:
            "Il faut exactement 5 scènes."
        });
      }

      const job =
        createAnimationJob(
          scenes
        );

      processAnimationQueue();

      res.json({
        success: true,
        jobId: job.id,
        status: job.status
      });

    } catch (error) {

      res.status(500).json({
        error:
          error.message ||
          "Erreur de création de la file d'animation."
      });
    }
  }
);

/* =========================================================
   ANIMATION STATUS
========================================================= */

app.get(
  "/api/animation-status/:jobId",
  (req, res) => {

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
  }
);

/* =========================================================
   GET ANIMATION SCENE VIDEO
========================================================= */

app.get(
  "/api/animation-scene/:jobId/:sceneIndex",
  (req, res) => {

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

    const index =
      Number(
        req.params.sceneIndex
      );

    const scene =
      job.scenes[index];

    if (!scene) {
      return res.status(404).json({
        error:
          "Scène introuvable."
      });
    }

    if (!scene.videoBase64) {
      return res.status(404).json({
        error:
          "Vidéo de scène non disponible."
      });
    }

    res.json({
      success: true,
      videoBase64:
        scene.videoBase64,
      mimeType:
        "video/mp4"
    });
  }
);

/* =========================================================
   RETRY
========================================================= */

app.post(
  "/api/animation-retry",
  async (req, res) => {

    try {

      const job =
        retryScene(
          req.body.jobId,
          req.body.sceneIndex
        );

      res.json({
        success: true,
        job:
          getPublicJob(job)
      });

    } catch (error) {

      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   REGENERATE
========================================================= */

app.post(
  "/api/animation-regenerate",
  async (req, res) => {

    try {

      const job =
        retryScene(
          req.body.jobId,
          req.body.sceneIndex
        );

      res.json({
        success: true,
        job:
          getPublicJob(job)
      });

    } catch (error) {

      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   CREATE FINAL VIDEO
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

      const project =
        req.body.project || {};

      if (
        !Array.isArray(clips) ||
        clips.length !== 5
      ) {
        return res.status(400).json({
          error:
            "Il faut exactement 5 clips vidéo."
        });
      }

      const normalizedFiles = [];

      for (
        let i = 0;
        i < clips.length;
        i++
      ) {

        const clip =
          clips[i];

        if (!clip || !clip.base64) {
          throw new Error(
            "Clip " +
            (i + 1) +
            " manquant."
          );
        }

        const rawFile =
          path.join(
            workDir,
            "scene-" +
              (i + 1) +
              "-raw.mp4"
          );

        const normalizedFile =
          path.join(
            workDir,
            "scene-" +
              (i + 1) +
              "-normalized.mp4"
          );

        fs.writeFileSync(
          rawFile,
          Buffer.from(
            clip.base64,
            "base64"
          )
        );

        await runFFmpeg([
          "-y",

          "-i",
          rawFile,

          "-vf",
          "scale=1280:720:force_original_aspect_ratio=decrease," +
            "pad=1280:720:(ow-iw)/2:(oh-ih)/2",

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

          "-ac",
          "2",

          normalizedFile
        ]);

        normalizedFiles.push(
          normalizedFile
        );
      }

      const listFile =
        path.join(
          workDir,
          "concat.txt"
        );

      const concatContent =
        normalizedFiles
          .map(
            function(file) {
              return (
                "file '" +
                file.replace(
                  /'/g,
                  "'\\\\''"
                ) +
                "'"
              );
            }
          )
          .join("\n");

      fs.writeFileSync(
        listFile,
        concatContent
      );

      const assembledFile =
        path.join(
          workDir,
          "cineflow-assembled.mp4"
        );

      await runFFmpeg([
        "-y",

        "-f",
        "concat",

        "-safe",
        "0",

        "-i",
        listFile,

        "-c",
        "copy",

        assembledFile
      ]);

      /* -----------------------------------------
         MUSIQUE LYRIA 3.5
      ----------------------------------------- */

      const audioPlan =
        buildAudioPlan(
          project
        );

      const audioFile =
        path.join(
          workDir,
          "cineflow-music.m4a"
        );

      const audioResult =
        await generateAudioTrack(
          audioPlan.mood,
          120,
          audioFile,
          project
        );

      /* -----------------------------------------
         MIX AUDIO
      ----------------------------------------- */

      const finalFile =
        path.join(
          workDir,
          "cineflow-final.mp4"
        );

      await runFFmpeg([
        "-y",

        "-i",
        assembledFile,

        "-i",
        audioFile,

        "-filter_complex",

        "[0:a]volume=1.0[original];" +
          "[1:a]volume=0.18[music];" +
          "[original][music]" +
          "amix=inputs=2:" +
          "duration=first:" +
          "dropout_transition=2" +
          "[aout]",

        "-map",
        "0:v:0",

        "-map",
        "[aout]",

        "-c:v",
        "copy",

        "-c:a",
        "aac",

        "-b:a",
        "192k",

        "-ar",
        "48000",

        "-ac",
        "2",

        "-shortest",

        "-movflags",
        "+faststart",

        finalFile
      ]);

      const persistentId =
        createVideoFileId();

      const persistentFile =
        path.join(
          os.tmpdir(),
          persistentId +
            ".mp4"
        );

      fs.copyFileSync(
        finalFile,
        persistentFile
      );

      finalVideoFiles.set(
        persistentId,
        {
          file:
            persistentFile,
          createdAt:
            Date.now()
        }
      );

      res.json({
        success: true,

        videoId:
          persistentId,

        downloadUrl:
          "/api/download-video/" +
          persistentId,

        audio: {
          provider:
            audioResult.provider,
          mood:
            audioResult.mood
        },

        expiresInMinutes:
          30
      });

    } catch (error) {

      console.error(
        "Erreur création vidéo:",
        error
      );

      res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          "Erreur lors de la création de la vidéo."
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
      } catch (_) {}
    }
  }
);

/* =========================================================
   DOWNLOAD VIDEO
========================================================= */

app.get(
  "/api/download-video/:videoId",
  (req, res) => {

    const item =
      finalVideoFiles.get(
        req.params.videoId
      );

    if (
      !item ||
      !item.file ||
      !fs.existsSync(item.file)
    ) {
      return res.status(404).send(
        "Vidéo introuvable ou expirée."
      );
    }

    res.download(
      item.file,
      "cineflow-video.mp4"
    );
  }
);

/* =========================================================
   PREPARE AUDIO
========================================================= */

app.post(
  "/api/prepare-audio",
  (req, res) => {

    try {

      const project =
        req.body.project || {};

      const plan =
        buildAudioPlan(
          project
        );

      res.json({
        success: true,
        plan
      });

    } catch (error) {

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   PREPARE THUMBNAIL
========================================================= */

app.post(
  "/api/prepare-thumbnail",
  (req, res) => {

    try {

      const plan =
        buildThumbnailPlan(
          req.body.project || {}
        );

      res.json({
        success: true,
        plan
      });

    } catch (error) {

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   PREPARE SOCIAL
========================================================= */

app.post(
  "/api/prepare-social",
  (req, res) => {

    try {

      const plan =
        buildSocialPlan(
          req.body.project || {}
        );

      res.json({
        success: true,
        plan
      });

    } catch (error) {

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   AUTOPILOT
========================================================= */

app.post(
  "/api/autopilot-plan",
  (req, res) => {

    try {

      const plan =
        buildAutoPilotPlan(
          req.body.project || {}
        );

      res.json({
        success: true,
        plan
      });

    } catch (error) {

      res.status(500).json({
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
   START
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      "🎬 Cineflow est lancé sur le port " +
      PORT
    );

    console.log(
      "🤖 Gemini : " +
      (API_KEY
        ? "connecté"
        : "clé absente")
    );

    console.log(
      "🎵 Lyria 3.5 : activé"
    );

    console.log(
      "🎞️ Veo 3.1 : activé"
    );
  }
);

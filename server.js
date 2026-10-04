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

const ai = API_KEY
  ? new GoogleGenAI({ apiKey: API_KEY })
  : null;


/* =========================================================
   OUTILS
   ========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanJson(text) {
  if (!text) return null;

  let value = String(text).trim();

  value = value
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");

  if (first !== -1 && last !== -1 && last > first) {
    value = value.slice(first, last + 1);
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getInteractionText(result) {
  if (!result) return "";

  if (typeof result.text === "string") {
    return result.text;
  }

  if (result.output_text) {
    return result.output_text;
  }

  if (Array.isArray(result.output)) {
    for (const item of result.output) {
      if (typeof item.text === "string") {
        return item.text;
      }

      if (Array.isArray(item.content)) {
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


/* =========================================================
   GEMINI TEXTE
   ========================================================= */

async function generateTextInteraction(prompt) {
  if (!ai) {
    throw new Error("GEMINI_API_KEY manquante sur Render.");
  }

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json"
    }
  });

  const text = getInteractionText(response);

  if (!text) {
    throw new Error("Gemini n'a retourné aucun texte.");
  }

  return cleanJson(text) || text;
}


/* =========================================================
   IMAGE
   ========================================================= */

async function generateImage(prompt) {
  if (!ai) {
    throw new Error("GEMINI_API_KEY manquante.");
  }

  const result = await ai.interactions.create({
    model: IMAGE_MODEL,
    input: prompt,
    response_format: {
      type: "image",
      mime_type: "image/jpeg",
      aspect_ratio: "16:9",
      image_size: "1K"
    }
  });

  let imageBase64 = null;

  if (result && Array.isArray(result.output)) {
    for (const item of result.output) {
      if (item && item.result) {
        if (typeof item.result === "string") {
          imageBase64 = item.result;
          break;
        }

        if (item.result.data) {
          imageBase64 = item.result.data;
          break;
        }

        if (item.result.image) {
          imageBase64 = item.result.image;
          break;
        }
      }

      if (item && item.data) {
        imageBase64 = item.data;
        break;
      }
    }
  }

  if (!imageBase64 && result && result.data) {
    imageBase64 = result.data;
  }

  if (!imageBase64) {
    throw new Error("Aucune image reçue de Gemini.");
  }

  return imageBase64;
}


/* =========================================================
   FFmpeg
   ========================================================= */

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}


/* =========================================================
   MUSIQUE
   ========================================================= */

function detectMood(text = "") {
  const value = text.toLowerCase();

  if (
    value.includes("football") ||
    value.includes("action") ||
    value.includes("combat") ||
    value.includes("aventure")
  ) {
    return "action";
  }

  if (
    value.includes("drame") ||
    value.includes("triste") ||
    value.includes("famille")
  ) {
    return "drama";
  }

  if (
    value.includes("suspense") ||
    value.includes("mystère") ||
    value.includes("mystere")
  ) {
    return "suspense";
  }

  if (
    value.includes("animation") ||
    value.includes("magique")
  ) {
    return "animation";
  }

  return "cinematic";
}

function buildAudioPlan(project) {
  const source = JSON.stringify(project || "");
  const mood = detectMood(source);

  const descriptions = {
    action:
      "Musique cinématique énergique, percussions puissantes, tension et montée héroïque.",

    drama:
      "Musique émotionnelle, piano doux, cordes légères et ambiance humaine.",

    suspense:
      "Musique mystérieuse et progressive, tension cinématographique.",

    animation:
      "Musique aventureuse, joyeuse et magique avec une sensation de découverte.",

    cinematic:
      "Musique cinématique moderne, émotionnelle et immersive."
  };

  return {
    mood,
    description: descriptions[mood]
  };
}

async function generateFallbackAudio(outputPath, duration = 120) {
  const frequency = 220;

  await runFFmpeg([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${frequency}:duration=${duration}`,
    "-af",
    "volume=0.12,afade=t=in:st=0:d=2,afade=t=out:st=115:d=5",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    "-y",
    outputPath
  ]);

  return "fallback-ffmpeg";
}

async function generateAudioTrack(project, outputPath, duration = 120) {
  const plan = buildAudioPlan(project);

  if (!ai) {
    await generateFallbackAudio(outputPath, duration);
    return {
      provider: "fallback",
      mood: plan.mood
    };
  }

  try {
    const musicPrompt = `
Crée une musique instrumentale cinématique originale pour une vidéo.

Style:
${plan.description}

La musique doit accompagner une histoire vidéo,
être immersive, sans paroles et adaptée au rythme d'un film.
`;

    const result = await ai.interactions.create({
      model: MUSIC_MODEL,
      input: musicPrompt,
      response_format: {
        type: "audio"
      }
    });

    let audioBase64 = null;

    if (result && Array.isArray(result.output)) {
      for (const item of result.output) {
        if (item && item.data) {
          audioBase64 = item.data;
          break;
        }

        if (item && item.result && item.result.data) {
          audioBase64 = item.result.data;
          break;
        }
      }
    }

    if (!audioBase64) {
      throw new Error("Aucun audio reçu.");
    }

    fs.writeFileSync(outputPath, Buffer.from(audioBase64, "base64"));

    return {
      provider: "lyria",
      mood: plan.mood
    };

  } catch (error) {
    console.log("Musique IA indisponible, utilisation du fallback.");

    await generateFallbackAudio(outputPath, duration);

    return {
      provider: "fallback",
      mood: plan.mood,
      warning: error.message
    };
  }
}


/* =========================================================
   STATS CINEFLOW
   ========================================================= */

const cineflowStats = {
  videosCreated: 0,
  videosPublished: 0,
  views: 0,
  likes: 0,
  subscribers: 0,
  estimatedRevenue: 0,
  weeklyGoal: 10
};

const cineflowProjects = [];
const cineflowSeries = [];


/* =========================================================
   PROJETS
   ========================================================= */

function saveProject(project) {
  if (!project) return null;

  const saved = {
    id: `project_${Date.now()}`,
    createdAt: new Date().toISOString(),
    project
  };

  cineflowProjects.unshift(saved);

  if (cineflowProjects.length > 50) {
    cineflowProjects.pop();
  }

  return saved;
}


/* =========================================================
   IDÉES
   ========================================================= */

function buildTrendingIdeas(category = "Film") {

  const ideas = {

    Film: [
      "Un jeune rêve de devenir réalisateur malgré les difficultés.",
      "Un garçon découvre un mystérieux secret dans son village.",
      "Une famille doit surmonter une grande épreuve.",
      "Un jeune entrepreneur part de zéro.",
      "Un inconnu change complètement la vie d'une famille."
    ],

    Animation: [
      "Un jeune héros africain découvre un pouvoir inattendu.",
      "Un animal devient le héros de son village.",
      "Deux amis partent dans une aventure extraordinaire.",
      "Une jeune fille découvre une ville magique.",
      "Un petit héros doit sauver son monde."
    ],

    Action: [
      "Un jeune héros doit protéger sa ville.",
      "Une mission impossible commence dans une grande ville.",
      "Un ancien champion revient pour sauver son équipe.",
      "Une course contre la montre commence.",
      "Un héros doit affronter son plus grand défi."
    ],

    Drama: [
      "Un jeune doit choisir entre son rêve et sa famille.",
      "Deux amis se retrouvent après plusieurs années.",
      "Une famille tente de reconstruire sa vie.",
      "Un personnage doit surmonter un grand échec.",
      "Un sacrifice change la vie d'une famille."
    ],

    Football: [
      "Un jeune footballeur africain rêve de devenir professionnel.",
      "Un joueur inconnu obtient enfin sa chance.",
      "Une équipe perd tout avant de revenir plus forte.",
      "Un jeune gardien devient le héros de son équipe.",
      "Un jeune joueur transforme son rêve en réalité."
    ]
  };

  return ideas[category] || ideas.Film;
}

function buildIdeaGenerator(category = "Film", count = 5) {

  const base = buildTrendingIdeas(category);
  const ideas = [];

  for (let i = 0; i < count; i++) {

    const title = base[i % base.length];

    ideas.push({
      id: `idea_${Date.now()}_${i}`,
      category,
      title,
      prompt:
        `Crée une vidéo ${category.toLowerCase()} basée sur cette idée : ${title}
Construis une histoire captivante en 5 scènes.
Chaque scène doit avoir une continuité visuelle et narrative.`
    });
  }

  return ideas;
}


/* =========================================================
   RAPPORTS
   ========================================================= */

function getWeekNumber(date = new Date()) {

  const d = new Date(Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  ));

  const dayNum = d.getUTCDay() || 7;

  d.setUTCDate(d.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(
    Date.UTC(d.getUTCFullYear(), 0, 1)
  );

  return Math.ceil(
    (((d - yearStart) / 86400000) + 1) / 7
  );
}

function buildWeeklyReport() {

  const progress = Math.min(
    100,
    Math.round(
      (cineflowStats.videosCreated /
        Math.max(1, cineflowStats.weeklyGoal)) *
      100
    )
  );

  return {
    period: `Semaine ${getWeekNumber()}`,
    videosCreated: cineflowStats.videosCreated,
    videosPublished: cineflowStats.videosPublished,
    views: cineflowStats.views,
    likes: cineflowStats.likes,
    subscribers: cineflowStats.subscribers,
    estimatedRevenue: cineflowStats.estimatedRevenue,
    weeklyGoal: cineflowStats.weeklyGoal,
    progress
  };
}

function buildMonthlyReport() {

  return {
    month: new Date().toLocaleString("fr-FR", {
      month: "long",
      year: "numeric"
    }),

    videosCreated: cineflowStats.videosCreated,
    videosPublished: cineflowStats.videosPublished,
    views: cineflowStats.views,
    likes: cineflowStats.likes,
    subscribers: cineflowStats.subscribers,
    estimatedRevenue: cineflowStats.estimatedRevenue
  };
}


/* =========================================================
   AUTOPILOTE
   ========================================================= */

function buildAutoPilotFullPlan() {

  return {

    active: false,

    workflow: [
      "Analyser les idées",
      "Choisir une idée",
      "Créer le scénario",
      "Préparer les 5 scènes",
      "Générer les images",
      "Animer les scènes",
      "Créer la musique",
      "Créer la vidéo finale",
      "Créer la miniature",
      "Préparer les publications",
      "Publier sur les plateformes connectées",
      "Analyser les résultats",
      "Préparer les prochaines vidéos"
    ],

    weeklyGoal: cineflowStats.weeklyGoal,

    platforms: [
      "YouTube",
      "TikTok",
      "Instagram",
      "Facebook"
    ],

    status: "Prêt"
  };
}


/* =========================================================
   FORMATS PLATEFORMES
   ========================================================= */

function buildPlatformFormats() {

  return {

    youtube: {
      horizontal: "16:9",
      shorts: "9:16"
    },

    tiktok: {
      vertical: "9:16"
    },

    instagram: {
      reels: "9:16",
      square: "1:1"
    },

    facebook: {
      horizontal: "16:9",
      vertical: "9:16"
    }
  };
}


/* =========================================================
   BUDGET IA
   ========================================================= */

function buildAIBudget() {

  return {

    mode: "Free Tier",

    status: "Surveillance active",

    services: {

      gemini: {
        status: API_KEY ? "Connecté" : "Clé absente"
      },

      imageGeneration: {
        status: "Selon quota"
      },

      veo: {
        status: "Selon quota"
      },

      music: {
        status: "IA + fallback FFmpeg"
      }
    },

    recommendation:
      "Cineflow surveille les appels IA afin d'éviter les appels inutiles."
  };
}


/* =========================================================
   CINEFLOW BRAIN
   ========================================================= */

function buildCineflowBrain() {

  return {

    name: "Cineflow Brain",

    mission:
      "Orchestrer automatiquement la création complète d'une vidéo.",

    pipeline: [
      "Idée",
      "Scénario",
      "Scènes",
      "Images",
      "Animation",
      "Musique",
      "Montage",
      "Miniature",
      "Réseaux sociaux",
      "Publication",
      "Analyse"
    ],

    priority:
      "Terminer le moteur vidéo existant sans casser les fonctions déjà opérationnelles."
  };
}


/* =========================================================
   DASHBOARD API
   ========================================================= */

app.get("/api/dashboard", (req, res) => {

  res.json({
    success: true,
    stats: cineflowStats,
    weeklyReport: buildWeeklyReport(),
    monthlyReport: buildMonthlyReport(),
    autopilot: buildAutoPilotFullPlan(),
    brain: buildCineflowBrain(),
    budget: buildAIBudget()
  });
});


/* =========================================================
   TEST GEMINI
   ========================================================= */

app.get("/api/test-gemini", async (req, res) => {

  if (!ai) {
    return res.status(500).json({
      success: false,
      error: "GEMINI_API_KEY manquante."
    });
  }

  try {

    const response = await ai.models.generateContent({
      model: MODEL,
      contents:
        "Réponds uniquement par : Je confirme que Gemini est correctement connecté à Cineflow."
    });

    const text = getInteractionText(response);

    res.json({
      success: true,
      message: text
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/* =========================================================
   GÉNÉRER UN PROJET
   ========================================================= */

app.post("/api/generate", async (req, res) => {

  try {

    const prompt = String(req.body.prompt || "").trim();
    const category = req.body.category || "Film";

    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: "Décris ton idée de vidéo."
      });
    }

    const instruction = `
Tu es le moteur narratif de Cineflow.

Crée un projet vidéo complet à partir de cette idée :

${prompt}

Catégorie :
${category}

Réponds uniquement en JSON valide avec exactement cette structure :

{
  "titre": "",
  "concept": "",
  "style": "",
  "personnages": [],
  "scenario": "",
  "scenes": [
    {
      "numero": 1,
      "titre": "",
      "description": "",
      "promptImage": ""
    },
    {
      "numero": 2,
      "titre": "",
      "description": "",
      "promptImage": ""
    },
    {
      "numero": 3,
      "titre": "",
      "description": "",
      "promptImage": ""
    },
    {
      "numero": 4,
      "titre": "",
      "description": "",
      "promptImage": ""
    },
    {
      "numero": 5,
      "titre": "",
      "description": "",
      "promptImage": ""
    }
  ],
  "thumbnailPrompt": "",
  "socialCaption": ""
}

Les 5 scènes doivent être cohérentes.
Les personnages doivent conserver leur apparence.
Les prompts d'image doivent être cinématographiques.
`;

    const project = await generateTextInteraction(instruction);

    const savedProject = saveProject(project);

    res.json({
      success: true,
      project,
      savedProject
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/* =========================================================
   PRÉPARER LES SCÈNES
   ========================================================= */

app.post("/api/prepare-images", async (req, res) => {

  try {

    const project = req.body.project;

    if (!project) {
      return res.status(400).json({
        success: false,
        error: "Projet manquant."
      });
    }

    let scenes = Array.isArray(project.scenes)
      ? project.scenes
      : [];

    if (scenes.length !== 5) {

      const prompt = `
Transforme ce projet vidéo en exactement 5 scènes visuelles.

Projet :
${JSON.stringify(project)}

Réponds uniquement avec :

{
  "scenes": [
    {
      "numero": 1,
      "titre": "",
      "description": "",
      "promptImage": ""
    },
    {
      "numero": 2,
      "titre": "",
      "description": "",
      "promptImage": ""
    },
    {
      "numero": 3,
      "titre": "",
      "description": "",
      "promptImage": ""
    },
    {
      "numero": 4,
      "titre": "",
      "description": "",
      "promptImage": ""
    },
    {
      "numero": 5,
      "titre": "",
      "description": "",
      "promptImage": ""
    }
  ]
}
`;

      const result = await generateTextInteraction(prompt);

      scenes = result.scenes || [];
    }

    if (scenes.length !== 5) {
      throw new Error("Cineflow n'a pas obtenu exactement 5 scènes.");
    }

    res.json({
      success: true,
      scenes
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/* =========================================================
   GÉNÉRER UNE IMAGE
   ========================================================= */

app.post("/api/generate-image", async (req, res) => {

  try {

    const scene = req.body.scene;

    if (!scene) {
      return res.status(400).json({
        success: false,
        error: "Scène manquante."
      });
    }

    const prompt = `
Crée une image cinématographique 16:9 pour Cineflow.

Scène :
${JSON.stringify(scene)}

Respecte exactement les personnages,
leurs vêtements, leur âge apparent,
leur environnement et la continuité visuelle.

Style :
cinématographique réaliste,
éclairage professionnel,
composition de film,
haute qualité,
16:9.
`;

    const image = await generateImage(prompt);

    res.json({
      success: true,
      image
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/* =========================================================
   ANIMATION D'UNE SCÈNE
   ========================================================= */

async function generateVideoForScene(scene) {

  if (!ai) {
    throw new Error("GEMINI_API_KEY manquante.");
  }

  const prompt = `
Anime cette scène comme un plan cinématographique.

Scène :
${JSON.stringify(scene)}

Mouvement naturel de caméra,
mouvements réalistes des personnages,
continuité visuelle,
style cinématographique,
qualité professionnelle.
`;

  let operation = await ai.models.generateVideos({
    model: VIDEO_MODEL,
    prompt
  });

  let attempts = 0;

  while (!operation.done && attempts < 60) {

    await sleep(10000);

    operation = await ai.operations.getVideosOperation({
      operation
    });

    attempts++;
  }

  if (!operation.done) {
    throw new Error("La génération vidéo a dépassé le délai.");
  }

  if (
    operation.error
  ) {
    throw new Error(
      operation.error.message ||
      "Erreur Veo."
    );
  }

  const videoFile =
    operation.response?.generatedVideos?.[0]?.video;

  if (!videoFile) {
    throw new Error("Veo n'a retourné aucune vidéo.");
  }

  const tempPath = path.join(
    os.tmpdir(),
    `cineflow_${Date.now()}_${Math.random()}.mp4`
  );

  await ai.files.download({
    file: videoFile,
    path: tempPath
  });

  const base64 = fs.readFileSync(tempPath).toString("base64");

  try {
    fs.unlinkSync(tempPath);
  } catch {}

  return base64;
}


/* =========================================================
   ANIMATION SIMPLE
   ========================================================= */

app.post("/api/animate-scene", async (req, res) => {

  try {

    const scene = req.body.scene;

    if (!scene) {
      return res.status(400).json({
        success: false,
        error: "Scène manquante."
      });
    }

    const video = await generateVideoForScene(scene);

    res.json({
      success: true,
      video
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/* =========================================================
   FILE D'ATTENTE D'ANIMATION
   ========================================================= */

const animationQueue = [];
let animationRunning = false;

const animationJobs = new Map();

function createAnimationJob(scenes) {

  const jobId =
    `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const job = {

    id: jobId,

    scenes,

    statuses: scenes.map(() => "waiting"),

    attempts: scenes.map(() => 0),

    videos: scenes.map(() => null),

    errors: scenes.map(() => null),

    createdAt: new Date().toISOString(),

    completed: false
  };

  animationJobs.set(jobId, job);

  animationQueue.push(jobId);

  processAnimationQueue();

  return job;
}

async function processAnimationQueue() {

  if (animationRunning) return;

  animationRunning = true;

  try {

    while (animationQueue.length > 0) {

      const jobId = animationQueue.shift();
      const job = animationJobs.get(jobId);

      if (!job) continue;

      for (let i = 0; i < job.scenes.length; i++) {

        if (job.videos[i]) continue;

        job.statuses[i] = "processing";
        job.attempts[i]++;

        try {

          const video =
            await generateVideoForScene(job.scenes[i]);

          job.videos[i] = video;
          job.statuses[i] = "completed";

        } catch (error) {

          job.statuses[i] = "error";
          job.errors[i] = error.message;
        }
      }

      job.completed =
        job.statuses.every(
          status => status === "completed"
        );
    }

  } finally {

    animationRunning = false;

    if (animationQueue.length > 0) {
      processAnimationQueue();
    }
  }
}


/* =========================================================
   LANCER LES 5 SCÈNES
   ========================================================= */

app.post("/api/animate-scenes", (req, res) => {

  try {

    const scenes = req.body.scenes;

    if (!Array.isArray(scenes) || scenes.length !== 5) {

      return res.status(400).json({
        success: false,
        error: "Cineflow doit recevoir exactement 5 scènes."
      });
    }

    const job = createAnimationJob(scenes);

    res.json({
      success: true,
      jobId: job.id,
      message: "Les 5 scènes sont placées dans la file d'attente."
    });

  } catch (error) {

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/* =========================================================
   STATUT ANIMATION
   ========================================================= */

app.get("/api/animation-status/:jobId", (req, res) => {

  const job = animationJobs.get(req.params.jobId);

  if (!job) {

    return res.status(404).json({
      success: false,
      error: "Job introuvable."
    });
  }

  res.json({
    success: true,
    job: {
      id: job.id,
      statuses: job.statuses,
      attempts: job.attempts,
      errors: job.errors,
      completed: job.completed
    }
  });
});


/* =========================================================
   RÉCUPÉRER UNE SCÈNE
   ========================================================= */

app.get(
  "/api/animation-scene/:jobId/:sceneIndex",
  (req, res) => {

    const job = animationJobs.get(req.params.jobId);

    if (!job) {

      return res.status(404).json({
        success: false,
        error: "Job introuvable."
      });
    }

    const index = Number(req.params.sceneIndex);

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= job.videos.length
    ) {

      return res.status(400).json({
        success: false,
        error: "Numéro de scène invalide."
      });
    }

    res.json({
      success: true,
      sceneIndex: index,
      status: job.statuses[index],
      video: job.videos[index]
    });
  }
);


/* =========================================================
   RETRY
   ========================================================= */

app.post("/api/animation-retry", async (req, res) => {

  try {

    const {
      jobId,
      sceneIndex
    } = req.body;

    const job = animationJobs.get(jobId);

    if (!job) {

      return res.status(404).json({
        success: false,
        error: "Job introuvable."
      });
    }

    const index = Number(sceneIndex);

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= job.scenes.length
    ) {

      return res.status(400).json({
        success: false,
        error: "Scène invalide."
      });
    }

    job.statuses[index] = "waiting";
    job.errors[index] = null;

    if (!animationQueue.includes(jobId)) {
      animationQueue.push(jobId);
    }

    processAnimationQueue();

    res.json({
      success: true,
      message: "La scène a été remise dans la file."
    });

  } catch (error) {

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/* =========================================================
   RÉGÉNÉRER UNE SCÈNE
   ========================================================= */

app.post("/api/animation-regenerate", async (req, res) => {

  try {

    const {
      jobId,
      sceneIndex,
      scene
    } = req.body;

    const job = animationJobs.get(jobId);

    if (!job) {

      return res.status(404).json({
        success: false,
        error: "Job introuvable."
      });
    }

    const index = Number(sceneIndex);

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= 5
    ) {

      return res.status(400).json({
        success: false,
        error: "Scène invalide."
      });
    }

    if (scene) {
      job.scenes[index] = scene;
    }

    job.videos[index] = null;
    job.statuses[index] = "waiting";
    job.errors[index] = null;

    if (!animationQueue.includes(jobId)) {
      animationQueue.push(jobId);
    }

    processAnimationQueue();

    res.json({
      success: true,
      message: "La scène sera régénérée."
    });

  } catch (error) {

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/* =========================================================
   VIDÉO FINALE
   ========================================================= */

const finalVideoFiles = new Map();

app.post("/api/create-video", async (req, res) => {

  try {

    const clips = req.body.clips;

    const project = req.body.project || {};

    if (!Array.isArray(clips) || clips.length !== 5) {

      return res.status(400).json({
        success: false,
        error: "Cineflow doit recevoir exactement 5 clips."
      });
    }

    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cineflow-")
    );

    const normalizedFiles = [];

    for (let i = 0; i < clips.length; i++) {

      const input =
        path.join(tempDir, `input_${i}.mp4`);

      const output =
        path.join(tempDir, `clip_${i}.mp4`);

      fs.writeFileSync(
        input,
        Buffer.from(clips[i], "base64")
      );

      await runFFmpeg([
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
        "-an",
        "-y",
        output
      ]);

      normalizedFiles.push(output);
    }

    const listFile =
      path.join(tempDir, "concat.txt");

    fs.writeFileSync(
      listFile,
      normalizedFiles
        .map(file =>
          `file '${file.replace(/'/g, "'\\''")}'`
        )
        .join("\n")
    );

    const silentVideo =
      path.join(tempDir, "silent.mp4");

    await runFFmpeg([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-c",
      "copy",
      "-y",
      silentVideo
    ]);

    const audioFile =
      path.join(tempDir, "music.mp3");

    await generateAudioTrack(
      project,
      audioFile,
      120
    );

    const finalPath =
      path.join(tempDir, "cineflow_final.mp4");

    await runFFmpeg([
      "-i",
      silentVideo,
      "-i",
      audioFile,
      "-filter_complex",
      "[1:a]volume=0.18[music]",
      "-map",
      "0:v:0",
      "-map",
      "[music]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-shortest",
      "-y",
      finalPath
    ]);

    const videoId =
      `video_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    finalVideoFiles.set(videoId, {
      path: finalPath,
      createdAt: Date.now()
    });

    cineflowStats.videosCreated += 1;

    res.json({
      success: true,
      videoId,
      downloadUrl:
        `/api/download-video/${videoId}`
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/* =========================================================
   DOWNLOAD VIDÉO
   ========================================================= */

app.get("/api/download-video/:videoId", (req, res) => {

  const item =
    finalVideoFiles.get(req.params.videoId);

  if (!item) {

    return res.status(404).send(
      "Vidéo introuvable ou expirée."
    );
  }

  if (
    Date.now() - item.createdAt >
    30 * 60 * 1000
  ) {

    try {
      fs.unlinkSync(item.path);
    } catch {}

    finalVideoFiles.delete(req.params.videoId);

    return res.status(410).send(
      "La vidéo a expiré."
    );
  }

  res.download(
    item.path,
    "cineflow-video.mp4"
  );
});


/* =========================================================
   AUDIO
   ========================================================= */

app.post("/api/prepare-audio", async (req, res) => {

  try {

    const project = req.body.project;

    if (!project) {

      return res.status(400).json({
        success: false,
        error: "Projet manquant."
      });
    }

    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cineflow-audio-")
    );

    const output =
      path.join(tempDir, "music.mp3");

    const result =
      await generateAudioTrack(
        project,
        output,
        120
      );

    const audio =
      fs.readFileSync(output).toString("base64");

    res.json({
      success: true,
      audio,
      provider: result.provider,
      mood: result.mood
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/* =========================================================
   MINIATURE
   ========================================================= */

app.post("/api/prepare-thumbnail", async (req, res) => {

  try {

    const project = req.body.project;

    if (!project) {

      return res.status(400).json({
        success: false,
        error: "Projet manquant."
      });
    }

    const prompt =
      project.thumbnailPrompt ||
      `
Crée une miniature YouTube cinématographique
pour cette histoire :

${JSON.stringify(project)}
`;

    const image =
      await generateImage(prompt);

    res.json({
      success: true,
      image
    });

  } catch (error) {

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/* =========================================================
   RÉSEAUX SOCIAUX
   ========================================================= */

app.post("/api/prepare-social", async (req, res) => {

  try {

    const project = req.body.project;

    if (!project) {

      return res.status(400).json({
        success: false,
        error: "Projet manquant."
      });
    }

    const title =
      project.titre ||
      "Nouvelle vidéo Cineflow";

    const caption =
      project.socialCaption ||
      project.concept ||
      "Une nouvelle création Cineflow.";

    res.json({

      success: true,

      social: {

        youtube: {
          title,
          description: caption,
          format: "16:9"
        },

        tiktok: {
          caption,
          format: "9:16"
        },

        instagram: {
          caption,
          format: "9:16"
        },

        facebook: {
          caption,
          format: "16:9"
        }
      }
    });

  } catch (error) {

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/* =========================================================
   AUTOPILOTE
   ========================================================= */

app.post("/api/autopilot-plan", (req, res) => {

  res.json({
    success: true,
    plan: buildAutoPilotFullPlan()
  });
});

app.get("/api/autopilot", (req, res) => {

  res.json({
    success: true,
    autopilot: buildAutoPilotFullPlan()
  });
});


/* =========================================================
   TENDANCES
   ========================================================= */

app.get("/api/trending", (req, res) => {

  const category =
    req.query.category || "Film";

  res.json({
    success: true,
    category,
    ideas: buildTrendingIdeas(category)
  });
});


/* =========================================================
   GÉNÉRATEUR D'IDÉES
   ========================================================= */

app.post("/api/generate-ideas", (req, res) => {

  const category =
    req.body.category || "Film";

  const count = Math.min(
    Math.max(
      Number(req.body.count) || 5,
      1
    ),
    20
  );

  res.json({
    success: true,
    category,
    ideas:
      buildIdeaGenerator(category, count)
  });
});


/* =========================================================
   OBJECTIF HEBDOMADAIRE
   ========================================================= */

app.post("/api/weekly-goal", (req, res) => {

  const goal =
    Number(req.body.goal);

  if (
    !Number.isFinite(goal) ||
    goal < 1
  ) {

    return res.status(400).json({
      success: false,
      error: "Objectif invalide."
    });
  }

  cineflowStats.weeklyGoal =
    Math.min(
      Math.round(goal),
      100
    );

  res.json({
    success: true,
    weeklyGoal:
      cineflowStats.weeklyGoal
  });
});


/* =========================================================
   RAPPORT HEBDOMADAIRE
   ========================================================= */

app.get("/api/report/weekly", (req, res) => {

  res.json({
    success: true,
    report:
      buildWeeklyReport()
  });
});


/* =========================================================
   RAPPORT MENSUEL
   ========================================================= */

app.get("/api/report/monthly", (req, res) => {

  res.json({
    success: true,
    report:
      buildMonthlyReport()
  });
});


/* =========================================================
   COMPTES
   ========================================================= */

app.get("/api/accounts", (req, res) => {

  res.json({

    success: true,

    accounts: [

      {
        platform: "YouTube",
        connected: false,
        status: "Non connecté"
      },

      {
        platform: "TikTok",
        connected: false,
        status: "Non connecté"
      },

      {
        platform: "Instagram",
        connected: false,
        status: "Non connecté"
      },

      {
        platform: "Facebook",
        connected: false,
        status: "Non connecté"
      }

    ]
  });
});


/* =========================================================
   PROJETS
   ========================================================= */

app.get("/api/projects", (req, res) => {

  res.json({
    success: true,
    projects: cineflowProjects
  });
});

app.post("/api/projects/save", (req, res) => {

  const project =
    req.body.project;

  if (!project) {

    return res.status(400).json({
      success: false,
      error: "Projet manquant."
    });
  }

  const saved =
    saveProject(project);

  res.json({
    success: true,
    savedProject: saved
  });
});


/* =========================================================
   SÉRIES
   ========================================================= */

app.get("/api/series", (req, res) => {

  res.json({
    success: true,
    series: cineflowSeries
  });
});

app.post("/api/series", (req, res) => {

  const title =
    String(req.body.title || "").trim();

  if (!title) {

    return res.status(400).json({
      success: false,
      error: "Titre de série manquant."
    });
  }

  const serie = {

    id:
      `series_${Date.now()}`,

    title,

    episodes: [],

    createdAt:
      new Date().toISOString()
  };

  cineflowSeries.unshift(serie);

  res.json({
    success: true,
    series: serie
  });
});


/* =========================================================
   FORMATS
   ========================================================= */

app.get("/api/formats", (req, res) => {

  res.json({
    success: true,
    formats:
      buildPlatformFormats()
  });
});


/* =========================================================
   BUDGET IA
   ========================================================= */

app.get("/api/ai-budget", (req, res) => {

  res.json({
    success: true,
    budget:
      buildAIBudget()
  });
});


/* =========================================================
   CINEFLOW BRAIN
   ========================================================= */

app.post("/api/cineflow-brain", (req, res) => {

  res.json({
    success: true,
    brain:
      buildCineflowBrain()
  });
});


/* =========================================================
   PAGE CINEFLOW STUDIO
   ========================================================= */

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
}

body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: #080d18;
  color: #ffffff;
}

button {
  border: 0;
  border-radius: 12px;
  padding: 13px 18px;
  cursor: pointer;
  font-weight: bold;
}

button:disabled {
  opacity: .5;
  cursor: not-allowed;
}

input,
textarea,
select {
  width: 100%;
  padding: 13px;
  border-radius: 10px;
  border: 1px solid #26334d;
  background: #10192b;
  color: white;
}

.container {
  width: min(1200px, 94%);
  margin: auto;
}

header {
  padding: 20px 0;
  border-bottom: 1px solid #1b263a;
  background: #0a1120;
  position: sticky;
  top: 0;
  z-index: 10;
}

.logo {
  font-size: 24px;
  font-weight: 900;
}

.logo span {
  color: #7c5cff;
}

nav {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 15px;
}

nav button {
  background: #151f33;
  color: white;
}

section {
  margin: 25px 0;
}

.card {
  background: #10192b;
  border: 1px solid #1e2b43;
  border-radius: 18px;
  padding: 20px;
  margin-bottom: 18px;
}

.hero {
  padding: 35px 0;
}

.hero h1 {
  font-size: clamp(30px, 6vw, 56px);
  margin-bottom: 10px;
}

.hero p {
  color: #9eabc1;
}

.primary {
  background: #7c5cff;
  color: white;
}

.success {
  background: #22c55e;
  color: white;
}

.secondary {
  background: #26334d;
  color: white;
}

.danger {
  background: #ef4444;
  color: white;
}

.chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 15px 0;
}

.chips button {
  background: #18243a;
  color: white;
}

.chips button.active {
  background: #7c5cff;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fit, minmax(220px, 1fr));
  gap: 15px;
}

.stat {
  background: #111d31;
  padding: 20px;
  border-radius: 16px;
}

.stat strong {
  display: block;
  font-size: 30px;
  margin-top: 8px;
}

.small {
  color: #9eabc1;
  font-size: 14px;
}

.scene {
  border-left: 3px solid #7c5cff;
  padding: 15px;
  margin: 12px 0;
  background: #0d1627;
  border-radius: 10px;
}

.scene img,
.preview {
  width: 100%;
  max-width: 600px;
  border-radius: 12px;
  margin-top: 12px;
}

pre {
  white-space: pre-wrap;
  word-break: break-word;
  color: #c8d3e6;
}

.idea {
  background: #0d1627;
  padding: 15px;
  border-radius: 12px;
  margin-bottom: 10px;
}

.badge {
  display: inline-block;
  padding: 5px 9px;
  border-radius: 20px;
  background: #26334d;
  font-size: 12px;
}

#status {
  padding: 12px;
  border-radius: 10px;
  background: #111d31;
  margin-top: 12px;
}

footer {
  padding: 40px 0;
  text-align: center;
  color: #77859d;
}

</style>

</head>

<body>

<header>

<div class="container">

<div class="logo">
🎬 <span>Cineflow</span> Studio
</div>

<nav>

<button onclick="showSection('creation')">
Créer
</button>

<button onclick="showSection('dashboard')">
Dashboard
</button>

<button onclick="showSection('ideas')">
Idées
</button>

<button onclick="showSection('reports')">
Rapports
</button>

<button onclick="showSection('autopilot')">
Auto-Pilote
</button>

</nav>

</div>

</header>


<main class="container">


<section id="creation">

<div class="hero">

<h1>
Crée tes vidéos avec Cineflow
</h1>

<p>
Ton espace de création assistée par intelligence artificielle.
</p>

<div class="card">

<textarea
id="prompt"
rows="6"
placeholder="Décris la vidéo que tu veux créer..."
></textarea>

<div class="chips">

<button
class="category active"
onclick="selectCategory('Film', this)"
>
Film
</button>

<button
class="category"
onclick="selectCategory('Animation', this)"
>
Animation
</button>

<button
class="category"
onclick="selectCategory('Action', this)"
>
Action
</button>

<button
class="category"
onclick="selectCategory('Drama', this)"
>
Drama
</button>

<button
class="category"
onclick="selectCategory('Football', this)"
>
Football
</button>

</div>

<button
class="primary"
onclick="genererProjet()"
>
🚀 Créer mon projet
</button>

<div id="status">
Cineflow est prêt.
</div>

</div>

</div>


<div class="card">

<h2>📖 Projet généré</h2>

<div id="projectOutput">
Aucun projet pour le moment.
</div>

</div>


<div class="card">

<h2>🧩 Les 5 scènes</h2>

<button
class="primary"
onclick="preparerScenes()"
>
🧩 Préparer les 5 scènes
</button>

<div id="scenesOutput"></div>

</div>


<div class="card">

<h2>🎨 Génération des images</h2>

<button
class="primary"
onclick="genererImages()"
>
🎨 Générer les images
</button>

<div id="imagesOutput"></div>

</div>


<div class="card">

<h2>🎞️ Veo 3.1</h2>

<button
class="primary"
onclick="animerScenes()"
>
🎞️ Animer les 5 scènes
</button>

<div id="animationOutput"></div>

</div>


<div class="card">

<h2>🎬 Vidéo finale</h2>

<button
class="success"
onclick="creerVideo()"
>
🎬 Créer ma vidéo
</button>

<div id="videoOutput"></div>

</div>


<div class="card">

<h2>🎵 Musique</h2>

<button
class="secondary"
onclick="preparerAudio()"
>
🎵 Préparer la musique
</button>

<div id="audioOutput"></div>

</div>


<div class="card">

<h2>🖼️ Miniature</h2>

<button
class="secondary"
onclick="preparerThumbnail()"
>
🖼️ Générer la miniature
</button>

<div id="thumbnailOutput"></div>

</div>


<div class="card">

<h2>📱 Réseaux sociaux</h2>

<button
class="secondary"
onclick="preparerSocial()"
>
📱 Préparer les publications
</button>

<div id="socialOutput"></div>

</div>

</section>


<section id="dashboard" style="display:none">

<h2>📊 Dashboard Cineflow</h2>

<div class="grid">

<div class="stat">
<div class="small">Vidéos créées</div>
<strong id="statVideos">0</strong>
</div>

<div class="stat">
<div class="small">Vidéos publiées</div>
<strong id="statPublished">0</strong>
</div>

<div class="stat">
<div class="small">Vues</div>
<strong id="statViews">0</strong>
</div>

<div class="stat">
<div class="small">Likes</div>
<strong id="statLikes">0</strong>
</div>

<div class="stat">
<div class="small">Abonnés</div>
<strong id="statSubscribers">0</strong>
</div>

<div class="stat">
<div class="small">Revenus estimés</div>
<strong id="statRevenue">0 FCFA</strong>
</div>

</div>

<div class="card">

<h3>🧠 Cineflow Brain</h3>

<div id="brainOutput">
Chargement...
</div>

</div>

<div class="card">

<h3>💰 Budget IA</h3>

<div id="budgetOutput">
Chargement...
</div>

</div>

</section>


<section id="ideas" style="display:none">

<h2>💡 Idées Cineflow</h2>

<div class="chips">

<button onclick="genererIdees('Film')">
Film
</button>

<button onclick="genererIdees('Animation')">
Animation
</button>

<button onclick="genererIdees('Action')">
Action
</button>

<button onclick="genererIdees('Drama')">
Drama
</button>

<button onclick="genererIdees('Football')">
Football
</button>

</div>

<div id="ideasOutput"></div>

</section>


<section id="reports" style="display:none">

<h2>📈 Rapports</h2>

<div class="card">

<h3>Rapport hebdomadaire</h3>

<div id="weeklyOutput">
Chargement...
</div>

</div>

<div class="card">

<h3>Rapport mensuel</h3>

<div id="monthlyOutput">
Chargement...
</div>

</div>

<div class="card">

<h3>🎯 Objectif hebdomadaire</h3>

<input
id="weeklyGoal"
type="number"
min="1"
value="10"
>

<br><br>

<button
class="primary"
onclick="saveWeeklyGoal()"
>
Enregistrer
</button>

</div>

</section>


<section id="autopilot" style="display:none">

<h2>🤖 Auto-Pilote Cineflow</h2>

<div class="card">

<p>
Cineflow pourra progressivement automatiser
toute la chaîne de production.
</p>

<div id="autopilotOutput">
Chargement...
</div>

</div>

<div class="card">

<h3>🌍 Plateformes</h3>

<div id="formatsOutput">
Chargement...
</div>

</div>

<div class="card">

<h3>🔗 Comptes</h3>

<div id="accountsOutput">
Chargement...
</div>

</div>

</section>


</main>


<footer>
Cineflow — Création vidéo assistée par IA
</footer>


<script>

let selectedCategory = "Film";

let currentProject = null;
let currentScenes = [];
let currentImages = [];
let currentClips = [];
let currentJobId = null;


/* =========================================================
   NAVIGATION
   ========================================================= */

function showSection(id) {

  const sections = [
    "creation",
    "dashboard",
    "ideas",
    "reports",
    "autopilot"
  ];

  sections.forEach(section => {

    const element =
      document.getElementById(section);

    if (element) {
      element.style.display =
        section === id ? "block" : "none";
    }
  });

  if (id === "dashboard") {
    chargerDashboard();
  }

  if (id === "ideas") {
    genererIdees("Film");
  }

  if (id === "reports") {
    chargerRapports();
  }

  if (id === "autopilot") {
    chargerAutopilot();
  }
}


/* =========================================================
   CATÉGORIE
   ========================================================= */

function selectCategory(category, button) {

  selectedCategory = category;

  document
    .querySelectorAll(".category")
    .forEach(btn =>
      btn.classList.remove("active")
    );

  if (button) {
    button.classList.add("active");
  }
}


/* =========================================================
   STATUS
   ========================================================= */

function setStatus(message) {

  const element =
    document.getElementById("status");

  if (element) {
    element.textContent = message;
  }
}


/* =========================================================
   CRÉER PROJET
   ========================================================= */

async function genererProjet() {

  const prompt =
    document.getElementById("prompt").value.trim();

  if (!prompt) {

    setStatus(
      "Décris d'abord ton idée."
    );

    return;
  }

  setStatus(
    "⏳ Cineflow crée ton projet..."
  );

  try {

    const response =
      await fetch("/api/generate", {

        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          prompt,
          category:
            selectedCategory
        })
      });

    const data =
      await response.json();

    if (!data.success) {
      throw new Error(data.error);
    }

    currentProject =
      data.project;

    document.getElementById(
      "projectOutput"
    ).innerHTML = `

      <h3>${escapeHtml(
        currentProject.titre || ""
      )}</h3>

      <p>${escapeHtml(
        currentProject.concept || ""
      )}</p>

      <p>
        <b>Style :</b>
        ${escapeHtml(
          currentProject.style || ""
        )}
      </p>

      <pre>${escapeHtml(
        JSON.stringify(
          currentProject,
          null,
          2
        )
      )}</pre>
    `;

    setStatus(
      "✅ Projet créé."
    );

  } catch (error) {

    setStatus(
      "❌ " + error.message
    );
  }
}


/* =========================================================
   PRÉPARER SCÈNES
   ========================================================= */

async function preparerScenes() {

  if (!currentProject) {

    setStatus(
      "Crée d'abord un projet."
    );

    return;
  }

  setStatus(
    "⏳ Préparation des 5 scènes..."
  );

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
              currentProject
          })
        }
      );

    const data =
      await response.json();

    if (!data.success) {
      throw new Error(data.error);
    }

    currentScenes =
      data.scenes;

    afficherScenes();

    setStatus(
      "✅ Les 5 scènes sont prêtes."
    );

  } catch (error) {

    setStatus(
      "❌ " + error.message
    );
  }
}


/* =========================================================
   AFFICHER SCÈNES
   ========================================================= */

function afficherScenes() {

  const output =
    document.getElementById(
      "scenesOutput"
    );

  output.innerHTML = "";

  currentScenes.forEach(
    (scene, index) => {

      const div =
        document.createElement("div");

      div.className =
        "scene";

      div.innerHTML = `

        <h3>
          Scène ${index + 1}
          — ${escapeHtml(
            scene.titre || ""
          )}
        </h3>

        <p>
          ${escapeHtml(
            scene.description || ""
          )}
        </p>

        <div class="small">
          ${escapeHtml(
            scene.promptImage || ""
          )}
        </div>
      `;

      output.appendChild(div);
    }
  );
}


/* =========================================================
   IMAGES
   ========================================================= */

async function genererImages() {

  if (currentScenes.length !== 5) {

    setStatus(
      "Prépare d'abord les 5 scènes."
    );

    return;
  }

  currentImages = [];

  const output =
    document.getElementById(
      "imagesOutput"
    );

  output.innerHTML = "";

  for (
    let i = 0;
    i < currentScenes.length;
    i++
  ) {

    setStatus(
      `🎨 Génération image ${i + 1}/5...`
    );

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
              scene:
                currentScenes[i]
            })
          }
        );

      const data =
        await response.json();

      if (!data.success) {
        throw new Error(
          data.error
        );
      }

      currentImages[i] =
        data.image;

      output.innerHTML += `

        <div class="scene">

          <h3>
            Image scène ${i + 1}
          </h3>

          <img
            class="preview"
            src="data:image/jpeg;base64,${data.image}"
          >

        </div>
      `;

    } catch (error) {

      output.innerHTML += `

        <div class="scene">

          ❌ Scène ${i + 1} :
          ${escapeHtml(
            error.message
          )}

        </div>
      `;
    }
  }

  setStatus(
    "🎨 Génération des images terminée."
  );
}


/* =========================================================
   ANIMATION
   ========================================================= */

async function animerScenes() {

  if (currentScenes.length !== 5) {

    setStatus(
      "Prépare d'abord les 5 scènes."
    );

    return;
  }

  setStatus(
    "🎞️ Mise en file des 5 scènes..."
  );

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
            scenes:
              currentScenes
          })
        }
      );

    const data =
      await response.json();

    if (!data.success) {
      throw new Error(
        data.error
      );
    }

    currentJobId =
      data.jobId;

    pollAnimation();

  } catch (error) {

    setStatus(
      "❌ " + error.message
    );
  }
}


/* =========================================================
   POLL ANIMATION
   ========================================================= */

async function pollAnimation() {

  if (!currentJobId) return;

  try {

    const response =
      await fetch(
        `/api/animation-status/${currentJobId}`
      );

    const data =
      await response.json();

    if (!data.success) {
      throw new Error(
        data.error
      );
    }

    document.getElementById(
      "animationOutput"
    ).innerHTML = `

      <p>
        ${data.job.statuses
          .map(
            (status, i) =>
              `Scène ${i + 1} :
              <b>${status}</b>`
          )
          .join("<br>")}
      </p>
    `;

    if (data.job.completed) {

      currentClips = [];

      for (let i = 0; i < 5; i++) {

        const sceneResponse =
          await fetch(
            `/api/animation-scene/${currentJobId}/${i}`
          );

        const sceneData =
          await sceneResponse.json();

        if (
          sceneData.success &&
          sceneData.video
        ) {

          currentClips[i] =
            sceneData.video;
        }
      }

      setStatus(
        "✅ Les 5 scènes sont animées."
      );

      return;
    }

    setTimeout(
      pollAnimation,
      5000
    );

  } catch (error) {

    setStatus(
      "❌ " + error.message
    );
  }
}


/* =========================================================
   VIDÉO FINALE
   ========================================================= */

async function creerVideo() {

  if (currentClips.length !== 5) {

    setStatus(
      "Anime d'abord les 5 scènes."
    );

    return;
  }

  setStatus(
    "🎬 Création de la vidéo finale..."
  );

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
              currentClips,

            project:
              currentProject
          })
        }
      );

    const data =
      await response.json();

    if (!data.success) {
      throw new Error(
        data.error
      );
    }

    document.getElementById(
      "videoOutput"
    ).innerHTML = `

      <a
        href="${data.downloadUrl}"
        target="_blank"
      >
        <button class="success">
          ⬇️ Télécharger ma vidéo
        </button>
      </a>
    `;

    setStatus(
      "🎉 Ta vidéo est prête !"
    );

  } catch (error) {

    setStatus(
      "❌ " + error.message
    );
  }
}


/* =========================================================
   AUDIO
   ========================================================= */

async function preparerAudio() {

  if (!currentProject) {

    setStatus(
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
              currentProject
          })
        }
      );

    const data =
      await response.json();

    if (!data.success) {
      throw new Error(
        data.error
      );
    }

    document.getElementById(
      "audioOutput"
    ).innerHTML = `

      <p>
        🎵 Musique prête.
        <span class="badge">
          ${data.provider}
        </span>
      </p>

      <audio
        controls
        src="data:audio/mpeg;base64,${data.audio}"
      ></audio>
    `;

  } catch (error) {

    setStatus(
      "❌ " + error.message
    );
  }
}


/* =========================================================
   MINIATURE
   ========================================================= */

async function preparerThumbnail() {

  if (!currentProject) {

    setStatus(
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
              currentProject
          })
        }
      );

    const data =
      await response.json();

    if (!data.success) {
      throw new Error(
        data.error
      );
    }

    document.getElementById(
      "thumbnailOutput"
    ).innerHTML = `

      <img
        class="preview"
        src="data:image/jpeg;base64,${data.image}"
      >
    `;

  } catch (error) {

    setStatus(
      "❌ " + error.message
    );
  }
}


/* =========================================================
   SOCIAL
   ========================================================= */

async function preparerSocial() {

  if (!currentProject) {

    setStatus(
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
              currentProject
          })
        }
      );

    const data =
      await response.json();

    if (!data.success) {
      throw new Error(
        data.error
      );
    }

    document.getElementById(
      "socialOutput"
    ).innerHTML = `

      <pre>${escapeHtml(
        JSON.stringify(
          data.social,
          null,
          2
        )
      )}</pre>
    `;

  } catch (error) {

    setStatus(
      "❌ " + error.message
    );
  }
}


/* =========================================================
   DASHBOARD
   ========================================================= */

async function chargerDashboard() {

  try {

    const response =
      await fetch(
        "/api/dashboard"
      );

    const data =
      await response.json();

    if (!data.success) return;

    const stats =
      data.stats;

    document.getElementById(
      "statVideos"
    ).textContent =
      stats.videosCreated;

    document.getElementById(
      "statPublished"
    ).textContent =
      stats.videosPublished;

    document.getElementById(
      "statViews"
    ).textContent =
      stats.views;

    document.getElementById(
      "statLikes"
    ).textContent =
      stats.likes;

    document.getElementById(
      "statSubscribers"
    ).textContent =
      stats.subscribers;

    document.getElementById(
      "statRevenue"
    ).textContent =
      `${stats.estimatedRevenue} FCFA`;

    document.getElementById(
      "brainOutput"
    ).innerHTML = `

      <p>
        <b>${data.brain.name}</b>
      </p>

      <p>
        ${escapeHtml(
          data.brain.mission
        )}
      </p>

      <p>
        ${data.brain.pipeline.join(
          " → "
        )}
      </p>
    `;

    document.getElementById(
      "budgetOutput"
    ).innerHTML = `

      <p>
        Mode :
        <b>${data.budget.mode}</b>
      </p>

      <p>
        ${data.budget.status}
      </p>
    `;

  } catch (error) {

    console.error(error);
  }
}


/* =========================================================
   IDÉES
   ========================================================= */

async function genererIdees(category) {

  try {

    const response =
      await fetch(
        "/api/generate-ideas",
        {

          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            category,
            count: 5
          })
        }
      );

    const data =
      await response.json();

    if (!data.success) {
      throw new Error(
        data.error
      );
    }

    const output =
      document.getElementById(
        "ideasOutput"
      );

    output.innerHTML = "";

    data.ideas.forEach(
      idea => {

        output.innerHTML += `

          <div class="idea">

            <span class="badge">
              ${escapeHtml(
                idea.category
              )}
            </span>

            <h3>
              ${escapeHtml(
                idea.title
              )}
            </h3>

            <button
              class="primary"
              onclick='utiliserIdee(${JSON.stringify(
                idea.prompt
              )})'
            >
              Utiliser cette idée
            </button>

          </div>
        `;
      }
    );

  } catch (error) {

    console.error(error);
  }
}


function utiliserIdee(prompt) {

  document.getElementById(
    "prompt"
  ).value = prompt;

  showSection(
    "creation"
  );

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}


/* =========================================================
   RAPPORTS
   ========================================================= */

async function chargerRapports() {

  try {

    const weekly =
      await fetch(
        "/api/report/weekly"
      ).then(
        response => response.json()
      );

    const monthly =
      await fetch(
        "/api/report/monthly"
      ).then(
        response => response.json()
      );

    if (weekly.success) {

      const r =
        weekly.report;

      document.getElementById(
        "weeklyOutput"
      ).innerHTML = `

        <p>
          ${r.period}
        </p>

        <p>
          🎬 Vidéos :
          <b>${r.videosCreated}</b>
        </p>

        <p>
          🎯 Objectif :
          <b>${r.weeklyGoal}</b>
        </p>

        <p>
          📊 Progression :
          <b>${r.progress}%</b>
        </p>

        <p>
          👀 Vues :
          ${r.views}
        </p>

        <p>
          ❤️ Likes :
          ${r.likes}
        </p>

        <p>
          👥 Abonnés :
          ${r.subscribers}
        </p>

        <p>
          💰 Revenus :
          ${r.estimatedRevenue} FCFA
        </p>
      `;
    }

    if (monthly.success) {

      const r =
        monthly.report;

      document.getElementById(
        "monthlyOutput"
      ).innerHTML = `

        <p>
          ${r.month}
        </p>

        <p>
          🎬 Vidéos :
          ${r.videosCreated}
        </p>

        <p>
          📤 Publiées :
          ${r.videosPublished}
        </p>

        <p>
          👀 Vues :
          ${r.views}
        </p>

        <p>
          ❤️ Likes :
          ${r.likes}
        </p>

        <p>
          👥 Abonnés :
          ${r.subscribers}
        </p>

        <p>
          💰 Revenus :
          ${r.estimatedRevenue} FCFA
        </p>
      `;
    }

  } catch (error) {

    console.error(error);
  }
}


/* =========================================================
   OBJECTIF
   ========================================================= */

async function saveWeeklyGoal() {

  const goal =
    Number(
      document.getElementById(
        "weeklyGoal"
      ).value
    );

  try {

    await fetch(
      "/api/weekly-goal",
      {

        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          goal
        })
      }
    );

    chargerRapports();

  } catch (error) {

    console.error(error);
  }
}


/* =========================================================
   AUTOPILOTE
   ========================================================= */

async function chargerAutopilot() {

  try {

    const data =
      await fetch(
        "/api/autopilot"
      ).then(
        response => response.json()
      );

    if (!data.success) return;

    const plan =
      data.autopilot;

    document.getElementById(
      "autopilotOutput"
    ).innerHTML = `

      <p>
        <b>Statut :</b>
        ${plan.status}
      </p>

      <p>
        <b>Objectif :</b>
        ${plan.weeklyGoal}
        vidéos/semaine
      </p>

      <ol>
        ${plan.workflow
          .map(
            step =>
              `<li>${escapeHtml(
                step
              )}</li>`
          )
          .join("")}
      </ol>
    `;

    const formats =
      await fetch(
        "/api/formats"
      ).then(
        response => response.json()
      );

    document.getElementById(
      "formatsOutput"
    ).innerHTML = `

      <pre>${escapeHtml(
        JSON.stringify(
          formats.formats,
          null,
          2
        )
      )}</pre>
    `;

    const accounts =
      await fetch(
        "/api/accounts"
      ).then(
        response => response.json()
      );

    document.getElementById(
      "accountsOutput"
    ).innerHTML =
      accounts.accounts
        .map(
          account =>
            `<p>
              ${account.platform}
              —
              <span class="badge">
                ${account.status}
              </span>
            </p>`
        )
        .join("");

  } catch (error) {

    console.error(error);
  }
}


/* =========================================================
   ESCAPE HTML
   ========================================================= */

function escapeHtml(value) {

  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


/* =========================================================
   CHARGEMENT INITIAL
   ========================================================= */

window.addEventListener(
  "load",
  () => {

    chargerDashboard();

  }
);

</script>

</body>

</html>`);
});


/* =========================================================
   404
   ========================================================= */

app.use((req, res) => {

  res.status(404).json({
    success: false,
    error: "Route introuvable."
  });
});


/* =========================================================
   DÉMARRAGE
   ========================================================= */

app.listen(PORT, () => {

  console.log(
    `Cineflow API démarrée sur le port ${PORT}`
  );

});

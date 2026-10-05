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

const ai = API_KEY
  ? new GoogleGenAI({ apiKey: API_KEY })
  : null;

/* =========================================================
   DONNÉES CINEFLOW
========================================================= */

const dashboardProjects = [];
const dashboardSeries = [];

const dashboardAccounts = [
  {
    platform: "YouTube",
    connected: false,
    views: 0,
    likes: 0,
    subscribers: 0,
    revenue: 0
  },
  {
    platform: "TikTok",
    connected: false,
    views: 0,
    likes: 0,
    subscribers: 0,
    revenue: 0
  },
  {
    platform: "Instagram",
    connected: false,
    views: 0,
    likes: 0,
    subscribers: 0,
    revenue: 0
  },
  {
    platform: "Facebook",
    connected: false,
    views: 0,
    likes: 0,
    subscribers: 0,
    revenue: 0
  }
];

const videoFiles = new Map();
const animationJobs = new Map();

/* =========================================================
   OUTILS
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

  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");

  if (first !== -1 && last !== -1 && last > first) {
    return value.slice(first, last + 1);
  }

  return value;
}

function getInteractionText(interaction) {
  if (!interaction) return "";

  if (typeof interaction.output_text === "string") {
    return interaction.output_text;
  }

  if (Array.isArray(interaction.output)) {
    for (const item of interaction.output) {
      if (typeof item.text === "string") {
        return item.text;
      }

      if (item.content && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (typeof block.text === "string") {
            return block.text;
          }
        }
      }
    }
  }

  return "";
}

async function generateTextInteraction(prompt) {
  if (!ai) {
    throw new Error("GEMINI_API_KEY est absente de Render.");
  }

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt
  });

  return response.text || "";
}

async function generateImage(prompt) {
  if (!ai) {
    throw new Error("GEMINI_API_KEY est absente.");
  }

  const interaction = await ai.interactions.create({
    model: IMAGE_MODEL,
    input: prompt,
    response_format: {
      type: "image",
      mime_type: "image/png",
      aspect_ratio: "16:9",
      image_size: "1K"
    }
  });

  if (
    interaction &&
    interaction.output_image &&
    interaction.output_image.data
  ) {
    return {
      base64: interaction.output_image.data,
      mimeType: "image/png"
    };
  }

  if (interaction && Array.isArray(interaction.steps)) {
    for (const step of interaction.steps) {
      if (step.type !== "model_output") continue;
      if (!Array.isArray(step.content)) continue;

      for (const block of step.content) {
        if (block.type === "image" && block.data) {
          return {
            base64: block.data,
            mimeType: block.mime_type || "image/png"
          };
        }
      }
    }
  }

  throw new Error("Aucune image n'a été retournée par Gemini.");
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      args,
      {
        maxBuffer: 50 * 1024 * 1024
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
   AUDIO
========================================================= */

function detectMood(project) {
  const text = JSON.stringify(project || {}).toLowerCase();

  if (
    text.includes("action") ||
    text.includes("football") ||
    text.includes("combat") ||
    text.includes("victoire")
  ) {
    return "énergique";
  }

  if (
    text.includes("drame") ||
    text.includes("triste") ||
    text.includes("difficulté")
  ) {
    return "émotionnel";
  }

  if (
    text.includes("animation") ||
    text.includes("aventure")
  ) {
    return "aventure";
  }

  return "cinématique";
}

function buildAudioPlan(project) {
  const mood = detectMood(project);

  return {
    mood,
    bpm: mood === "énergique" ? 125 : 95,
    duration: 40,
    description:
      "Musique instrumentale originale adaptée au rythme de l'histoire."
  };
}

async function generateFallbackAudio(outputPath, duration = 40) {
  await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=stereo",
    "-t",
    String(duration),
    "-q:a",
    "9",
    "-acodec",
    "libmp3lame",
    "-y",
    outputPath
  ]);

  return outputPath;
}

async function generateAudioTrack(project) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cineflow-audio-")
  );

  const outputPath = path.join(dir, "music.mp3");

  await generateFallbackAudio(outputPath, 40);

  return {
    path: outputPath,
    plan: buildAudioPlan(project)
  };
}

/* =========================================================
   TENDANCES
========================================================= */

function buildTrendPrompt(project) {
  return `
Tu es le moteur créatif de Cineflow.

Crée 5 idées de vidéos ORIGINALES inspirées des tendances
générales des plateformes vidéo.

Plateformes :
YouTube, TikTok, Instagram, Facebook.

Catégorie :
${project?.category || "cinéma"}

Idée actuelle :
${project?.idea || ""}

IMPORTANT :
- Ne copie aucune vidéo existante.
- Ne donne aucun lien.
- Ne prétends pas disposer de statistiques en temps réel.
- Les idées doivent être originales.
- Donne un hook fort.
- Donne une raison expliquant pourquoi le concept peut intéresser
  les spectateurs.

Réponds uniquement en JSON :

{
  "ideas": [
    {
      "title": "",
      "platform": "",
      "category": "",
      "hook": "",
      "concept": "",
      "reason": ""
    }
  ]
}
`;
}

async function generateTrendIdeas(project) {
  const text = await generateTextInteraction(
    buildTrendPrompt(project)
  );

  try {
    const parsed = JSON.parse(cleanJson(text));

    return parsed.ideas || [];
  } catch {
    return [
      {
        title: "Le dernier match",
        platform: "TikTok",
        category: "football",
        hook: "Tout semblait perdu...",
        concept:
          "Une histoire courte et cinématique autour d'un jeune joueur.",
        reason:
          "Le suspense et l'émotion peuvent créer une forte rétention."
      },
      {
        title: "Une décision qui change tout",
        platform: "YouTube",
        category: "drame",
        hook:
          "Il n'avait que quelques secondes pour choisir.",
        concept:
          "Une histoire dramatique avec une décision inattendue.",
        reason:
          "Le suspense encourage les spectateurs à rester jusqu'à la fin."
      },
      {
        title: "Le monde de demain",
        platform: "Instagram",
        category: "animation",
        hook:
          "En 2050, cette chose est devenue normale.",
        concept:
          "Une courte fiction futuriste.",
        reason:
          "Le concept visuel se prête bien à des scènes courtes."
      },
      {
        title: "Le défi impossible",
        platform: "TikTok",
        category: "action",
        hook:
          "Personne ne pensait qu'il réussirait.",
        concept:
          "Une aventure rapide en cinq scènes.",
        reason:
          "Le rythme permet de créer un hook immédiatement."
      },
      {
        title: "Une histoire qui inspire",
        platform: "Facebook",
        category: "drame",
        hook:
          "Il a commencé avec presque rien.",
        concept:
          "Une histoire de progression et de réussite.",
        reason:
          "Les récits humains peuvent favoriser les réactions et les partages."
      }
    ];
  }
}

/* =========================================================
   PROJETS
========================================================= */

function makeDashboardProject(project, status = "Créé") {
  const item = {
    id:
      "project_" +
      Date.now() +
      "_" +
      Math.random().toString(36).slice(2, 8),

    title:
      project?.title ||
      project?.idea ||
      "Projet Cineflow",

    category:
      project?.category ||
      "cinéma",

    status,

    createdAt:
      new Date().toISOString(),

    scenes:
      project?.scenes || [],

    data:
      project || {}
  };

  dashboardProjects.unshift(item);

  if (dashboardProjects.length > 50) {
    dashboardProjects.pop();
  }

  return item;
}

function getProjectById(id) {
  return dashboardProjects.find(
    project => project.id === id
  );
}

/* =========================================================
   GÉNÉRATION DU PROJET
========================================================= */

async function generateProject(idea, category) {
  const prompt = `
Tu es Cineflow, un studio de création vidéo IA.

Crée un projet vidéo original.

Catégorie :
${category || "cinéma"}

Idée de départ :
${idea || "Créer une histoire captivante."}

Le projet doit contenir exactement 5 scènes.

Chaque scène doit avoir :
- un numéro
- un titre
- une description
- un prompt visuel cinématique
- un prompt d'animation
- une durée

Garde les personnages cohérents entre les scènes.

Réponds uniquement avec ce JSON :

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
      "visualPrompt": "",
      "animationPrompt": "",
      "duration": 8
    }
  ],
  "thumbnailPrompt": "",
  "socialPosts": {
    "youtube": "",
    "tiktok": "",
    "instagram": "",
    "facebook": ""
  }
}
`;

  const text =
    await generateTextInteraction(prompt);

  const parsed =
    JSON.parse(cleanJson(text));

  if (
    !parsed.scenes ||
    !Array.isArray(parsed.scenes)
  ) {
    throw new Error(
      "Gemini n'a pas retourné les scènes."
    );
  }

  parsed.scenes =
    parsed.scenes
      .slice(0, 5)
      .map((scene, index) => ({
        number: index + 1,

        title:
          scene.title ||
          `Scène ${index + 1}`,

        description:
          scene.description || "",

        visualPrompt:
          scene.visualPrompt ||
          scene.description ||
          "",

        animationPrompt:
          scene.animationPrompt ||
          scene.description ||
          "",

        duration:
          Number(scene.duration) || 8
      }));

  return parsed;
}

/* =========================================================
   TEST GEMINI
========================================================= */

app.get("/api/test-gemini", async (req, res) => {
  try {
    const text =
      await generateTextInteraction(
        "Réponds exactement : Je vous confirme que Gemini est correctement connecté à Cineflow."
      );

    res.json({
      success: true,
      message: text
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   CRÉER UN PROJET
========================================================= */

app.post("/api/generate", async (req, res) => {
  try {
    const {
      idea,
      category
    } = req.body || {};

    if (!idea || !String(idea).trim()) {
      return res.status(400).json({
        success: false,
        error: "Décris ton idée de vidéo."
      });
    }

    const project =
      await generateProject(
        String(idea).trim(),
        category || "cinéma"
      );

    project.idea = idea;
    project.category =
      category || "cinéma";

    const dashboardProject =
      makeDashboardProject(
        project,
        "Projet généré"
      );

    res.json({
      success: true,
      project,
      dashboardProject
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
   PRÉPARER LES IMAGES
========================================================= */

app.post("/api/prepare-images", async (req, res) => {
  try {
    const project =
      req.body?.project;

    if (!project) {
      return res.status(400).json({
        success: false,
        error: "Projet manquant."
      });
    }

    const scenes =
      Array.isArray(project.scenes)
        ? project.scenes.slice(0, 5)
        : [];

    if (scenes.length !== 5) {
      return res.status(400).json({
        success: false,
        error:
          "Cineflow doit avoir exactement 5 scènes."
      });
    }

    const preparedScenes =
      scenes.map((scene, index) => ({
        number: index + 1,

        title:
          scene.title ||
          `Scène ${index + 1}`,

        prompt:
          scene.visualPrompt ||
          scene.description ||
          "",

        image: null,

        status: "ready"
      }));

    res.json({
      success: true,
      scenes: preparedScenes
    });
  } catch (error) {
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
    const prompt =
      req.body?.prompt;

    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: "Prompt image manquant."
      });
    }

    const image =
      await generateImage(prompt);

    res.json({
      success: true,
      image: image.base64,
      mimeType: image.mimeType
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

async function animateScene(prompt, duration = 8) {
  if (!ai) {
    throw new Error(
      "GEMINI_API_KEY est absente de Render."
    );
  }

  const operation =
    await ai.models.generateVideos({
      model: VIDEO_MODEL,
      prompt,
      config: {
        durationSeconds: duration
      }
    });

  let currentOperation =
    operation;

  while (
    currentOperation &&
    !currentOperation.done
  ) {
    await sleep(10000);

    currentOperation =
      await ai.operations.getVideosOperation(
        currentOperation
      );
  }

  if (
    !currentOperation ||
    !currentOperation.response
  ) {
    throw new Error(
      "La génération vidéo n'a retourné aucun résultat."
    );
  }

  const generated =
    currentOperation.response.generatedVideos;

  if (
    !generated ||
    !generated.length
  ) {
    throw new Error(
      "Aucune vidéo générée."
    );
  }

  const video =
    generated[0];

  const dir =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        "cineflow-video-"
      )
    );

  const outputPath =
    path.join(
      dir,
      "scene.mp4"
    );

  if (
    video.video &&
    video.video.uri
  ) {
    await ai.files.download({
      file: video.video,
      path: outputPath
    });
  } else {
    throw new Error(
      "Fichier vidéo introuvable."
    );
  }

  return outputPath;
}

/* =========================================================
   ANIMER UNE SCÈNE
========================================================= */

app.post("/api/animate-scene", async (req, res) => {
  try {
    const {
      prompt,
      duration
    } = req.body || {};

    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: "Prompt d'animation manquant."
      });
    }

    const output =
      await animateScene(
        prompt,
        Number(duration) || 8
      );

    res.json({
      success: true,
      path: output
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
   JOB ANIMATION 5 SCÈNES
========================================================= */

async function processAnimationJob(jobId) {
  const job =
    animationJobs.get(jobId);

  if (!job) return;

  job.status = "running";

  for (
    let i = 0;
    i < job.scenes.length;
    i++
  ) {
    const scene =
      job.scenes[i];

    if (
      scene.status === "completed"
    ) {
      continue;
    }

    scene.status = "generating";
    job.currentScene = i + 1;

    try {
      const output =
        await animateScene(
          scene.animationPrompt ||
          scene.prompt ||
          scene.description,
          Number(scene.duration) || 8
        );

      scene.videoPath = output;
      scene.status = "completed";
    } catch (error) {
      scene.status = "error";
      scene.error =
        error.message;

      job.status = "error";

      return;
    }
  }

  job.status = "completed";
  job.currentScene = 5;
}

app.post("/api/animate-scenes", async (req, res) => {
  try {
    const scenes =
      req.body?.scenes;

    if (
      !Array.isArray(scenes) ||
      scenes.length !== 5
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Il faut exactement 5 scènes."
      });
    }

    const jobId =
      "job_" +
      Date.now() +
      "_" +
      Math.random()
        .toString(36)
        .slice(2, 8);

    const job = {
      id: jobId,
      status: "queued",
      currentScene: 0,
      createdAt:
        new Date().toISOString(),

      scenes:
        scenes.map((scene, index) => ({
          number: index + 1,

          title:
            scene.title ||
            `Scène ${index + 1}`,

          prompt:
            scene.prompt ||
            scene.visualPrompt ||
            scene.description ||
            "",

          animationPrompt:
            scene.animationPrompt ||
            scene.prompt ||
            scene.description ||
            "",

          duration:
            Number(scene.duration) || 8,

          status: "waiting",

          videoPath: null,

          error: null
        }))
    };

    animationJobs.set(
      jobId,
      job
    );

    processAnimationJob(
      jobId
    ).catch(error => {
      const current =
        animationJobs.get(jobId);

      if (current) {
        current.status = "error";
        current.error =
          error.message;
      }
    });

    res.json({
      success: true,
      jobId
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

app.get(
  "/api/animation-status/:jobId",
  (req, res) => {
    const job =
      animationJobs.get(
        req.params.jobId
      );

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job introuvable."
      });
    }

    res.json({
      success: true,
      job
    });
  }
);

/* =========================================================
   VIDÉO D'UNE SCÈNE
========================================================= */

app.get(
  "/api/animation-scene/:jobId/:sceneIndex",
  (req, res) => {
    const job =
      animationJobs.get(
        req.params.jobId
      );

    if (!job) {
      return res.status(404).send(
        "Job introuvable."
      );
    }

    const index =
      Number(req.params.sceneIndex);

    const scene =
      job.scenes[index];

    if (
      !scene ||
      !scene.videoPath
    ) {
      return res.status(404).send(
        "Vidéo introuvable."
      );
    }

    if (
      !fs.existsSync(
        scene.videoPath
      )
    ) {
      return res.status(404).send(
        "Fichier vidéo indisponible."
      );
    }

    res.sendFile(
      scene.videoPath
    );
  }
);

/* =========================================================
   RETRY ANIMATION
========================================================= */

app.post("/api/animation-retry", async (req, res) => {
  try {
    const {
      jobId,
      sceneIndex
    } = req.body || {};

    const job =
      animationJobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job introuvable."
      });
    }

    const index =
      Number(sceneIndex);

    const scene =
      job.scenes[index];

    if (!scene) {
      return res.status(404).json({
        success: false,
        error: "Scène introuvable."
      });
    }

    scene.status = "waiting";
    scene.error = null;

    processAnimationJob(
      jobId
    ).catch(error => {
      job.status = "error";
      job.error =
        error.message;
    });

    res.json({
      success: true,
      message:
        "Nouvelle tentative lancée."
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

app.post(
  "/api/animation-regenerate",
  async (req, res) => {
    try {
      const {
        jobId,
        sceneIndex,
        prompt
      } = req.body || {};

      const job =
        animationJobs.get(jobId);

      if (!job) {
        return res.status(404).json({
          success: false,
          error: "Job introuvable."
        });
      }

      const index =
        Number(sceneIndex);

      const scene =
        job.scenes[index];

      if (!scene) {
        return res.status(404).json({
          success: false,
          error: "Scène introuvable."
        });
      }

      if (prompt) {
        scene.animationPrompt =
          prompt;
      }

      scene.status = "waiting";
      scene.error = null;

      processAnimationJob(
        jobId
      ).catch(error => {
        job.status = "error";
        job.error =
          error.message;
      });

      res.json({
        success: true,
        message:
          "Régénération lancée."
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   CRÉER LA VIDÉO FINALE
========================================================= */

app.post("/api/create-video", async (req, res) => {
  try {
    const {
      jobId
    } = req.body || {};

    const job =
      animationJobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job introuvable."
      });
    }

    const completed =
      job.scenes.every(
        scene =>
          scene.status === "completed" &&
          scene.videoPath &&
          fs.existsSync(
            scene.videoPath
          )
      );

    if (!completed) {
      return res.status(400).json({
        success: false,
        error:
          "Les 5 scènes doivent être terminées."
      });
    }

    const dir =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "cineflow-final-"
        )
      );

    const concatFile =
      path.join(
        dir,
        "concat.txt"
      );

    const outputPath =
      path.join(
        dir,
        "cineflow-final.mp4"
      );

    const lines =
      job.scenes.map(
        scene =>
          `file '${scene.videoPath.replace(/'/g, "'\\''")}'`
      );

    fs.writeFileSync(
      concatFile,
      lines.join("\n")
    );

    await runFfmpeg([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatFile,
      "-c",
      "copy",
      "-y",
      outputPath
    ]);

    const videoId =
      "video_" +
      Date.now();

    videoFiles.set(
      videoId,
      outputPath
    );

    res.json({
      success: true,
      videoId
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
   TÉLÉCHARGER VIDÉO
========================================================= */

app.get(
  "/api/download-video/:videoId",
  (req, res) => {
    const file =
      videoFiles.get(
        req.params.videoId
      );

    if (!file) {
      return res.status(404).send(
        "Vidéo introuvable."
      );
    }

    if (!fs.existsSync(file)) {
      return res.status(404).send(
        "Fichier vidéo indisponible."
      );
    }

    res.download(
      file,
      "cineflow-video.mp4"
    );
  }
);

/* =========================================================
   AUDIO
========================================================= */

app.post("/api/prepare-audio", async (req, res) => {
  try {
    const project =
      req.body?.project || {};

    const audio =
      await generateAudioTrack(
        project
      );

    res.json({
      success: true,
      plan: audio.plan
    });
  } catch (error) {
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
    const {
      prompt,
      project
    } = req.body || {};

    const finalPrompt =
      prompt ||
      project?.thumbnailPrompt ||
      project?.title ||
      "Cinématique spectaculaire";

    const image =
      await generateImage(
        `${finalPrompt}. YouTube thumbnail, cinematic composition, highly attractive, dramatic lighting, 16:9.`
      );

    res.json({
      success: true,
      image: image.base64,
      mimeType: image.mimeType
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
    const project =
      req.body?.project || {};

    const prompt = `
Crée les textes de publication pour ce projet vidéo Cineflow.

Titre :
${project.title || ""}

Concept :
${project.concept || ""}

Réponds uniquement en JSON :

{
  "youtube": "",
  "tiktok": "",
  "instagram": "",
  "facebook": ""
}
`;

    const text =
      await generateTextInteraction(
        prompt
      );

    const posts =
      JSON.parse(
        cleanJson(text)
      );

    res.json({
      success: true,
      posts
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   AUTO-PILOTE
========================================================= */

app.post("/api/autopilot-plan", async (req, res) => {
  try {
    const {
      idea,
      category
    } = req.body || {};

    if (!idea) {
      return res.status(400).json({
        success: false,
        error: "Idée manquante."
      });
    }

    const steps = [
      {
        id: 1,
        title: "Créer le concept",
        status: "ready"
      },
      {
        id: 2,
        title: "Créer le scénario",
        status: "waiting"
      },
      {
        id: 3,
        title: "Préparer les 5 scènes",
        status: "waiting"
      },
      {
        id: 4,
        title: "Générer les images",
        status: "waiting"
      },
      {
        id: 5,
        title: "Animer les scènes",
        status: "waiting"
      },
      {
        id: 6,
        title: "Créer la vidéo finale",
        status: "waiting"
      },
      {
        id: 7,
        title: "Préparer l'audio",
        status: "waiting"
      },
      {
        id: 8,
        title: "Préparer la miniature",
        status: "waiting"
      },
      {
        id: 9,
        title: "Préparer les publications",
        status: "waiting"
      }
    ];

    res.json({
      success: true,
      idea,
      category:
        category || "cinéma",
      steps
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   TENDANCES API
========================================================= */

app.post("/api/trends", async (req, res) => {
  try {
    const ideas =
      await generateTrendIdeas(
        req.body || {}
      );

    res.json({
      success: true,
      ideas
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   DASHBOARD
========================================================= */

app.get("/api/dashboard", (req, res) => {
  const views =
    dashboardAccounts.reduce(
      (sum, account) =>
        sum + account.views,
      0
    );

  const likes =
    dashboardAccounts.reduce(
      (sum, account) =>
        sum + account.likes,
      0
    );

  const subscribers =
    dashboardAccounts.reduce(
      (sum, account) =>
        sum + account.subscribers,
      0
    );

  const revenue =
    dashboardAccounts.reduce(
      (sum, account) =>
        sum + account.revenue,
      0
    );

  res.json({
    success: true,

    stats: {
      projects:
        dashboardProjects.length,
      views,
      likes,
      subscribers,
      revenue
    },

    recentProjects:
      dashboardProjects.slice(
        0,
        6
      ),

    accounts:
      dashboardAccounts
  });
});

/* =========================================================
   PROJETS
========================================================= */

app.get("/api/projects", (req, res) => {
  res.json({
    success: true,
    projects:
      dashboardProjects
  });
});

app.get(
  "/api/projects/status",
  (req, res) => {
    res.json({
      success: true,
      projects:
        dashboardProjects.map(
          project => ({
            id: project.id,
            title: project.title,
            status: project.status,
            createdAt:
              project.createdAt
          })
        )
    });
  }
);

/* =========================================================
   COMPTES
========================================================= */

app.get("/api/accounts", (req, res) => {
  res.json({
    success: true,
    accounts:
      dashboardAccounts
  });
});

app.post(
  "/api/accounts/connect",
  (req, res) => {
    const {
      platform
    } = req.body || {};

    const account =
      dashboardAccounts.find(
        item =>
          item.platform
            .toLowerCase() ===
          String(platform || "")
            .toLowerCase()
      );

    if (!account) {
      return res.status(404).json({
        success: false,
        error: "Plateforme inconnue."
      });
    }

    account.connected = true;

    res.json({
      success: true,
      account
    });
  }
);

/* =========================================================
   RAPPORT HEBDOMADAIRE
========================================================= */

app.get(
  "/api/reports/weekly",
  (req, res) => {
    const views =
      dashboardAccounts.reduce(
        (sum, account) =>
          sum + account.views,
        0
      );

    const likes =
      dashboardAccounts.reduce(
        (sum, account) =>
          sum + account.likes,
        0
      );

    const subscribers =
      dashboardAccounts.reduce(
        (sum, account) =>
          sum + account.subscribers,
        0
      );

    res.json({
      success: true,

      report: {
        videosCreated:
          dashboardProjects.length,

        views,

        likes,

        subscribers,

        estimatedRevenue:
          dashboardAccounts.reduce(
            (sum, account) =>
              sum + account.revenue,
            0
          ),

        bestPlatform:
          dashboardAccounts.length
            ? dashboardAccounts
                .slice()
                .sort(
                  (a, b) =>
                    b.views -
                    a.views
                )[0].platform
            : null,

        suggestions: [
          "Publier régulièrement.",
          "Tester plusieurs hooks.",
          "Comparer les performances des plateformes.",
          "Régénérer les scènes qui fonctionnent le moins."
        ]
      }
    });
  }
);

/* =========================================================
   RAPPORT MENSUEL
========================================================= */

app.get(
  "/api/reports/monthly",
  (req, res) => {
    res.json({
      success: true,

      report: {
        period:
          new Date()
            .toISOString()
            .slice(0, 7),

        projects:
          dashboardProjects.length,

        views:
          dashboardAccounts.reduce(
            (sum, account) =>
              sum + account.views,
            0
          ),

        likes:
          dashboardAccounts.reduce(
            (sum, account) =>
              sum + account.likes,
            0
          ),

        subscribers:
          dashboardAccounts.reduce(
            (sum, account) =>
              sum + account.subscribers,
            0
          ),

        revenue:
          dashboardAccounts.reduce(
            (sum, account) =>
              sum + account.revenue,
            0
          )
      }
    });
  }
);

/* =========================================================
   SÉRIES
========================================================= */

app.get("/api/series", (req, res) => {
  res.json({
    success: true,
    series:
      dashboardSeries
  });
});

/* =========================================================
   NOUVELLE INTERFACE CINEFLOW
========================================================= */

app.get("/", (req, res) => {
  function cineflowPage() {
    /*
<!DOCTYPE html>
<html lang="fr">

<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>Cineflow — Studio vidéo IA</title>

<style>

* {
  box-sizing: border-box;
}

:root {
  --bg: #070b14;
  --panel: #0e1525;
  --panel2: #121b2e;
  --border: rgba(255,255,255,.08);
  --text: #f5f7fb;
  --muted: #8e9ab0;
  --purple: #8b5cf6;
  --blue: #3b82f6;
  --cyan: #22d3ee;
  --green: #22c55e;
  --orange: #f59e0b;
}

body {
  margin: 0;
  background:
    radial-gradient(
      circle at 20% 0%,
      rgba(99,102,241,.18),
      transparent 35%
    ),
    radial-gradient(
      circle at 90% 10%,
      rgba(34,211,238,.10),
      transparent 30%
    ),
    var(--bg);

  color: var(--text);
  font-family:
    Inter,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  min-height: 100vh;
}

button,
input,
textarea,
select {
  font: inherit;
}

button {
  cursor: pointer;
}

.app {
  min-height: 100vh;
  display: flex;
}

/* SIDEBAR */

.sidebar {
  width: 250px;
  min-height: 100vh;
  border-right: 1px solid var(--border);
  background: rgba(7,11,20,.94);
  padding: 22px 15px;
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  z-index: 20;
  backdrop-filter: blur(20px);
}

.logo {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 5px 9px 25px;
}

.logo-icon {
  width: 42px;
  height: 42px;
  border-radius: 13px;

  display: flex;
  align-items: center;
  justify-content: center;

  background:
    linear-gradient(
      135deg,
      var(--purple),
      var(--blue)
    );

  font-size: 22px;
  box-shadow:
    0 8px 30px
    rgba(99,102,241,.3);
}

.logo-name {
  font-size: 20px;
  font-weight: 800;
}

.logo-name span {
  color: #a78bfa;
}

.nav-section {
  margin-top: 18px;
}

.nav-title {
  font-size: 10px;
  color: #58647a;
  font-weight: 800;
  letter-spacing: 1.5px;
  padding: 0 12px 8px;
}

.nav-item {
  width: 100%;
  border: 0;
  background: transparent;
  color: #aab5c8;
  padding: 11px 12px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 3px;
  text-align: left;
  transition: .2s;
}

.nav-item:hover {
  background: rgba(255,255,255,.05);
  color: white;
}

.nav-item.active {
  background:
    linear-gradient(
      90deg,
      rgba(139,92,246,.22),
      rgba(59,130,246,.10)
    );

  color: white;
  border: 1px solid
    rgba(139,92,246,.16);
}

.nav-icon {
  width: 24px;
  text-align: center;
  font-size: 17px;
}

/* MAIN */

.main {
  width: calc(100% - 250px);
  margin-left: 250px;
  min-height: 100vh;
}

.topbar {
  height: 70px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 32px;
  position: sticky;
  top: 0;
  z-index: 10;
  background: rgba(7,11,20,.82);
  backdrop-filter: blur(18px);
}

.top-title {
  font-weight: 700;
  font-size: 15px;
}

.status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #8fa0b8;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 10px #22c55e;
}

.content {
  padding: 34px;
  max-width: 1450px;
  margin: auto;
}

/* HERO */

.hero {
  min-height: 350px;
  border: 1px solid var(--border);
  border-radius: 25px;
  padding: 42px;
  overflow: hidden;
  position: relative;

  background:
    radial-gradient(
      circle at 80% 20%,
      rgba(124,58,237,.28),
      transparent 32%
    ),
    radial-gradient(
      circle at 50% 100%,
      rgba(37,99,235,.16),
      transparent 35%
    ),
    linear-gradient(
      135deg,
      #11182b,
      #0b1120
    );
}

.hero::after {
  content: "";
  position: absolute;
  width: 300px;
  height: 300px;
  right: -90px;
  bottom: -140px;
  border-radius: 50%;
  border: 1px solid rgba(139,92,246,.18);
  box-shadow:
    0 0 0 30px rgba(139,92,246,.025),
    0 0 0 60px rgba(139,92,246,.02);
}

.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;

  padding: 7px 12px;
  border-radius: 99px;

  background: rgba(139,92,246,.12);
  border: 1px solid rgba(139,92,246,.25);

  color: #c4b5fd;
  font-size: 12px;
  font-weight: 700;
}

.hero h1 {
  font-size: clamp(34px, 5vw, 62px);
  line-height: 1;
  max-width: 780px;
  margin: 22px 0 17px;
  letter-spacing: -2.5px;
}

.hero h1 span {
  background:
    linear-gradient(
      90deg,
      #a78bfa,
      #60a5fa,
      #22d3ee
    );

  -webkit-background-clip: text;
  color: transparent;
}

.hero p {
  max-width: 690px;
  color: #9da9bc;
  font-size: 16px;
  line-height: 1.7;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 27px;
}

/* BUTTONS */

.btn {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 17px;
  color: white;
  background: rgba(255,255,255,.05);
  transition: .2s;
  font-weight: 700;
}

.btn:hover {
  transform: translateY(-1px);
  background: rgba(255,255,255,.09);
}

.btn-primary {
  border: 0;
  background:
    linear-gradient(
      135deg,
      #8b5cf6,
      #4f46e5
    );

  box-shadow:
    0 12px 30px
    rgba(99,102,241,.25);
}

.btn-auto {
  background:
    linear-gradient(
      135deg,
      rgba(59,130,246,.25),
      rgba(139,92,246,.2)
    );

  border-color:
    rgba(96,165,250,.25);
}

.btn-small {
  padding: 8px 12px;
  font-size: 12px;
}

/* STATS */

.stats {
  display: grid;
  grid-template-columns:
    repeat(4, 1fr);
  gap: 15px;
  margin: 22px 0;
}

.stat {
  padding: 19px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 17px;
}

.stat-label {
  color: #7f8ba0;
  font-size: 12px;
  margin-bottom: 8px;
}

.stat-value {
  font-size: 27px;
  font-weight: 800;
}

.stat-icon {
  float: right;
  font-size: 20px;
}

/* SECTION */

.section {
  margin-top: 30px;
}

.section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 15px;
  margin-bottom: 14px;
}

.section-title {
  font-size: 20px;
  font-weight: 800;
}

.section-subtitle {
  color: var(--muted);
  font-size: 13px;
  margin-top: 3px;
}

/* WORKFLOW */

.workflow {
  display: grid;
  grid-template-columns:
    repeat(6, 1fr);
  gap: 10px;
}

.workflow-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 18px 14px;
  min-height: 130px;
  position: relative;
}

.workflow-number {
  font-size: 11px;
  color: #66758d;
}

.workflow-icon {
  font-size: 25px;
  margin: 14px 0 8px;
}

.workflow-name {
  font-size: 13px;
  font-weight: 700;
}

/* CREATION CARDS */

.creation-grid {
  display: grid;
  grid-template-columns:
    1.25fr .9fr .9fr;
  gap: 15px;
}

.creation-card {
  min-height: 190px;
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 19px;
  padding: 22px;
  position: relative;
  overflow: hidden;
}

.creation-card.featured {
  background:
    radial-gradient(
      circle at 90% 0,
      rgba(139,92,246,.22),
      transparent 40%
    ),
    var(--panel);
}

.card-icon {
  font-size: 27px;
  margin-bottom: 15px;
}

.card-title {
  font-size: 17px;
  font-weight: 800;
}

.card-text {
  color: #8592a7;
  font-size: 13px;
  line-height: 1.5;
  margin: 8px 0 18px;
}

/* PROJECTS */

.projects-grid {
  display: grid;
  grid-template-columns:
    repeat(3, 1fr);
  gap: 14px;
}

.project-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 17px;
  padding: 17px;
}

.project-thumb {
  height: 115px;
  border-radius: 12px;
  background:
    linear-gradient(
      135deg,
      #172033,
      #31205b
    );

  display: flex;
  align-items: center;
  justify-content: center;

  font-size: 37px;
  margin-bottom: 13px;
}

.project-title {
  font-weight: 750;
}

.project-meta {
  display: flex;
  justify-content: space-between;
  color: #75839a;
  font-size: 11px;
  margin-top: 7px;
}

.empty {
  padding: 35px;
  border: 1px dashed
    rgba(255,255,255,.1);

  border-radius: 16px;
  text-align: center;
  color: #69768b;
}

/* STUDIO */

.studio {
  display: none;
}

.studio.active {
  display: block;
}

.page {
  display: none;
}

.page.active {
  display: block;
}

/* FORMS */

.form-card {
  max-width: 850px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 22px;
  padding: 25px;
}

.label {
  display: block;
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 8px;
}

textarea,
input,
select {
  width: 100%;
  background: #080e1b;
  color: white;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 13px;
  outline: none;
}

textarea {
  min-height: 145px;
  resize: vertical;
}

textarea:focus,
input:focus,
select:focus {
  border-color:
    rgba(139,92,246,.6);
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 13px;
  margin-top: 13px;
}

.form-actions {
  display: flex;
  gap: 10px;
  margin-top: 17px;
  flex-wrap: wrap;
}

/* SCENES */

.scenes-grid {
  display: grid;
  grid-template-columns:
    repeat(2, 1fr);
  gap: 14px;
}

.scene {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 17px;
  padding: 17px;
}

.scene-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.scene-number {
  color: #a78bfa;
  font-size: 12px;
  font-weight: 800;
}

.scene-title {
  font-weight: 800;
  margin-top: 4px;
}

.scene-description {
  color: #8491a6;
  font-size: 12px;
  line-height: 1.6;
  margin-top: 10px;
}

.scene-image {
  margin-top: 13px;
  height: 180px;
  border-radius: 12px;
  background:
    linear-gradient(
      135deg,
      #111827,
      #1e293b
    );

  display: flex;
  align-items: center;
  justify-content: center;

  color: #64748b;
  overflow: hidden;
}

.scene-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* RESULT */

.result {
  margin-top: 18px;
  background: #080e1a;
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 16px;
  white-space: pre-wrap;
  color: #b8c3d4;
  font-size: 13px;
  line-height: 1.6;
}

/* MOBILE */

.mobile-menu {
  display: none;
}

@media(max-width: 1050px) {

  .workflow {
    grid-template-columns:
      repeat(3, 1fr);
  }

  .creation-grid {
    grid-template-columns: 1fr 1fr;
  }

  .creation-card.featured {
    grid-column: span 2;
  }

  .projects-grid {
    grid-template-columns:
      repeat(2, 1fr);
  }

}

@media(max-width: 760px) {

  .sidebar {
    display: none;
  }

  .main {
    width: 100%;
    margin-left: 0;
  }

  .topbar {
    padding: 0 16px;
  }

  .mobile-menu {
    display: block;
    border: 0;
    background: transparent;
    color: white;
    font-size: 22px;
  }

  .content {
    padding: 17px;
  }

  .hero {
    padding: 26px 21px;
    min-height: 390px;
    border-radius: 21px;
  }

  .hero h1 {
    font-size: 37px;
    letter-spacing: -1.7px;
  }

  .hero p {
    font-size: 14px;
  }

  .stats {
    grid-template-columns:
      repeat(2, 1fr);
  }

  .workflow {
    grid-template-columns:
      repeat(2, 1fr);
  }

  .creation-grid {
    grid-template-columns: 1fr;
  }

  .creation-card.featured {
    grid-column: auto;
  }

  .projects-grid,
  .scenes-grid {
    grid-template-columns: 1fr;
  }

  .form-row {
    grid-template-columns: 1fr;
  }
}

</style>
</head>

<body>

<div class="app">

<!-- SIDEBAR -->

<aside class="sidebar">

  <div class="logo">
    <div class="logo-icon">🎬</div>

    <div class="logo-name">
      Cine<span>flow</span>
    </div>
  </div>

  <div class="nav-section">

    <div class="nav-title">
      ESPACE CRÉATION
    </div>

    <button
      class="nav-item active"
      onclick="showPage('home', this)"
    >
      <span class="nav-icon">🏠</span>
      Accueil
    </button>

    <button
      class="nav-item"
      onclick="showPage('create', this)"
    >
      <span class="nav-icon">🎬</span>
      Créer une vidéo
    </button>

    <button
      class="nav-item"
      onclick="showPage('autopilot', this)"
    >
      <span class="nav-icon">🤖</span>
      Auto-Pilote
    </button>

    <button
      class="nav-item"
      onclick="showPage('trends', this)"
    >
      <span class="nav-icon">📈</span>
      Tendances
    </button>

  </div>

  <div class="nav-section">

    <div class="nav-title">
      STUDIO
    </div>

    <button
      class="nav-item"
      onclick="showPage('scenes', this)"
    >
      <span class="nav-icon">🧩</span>
      Scènes
    </button>

    <button
      class="nav-item"
      onclick="showPage('images', this)"
    >
      <span class="nav-icon">🖼️</span>
      Images
    </button>

    <button
      class="nav-item"
      onclick="showPage('animation', this)"
    >
      <span class="nav-icon">🎞️</span>
      Animation
    </button>

    <button
      class="nav-item"
      onclick="showPage('video', this)"
    >
      <span class="nav-icon">🎥</span>
      Vidéo finale
    </button>

  </div>

  <div class="nav-section">

    <div class="nav-title">
      SUIVI
    </div>

    <button
      class="nav-item"
      onclick="showPage('projects', this)"
    >
      <span class="nav-icon">📁</span>
      Mes projets
    </button>

    <button
      class="nav-item"
      onclick="showPage('accounts', this)"
    >
      <span class="nav-icon">👤</span>
      Mes comptes
    </button>

    <button
      class="nav-item"
      onclick="showPage('reports', this)"
    >
      <span class="nav-icon">📊</span>
      Rapports
    </button>

  </div>

</aside>

<!-- MAIN -->

<main class="main">

  <header class="topbar">

    <button
      class="mobile-menu"
      onclick="toggleMobileNav()"
    >
      ☰
    </button>

    <div class="top-title">
      Studio de création
    </div>

    <div class="status">
      <span class="status-dot"></span>
      Cineflow opérationnel
    </div>

  </header>

  <div class="content">

    <!-- ================= HOME ================= -->

    <section
      id="page-home"
      class="page active"
    >

      <div class="hero">

        <div class="hero-badge">
          ✨ STUDIO VIDÉO INTELLIGENT
        </div>

        <h1>
          Transforme une idée en
          <span>vidéo.</span>
        </h1>

        <p>
          Cineflow transforme ton idée en projet vidéo :
          scénario, scènes, images, animation et montage.
          Tout dans un seul espace de création.
        </p>

        <div class="hero-actions">

          <button
            class="btn btn-primary"
            onclick="showPage('create')"
          >
            🎬 Créer une vidéo
          </button>

          <button
            class="btn btn-auto"
            onclick="showPage('autopilot')"
          >
            🤖 Lancer Auto-Pilote
          </button>

          <button
            class="btn"
            onclick="showPage('trends')"
          >
            📈 Explorer les tendances
          </button>

        </div>

      </div>

      <div class="stats">

        <div class="stat">
          <span class="stat-icon">🎬</span>
          <div class="stat-label">
            PROJETS
          </div>
          <div
            class="stat-value"
            id="statProjects"
          >
            0
          </div>
        </div>

        <div class="stat">
          <span class="stat-icon">👁️</span>
          <div class="stat-label">
            VUES
          </div>
          <div
            class="stat-value"
            id="statViews"
          >
            0
          </div>
        </div>

        <div class="stat">
          <span class="stat-icon">❤️</span>
          <div class="stat-label">
            LIKES
          </div>
          <div
            class="stat-value"
            id="statLikes"
          >
            0
          </div>
        </div>

        <div class="stat">
          <span class="stat-icon">👥</span>
          <div class="stat-label">
            ABONNÉS
          </div>
          <div
            class="stat-value"
            id="statSubscribers"
          >
            0
          </div>
        </div>

      </div>

      <div class="section">

        <div class="section-head">

          <div>
            <div class="section-title">
              Le moteur Cineflow
            </div>

            <div class="section-subtitle">
              Ton idée passe automatiquement par chaque étape.
            </div>
          </div>

        </div>

        <div class="workflow">

          <div class="workflow-card">
            <div class="workflow-number">01</div>
            <div class="workflow-icon">💡</div>
            <div class="workflow-name">Idée</div>
          </div>

          <div class="workflow-card">
            <div class="workflow-number">02</div>
            <div class="workflow-icon">📖</div>
            <div class="workflow-name">Scénario</div>
          </div>

          <div class="workflow-card">
            <div class="workflow-number">03</div>
            <div class="workflow-icon">🧩</div>
            <div class="workflow-name">5 scènes</div>
          </div>

          <div class="workflow-card">
            <div class="workflow-number">04</div>
            <div class="workflow-icon">🖼️</div>
            <div class="workflow-name">Images</div>
          </div>

          <div class="workflow-card">
            <div class="workflow-number">05</div>
            <div class="workflow-icon">🎞️</div>
            <div class="workflow-name">Animation</div>
          </div>

          <div class="workflow-card">
            <div class="workflow-number">06</div>
            <div class="workflow-icon">🎬</div>
            <div class="workflow-name">Vidéo</div>
          </div>

        </div>

      </div>

      <div class="section">

        <div class="section-head">

          <div>
            <div class="section-title">
              Commencer une création
            </div>

            <div class="section-subtitle">
              Choisis ton mode de création.
            </div>
          </div>

        </div>

        <div class="creation-grid">

          <div class="creation-card featured">

            <div class="card-icon">🎬</div>

            <div class="card-title">
              Créer une vidéo
            </div>

            <div class="card-text">
              Décris simplement ton idée.
              Cineflow construit ton projet en cinq scènes
              cohérentes.
            </div>

            <button
              class="btn btn-primary"
              onclick="showPage('create')"
            >
              Commencer →
            </button>

          </div>

          <div class="creation-card">

            <div class="card-icon">🤖</div>

            <div class="card-title">
              Auto-Pilote
            </div>

            <div class="card-text">
              Laisse Cineflow orchestrer les différentes
              étapes de création.
            </div>

            <button
              class="btn btn-auto"
              onclick="showPage('autopilot')"
            >
              Ouvrir
            </button>

          </div>

          <div class="creation-card">

            <div class="card-icon">📈</div>

            <div class="card-title">
              Tendances
            </div>

            <div class="card-text">
              Trouve des concepts originaux adaptés
              aux plateformes vidéo.
            </div>

            <button
              class="btn"
              onclick="showPage('trends')"
            >
              Explorer
            </button>

          </div>

        </div>

      </div>

      <div class="section">

        <div class="section-head">

          <div>
            <div class="section-title">
              Projets récents
            </div>

            <div class="section-subtitle">
              Reprends rapidement une création.
            </div>
          </div>

          <button
            class="btn btn-small"
            onclick="showPage('projects')"
          >
            Voir tout
          </button>

        </div>

        <div
          id="recentProjects"
          class="projects-grid"
        >
        </div>

      </div>

    </section>

    <!-- ================= CREATE ================= -->

    <section
      id="page-create"
      class="page"
    >

      <div class="section-head">

        <div>
          <div class="section-title">
            🎬 Créer une vidéo
          </div>

          <div class="section-subtitle">
            Donne une idée à Cineflow.
          </div>
        </div>

      </div>

      <div class="form-card">

        <label class="label">
          Ton idée
        </label>

        <textarea
          id="idea"
          placeholder="Exemple : un jeune footballeur africain qui veut devenir professionnel malgré les difficultés..."
        ></textarea>

        <div class="form-row">

          <div>

            <label class="label">
              Catégorie
            </label>

            <select id="category">

              <option value="cinéma">
                🎬 Cinéma
              </option>

              <option value="football">
                ⚽ Football
              </option>

              <option value="action">
                💥 Action
              </option>

              <option value="drame">
                🎭 Drame
              </option>

              <option value="animation">
                🧸 Animation
              </option>

            </select>

          </div>

          <div>

            <label class="label">
              Format
            </label>

            <select id="format">

              <option value="16:9">
                YouTube — 16:9
              </option>

              <option value="9:16">
                TikTok / Reels — 9:16
              </option>

              <option value="1:1">
                Instagram — 1:1
              </option>

            </select>

          </div>

        </div>

        <div class="form-actions">

          <button
            class="btn btn-primary"
            id="generateBtn"
            onclick="generateProject()"
          >
            🚀 Générer mon projet
          </button>

          <button
            class="btn"
            onclick="testGemini()"
          >
            🧠 Tester Gemini
          </button>

        </div>

        <div
          id="createResult"
          class="result"
          style="display:none"
        ></div>

      </div>

    </section>

    <!-- ================= AUTOPILOT ================= -->

    <section
      id="page-autopilot"
      class="page"
    >

      <div class="section-head">

        <div>
          <div class="section-title">
            🤖 Auto-Pilote Cineflow
          </div>

          <div class="section-subtitle">
            Le mode qui orchestre ton processus de création.
          </div>
        </div>

      </div>

      <div class="form-card">

        <label class="label">
          Idée de départ
        </label>

        <textarea
          id="autopilotIdea"
          placeholder="Décris la vidéo que tu veux créer..."
        ></textarea>

        <div class="form-actions">

          <button
            class="btn btn-primary"
            onclick="startAutopilot()"
          >
            🤖 Préparer Auto-Pilote
          </button>

        </div>

        <div
          id="autopilotResult"
          class="result"
          style="display:none"
        ></div>

      </div>

    </section>

    <!-- ================= TRENDS ================= -->

    <section
      id="page-trends"
      class="page"
    >

      <div class="section-head">

        <div>
          <div class="section-title">
            📈 Tendances & idées
          </div>

          <div class="section-subtitle">
            Des concepts originaux pour inspirer tes prochaines vidéos.
          </div>
        </div>

        <button
          class="btn btn-primary"
          onclick="loadTrends()"
        >
          ✨ Générer des idées
        </button>

      </div>

      <div
        id="trendsResult"
        class="projects-grid"
      >

        <div class="empty">
          Clique sur « Générer des idées ».
        </div>

      </div>

    </section>

    <!-- ================= SCENES ================= -->

    <section
      id="page-scenes"
      class="page"
    >

      <div class="section-head">

        <div>
          <div class="section-title">
            🧩 Scènes
          </div>

          <div class="section-subtitle">
            Les cinq scènes de ton dernier projet.
          </div>
        </div>

        <button
          class="btn btn-primary"
          onclick="prepareImages()"
        >
          🧩 Préparer les 5 scènes
        </button>

      </div>

      <div
        id="scenesResult"
        class="scenes-grid"
      >

        <div class="empty">
          Crée d'abord un projet.
        </div>

      </div>

    </section>

    <!-- ================= IMAGES ================= -->

    <section
      id="page-images"
      class="page"
    >

      <div class="section-head">

        <div>
          <div class="section-title">
            🖼️ Génération des images
          </div>

          <div class="section-subtitle">
            Génère les images cinématiques de tes cinq scènes.
          </div>
        </div>

        <button
          id="generateImagesBtn"
          class="btn btn-primary"
          onclick="generateImages()"
          disabled
        >
          🎨 Générer les images
        </button>

      </div>

      <div
        id="imagesResult"
        class="scenes-grid"
      >

        <div class="empty">
          Prépare d'abord les scènes.
        </div>

      </div>

    </section>

    <!-- ================= ANIMATION ================= -->

    <section
      id="page-animation"
      class="page"
    >

      <div class="section-head">

        <div>
          <div class="section-title">
            🎞️ Animation
          </div>

          <div class="section-subtitle">
            Anime les cinq scènes avec le moteur vidéo.
          </div>
        </div>

        <button
          id="animateBtn"
          class="btn btn-primary"
          onclick="animateScenes()"
          disabled
        >
          🎞️ Animer les 5 scènes
        </button>

      </div>

      <div
        id="animationResult"
        class="result"
      >
        Les scènes animées apparaîtront ici.
      </div>

    </section>

    <!-- ================= VIDEO ================= -->

    <section
      id="page-video"
      class="page"
    >

      <div class="section-head">

        <div>
          <div class="section-title">
            🎥 Vidéo finale
          </div>

          <div class="section-subtitle">
            Assemble les scènes terminées en une vidéo MP4.
          </div>
        </div>

      </div>

      <div class="form-card">

        <button
          id="createVideoBtn"
          class="btn btn-primary"
          onclick="createFinalVideo()"
          disabled
        >
          🎬 Créer ma vidéo
        </button>

        <div
          id="videoResult"
          class="result"
        >
          Termine les cinq animations pour créer la vidéo finale.
        </div>

      </div>

    </section>

    <!-- ================= PROJECTS ================= -->

    <section
      id="page-projects"
      class="page"
    >

      <div class="section-head">

        <div>
          <div class="section-title">
            📁 Mes projets
          </div>

          <div class="section-subtitle">
            Toutes tes créations Cineflow.
          </div>
        </div>

      </div>

      <div
        id="allProjects"
        class="projects-grid"
      ></div>

    </section>

    <!-- ================= ACCOUNTS ================= -->

    <section
      id="page-accounts"
      class="page"
    >

      <div class="section-head">

        <div>
          <div class="section-title">
            👤 Mes comptes
          </div>

          <div class="section-subtitle">
            Prépare le suivi de tes plateformes.
          </div>
        </div>

      </div>

      <div
        id="accountsResult"
        class="projects-grid"
      ></div>

    </section>

    <!-- ================= REPORTS ================= -->

    <section
      id="page-reports"
      class="page"
    >

      <div class="section-head">

        <div>
          <div class="section-title">
            📊 Rapports
          </div>

          <div class="section-subtitle">
            Suivi hebdomadaire et mensuel.
          </div>
        </div>

      </div>

      <div
        id="reportsResult"
        class="creation-grid"
      ></div>

    </section>

  </div>

</main>

</div>

<script>

let currentProject = null;
let preparedScenes = [];
let currentJobId = null;

/* =========================================================
   NAVIGATION
========================================================= */

function showPage(page, button) {

  document
    .querySelectorAll(".page")
    .forEach(el => {
      el.classList.remove("active");
    });

  const target =
    document.getElementById(
      "page-" + page
    );

  if (target) {
    target.classList.add("active");
  }

  document
    .querySelectorAll(".nav-item")
    .forEach(el => {
      el.classList.remove("active");
    });

  if (button) {
    button.classList.add("active");
  }

  if (page === "projects") {
    loadProjects();
  }

  if (page === "accounts") {
    loadAccounts();
  }

  if (page === "reports") {
    loadReports();
  }
}

function toggleMobileNav() {
  alert(
    "Utilise le menu principal de Cineflow."
  );
}

/* =========================================================
   DASHBOARD
========================================================= */

async function loadDashboard() {

  try {

    const response =
      await fetch(
        "/api/dashboard"
      );

    const data =
      await response.json();

    if (!data.success) return;

    document.getElementById(
      "statProjects"
    ).textContent =
      data.stats.projects;

    document.getElementById(
      "statViews"
    ).textContent =
      data.stats.views;

    document.getElementById(
      "statLikes"
    ).textContent =
      data.stats.likes;

    document.getElementById(
      "statSubscribers"
    ).textContent =
      data.stats.subscribers;

    renderProjects(
      data.recentProjects || [],
      "recentProjects"
    );

  } catch (error) {

    console.error(error);

  }
}

/* =========================================================
   PROJETS
========================================================= */

function renderProjects(
  projects,
  containerId
) {

  const container =
    document.getElementById(
      containerId
    );

  if (!container) return;

  if (!projects.length) {

    container.innerHTML = `
      <div class="empty">
        Aucun projet pour le moment.
        <br><br>
        Crée ta première vidéo avec Cineflow.
      </div>
    `;

    return;
  }

  container.innerHTML =
    projects.map(project => `
      <div class="project-card">

        <div class="project-thumb">
          🎬
        </div>

        <div class="project-title">
          ${escapeHtml(
            project.title
          )}
        </div>

        <div class="project-meta">

          <span>
            ${escapeHtml(
              project.category || "cinéma"
            )}
          </span>

          <span>
            ${escapeHtml(
              project.status || "Créé"
            )}
          </span>

        </div>

      </div>
    `).join("");
}

async function loadProjects() {

  try {

    const response =
      await fetch(
        "/api/projects"
      );

    const data =
      await response.json();

    renderProjects(
      data.projects || [],
      "allProjects"
    );

  } catch (error) {

    console.error(error);

  }
}

/* =========================================================
   CRÉATION
========================================================= */

async function generateProject() {

  const idea =
    document
      .getElementById("idea")
      .value
      .trim();

  const category =
    document
      .getElementById("category")
      .value;

  const result =
    document.getElementById(
      "createResult"
    );

  const button =
    document.getElementById(
      "generateBtn"
    );

  if (!idea) {

    alert(
      "Décris d'abord ton idée."
    );

    return;
  }

  button.disabled = true;

  button.textContent =
    "⏳ Création du projet...";

  result.style.display =
    "block";

  result.textContent =
    "Cineflow prépare ton histoire...";

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

          body: JSON.stringify({
            idea,
            category
          })
        }
      );

    const data =
      await response.json();

    if (!response.ok || !data.success) {
      throw new Error(
        data.error ||
        "Erreur de génération."
      );
    }

    currentProject =
      data.project;

    preparedScenes = [];

    result.textContent =
      "✅ Projet créé : " +
      currentProject.title +
      "\n\n" +
      (currentProject.concept || "") +
      "\n\n" +
      "5 scènes générées.";

    renderScenes();

    document.getElementById(
      "generateImagesBtn"
    ).disabled = true;

    showPage("scenes");

    loadDashboard();

  } catch (error) {

    result.textContent =
      "❌ " +
      error.message;

  } finally {

    button.disabled = false;

    button.textContent =
      "🚀 Générer mon projet";
  }
}

/* =========================================================
   TEST GEMINI
========================================================= */

async function testGemini() {

  const result =
    document.getElementById(
      "createResult"
    );

  result.style.display =
    "block";

  result.textContent =
    "⏳ Test de connexion Gemini...";

  try {

    const response =
      await fetch(
        "/api/test-gemini"
      );

    const data =
      await response.json();

    if (!data.success) {
      throw new Error(
        data.error
      );
    }

    result.textContent =
      "✅ " +
      data.message;

  } catch (error) {

    result.textContent =
      "❌ " +
      error.message;
  }
}

/* =========================================================
   SCÈNES
========================================================= */

function renderScenes() {

  const container =
    document.getElementById(
      "scenesResult"
    );

  if (
    !currentProject ||
    !Array.isArray(
      currentProject.scenes
    )
  ) {

    container.innerHTML =
      `<div class="empty">
        Aucun projet disponible.
      </div>`;

    return;
  }

  container.innerHTML =
    currentProject.scenes
      .slice(0, 5)
      .map((scene, index) => `

        <div class="scene">

          <div class="scene-head">

            <div>

              <div class="scene-number">
                SCÈNE ${index + 1}
              </div>

              <div class="scene-title">
                ${escapeHtml(
                  scene.title ||
                  "Scène " +
                  (index + 1)
                )}
              </div>

            </div>

            <div>
              ${scene.duration || 8}s
            </div>

          </div>

          <div class="scene-description">
            ${escapeHtml(
              scene.description || ""
            )}
          </div>

        </div>

      `)
      .join("");
}

/* =========================================================
   PRÉPARER IMAGES
========================================================= */

async function prepareImages() {

  if (!currentProject) {

    alert(
      "Crée d'abord un projet."
    );

    return;
  }

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
      throw new Error(
        data.error
      );
    }

    preparedScenes =
      data.scenes;

    renderPreparedImages();

    document.getElementById(
      "generateImagesBtn"
    ).disabled = false;

    showPage("images");

  } catch (error) {

    alert(
      "❌ " +
      error.message
    );
  }
}

/* =========================================================
   IMAGES
========================================================= */

function renderPreparedImages() {

  const container =
    document.getElementById(
      "imagesResult"
    );

  if (!preparedScenes.length) {

    container.innerHTML =
      `<div class="empty">
        Aucune scène préparée.
      </div>`;

    return;
  }

  container.innerHTML =
    preparedScenes.map(
      (scene, index) => `

      <div class="scene">

        <div class="scene-number">
          SCÈNE ${index + 1}
        </div>

        <div class="scene-title">
          ${escapeHtml(
            scene.title
          )}
        </div>

        <div class="scene-image"
             id="image-${index}">

          <span>
            Image en attente
          </span>

        </div>

      </div>

    `
    ).join("");
}

async function generateImages() {

  if (
    preparedScenes.length !== 5
  ) {

    alert(
      "Il faut préparer les 5 scènes."
    );

    return;
  }

  const button =
    document.getElementById(
      "generateImagesBtn"
    );

  button.disabled = true;

  button.textContent =
    "⏳ Génération...";

  let completed = 0;

  try {

    for (
      let i = 0;
      i < preparedScenes.length;
      i++
    ) {

      const scene =
        preparedScenes[i];

      const box =
        document.getElementById(
          "image-" + i
        );

      if (box) {
        box.innerHTML =
          "<span>🎨 Génération...</span>";
      }

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
                scene.prompt
            })
          }
        );

      const data =
        await response.json();

      if (
        !response.ok ||
        !data.success
      ) {
        throw new Error(
          data.error ||
          "Impossible de générer l'image."
        );
      }

      scene.image =
        data.image;

      scene.status =
        "completed";

      completed++;

      if (box) {

        box.innerHTML = `
          <img
            src="data:${data.mimeType || "image/png"};base64,${data.image}"
            alt="Scène ${i + 1}"
          >
        `;

      }
    }

    if (completed === 5) {

      document.getElementById(
        "animateBtn"
      ).disabled = false;

      alert(
        "✅ Les 5 images sont générées."
      );
    }

  } catch (error) {

    alert(
      "❌ " +
      error.message
    );

  } finally {

    button.disabled = false;

    button.textContent =
      "🎨 Générer les images";
  }
}

/* =========================================================
   ANIMATION
========================================================= */

async function animateScenes() {

  if (
    preparedScenes.length !== 5
  ) {

    alert(
      "Il faut exactement 5 scènes."
    );

    return;
  }

  const button =
    document.getElementById(
      "animateBtn"
    );

  button.disabled = true;

  button.textContent =
    "⏳ Préparation...";

  const result =
    document.getElementById(
      "animationResult"
    );

  try {

    const scenes =
      preparedScenes.map(
        (scene, index) => {

          const original =
            currentProject.scenes[index];

          return {
            number:
              index + 1,

            title:
              scene.title,

            prompt:
              scene.prompt,

            animationPrompt:
              original?.animationPrompt ||
              scene.prompt,

            duration:
              original?.duration ||
              8
          };

        }
      );

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
            scenes
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

    result.textContent =
      "🎞️ Animation lancée...\n\n" +
      "Cineflow anime les cinq scènes.";

    pollAnimation();

  } catch (error) {

    result.textContent =
      "❌ " +
      error.message;

    button.disabled = false;

    button.textContent =
      "🎞️ Animer les 5 scènes";
  }
}

async function pollAnimation() {

  if (!currentJobId) return;

  try {

    const response =
      await fetch(
        "/api/animation-status/" +
        encodeURIComponent(
          currentJobId
        )
      );

    const data =
      await response.json();

    if (!data.success) {
      throw new Error(
        data.error
      );
    }

    const job =
      data.job;

    const completed =
      job.scenes.filter(
        scene =>
          scene.status ===
          "completed"
      ).length;

    const result =
      document.getElementById(
        "animationResult"
      );

    result.textContent =
      "🎞️ Animation en cours\n\n" +
      completed +
      " / 5 scènes terminées.";

    if (
      job.status ===
      "completed"
    ) {

      result.textContent =
        "✅ Les 5 scènes sont animées.\n\n" +
        "Tu peux maintenant créer la vidéo finale.";

      document.getElementById(
        "createVideoBtn"
      ).disabled = false;

      document.getElementById(
        "animateBtn"
      ).disabled = false;

      document.getElementById(
        "animateBtn"
      ).textContent =
        "🎞️ Animer les 5 scènes";

      return;
    }

    if (
      job.status ===
      "error"
    ) {

      result.textContent =
        "❌ Une scène n'a pas pu être animée.\n\n" +
        (job.error || "");

      document.getElementById(
        "animateBtn"
      ).disabled = false;

      document.getElementById(
        "animateBtn"
      ).textContent =
        "🎞️ Réessayer";

      return;
    }

    setTimeout(
      pollAnimation,
      5000
    );

  } catch (error) {

    document.getElementById(
      "animationResult"
    ).textContent =
      "❌ " +
      error.message;

  }
}

/* =========================================================
   VIDÉO FINALE
========================================================= */

async function createFinalVideo() {

  if (!currentJobId) {

    alert(
      "Aucune animation disponible."
    );

    return;
  }

  const button =
    document.getElementById(
      "createVideoBtn"
    );

  const result =
    document.getElementById(
      "videoResult"
    );

  button.disabled = true;

  button.textContent =
    "⏳ Montage...";

  result.textContent =
    "🎬 Cineflow assemble les cinq scènes...";

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
            jobId:
              currentJobId
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

    result.innerHTML = `
      ✅ Vidéo finale créée.

      <br><br>

      <a
        class="btn btn-primary"
        href="/api/download-video/${encodeURIComponent(data.videoId)}"
      >
        🎬 Télécharger la vidéo
      </a>
    `;

  } catch (error) {

    result.textContent =
      "❌ " +
      error.message;

    button.disabled = false;

  } finally {

    button.textContent =
      "🎬 Créer ma vidéo";
  }
}

/* =========================================================
   AUTOPILOTE
========================================================= */

async function startAutopilot() {

  const idea =
    document
      .getElementById(
        "autopilotIdea"
      )
      .value
      .trim();

  const result =
    document.getElementById(
      "autopilotResult"
    );

  if (!idea) {

    alert(
      "Décris ton idée."
    );

    return;
  }

  result.style.display =
    "block";

  result.textContent =
    "🤖 Préparation du plan Auto-Pilote...";

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
            idea,
            category: "cinéma"
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

    result.textContent =
      "🤖 AUTO-PILOTE\n\n" +
      data.steps
        .map(
          step =>
            step.id +
            ". " +
            step.title
        )
        .join("\n");

  } catch (error) {

    result.textContent =
      "❌ " +
      error.message;
  }
}

/* =========================================================
   TENDANCES
========================================================= */

async function loadTrends() {

  const container =
    document.getElementById(
      "trendsResult"
    );

  container.innerHTML =
    `<div class="empty">
      ⏳ Cineflow cherche des idées...
    </div>`;

  try {

    const response =
      await fetch(
        "/api/trends",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            category:
              "cinéma"
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

    container.innerHTML =
      data.ideas
        .map(
          idea => `

          <div class="creation-card">

            <div class="card-icon">
              ${
                idea.platform === "TikTok"
                  ? "🎵"
                  : idea.platform === "YouTube"
                  ? "▶️"
                  : idea.platform === "Instagram"
                  ? "📸"
                  : "📱"
              }
            </div>

            <div class="card-title">
              ${escapeHtml(
                idea.title
              )}
            </div>

            <div class="card-text">
              <strong>
                ${escapeHtml(
                  idea.hook || ""
                )}
              </strong>

              <br><br>

              ${escapeHtml(
                idea.concept || ""
              )}
            </div>

            <button
              class="btn btn-small"
              onclick="useTrendIdea(${JSON.stringify(
                idea.concept || ""
              )})"
            >
              🎬 Créer cette vidéo
            </button>

          </div>

        `
        )
        .join("");

  } catch (error) {

    container.innerHTML =
      `<div class="empty">
        ❌ ${escapeHtml(
          error.message
        )}
      </div>`;
  }
}

function useTrendIdea(idea) {

  document.getElementById(
    "idea"
  ).value = idea;

  showPage("create");

}

/* =========================================================
   COMPTES
========================================================= */

async function loadAccounts() {

  const container =
    document.getElementById(
      "accountsResult"
    );

  try {

    const response =
      await fetch(
        "/api/accounts"
      );

    const data =
      await response.json();

    container.innerHTML =
      data.accounts
        .map(
          account => `

          <div class="creation-card">

            <div class="card-icon">
              ${
                account.platform === "YouTube"
                  ? "▶️"
                  : account.platform === "TikTok"
                  ? "🎵"
                  : account.platform === "Instagram"
                  ? "📸"
                  : "📘"
              }
            </div>

            <div class="card-title">
              ${account.platform}
            </div>

            <div class="card-text">

              Statut :
              ${
                account.connected
                  ? "Connecté"
                  : "Non connecté"
              }

              <br><br>

              Vues :
              ${account.views}

            </div>

            <button
              class="btn btn-small"
              onclick="connectAccount('${account.platform}')"
            >
              ${
                account.connected
                  ? "✓ Connecté"
                  : "Connecter"
              }
            </button>

          </div>

        `
        )
        .join("");

  } catch (error) {

    container.innerHTML =
      `<div class="empty">
        ❌ ${escapeHtml(
          error.message
        )}
      </div>`;
  }
}

async function connectAccount(
  platform
) {

  try {

    const response =
      await fetch(
        "/api/accounts/connect",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            platform
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

    loadAccounts();

  } catch (error) {

    alert(
      "❌ " +
      error.message
    );
  }
}

/* =========================================================
   RAPPORTS
========================================================= */

async function loadReports() {

  const container =
    document.getElementById(
      "reportsResult"
    );

  try {

    const weeklyResponse =
      await fetch(
        "/api/reports/weekly"
      );

    const weekly =
      await weeklyResponse.json();

    const monthlyResponse =
      await fetch(
        "/api/reports/monthly"
      );

    const monthly =
      await monthlyResponse.json();

    container.innerHTML = `

      <div class="creation-card">

        <div class="card-icon">
          📊
        </div>

        <div class="card-title">
          Cette semaine
        </div>

        <div class="card-text">

          Vidéos :
          ${weekly.report.videosCreated}

          <br><br>

          Vues :
          ${weekly.report.views}

          <br>

          Likes :
          ${weekly.report.likes}

          <br>

          Abonnés :
          ${weekly.report.subscribers}

          <br>

          Revenus estimés :
          ${weekly.report.estimatedRevenue}

        </div>

      </div>

      <div class="creation-card">

        <div class="card-icon">
          📋
        </div>

        <div class="card-title">
          Ce mois
        </div>

        <div class="card-text">

          Projets :
          ${monthly.report.projects}

          <br><br>

          Vues :
          ${monthly.report.views}

          <br>

          Likes :
          ${monthly.report.likes}

          <br>

          Abonnés :
          ${monthly.report.subscribers}

        </div>

      </div>

    `;

  } catch (error) {

    container.innerHTML =
      `<div class="empty">
        ❌ ${escapeHtml(
          error.message
        )}
      </div>`;
  }
}

/* =========================================================
   SÉCURITÉ HTML
========================================================= */

function escapeHtml(value) {

  return String(
    value ?? ""
  )
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}

/* =========================================================
   INITIALISATION
========================================================= */

loadDashboard();

</script>

</body>
</html>
*/
  }

  const source =
    cineflowPage.toString();

  const start =
    source.indexOf("/*");

  const end =
    source.lastIndexOf("*/");

  const html =
    source
      .slice(
        start + 2,
        end
      )
      .trim();

  res.send(html);
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
   SERVEUR
========================================================= */

app.listen(PORT, () => {
  console.log(
    `🎬 Cineflow est lancé sur le port ${PORT}`
  );

  console.log(
    API_KEY
      ? "✅ GEMINI_API_KEY détectée."
      : "⚠️ GEMINI_API_KEY absente."
  );
});

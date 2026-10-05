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
   MÉMOIRE TEMPORAIRE
========================================================= */

const dashboardProjects = [];
const dashboardSeries = [];

const dashboardAccounts = {
  youtube: {
    connected: false,
    name: "YouTube",
    followers: 0,
    views: 0
  },
  tiktok: {
    connected: false,
    name: "TikTok",
    followers: 0,
    views: 0
  },
  instagram: {
    connected: false,
    name: "Instagram",
    followers: 0,
    views: 0
  },
  facebook: {
    connected: false,
    name: "Facebook",
    followers: 0,
    views: 0
  }
};

const videoFiles = new Map();
const animationJobs = new Map();

/* =========================================================
   OUTILS
========================================================= */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanJson(text) {
  if (!text) return "";

  let value = String(text).trim();

  value = value
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");

  if (first !== -1 && last !== -1 && last > first) {
    value = value.substring(first, last + 1);
  }

  return value;
}

function getInteractionText(result) {
  if (!result) return "";

  if (typeof result.text === "string") {
    return result.text;
  }

  if (result.response && typeof result.response.text === "string") {
    return result.response.text;
  }

  if (Array.isArray(result.output)) {
    for (const item of result.output) {
      if (typeof item.text === "string") return item.text;

      if (Array.isArray(item.content)) {
        for (const block of item.content) {
          if (typeof block.text === "string") {
            return block.text;
          }
        }
      }
    }
  }

  if (Array.isArray(result.steps)) {
    for (const step of result.steps) {
      if (typeof step.text === "string") {
        return step.text;
      }

      if (Array.isArray(step.content)) {
        for (const block of step.content) {
          if (typeof block.text === "string") {
            return block.text;
          }
        }
      }
    }
  }

  return "";
}

function quotaError(error) {
  const message = String(
    error && error.message ? error.message : error
  );

  if (
    message.includes("429") ||
    message.includes("RESOURCE_EXHAUSTED") ||
    message.toLowerCase().includes("rate limit") ||
    message.toLowerCase().includes("quota")
  ) {
    return {
      quota: true,
      message:
        "Quota Gemini atteinte. Cineflow est prêt, mais Gemini doit attendre la remise à zéro de la limite."
    };
  }

  return null;
}

async function generateTextInteraction(prompt) {
  if (!ai) {
    throw new Error("GEMINI_API_KEY manquante sur Render.");
  }

  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: prompt
    });

    const text =
      typeof result.text === "string"
        ? result.text
        : getInteractionText(result);

    return text || "";
  } catch (error) {
    const q = quotaError(error);

    if (q) {
      const e = new Error(q.message);
      e.statusCode = 429;
      throw e;
    }

    throw error;
  }
}

/* =========================================================
   GÉNÉRATION IMAGE
========================================================= */

async function generateImage(prompt) {
  if (!ai) {
    throw new Error("GEMINI_API_KEY manquante sur Render.");
  }

  try {
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
      return interaction.output_image.data;
    }

    if (interaction && Array.isArray(interaction.steps)) {
      for (const step of interaction.steps) {
        if (
          step &&
          step.output_image &&
          step.output_image.data
        ) {
          return step.output_image.data;
        }

        if (step && Array.isArray(step.content)) {
          for (const block of step.content) {
            if (
              block &&
              block.type === "image" &&
              block.data
            ) {
              return block.data;
            }

            if (
              block &&
              block.image &&
              block.image.data
            ) {
              return block.image.data;
            }
          }
        }
      }
    }

    throw new Error("Gemini n'a retourné aucune image.");
  } catch (error) {
    const q = quotaError(error);

    if (q) {
      const e = new Error(q.message);
      e.statusCode = 429;
      throw e;
    }

    throw error;
  }
}

/* =========================================================
   FFMPEG
========================================================= */

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
              stdout ||
              error.message ||
              "Erreur FFmpeg"
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
    text.includes("triste") ||
    text.includes("drame") ||
    text.includes("dramatique")
  ) {
    return "dramatic";
  }

  if (
    text.includes("action") ||
    text.includes("combat") ||
    text.includes("course")
  ) {
    return "action";
  }

  if (
    text.includes("football") ||
    text.includes("sport")
  ) {
    return "sport";
  }

  if (
    text.includes("joie") ||
    text.includes("heureux") ||
    text.includes("victoire")
  ) {
    return "uplifting";
  }

  return "cinematic";
}

function buildAudioPlan(project) {
  const mood = detectMood(project);

  const plans = {
    dramatic: {
      mood,
      tempo: "slow",
      instruments: ["piano", "strings", "soft pads"],
      description:
        "Musique cinématique émotionnelle et dramatique."
    },

    action: {
      mood,
      tempo: "fast",
      instruments: ["drums", "bass", "cinematic percussion"],
      description:
        "Musique dynamique et énergique adaptée à l'action."
    },

    sport: {
      mood,
      tempo: "medium-fast",
      instruments: ["drums", "bass", "uplifting synth"],
      description:
        "Musique sportive motivante et cinématique."
    },

    uplifting: {
      mood,
      tempo: "medium",
      instruments: ["piano", "strings", "light drums"],
      description:
        "Musique positive et inspirante."
    },

    cinematic: {
      mood,
      tempo: "medium",
      instruments: ["strings", "piano", "cinematic percussion"],
      description:
        "Musique cinématique moderne adaptée à l'histoire."
    }
  };

  return plans[mood] || plans.cinematic;
}

async function generateFallbackAudio(outputPath, duration) {
  const seconds = Math.max(1, Number(duration) || 10);

  await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=stereo",
    "-t",
    String(seconds),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-y",
    outputPath
  ]);

  return outputPath;
}

async function generateAudioTrack(project, outputPath) {
  const duration =
    Number(project && project.duration) || 10;

  return generateFallbackAudio(
    outputPath,
    duration
  );
}

/* =========================================================
   TENDANCES
========================================================= */

function buildTrendPrompt() {
  return [
    "Donne 6 idées de vidéos courtes populaires.",
    "Réponds uniquement en JSON.",
    "Format:",
    "{",
    '"ideas": [',
    "{",
    '"title":"",',
    '"concept":"",',
    '"style":"",',
    '"hook":""',
    "}",
    "]",
    "}"
  ].join("\n");
}

async function generateTrendIdeas() {
  try {
    const text = await generateTextInteraction(
      buildTrendPrompt()
    );

    const parsed = JSON.parse(cleanJson(text));

    if (
      parsed &&
      Array.isArray(parsed.ideas)
    ) {
      return parsed.ideas;
    }
  } catch (error) {
    console.log(
      "Tendances Gemini indisponibles:",
      error.message
    );
  }

  return [
    {
      title: "Le rêve devenu réalité",
      concept:
        "Un jeune talent poursuit son rêve malgré les difficultés.",
      style: "cinématique",
      hook:
        "Tout le monde lui disait qu'il n'y arriverait jamais."
    },
    {
      title: "Le dernier match",
      concept:
        "Un jeune sportif joue le match le plus important de sa vie.",
      style: "sport",
      hook:
        "Il ne lui reste qu'une seule chance."
    },
    {
      title: "Une décision",
      concept:
        "Un personnage doit choisir entre abandonner et continuer.",
      style: "drame",
      hook:
        "Cette décision va changer toute sa vie."
    }
  ];
}

/* =========================================================
   PROJETS
========================================================= */

function makeDashboardProject(project) {
  const id =
    "project-" +
    Date.now() +
    "-" +
    Math.random()
      .toString(36)
      .slice(2, 8);

  const item = {
    id,
    title:
      project.title ||
      "Projet Cineflow",
    concept:
      project.concept ||
      "",
    status: "created",
    createdAt: new Date().toISOString(),
    views: 0,
    likes: 0,
    scenes: project.scenes || []
  };

  dashboardProjects.unshift(item);

  return item;
}

function getProjectById(id) {
  return dashboardProjects.find(
    (project) => project.id === id
  );
}

/* =========================================================
   GÉNÉRATION PROJET
========================================================= */

async function generateProject(prompt) {
  const instruction = [
    "Tu es le moteur créatif de Cineflow.",
    "Crée un projet vidéo cinématique.",
    "Le projet doit contenir exactement 5 scènes.",
    "",
    "Prompt utilisateur:",
    prompt,
    "",
    "Réponds uniquement avec du JSON valide.",
    "Format obligatoire:",
    "{",
    '"title":"",',
    '"concept":"",',
    '"style":"",',
    '"characters":[""],',
    '"scenario":"",',
    '"scenes":[',
    "{",
    '"number":1,',
    '"title":"",',
    '"description":"",',
    '"visualPrompt":"",',
    '"animationPrompt":""',
    "},",
    "{",
    '"number":2,',
    '"title":"",',
    '"description":"",',
    '"visualPrompt":"",',
    '"animationPrompt":""',
    "},",
    "{",
    '"number":3,',
    '"title":"",',
    '"description":"",',
    '"visualPrompt":"",',
    '"animationPrompt":""',
    "},",
    "{",
    '"number":4,',
    '"title":"",',
    '"description":"",',
    '"visualPrompt":"",',
    '"animationPrompt":""',
    "},",
    "{",
    '"number":5,',
    '"title":"",',
    '"description":"",',
    '"visualPrompt":"",',
    '"animationPrompt":""',
    "}",
    "]",
    "}"
  ].join("\n");

  const text =
    await generateTextInteraction(
      instruction
    );

  let project;

  try {
    project = JSON.parse(
      cleanJson(text)
    );
  } catch (error) {
    throw new Error(
      "Gemini a retourné un format de projet invalide."
    );
  }

  if (
    !project ||
    !Array.isArray(project.scenes)
  ) {
    throw new Error(
      "Le projet généré ne contient pas de scènes."
    );
  }

  project.scenes =
    project.scenes.slice(0, 5);

  while (project.scenes.length < 5) {
    project.scenes.push({
      number:
        project.scenes.length + 1,
      title:
        "Scène " +
        (project.scenes.length + 1),
      description: "",
      visualPrompt:
        project.concept || prompt,
      animationPrompt:
        "Animation cinématique naturelle."
    });
  }

  const dashboard =
    makeDashboardProject(project);

  project.id = dashboard.id;

  return project;
}

/* =========================================================
   TEST GEMINI
========================================================= */

app.get(
  "/api/test-gemini",
  async (req, res) => {
    if (!API_KEY) {
      return res.status(500).json({
        ok: false,
        message:
          "GEMINI_API_KEY n'est pas configurée sur Render."
      });
    }

    try {
      const text =
        await generateTextInteraction(
          "Réponds uniquement: Je confirme que Gemini est correctement connecté à Cineflow."
        );

      res.json({
        ok: true,
        message: text ||
          "Gemini est correctement connecté à Cineflow."
      });
    } catch (error) {
      const q = quotaError(error);

      if (q) {
        return res.status(429).json({
          ok: false,
          quota: true,
          message: q.message
        });
      }

      res.status(500).json({
        ok: false,
        message:
          error.message ||
          "Erreur Gemini."
      });
    }
  }
);

/* =========================================================
   GÉNÉRER PROJET
========================================================= */

app.post(
  "/api/generate",
  async (req, res) => {
    const prompt =
      String(req.body && req.body.prompt || "")
        .trim();

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        message:
          "Décris la vidéo que tu veux créer."
      });
    }

    try {
      const project =
        await generateProject(prompt);

      res.json({
        ok: true,
        project
      });
    } catch (error) {
      const q = quotaError(error);

      if (q) {
        return res.status(429).json({
          ok: false,
          quota: true,
          message: q.message
        });
      }

      res.status(500).json({
        ok: false,
        message:
          error.message ||
          "Erreur pendant la génération du projet."
      });
    }
  }
);

/* =========================================================
   PRÉPARER IMAGES
========================================================= */

app.post(
  "/api/prepare-images",
  async (req, res) => {
    const scenes =
      Array.isArray(req.body && req.body.scenes)
        ? req.body.scenes
        : [];

    if (scenes.length !== 5) {
      return res.status(400).json({
        ok: false,
        message:
          "Cineflow doit avoir exactement 5 scènes."
      });
    }

    const prepared =
      scenes.map((scene, index) => ({
        number: index + 1,
        title:
          scene.title ||
          "Scène " + (index + 1),
        description:
          scene.description || "",
        prompt:
          scene.visualPrompt ||
          scene.prompt ||
          scene.description ||
          ""
      }));

    res.json({
      ok: true,
      scenes: prepared
    });
  }
);

/* =========================================================
   GÉNÉRER UNE IMAGE
========================================================= */

app.post(
  "/api/generate-image",
  async (req, res) => {
    const prompt =
      String(req.body && req.body.prompt || "")
        .trim();

    const index =
      Number(req.body && req.body.index);

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        message:
          "Prompt image manquant."
      });
    }

    try {
      const image =
        await generateImage(prompt);

      res.json({
        ok: true,
        index,
        image
      });
    } catch (error) {
      const q = quotaError(error);

      if (q) {
        return res.status(429).json({
          ok: false,
          quota: true,
          index,
          message: q.message
        });
      }

      res.status(500).json({
        ok: false,
        index,
        message:
          error.message ||
          "Erreur pendant la génération de l'image."
      });
    }
  }
);

/* =========================================================
   ANIMATION D'UNE SCÈNE
========================================================= */

app.post(
  "/api/animate-scene",
  async (req, res) => {
    if (!ai) {
      return res.status(500).json({
        ok: false,
        message:
          "GEMINI_API_KEY manquante."
      });
    }

    const prompt =
      String(req.body && req.body.prompt || "")
        .trim();

    const image =
      req.body && req.body.image
        ? req.body.image
        : null;

    const index =
      Number(req.body && req.body.index);

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        message:
          "Prompt d'animation manquant."
      });
    }

    try {
      const videoPrompt =
        prompt +
        "\nAnimation vidéo cinématique réaliste, mouvements naturels, caméra fluide.";

      const operation =
        await ai.models.generateVideos({
          model: VIDEO_MODEL,
          prompt: videoPrompt
        });

      const jobId =
        "scene-" +
        Date.now() +
        "-" +
        Math.random()
          .toString(36)
          .slice(2, 8);

      animationJobs.set(jobId, {
        id: jobId,
        status: "processing",
        operation,
        index,
        image,
        createdAt: Date.now()
      });

      res.json({
        ok: true,
        jobId,
        index,
        status: "processing"
      });
    } catch (error) {
      const q = quotaError(error);

      if (q) {
        return res.status(429).json({
          ok: false,
          quota: true,
          message: q.message
        });
      }

      res.status(500).json({
        ok: false,
        message:
          error.message ||
          "Impossible de lancer l'animation."
      });
    }
  }
);

/* =========================================================
   ANIMER LES 5 SCÈNES
========================================================= */

app.post(
  "/api/animate-scenes",
  async (req, res) => {
    const scenes =
      Array.isArray(req.body && req.body.scenes)
        ? req.body.scenes
        : [];

    if (scenes.length !== 5) {
      return res.status(400).json({
        ok: false,
        message:
          "Il faut exactement 5 scènes."
      });
    }

    const jobId =
      "animation-" +
      Date.now() +
      "-" +
      Math.random()
        .toString(36)
        .slice(2, 8);

    const job = {
      id: jobId,
      status: "processing",
      progress: 0,
      scenes: scenes.map(
        (scene, index) => ({
          index,
          status: "waiting",
          video: null,
          error: null,
          prompt:
            scene.animationPrompt ||
            scene.visualPrompt ||
            scene.description ||
            ""
        })
      ),
      createdAt: Date.now()
    };

    animationJobs.set(
      jobId,
      job
    );

    res.json({
      ok: true,
      jobId,
      status: "processing"
    });

    processAnimationJob(jobId).catch(
      (error) => {
        const current =
          animationJobs.get(jobId);

        if (current) {
          current.status = "error";
          current.error =
            error.message;
        }
      }
    );
  }
);

async function processAnimationJob(
  jobId
) {
  const job =
    animationJobs.get(jobId);

  if (!job) return;

  if (!ai) {
    job.status = "error";
    job.error =
      "GEMINI_API_KEY manquante.";
    return;
  }

  for (
    let i = 0;
    i < job.scenes.length;
    i++
  ) {
    const scene =
      job.scenes[i];

    scene.status =
      "processing";

    try {
      const operation =
        await ai.models.generateVideos({
          model: VIDEO_MODEL,
          prompt:
            scene.prompt +
            "\nVidéo cinématique réaliste de 8 secondes."
        });

      scene.operation =
        operation;

      let current =
        operation;

      let attempts = 0;

      while (
        current &&
        !current.done &&
        attempts < 60
      ) {
        await sleep(5000);

        current =
          await ai.operations.getVideosOperation({
            operation: current
          });

        attempts++;
      }

      if (
        !current ||
        !current.done
      ) {
        throw new Error(
          "La génération vidéo a pris trop de temps."
        );
      }

      scene.video =
        current.result ||
        current.response ||
        null;

      scene.status = "completed";
    } catch (error) {
      scene.status = "error";
      scene.error =
        error.message ||
        "Erreur animation.";

      const q =
        quotaError(error);

      if (q) {
        job.status = "error";
        job.error = q.message;
        return;
      }
    }

    const completed =
      job.scenes.filter(
        (item) =>
          item.status === "completed"
      ).length;

    job.progress =
      Math.round(
        (completed /
          job.scenes.length) *
          100
      );
  }

  const failed =
    job.scenes.some(
      (scene) =>
        scene.status === "error"
    );

  job.status =
    failed
      ? "error"
      : "completed";

  job.progress =
    failed
      ? job.progress
      : 100;
}

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
        ok: false,
        message:
          "Animation introuvable."
      });
    }

    res.json({
      ok: true,
      job
    });
  }
);

/* =========================================================
   ANIMATION SCÈNE
========================================================= */

app.get(
  "/api/animation-scene/:jobId/:sceneIndex",
  (req, res) => {
    const job =
      animationJobs.get(
        req.params.jobId
      );

    if (!job) {
      return res.status(404).json({
        ok: false,
        message:
          "Animation introuvable."
      });
    }

    const index =
      Number(req.params.sceneIndex);

    const scene =
      job.scenes[index];

    if (!scene) {
      return res.status(404).json({
        ok: false,
        message:
          "Scène introuvable."
      });
    }

    res.json({
      ok: true,
      scene
    });
  }
);

/* =========================================================
   RETRY ANIMATION
========================================================= */

app.post(
  "/api/animation-retry",
  async (req, res) => {
    const jobId =
      req.body && req.body.jobId;

    const job =
      animationJobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        ok: false,
        message:
          "Job introuvable."
      });
    }

    job.status = "processing";
    job.error = null;

    processAnimationJob(jobId).catch(
      (error) => {
        job.status = "error";
        job.error =
          error.message;
      }
    );

    res.json({
      ok: true,
      jobId,
      status: "processing"
    });
  }
);

/* =========================================================
   REGENERER UNE SCÈNE
========================================================= */

app.post(
  "/api/animation-regenerate",
  async (req, res) => {
    const prompt =
      String(
        req.body &&
        req.body.prompt ||
        ""
      ).trim();

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        message:
          "Prompt manquant."
      });
    }

    try {
      const operation =
        await ai.models.generateVideos({
          model: VIDEO_MODEL,
          prompt:
            prompt +
            "\nVidéo cinématique réaliste."
        });

      res.json({
        ok: true,
        operation
      });
    } catch (error) {
      const q = quotaError(error);

      if (q) {
        return res.status(429).json({
          ok: false,
          quota: true,
          message: q.message
        });
      }

      res.status(500).json({
        ok: false,
        message:
          error.message
      });
    }
  }
);

/* =========================================================
   CRÉER VIDÉO FINALE
========================================================= */

app.post(
  "/api/create-video",
  async (req, res) => {
    const images =
      Array.isArray(
        req.body &&
        req.body.images
      )
        ? req.body.images
        : [];

    if (images.length !== 5) {
      return res.status(400).json({
        ok: false,
        message:
          "Cineflow doit avoir exactement 5 images."
      });
    }

    const tempDir =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "cineflow-"
        )
      );

    try {
      const imageFiles = [];

      for (
        let i = 0;
        i < images.length;
        i++
      ) {
        const item =
          images[i];

        let data =
          String(item || "");

        if (
          data.startsWith(
            "data:image"
          )
        ) {
          data =
            data.split(",")[1];
        }

        const file =
          path.join(
            tempDir,
            "scene-" +
            (i + 1) +
            ".png"
          );

        fs.writeFileSync(
          file,
          Buffer.from(
            data,
            "base64"
          )
        );

        imageFiles.push(file);
      }

      const listFile =
        path.join(
          tempDir,
          "list.txt"
        );

      const listContent =
        imageFiles
          .map(
            (file) =>
              "file '" +
              file.replace(
                /'/g,
                "'\\''"
              ) +
              "'"
          )
          .join("\n");

      fs.writeFileSync(
        listFile,
        listContent
      );

      const output =
        path.join(
          tempDir,
          "cineflow-final.mp4"
        );

      await runFfmpeg([
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listFile,
        "-vf",
        "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
        "-r",
        "30",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-movflags",
        "+faststart",
        "-y",
        output
      ]);

      const videoId =
        "video-" +
        Date.now() +
        "-" +
        Math.random()
          .toString(36)
          .slice(2, 8);

      videoFiles.set(
        videoId,
        {
          path: output,
          createdAt: Date.now()
        }
      );

      res.json({
        ok: true,
        videoId,
        download:
          "/api/download-video/" +
          videoId
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message:
          error.message ||
          "Impossible de créer la vidéo."
      });
    }
  }
);

/* =========================================================
   DOWNLOAD VIDÉO
========================================================= */

app.get(
  "/api/download-video/:videoId",
  (req, res) => {
    const video =
      videoFiles.get(
        req.params.videoId
      );

    if (
      !video ||
      !fs.existsSync(video.path)
    ) {
      return res.status(404).send(
        "Vidéo introuvable."
      );
    }

    res.download(
      video.path,
      "cineflow-video.mp4"
    );
  }
);

/* =========================================================
   AUDIO
========================================================= */

app.post(
  "/api/prepare-audio",
  async (req, res) => {
    const project =
      req.body &&
      req.body.project
        ? req.body.project
        : {};

    const plan =
      buildAudioPlan(project);

    const tempDir =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "cineflow-audio-"
        )
      );

    const output =
      path.join(
        tempDir,
        "audio.m4a"
      );

    try {
      await generateAudioTrack(
        project,
        output
      );

      res.json({
        ok: true,
        plan,
        audioReady: true
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        plan,
        message:
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
  async (req, res) => {
    const prompt =
      String(
        req.body &&
        req.body.prompt ||
        ""
      ).trim();

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        message:
          "Prompt miniature manquant."
      });
    }

    try {
      const image =
        await generateImage(
          "Miniature YouTube très attractive, cinématique, 16:9, sans texte illisible. " +
          prompt
        );

      res.json({
        ok: true,
        image
      });
    } catch (error) {
      const q = quotaError(error);

      if (q) {
        return res.status(429).json({
          ok: false,
          quota: true,
          message: q.message
        });
      }

      res.status(500).json({
        ok: false,
        message:
          error.message
      });
    }
  }
);

/* =========================================================
   RÉSEAUX SOCIAUX
========================================================= */

app.post(
  "/api/prepare-social",
  async (req, res) => {
    const project =
      req.body &&
      req.body.project
        ? req.body.project
        : {};

    const title =
      project.title ||
      "Nouvelle vidéo Cineflow";

    const concept =
      project.concept ||
      "";

    res.json({
      ok: true,
      posts: {
        youtube:
          title +
          "\n\n" +
          concept +
          "\n\n#Cineflow #YouTube",
        tiktok:
          concept +
          "\n\n#Cineflow #TikTok #FYP",
        instagram:
          concept +
          "\n\n#Cineflow #Reels",
        facebook:
          title +
          "\n\n" +
          concept
      }
    });
  }
);

/* =========================================================
   AUTO-PILOTE
========================================================= */

app.post(
  "/api/autopilot-plan",
  async (req, res) => {
    const count =
      Math.max(
        1,
        Math.min(
          10,
          Number(
            req.body &&
            req.body.count
          ) || 5
        )
      );

    res.json({
      ok: true,
      plan: {
        count,
        schedule:
          "Publication automatique planifiée.",
        platforms: [
          "YouTube",
          "TikTok",
          "Instagram",
          "Facebook"
        ]
      }
    });
  }
);

/* =========================================================
   TENDANCES
========================================================= */

app.get(
  "/api/trends",
  async (req, res) => {
    const ideas =
      await generateTrendIdeas();

    res.json({
      ok: true,
      ideas
    });
  }
);

/* =========================================================
   DASHBOARD
========================================================= */

app.get(
  "/api/dashboard",
  (req, res) => {
    res.json({
      ok: true,
      projects:
        dashboardProjects.length,
      series:
        dashboardSeries.length,
      accounts:
        dashboardAccounts
    });
  }
);

/* =========================================================
   PROJETS
========================================================= */

app.get(
  "/api/projects",
  (req, res) => {
    res.json({
      ok: true,
      projects:
        dashboardProjects
    });
  }
);

app.post(
  "/api/projects",
  (req, res) => {
    const project =
      makeDashboardProject(
        req.body || {}
      );

    res.json({
      ok: true,
      project
    });
  }
);

app.post(
  "/api/projects/status",
  (req, res) => {
    const project =
      getProjectById(
        req.body &&
        req.body.id
      );

    if (!project) {
      return res.status(404).json({
        ok: false,
        message:
          "Projet introuvable."
      });
    }

    project.status =
      req.body.status ||
      project.status;

    res.json({
      ok: true,
      project
    });
  }
);

/* =========================================================
   COMPTES
========================================================= */

app.get(
  "/api/accounts",
  (req, res) => {
    res.json({
      ok: true,
      accounts:
        dashboardAccounts
    });
  }
);

app.post(
  "/api/accounts/connect",
  (req, res) => {
    const platform =
      String(
        req.body &&
        req.body.platform ||
        ""
      ).toLowerCase();

    if (
      !dashboardAccounts[platform]
    ) {
      return res.status(400).json({
        ok: false,
        message:
          "Plateforme inconnue."
      });
    }

    dashboardAccounts[
      platform
    ].connected = true;

    res.json({
      ok: true,
      account:
        dashboardAccounts[
          platform
        ]
    });
  }
);

/* =========================================================
   RAPPORT HEBDOMADAIRE
========================================================= */

app.get(
  "/api/reports/weekly",
  (req, res) => {
    const totalViews =
      dashboardProjects.reduce(
        (sum, project) =>
          sum +
          Number(
            project.views || 0
          ),
        0
      );

    const totalLikes =
      dashboardProjects.reduce(
        (sum, project) =>
          sum +
          Number(
            project.likes || 0
          ),
        0
      );

    res.json({
      ok: true,
      report: {
        period: "weekly",
        videos:
          dashboardProjects.length,
        views: totalViews,
        likes: totalLikes,
        revenue: 0
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
      ok: true,
      report: {
        period: "monthly",
        videos:
          dashboardProjects.length,
        views: 0,
        likes: 0,
        revenue: 0
      }
    });
  }
);

/* =========================================================
   SÉRIES
========================================================= */

app.get(
  "/api/series",
  (req, res) => {
    res.json({
      ok: true,
      series:
        dashboardSeries
    });
  }
);

app.post(
  "/api/series",
  (req, res) => {
    const series = {
      id:
        "series-" +
        Date.now(),
      title:
        req.body &&
        req.body.title ||
        "Nouvelle série",
      description:
        req.body &&
        req.body.description ||
        "",
      episodes: [],
      createdAt:
        new Date().toISOString()
    };

    dashboardSeries.unshift(
      series
    );

    res.json({
      ok: true,
      series
    });
  }
);

/* =========================================================
   INTERFACE CINEFLOW
========================================================= */

app.get("/", (req, res) => {
  const html = String.raw`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
/>
<title>Cineflow</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, Helvetica, sans-serif;
  background: #080d18;
  color: #ffffff;
}

button,
textarea,
input {
  font: inherit;
}

button {
  cursor: pointer;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  padding: 14px 18px;
  background: rgba(8,13,24,.95);
  border-bottom: 1px solid #202b42;
  backdrop-filter: blur(12px);
}

.brand {
  font-size: 23px;
  font-weight: 800;
}

.brand span {
  color: #7c5cff;
}

.layout {
  display: flex;
  min-height: calc(100vh - 62px);
}

.sidebar {
  width: 230px;
  padding: 18px 12px;
  border-right: 1px solid #202b42;
  background: #0b1120;
}

.navbtn {
  width: 100%;
  border: 0;
  color: #b9c4d9;
  background: transparent;
  text-align: left;
  padding: 12px;
  margin-bottom: 5px;
  border-radius: 12px;
}

.navbtn:hover,
.navbtn.active {
  background: #18213a;
  color: white;
}

.main {
  flex: 1;
  padding: 20px;
  max-width: 1250px;
}

.hero {
  padding: 22px;
  border: 1px solid #263452;
  border-radius: 22px;
  background:
    linear-gradient(
      145deg,
      #121a2d,
      #0b1120
    );
  margin-bottom: 18px;
}

.hero h1 {
  margin: 0 0 8px;
  font-size: 30px;
}

.hero p {
  color: #aab5c9;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fit,minmax(260px,1fr));
  gap: 15px;
}

.card {
  background: #10182a;
  border: 1px solid #263452;
  border-radius: 18px;
  padding: 18px;
  margin-bottom: 15px;
}

.card h2,
.card h3 {
  margin-top: 0;
}

.muted {
  color: #9ba8be;
}

textarea {
  width: 100%;
  min-height: 130px;
  resize: vertical;
  background: #080d18;
  color: white;
  border: 1px solid #2c3955;
  border-radius: 14px;
  padding: 14px;
  outline: none;
}

textarea:focus {
  border-color: #7c5cff;
}

.btn {
  border: 0;
  border-radius: 12px;
  padding: 12px 16px;
  margin-top: 10px;
  background: #7c5cff;
  color: white;
  font-weight: 700;
}

.btn:hover {
  filter: brightness(1.12);
}

.btn.secondary {
  background: #202c46;
}

.btn.success {
  background: #167c55;
}

.btn.danger {
  background: #8b3040;
}

.btn:disabled {
  opacity: .45;
  cursor: not-allowed;
}

.scene {
  border: 1px solid #2b3854;
  background: #0b1120;
  border-radius: 14px;
  padding: 14px;
  margin: 10px 0;
}

.scene-number {
  display: inline-block;
  padding: 5px 8px;
  background: #7c5cff;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 800;
}

.scene img {
  width: 100%;
  border-radius: 12px;
  margin-top: 10px;
}

.result {
  margin-top: 12px;
}

.status {
  padding: 10px 12px;
  border-radius: 10px;
  background: #151f34;
  color: #bdc8dc;
  margin-top: 10px;
}

.mobile-nav {
  display: none;
}

.hidden {
  display: none !important;
}

.stat {
  padding: 18px;
  border-radius: 15px;
  background: #111b30;
  border: 1px solid #263452;
}

.stat strong {
  display: block;
  font-size: 28px;
  margin-top: 5px;
}

@media(max-width:800px) {
  .sidebar {
    display: none;
  }

  .main {
    padding: 13px;
    padding-bottom: 90px;
  }

  .mobile-nav {
    display: flex;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 30;
    background: #0b1120;
    border-top: 1px solid #263452;
    padding: 8px;
    gap: 5px;
  }

  .mobile-nav button {
    flex: 1;
    border: 0;
    background: transparent;
    color: #aeb9cc;
    padding: 9px 4px;
    border-radius: 10px;
    font-size: 11px;
  }

  .mobile-nav button:hover {
    background: #18213a;
    color: white;
  }

  .hero h1 {
    font-size: 25px;
  }
}
</style>
</head>

<body>

<header class="topbar">
  <div class="brand">
    🎬 Cine<span>flow</span>
  </div>
</header>

<div class="layout">

<aside class="sidebar">

<button class="navbtn active" onclick="showSection('home')">
🏠 Accueil
</button>

<button class="navbtn" onclick="showSection('create')">
✨ Créer
</button>

<button class="navbtn" onclick="showSection('studio')">
🎬 Studio
</button>

<button class="navbtn" onclick="showSection('trends')">
🔥 Tendances
</button>

<button class="navbtn" onclick="showSection('autopilot')">
🤖 Auto-Pilote
</button>

<button class="navbtn" onclick="showSection('projects')">
📁 Projets
</button>

<button class="navbtn" onclick="showSection('series')">
📺 Séries
</button>

<button class="navbtn" onclick="showSection('accounts')">
🌐 Comptes
</button>

<button class="navbtn" onclick="showSection('reports')">
📊 Rapports
</button>

</aside>

<main class="main">

<section id="home">

<div class="hero">
<h1>Ton espace de création assistée par intelligence artificielle</h1>
<p>
Cineflow transforme ton idée en projet vidéo,
scènes, images, animation et vidéo finale.
</p>

<button class="btn" onclick="showSection('create')">
🚀 Créer une vidéo
</button>
</div>

<div class="grid">

<div class="stat">
<span class="muted">Projets</span>
<strong id="homeProjects">0</strong>
</div>

<div class="stat">
<span class="muted">Séries</span>
<strong id="homeSeries">0</strong>
</div>

<div class="stat">
<span class="muted">Vues</span>
<strong id="homeViews">0</strong>
</div>

</div>

<div class="card">
<h2>🧠 Gemini</h2>
<p class="muted">
Teste la connexion entre Cineflow et Gemini.
</p>

<button class="btn secondary" onclick="testGemini()">
✨ Tester Gemini
</button>

<div id="geminiResult" class="result"></div>
</div>

</section>

<section id="create" class="hidden">

<div class="hero">
<h1>✨ Créer une vidéo</h1>
<p>
Décris simplement la vidéo que tu veux créer.
</p>
</div>

<div class="card">

<textarea
id="prompt"
placeholder="Exemple : un jeune footballeur africain qui poursuit son rêve de devenir professionnel malgré les difficultés..."
></textarea>

<button
id="generateProjectBtn"
class="btn"
onclick="genererProjet()"
>
🚀 Générer mon projet
</button>

<div id="projectResult" class="result"></div>

</div>

</section>

<section id="studio" class="hidden">

<div class="hero">
<h1>🎬 Studio Cineflow</h1>
<p>
Construis ta vidéo étape par étape.
</p>
</div>

<div class="card">
<h2>1. Projet</h2>
<div id="studioProject">
Aucun projet chargé.
</div>
</div>

<div class="card">
<h2>2. 🧩 5 scènes</h2>

<button
id="prepareScenesBtn"
class="btn secondary"
disabled
onclick="preparerScenes()"
>
🧩 Préparer les 5 scènes
</button>

<div id="scenesResult" class="result"></div>
</div>

<div class="card">
<h2>3. 🎨 Images</h2>

<p class="muted">
Cineflow génère une image pour chacune des 5 scènes.
</p>

<button
id="generateImagesBtn"
class="btn"
disabled
onclick="genererImages()"
>
🎨 Générer les images
</button>

<div id="imagesResult" class="result"></div>
</div>

<div class="card">
<h2>4. 🎞️ Veo 3.1</h2>

<button
id="animateBtn"
class="btn secondary"
disabled
onclick="animerScenes()"
>
🎞️ Animer les 5 scènes
</button>

<div id="animationResult" class="result"></div>
</div>

<div class="card">
<h2>5. 🎬 Vidéo finale</h2>

<button
id="createVideoBtn"
class="btn success"
disabled
onclick="creerVideo()"
>
🎬 Créer ma vidéo
</button>

<div id="videoResult" class="result"></div>
</div>

<div class="card">
<h2>6. 🎵 Musique</h2>

<button
class="btn secondary"
onclick="preparerAudio()"
>
🎵 Préparer la musique
</button>

<div id="audioResult" class="result"></div>
</div>

<div class="card">
<h2>7. 🖼️ Miniature</h2>

<button
class="btn secondary"
onclick="preparerThumbnail()"
>
🖼️ Générer la miniature
</button>

<div id="thumbnailResult" class="result"></div>
</div>

<div class="card">
<h2>8. 📱 Réseaux sociaux</h2>

<button
class="btn secondary"
onclick="preparerSocial()"
>
📱 Préparer les publications
</button>

<div id="socialResult" class="result"></div>
</div>

</section>

<section id="trends" class="hidden">

<div class="hero">
<h1>🔥 Tendances</h1>
<p>
Trouve rapidement des idées de vidéos.
</p>
</div>

<div class="card">
<button
class="btn"
onclick="chargerTendances()"
>
🔥 Charger les idées
</button>

<div id="trendsResult" class="result"></div>
</div>

</section>

<section id="autopilot" class="hidden">

<div class="hero">
<h1>🤖 Auto-Pilote</h1>
<p>
Prépare automatiquement plusieurs vidéos.
</p>
</div>

<div class="card">

<label>
Nombre de vidéos
</label>

<input
id="autopilotCount"
type="number"
min="1"
max="10"
value="5"
style="
width:100%;
padding:12px;
margin-top:8px;
background:#080d18;
border:1px solid #2c3955;
border-radius:12px;
color:white;
"
/>

<button
class="btn"
onclick="preparerAutopilot()"
>
🤖 Préparer l'Auto-Pilote
</button>

<div id="autopilotResult" class="result"></div>

</div>

</section>

<section id="projects" class="hidden">

<div class="hero">
<h1>📁 Projets</h1>
<p>
Tous tes projets Cineflow.
</p>
</div>

<div
id="projectsResult"
class="grid"
>
</div>

</section>

<section id="series" class="hidden">

<div class="hero">
<h1>📺 Séries</h1>
<p>
Crée des histoires avec plusieurs épisodes.
</p>
</div>

<div class="card">

<input
id="seriesTitle"
placeholder="Nom de la série"
style="
width:100%;
padding:12px;
background:#080d18;
border:1px solid #2c3955;
border-radius:12px;
color:white;
"
/>

<button
class="btn"
onclick="creerSerie()"
>
➕ Créer une série
</button>

<div id="seriesResult" class="result"></div>

</div>

</section>

<section id="accounts" class="hidden">

<div class="hero">
<h1>🌐 Comptes</h1>
<p>
Connecte les plateformes qui seront utilisées par Cineflow.
</p>
</div>

<div
id="accountsResult"
class="grid"
>
</div>

</section>

<section id="reports" class="hidden">

<div class="hero">
<h1>📊 Rapports</h1>
<p>
Suis les performances de Cineflow.
</p>
</div>

<div class="card">
<h2>Cette semaine</h2>

<button
class="btn"
onclick="chargerHebdo()"
>
📊 Rapport hebdomadaire
</button>

<div id="weeklyResult"></div>
</div>

<div class="card">
<h2>Ce mois</h2>

<button
class="btn secondary"
onclick="chargerMensuel()"
>
📈 Rapport mensuel
</button>

<div id="monthlyResult"></div>
</div>

</section>

</main>
</div>

<nav class="mobile-nav">

<button onclick="showSection('home')">
🏠<br>Accueil
</button>

<button onclick="showSection('create')">
✨<br>Créer
</button>

<button onclick="showSection('studio')">
🎬<br>Studio
</button>

<button onclick="showSection('trends')">
🔥<br>Tendances
</button>

<button onclick="showSection('autopilot')">
🤖<br>Auto
</button>

</nav>

<script>
var currentProject = null;
var preparedScenes = [];
var generatedImages = [];
var animationJobId = null;

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showSection(name) {
  var sections =
    document.querySelectorAll("main section");

  sections.forEach(function(section) {
    section.classList.add("hidden");
  });

  var target =
    document.getElementById(name);

  if (target) {
    target.classList.remove("hidden");
  }

  document
    .querySelectorAll(".navbtn")
    .forEach(function(button) {
      button.classList.remove("active");
    });

  if (name === "projects") {
    chargerProjets();
  }

  if (name === "accounts") {
    chargerComptes();
  }

  if (name === "series") {
    chargerSeries();
  }

  if (name === "home") {
    chargerAccueil();
  }
}

function setResult(id, html) {
  var element =
    document.getElementById(id);

  if (element) {
    element.innerHTML = html;
  }
}

async function testGemini() {
  setResult(
    "geminiResult",
    '<div class="status">⏳ Test de Gemini...</div>'
  );

  try {
    var response =
      await fetch("/api/test-gemini");

    var data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.message ||
        "Erreur Gemini"
      );
    }

    setResult(
      "geminiResult",
      '<div class="status">✅ ' +
      escapeHtml(data.message) +
      "</div>"
    );
  } catch (error) {
    setResult(
      "geminiResult",
      '<div class="status">❌ ' +
      escapeHtml(error.message) +
      "</div>"
    );
  }
}

async function genererProjet() {
  var prompt =
    document
      .getElementById("prompt")
      .value
      .trim();

  if (!prompt) {
    alert(
      "Décris d'abord ta vidéo."
    );
    return;
  }

  var button =
    document.getElementById(
      "generateProjectBtn"
    );

  button.disabled = true;
  button.textContent =
    "⏳ Génération...";

  setResult(
    "projectResult",
    '<div class="status">🧠 Gemini prépare ton projet...</div>'
  );

  try {
    var response =
      await fetch(
        "/api/generate",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            prompt: prompt
          })
        }
      );

    var data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.message ||
        "Erreur de génération."
      );
    }

    currentProject =
      data.project;

    preparedScenes = [];
    generatedImages = [];

    afficherProjet(
      currentProject
    );

    showSection("studio");
  } catch (error) {
    setResult(
      "projectResult",
      '<div class="status">❌ ' +
      escapeHtml(error.message) +
      "</div>"
    );
  } finally {
    button.disabled = false;
    button.textContent =
      "🚀 Générer mon projet";
  }
}

function afficherProjet(project) {
  if (!project) return;

  var html =
    "<h3>" +
    escapeHtml(project.title) +
    "</h3>" +
    "<p class='muted'>" +
    escapeHtml(project.concept) +
    "</p>" +
    "<p><strong>Style :</strong> " +
    escapeHtml(project.style) +
    "</p>";

  setResult(
    "projectResult",
    '<div class="card">' +
    html +
    "</div>"
  );

  setResult(
    "studioProject",
    html
  );

  var prepare =
    document.getElementById(
      "prepareScenesBtn"
    );

  prepare.disabled = false;
}

async function preparerScenes() {
  if (
    !currentProject ||
    !Array.isArray(
      currentProject.scenes
    ) ||
    currentProject.scenes.length !== 5
  ) {
    alert(
      "Le projet doit contenir exactement 5 scènes."
    );
    return;
  }

  var button =
    document.getElementById(
      "prepareScenesBtn"
    );

  button.disabled = true;
  button.textContent =
    "⏳ Préparation...";

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
            scenes:
              currentProject.scenes
          })
        }
      );

    var data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.message
      );
    }

    preparedScenes =
      data.scenes;

    afficherScenes();

    document.getElementById(
      "generateImagesBtn"
    ).disabled =
      preparedScenes.length !== 5;
  } catch (error) {
    setResult(
      "scenesResult",
      '<div class="status">❌ ' +
      escapeHtml(error.message) +
      "</div>"
    );
  } finally {
    button.disabled =
      preparedScenes.length !== 5;

    button.textContent =
      "🧩 Préparer les 5 scènes";
  }
}

function afficherScenes() {
  var html = "";

  preparedScenes.forEach(
    function(scene, index) {
      html +=
        '<div class="scene">' +
        '<span class="scene-number">SCÈNE ' +
        (index + 1) +
        "</span>" +
        "<h3>" +
        escapeHtml(scene.title) +
        "</h3>" +
        "<p>" +
        escapeHtml(scene.description) +
        "</p>" +
        "<p class='muted'><strong>Prompt :</strong><br>" +
        escapeHtml(scene.prompt) +
        "</p>" +
        "</div>";
    }
  );

  setResult(
    "scenesResult",
    html
  );
}

async function genererImages() {
  if (
    preparedScenes.length !== 5
  ) {
    alert(
      "Prépare d'abord les 5 scènes."
    );
    return;
  }

  var button =
    document.getElementById(
      "generateImagesBtn"
    );

  button.disabled = true;
  button.textContent =
    "⏳ Génération des images...";

  generatedImages = [];

  setResult(
    "imagesResult",
    '<div class="status">🎨 Cineflow génère les 5 images...</div>'
  );

  try {
    for (
      var i = 0;
      i < preparedScenes.length;
      i++
    ) {
      var scene =
        preparedScenes[i];

      setResult(
        "imagesResult",
        '<div class="status">🎨 Génération image ' +
        (i + 1) +
        "/5...</div>"
      );

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
              index: i,
              prompt: scene.prompt
            })
          }
        );

      var data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.message ||
          "Erreur image " +
          (i + 1)
        );
      }

      generatedImages[i] =
        data.image;

      afficherImages();
    }

    setResult(
      "imagesResult",
      '<div class="status">✅ Les 5 images sont prêtes.</div>' +
      document.getElementById(
        "imagesResult"
      ).innerHTML
    );

    document.getElementById(
      "animateBtn"
    ).disabled =
      generatedImages.length !== 5;

    document.getElementById(
      "createVideoBtn"
    ).disabled =
      generatedImages.length !== 5;

  } catch (error) {
    setResult(
      "imagesResult",
      '<div class="status">❌ ' +
      escapeHtml(error.message) +
      "</div>"
    );
  } finally {
    button.disabled =
      preparedScenes.length !== 5;

    button.textContent =
      "🎨 Générer les images";
  }
}

function afficherImages() {
  var html = "";

  generatedImages.forEach(
    function(image, index) {
      if (!image) return;

      var src =
        String(image);

      if (
        !src.startsWith(
          "data:image"
        )
      ) {
        src =
          "data:image/png;base64," +
          src;
      }

      html +=
        '<div class="scene">' +
        '<span class="scene-number">IMAGE ' +
        (index + 1) +
        "</span>" +
        '<img src="' +
        src +
        '" alt="Image scène ' +
        (index + 1) +
        '">' +
        "</div>";
    }
  );

  setResult(
    "imagesResult",
    html
  );
}

async function animerScenes() {
  if (
    generatedImages.length !== 5
  ) {
    alert(
      "Génère d'abord les 5 images."
    );
    return;
  }

  var button =
    document.getElementById(
      "animateBtn"
    );

  button.disabled = true;
  button.textContent =
    "⏳ Animation...";

  setResult(
    "animationResult",
    '<div class="status">🎞️ Cineflow lance Veo 3.1...</div>'
  );

  try {
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
            scenes:
              preparedScenes.map(
                function(scene) {
                  return {
                    animationPrompt:
                      scene.prompt
                  };
                }
              )
          })
        }
      );

    var data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.message ||
        "Erreur animation."
      );
    }

    animationJobId =
      data.jobId;

    pollAnimation();

  } catch (error) {
    setResult(
      "animationResult",
      '<div class="status">❌ ' +
      escapeHtml(error.message) +
      "</div>"
    );

    button.disabled = false;
    button.textContent =
      "🎞️ Animer les 5 scènes";
  }
}

async function pollAnimation() {
  if (!animationJobId) return;

  try {
    var response =
      await fetch(
        "/api/animation-status/" +
        animationJobId
      );

    var data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.message
      );
    }

    var job =
      data.job;

    setResult(
      "animationResult",
      '<div class="status">🎞️ Progression : ' +
      Number(job.progress || 0) +
      "%</div>"
    );

    if (
      job.status ===
      "completed"
    ) {
      setResult(
        "animationResult",
        '<div class="status">✅ Les 5 scènes sont animées.</div>'
      );

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
      job.status === "error"
    ) {
      throw new Error(
        job.error ||
        "Erreur pendant l'animation."
      );
    }

    setTimeout(
      pollAnimation,
      5000
    );

  } catch (error) {
    setResult(
      "animationResult",
      '<div class="status">❌ ' +
      escapeHtml(error.message) +
      "</div>"
    );

    document.getElementById(
      "animateBtn"
    ).disabled = false;

    document.getElementById(
      "animateBtn"
    ).textContent =
      "🎞️ Animer les 5 scènes";
  }
}

async function creerVideo() {
  if (
    generatedImages.length !== 5
  ) {
    alert(
      "Il faut 5 images pour créer la vidéo."
    );
    return;
  }

  var button =
    document.getElementById(
      "createVideoBtn"
    );

  button.disabled = true;
  button.textContent =
    "⏳ Création...";

  setResult(
    "videoResult",
    '<div class="status">🎬 Cineflow crée ta vidéo finale...</div>'
  );

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
            images:
              generatedImages
          })
        }
      );

    var data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.message ||
        "Erreur vidéo."
      );
    }

    setResult(
      "videoResult",
      '<div class="status">✅ Vidéo créée.</div>' +
      '<a class="btn" href="' +
      escapeHtml(
        data.download
      ) +
      '">⬇️ Télécharger la vidéo</a>'
    );

  } catch (error) {
    setResult(
      "videoResult",
      '<div class="status">❌ ' +
      escapeHtml(error.message) +
      "</div>"
    );
  } finally {
    button.disabled =
      generatedImages.length !== 5;

    button.textContent =
      "🎬 Créer ma vidéo";
  }
}

async function preparerAudio() {
  if (!currentProject) {
    alert(
      "Crée d'abord un projet."
    );
    return;
  }

  setResult(
    "audioResult",
    '<div class="status">🎵 Préparation de la musique...</div>'
  );

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
        data.message
      );
    }

    setResult(
      "audioResult",
      '<div class="status">✅ Plan musical : ' +
      escapeHtml(
        data.plan.description
      ) +
      "</div>"
    );

  } catch (error) {
    setResult(
      "audioResult",
      '<div class="status">❌ ' +
      escapeHtml(error.message) +
      "</div>"
    );
  }
}

async function preparerThumbnail() {
  if (!currentProject) {
    alert(
      "Crée d'abord un projet."
    );
    return;
  }

  setResult(
    "thumbnailResult",
    '<div class="status">🖼️ Génération de la miniature...</div>'
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
            prompt:
              currentProject.concept ||
              currentProject.title
          })
        }
      );

    var data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.message
      );
    }

    var image =
      String(data.image);

    if (
      !image.startsWith(
        "data:image"
      )
    ) {
      image =
        "data:image/png;base64," +
        image;
    }

    setResult(
      "thumbnailResult",
      '<div class="status">✅ Miniature prête.</div>' +
      '<img style="width:100%;border-radius:14px;margin-top:10px" src="' +
      image +
      '">'
    );

  } catch (error) {
    setResult(
      "thumbnailResult",
      '<div class="status">❌ ' +
      escapeHtml(error.message) +
      "</div>"
    );
  }
}

async function preparerSocial() {
  if (!currentProject) {
    alert(
      "Crée d'abord un projet."
    );
    return;
  }

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

    if (!response.ok) {
      throw new Error(
        data.message
      );
    }

    var posts =
      data.posts;

    setResult(
      "socialResult",
      "<div class='scene'><strong>YouTube</strong><p>" +
      escapeHtml(posts.youtube) +
      "</p></div>" +

      "<div class='scene'><strong>TikTok</strong><p>" +
      escapeHtml(posts.tiktok) +
      "</p></div>" +

      "<div class='scene'><strong>Instagram</strong><p>" +
      escapeHtml(posts.instagram) +
      "</p></div>" +

      "<div class='scene'><strong>Facebook</strong><p>" +
      escapeHtml(posts.facebook) +
      "</p></div>"
    );

  } catch (error) {
    setResult(
      "socialResult",
      '<div class="status">❌ ' +
      escapeHtml(error.message) +
      "</div>"
    );
  }
}

async function preparerAutopilot() {
  var count =
    Number(
      document.getElementById(
        "autopilotCount"
      ).value
    ) || 5;

  setResult(
    "autopilotResult",
    '<div class="status">🤖 Préparation...</div>'
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
            count: count
          })
        }
      );

    var data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.message
      );
    }

    setResult(
      "autopilotResult",
      '<div class="status">✅ ' +
      data.plan.count +
      " vidéos préparées pour l'Auto-Pilote.</div>"
    );

  } catch (error) {
    setResult(
      "autopilotResult",
      '<div class="status">❌ ' +
      escapeHtml(error.message) +
      "</div>"
    );
  }
}

async function chargerTendances() {
  setResult(
    "trendsResult",
    '<div class="status">🔥 Chargement...</div>'
  );

  try {
    var response =
      await fetch(
        "/api/trends"
      );

    var data =
      await response.json();

    var html = "";

    data.ideas.forEach(
      function(idea, index) {
        html +=
          '<div class="scene">' +
          "<h3>" +
          escapeHtml(
            idea.title
          ) +
          "</h3>" +
          "<p>" +
          escapeHtml(
            idea.concept
          ) +
          "</p>" +
          "<p class='muted'>" +
          escapeHtml(
            idea.hook
          ) +
          "</p>" +
          '<button class="btn" onclick="utiliserTendance(' +
          index +
          ')">✨ Utiliser</button>' +
          "</div>";
      }
    );

    window.currentTrends =
      data.ideas;

    setResult(
      "trendsResult",
      html
    );

  } catch (error) {
    setResult(
      "trendsResult",
      '<div class="status">❌ ' +
      escapeHtml(error.message) +
      "</div>"
    );
  }
}

function utiliserTendance(index) {
  var idea =
    window.currentTrends &&
    window.currentTrends[index];

  if (!idea) return;

  document.getElementById(
    "prompt"
  ).value =
    idea.concept ||
    idea.title;

  showSection("create");
}

async function chargerProjets() {
  var container =
    document.getElementById(
      "projectsResult"
    );

  container.innerHTML =
    '<div class="status">⏳ Chargement...</div>';

  try {
    var response =
      await fetch(
        "/api/projects"
      );

    var data =
      await response.json();

    if (!data.projects.length) {
      container.innerHTML =
        '<div class="card"><p class="muted">Aucun projet pour le moment.</p></div>';

      return;
    }

    var html = "";

    data.projects.forEach(
      function(project) {
        html +=
          '<div class="card">' +
          "<h3>" +
          escapeHtml(
            project.title
          ) +
          "</h3>" +
          "<p class='muted'>" +
          escapeHtml(
            project.concept
          ) +
          "</p>" +
          "<p>Statut : " +
          escapeHtml(
            project.status
          ) +
          "</p>" +
          "</div>";
      }
    );

    container.innerHTML =
      html;

  } catch (error) {
    container.innerHTML =
      '<div class="status">❌ ' +
      escapeHtml(error.message) +
      "</div>";
  }
}

async function chargerComptes() {
  var container =
    document.getElementById(
      "accountsResult"
    );

  try {
    var response =
      await fetch(
        "/api/accounts"
      );

    var data =
      await response.json();

    var html = "";

    Object.keys(
      data.accounts
    ).forEach(
      function(key) {
        var account =
          data.accounts[key];

        html +=
          '<div class="card">' +
          "<h3>" +
          escapeHtml(
            account.name
          ) +
          "</h3>" +
          "<p>" +
          (
            account.connected
              ? "✅ Connecté"
              : "⚪ Non connecté"
          ) +
          "</p>" +
          '<button class="btn secondary" onclick="connecterCompte(\'' +
          key +
          "')\">" +
          (
            account.connected
              ? "Reconnecter"
              : "Connecter"
          ) +
          "</button>" +
          "</div>";
      }
    );

    container.innerHTML =
      html;

  } catch (error) {
    container.innerHTML =
      '<div class="status">❌ ' +
      escapeHtml(error.message) +
      "</div>";
  }
}

async function connecterCompte(
  platform
) {
  try {
    await fetch(
      "/api/accounts/connect",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          platform:
            platform
        })
      }
    );

    chargerComptes();

  } catch (error) {
    alert(
      error.message
    );
  }
}

async function chargerHebdo() {
  try {
    var response =
      await fetch(
        "/api/reports/weekly"
      );

    var data =
      await response.json();

    setResult(
      "weeklyResult",
      '<div class="status">' +
      "🎬 Vidéos : " +
      data.report.videos +
      "<br>👁️ Vues : " +
      data.report.views +
      "<br>❤️ Likes : " +
      data.report.likes +
      "<br>💰 Revenus : " +
      data.report.revenue +
      "</div>"
    );
  } catch (error) {
    setResult(
      "weeklyResult",
      '<div class="status">❌ ' +
      escapeHtml(error.message) +
      "</div>"
    );
  }
}

async function chargerMensuel() {
  try {
    var response =
      await fetch(
        "/api/reports/monthly"
      );

    var data =
      await response.json();

    setResult(
      "monthlyResult",
      '<div class="status">' +
      "🎬 Vidéos : " +
      data.report.videos +
      "<br>👁️ Vues : " +
      data.report.views +
      "<br>❤️ Likes : " +
      data.report.likes +
      "<br>💰 Revenus : " +
      data.report.revenue +
      "</div>"
    );
  } catch (error) {
    setResult(
      "monthlyResult",
      '<div class="status">❌ ' +
      escapeHtml(error.message) +
      "</div>"
    );
  }
}

async function chargerSeries() {
  var container =
    document.getElementById(
      "seriesResult"
    );

  try {
    var response =
      await fetch(
        "/api/series"
      );

    var data =
      await response.json();

    if (!data.series.length) {
      container.innerHTML =
        '<div class="status">Aucune série pour le moment.</div>';

      return;
    }

    var html = "";

    data.series.forEach(
      function(series) {
        html +=
          '<div class="scene">' +
          "<h3>" +
          escapeHtml(
            series.title
          ) +
          "</h3>" +
          "<p>" +
          escapeHtml(
            series.description
          ) +
          "</p>" +
          "</div>";
      }
    );

    container.innerHTML =
      html;

  } catch (error) {
    container.innerHTML =
      '<div class="status">❌ ' +
      escapeHtml(error.message) +
      "</div>";
  }
}

async function creerSerie() {
  var title =
    document.getElementById(
      "seriesTitle"
    ).value.trim();

  if (!title) {
    alert(
      "Donne un nom à la série."
    );
    return;
  }

  try {
    var response =
      await fetch(
        "/api/series",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            title: title,
            description:
              "Série créée avec Cineflow."
          })
        }
      );

    var data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.message
      );
    }

    document.getElementById(
      "seriesTitle"
    ).value = "";

    chargerSeries();

  } catch (error) {
    alert(
      error.message
    );
  }
}

async function chargerAccueil() {
  try {
    var response =
      await fetch(
        "/api/dashboard"
      );

    var data =
      await response.json();

    document.getElementById(
      "homeProjects"
    ).textContent =
      data.projects;

    document.getElementById(
      "homeSeries"
    ).textContent =
      data.series;

    var views = 0;

    Object.keys(
      data.accounts
    ).forEach(
      function(key) {
        views +=
          Number(
            data.accounts[key]
              .views || 0
          );
      }
    );

    document.getElementById(
      "homeViews"
    ).textContent =
      views;

  } catch (error) {
    console.log(
      error.message
    );
  }
}

chargerAccueil();
</script>

</body>
</html>
`;

  res.send(html);
});

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      message:
        "Route introuvable."
    });
  }
);

/* =========================================================
   SERVEUR
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `🎬 Cineflow fonctionne sur le port ${PORT}`
    );
  }
);

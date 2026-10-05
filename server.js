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

const TEXT_MODEL = "gemini-3.8-flash";
const IMAGE_MODEL = "gemini-3.1-flash-image";
const VIDEO_MODEL = "veo-3.1-generate-preview";

const ai = API_KEY
  ? new GoogleGenAI({ apiKey: API_KEY })
  : null;

const projects = [];
const series = [];
const videoFiles = new Map();
const animationJobs = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanJson(text) {
  if (!text) return "";
  return String(text)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function getInteractionText(interaction) {
  if (!interaction) return "";

  if (interaction.output_text) {
    return String(interaction.output_text);
  }

  if (Array.isArray(interaction.outputs)) {
    for (const output of interaction.outputs) {
      if (output && typeof output.text === "string") {
        return output.text;
      }
    }
  }

  if (Array.isArray(interaction.steps)) {
    for (const step of interaction.steps) {
      if (!Array.isArray(step.content)) continue;

      for (const block of step.content) {
        if (block && typeof block.text === "string") {
          return block.text;
        }
      }
    }
  }

  return "";
}

function friendlyError(error) {
  const message =
    error?.message ||
    error?.error?.message ||
    String(error);

  if (
    message.includes("429") ||
    message.includes("RESOURCE_EXHAUSTED") ||
    message.toLowerCase().includes("quota")
  ) {
    return "Quota Gemini atteinte. Réessaie lorsque la limite sera réinitialisée.";
  }

  if (
    message.includes("503") ||
    message.includes("UNAVAILABLE")
  ) {
    return "Gemini est momentanément très sollicité. Réessaie dans quelques instants.";
  }

  return message;
}

async function generateText(prompt) {
  if (!ai) {
    throw new Error("GEMINI_API_KEY est absente dans Render.");
  }

  const interaction = await ai.interactions.create({
    model: TEXT_MODEL,
    input: prompt,
    response_format: {
      type: "text"
    }
  });

  return getInteractionText(interaction);
}

function imageToDataUrl(base64) {
  if (!base64) {
    throw new Error("Gemini n'a retourné aucune image.");
  }

  const value = String(base64);

  if (value.startsWith("data:image")) {
    return value;
  }

  return `data:image/jpeg;base64,${value}`;
}

async function generateImage(prompt) {
  if (!ai) {
    throw new Error("GEMINI_API_KEY est absente dans Render.");
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
    interaction.output_image &&
    interaction.output_image.data
  ) {
    return imageToDataUrl(interaction.output_image.data);
  }

  if (Array.isArray(interaction.steps)) {
    for (const step of interaction.steps) {
      if (!Array.isArray(step.content)) continue;

      for (const block of step.content) {
        if (
          block &&
          block.type === "image" &&
          block.data
        ) {
          return imageToDataUrl(block.data);
        }
      }
    }
  }

  throw new Error("Aucune image reçue de Gemini.");
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      args,
      {
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              stderr ||
              stdout ||
              error.message
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

function dataUrlToFile(dataUrl, filePath) {
  const value = String(dataUrl || "");

  const match = value.match(
    /^data:image\/([^;]+);base64,(.+)$/s
  );

  if (!match) {
    throw new Error("Image invalide.");
  }

  const extension =
    match[1].toLowerCase() === "jpeg"
      ? ".jpg"
      : "." + match[1].toLowerCase();

  const target =
    filePath.endsWith(".jpg") ||
    filePath.endsWith(".jpeg") ||
    filePath.endsWith(".png")
      ? filePath
      : filePath + extension;

  fs.writeFileSync(
    target,
    Buffer.from(match[2], "base64")
  );

  return target;
}

/* =========================
   GEMINI TEST
========================= */

app.get("/api/test-gemini", async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({
        success: false,
        message: "GEMINI_API_KEY absente dans Render."
      });
    }

    const text = await generateText(
      "Réponds exactement : Gemini est correctement connecté à Cineflow."
    );

    res.json({
      success: true,
      message: text
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: friendlyError(error)
    });
  }
});

/* =========================
   CREATE PROJECT
========================= */

app.post("/api/generate", async (req, res) => {
  try {
    const prompt = String(
      req.body.prompt || ""
    ).trim();

    if (!prompt) {
      return res.status(400).json({
        success: false,
        message: "Décris ton idée de vidéo."
      });
    }

    const instruction = `
Tu es le moteur créatif de Cineflow.

Crée un projet vidéo cinématographique à partir de cette idée :

${prompt}

Retourne UNIQUEMENT un JSON valide avec cette structure :

{
  "title": "",
  "concept": "",
  "style": "",
  "characters": [],
  "scenes": [
    {
      "number": 1,
      "title": "",
      "description": "",
      "visualPrompt": "",
      "animationPrompt": ""
    },
    {
      "number": 2,
      "title": "",
      "description": "",
      "visualPrompt": "",
      "animationPrompt": ""
    },
    {
      "number": 3,
      "title": "",
      "description": "",
      "visualPrompt": "",
      "animationPrompt": ""
    },
    {
      "number": 4,
      "title": "",
      "description": "",
      "visualPrompt": "",
      "animationPrompt": ""
    },
    {
      "number": 5,
      "title": "",
      "description": "",
      "visualPrompt": "",
      "animationPrompt": ""
    }
  ]
}

Règles :
- exactement 5 scènes ;
- continuité visuelle entre les scènes ;
- prompts visuels très détaillés ;
- format cinématographique 16:9 ;
- préciser personnages, environnement, lumière et caméra ;
- animationPrompt doit décrire les mouvements de caméra et des personnages.
`;

    const raw = await generateText(instruction);
    const project = JSON.parse(cleanJson(raw));

    project.id =
      "project_" +
      Date.now();

    project.createdAt =
      new Date().toISOString();

    projects.unshift(project);

    res.json({
      success: true,
      project
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: friendlyError(error)
    });
  }
});

/* =========================
   PREPARE SCENES
========================= */

app.post("/api/prepare-images", async (req, res) => {
  try {
    const project = req.body.project;

    if (
      !project ||
      !Array.isArray(project.scenes)
    ) {
      return res.status(400).json({
        success: false,
        message: "Projet ou scènes manquants."
      });
    }

    const scenes = project.scenes
      .slice(0, 5)
      .map((scene, index) => ({
        number: index + 1,
        title:
          scene.title ||
          `Scène ${index + 1}`,
        description:
          scene.description || "",
        prompt:
          scene.visualPrompt ||
          scene.description ||
          "",
        animationPrompt:
          scene.animationPrompt ||
          ""
      }));

    while (scenes.length < 5) {
      scenes.push({
        number: scenes.length + 1,
        title: `Scène ${scenes.length + 1}`,
        description: "",
        prompt: "",
        animationPrompt: ""
      });
    }

    res.json({
      success: true,
      scenes
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: friendlyError(error)
    });
  }
});

/* =========================
   GENERATE ONE IMAGE
========================= */

app.post("/api/generate-image", async (req, res) => {
  try {
    const prompt =
      String(req.body.prompt || "").trim();

    if (!prompt) {
      return res.status(400).json({
        success: false,
        message: "Prompt image manquant."
      });
    }

    const cinematicPrompt = `
Create a high-quality cinematic 16:9 movie frame.

${prompt}

Visual direction:
- cinematic composition
- realistic lighting
- strong depth
- detailed environment
- coherent characters
- professional film still
- no subtitles
- no UI
- no watermark text
`;

    const image =
      await generateImage(cinematicPrompt);

    res.json({
      success: true,
      image
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: friendlyError(error)
    });
  }
});

/* =========================
   ANIMATE ONE SCENE
========================= */

app.post("/api/animate-scene", async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({
        success: false,
        message: "GEMINI_API_KEY absente."
      });
    }

    const prompt =
      String(req.body.prompt || "").trim();

    if (!prompt) {
      return res.status(400).json({
        success: false,
        message: "Prompt d'animation manquant."
      });
    }

    const operation =
      await ai.models.generateVideos({
        model: VIDEO_MODEL,
        prompt,
        config: {
          aspectRatio: "16:9",
          resolution: "720p"
        }
      });

    res.json({
      success: true,
      operation
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: friendlyError(error)
    });
  }
});

/* =========================
   ANIMATE 5 SCENES
========================= */

app.post("/api/animate-scenes", async (req, res) => {
  try {
    const scenes =
      Array.isArray(req.body.scenes)
        ? req.body.scenes.slice(0, 5)
        : [];

    if (scenes.length !== 5) {
      return res.status(400).json({
        success: false,
        message: "Cineflow doit avoir exactement 5 scènes."
      });
    }

    const jobId =
      "job_" + Date.now();

    animationJobs.set(jobId, {
      id: jobId,
      status: "running",
      progress: 0,
      scenes: scenes.map((scene, index) => ({
        index,
        status: "waiting",
        video: null,
        error: null
      })),
      createdAt: new Date().toISOString()
    });

    processAnimationJob(jobId, scenes)
      .catch(error => {
        const job =
          animationJobs.get(jobId);

        if (job) {
          job.status = "error";
          job.error =
            friendlyError(error);
        }
      });

    res.json({
      success: true,
      jobId
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: friendlyError(error)
    });
  }
});

async function processAnimationJob(
  jobId,
  scenes
) {
  const job =
    animationJobs.get(jobId);

  if (!job) return;

  for (let i = 0; i < scenes.length; i++) {
    const item = job.scenes[i];

    item.status = "running";

    try {
      const prompt =
        scenes[i].animationPrompt ||
        scenes[i].prompt ||
        scenes[i].description ||
        "";

      const operation =
        await ai.models.generateVideos({
          model: VIDEO_MODEL,
          prompt: `
Create a cinematic video scene.

${prompt}

Requirements:
- 16:9
- cinematic camera movement
- coherent characters
- natural motion
- professional lighting
- movie quality
`,
          config: {
            aspectRatio: "16:9",
            resolution: "720p"
          }
        });

      let current =
        operation;

      for (let attempt = 0; attempt < 30; attempt++) {
        await sleep(5000);

        current =
          await ai.operations.getVideosOperation({
            operation: current
          });

        if (
          current.done ||
          current.state === "SUCCEEDED"
        ) {
          break;
        }

        if (
          current.state === "FAILED" ||
          current.error
        ) {
          throw new Error(
            current.error?.message ||
            "La génération vidéo a échoué."
          );
        }
      }

      item.status = "done";
      item.video = current;
    } catch (error) {
      item.status = "error";
      item.error =
        friendlyError(error);
    }

    job.progress =
      Math.round(
        ((i + 1) / scenes.length) * 100
      );
  }

  const failed =
    job.scenes.some(
      scene => scene.status === "error"
    );

  job.status =
    failed ? "partial" : "done";
}

/* =========================
   ANIMATION STATUS
========================= */

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
        message: "Job introuvable."
      });
    }

    res.json({
      success: true,
      job
    });
  }
);

/* =========================
   CREATE VIDEO FROM IMAGES
========================= */

app.post("/api/create-video", async (req, res) => {
  try {
    const images =
      Array.isArray(req.body.images)
        ? req.body.images
        : [];

    if (images.length !== 5) {
      return res.status(400).json({
        success: false,
        message:
          "Il faut exactement 5 images."
      });
    }

    const tempDir =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "cineflow-"
        )
      );

    const imageFiles = [];

    for (let i = 0; i < images.length; i++) {
      const file =
        path.join(
          tempDir,
          `scene-${i + 1}.jpg`
        );

      dataUrlToFile(
        images[i],
        file
      );

      imageFiles.push(file);
    }

    const listFile =
      path.join(
        tempDir,
        "images.txt"
      );

    fs.writeFileSync(
      listFile,
      imageFiles
        .map(
          file =>
            `file '${file.replace(/'/g, "'\\''")}'`
        )
        .join("\n")
    );

    const output =
      path.join(
        tempDir,
        "cineflow.mp4"
      );

    await runFfmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-vf",
      "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      output
    ]);

    const videoId =
      "video_" + Date.now();

    videoFiles.set(
      videoId,
      output
    );

    res.json({
      success: true,
      videoId,
      message:
        "Vidéo Cineflow créée."
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: friendlyError(error)
    });
  }
});

/* =========================
   DOWNLOAD VIDEO
========================= */

app.get(
  "/api/download-video/:videoId",
  (req, res) => {
    const file =
      videoFiles.get(
        req.params.videoId
      );

    if (
      !file ||
      !fs.existsSync(file)
    ) {
      return res.status(404).send(
        "Vidéo introuvable."
      );
    }

    res.download(
      file,
      "cineflow-video.mp4"
    );
  }
);

/* =========================
   AUDIO
========================= */

app.post("/api/prepare-audio", async (req, res) => {
  try {
    const project =
      req.body.project || {};

    const text = await generateText(`
Analyse ce projet vidéo et propose une direction musicale.

Titre :
${project.title || "Projet Cineflow"}

Concept :
${project.concept || ""}

Retourne uniquement un JSON :

{
  "mood": "",
  "tempo": "",
  "instruments": [],
  "description": ""
}
`);

    let music;

    try {
      music =
        JSON.parse(
          cleanJson(text)
        );
    } catch {
      music = {
        mood: "cinématique",
        tempo: "modéré",
        instruments: [
          "piano",
          "cordes"
        ],
        description:
          "Musique cinématique émotionnelle."
      };
    }

    res.json({
      success: true,
      music
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: friendlyError(error)
    });
  }
});

/* =========================
   THUMBNAIL
========================= */

app.post(
  "/api/prepare-thumbnail",
  async (req, res) => {
    try {
      const prompt =
        String(
          req.body.prompt ||
          req.body.title ||
          "cinematic movie"
        );

      const image =
        await generateImage(`
Create a professional YouTube thumbnail for:

${prompt}

Style:
cinematic,
high contrast,
dramatic composition,
clear central subject,
16:9,
professional streaming thumbnail.
`);

      res.json({
        success: true,
        image
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: friendlyError(error)
      });
    }
  }
);

/* =========================
   SOCIAL
========================= */

app.post(
  "/api/prepare-social",
  async (req, res) => {
    try {
      const project =
        req.body.project || {};

      const text =
        await generateText(`
Prépare les textes de publication pour ce projet Cineflow :

Titre :
${project.title || ""}

Concept :
${project.concept || ""}

Retourne uniquement un JSON :

{
  "youtube": {
    "title": "",
    "description": "",
    "hashtags": []
  },
  "tiktok": {
    "caption": "",
    "hashtags": []
  },
  "instagram": {
    "caption": "",
    "hashtags": []
  },
  "facebook": {
    "caption": "",
    "hashtags": []
  }
}
`);

      let social;

      try {
        social =
          JSON.parse(
            cleanJson(text)
          );
      } catch {
        social = {
          youtube: {},
          tiktok: {},
          instagram: {},
          facebook: {}
        };
      }

      res.json({
        success: true,
        social
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: friendlyError(error)
      });
    }
  }
);

/* =========================
   AUTOPILOT
========================= */

app.post(
  "/api/autopilot-plan",
  async (req, res) => {
    const platforms =
      Array.isArray(req.body.platforms)
        ? req.body.platforms
        : [
            "YouTube",
            "TikTok",
            "Instagram",
            "Facebook"
          ];

    res.json({
      success: true,
      count:
        Number(req.body.count || 1),
      platforms,
      status:
        "Plan Auto-Pilote préparé."
    });
  }
);

/* =========================
   TRENDS
========================= */

app.get("/api/trends", async (req, res) => {
  try {
    const text =
      await generateText(`
Donne 5 idées de vidéos populaires
que Cineflow pourrait créer.

Retourne uniquement un JSON :

{
  "ideas": [
    {
      "title": "",
      "category": "",
      "hook": ""
    }
  ]
}
`);

    let result;

    try {
      result =
        JSON.parse(
          cleanJson(text)
        );
    } catch {
      result = {
        ideas: [
          {
            title:
              "Le dernier match",
            category: "Football",
            hook:
              "Un jeune joueur joue le match de sa vie."
          },
          {
            title:
              "Le dernier tir",
            category: "Drama",
            hook:
              "Une décision change tout."
          },
          {
            title:
              "Mission impossible",
            category: "Action",
            hook:
              "Une équipe doit réussir avant la nuit."
          }
        ]
      };
    }

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: friendlyError(error)
    });
  }
});

/* =========================
   PROJECTS
========================= */

app.get("/api/projects", (req, res) => {
  res.json({
    success: true,
    projects
  });
});

app.get(
  "/api/projects/status",
  (req, res) => {
    res.json({
      success: true,
      projects: projects.map(project => ({
        id: project.id,
        title: project.title,
        status: "ready"
      }))
    });
  }
);

/* =========================
   SERIES
========================= */

app.get("/api/series", (req, res) => {
  res.json({
    success: true,
    series
  });
});

app.post("/api/series", (req, res) => {
  const item = {
    id:
      "series_" + Date.now(),
    title:
      req.body.title ||
      "Nouvelle série",
    description:
      req.body.description ||
      "",
    episodes: [],
    createdAt:
      new Date().toISOString()
  };

  series.unshift(item);

  res.json({
    success: true,
    series: item
  });
});

/* =========================
   ACCOUNTS
========================= */

const accounts = {
  youtube: {
    name: "YouTube",
    connected: false
  },
  tiktok: {
    name: "TikTok",
    connected: false
  },
  instagram: {
    name: "Instagram",
    connected: false
  },
  facebook: {
    name: "Facebook",
    connected: false
  }
};

app.get("/api/accounts", (req, res) => {
  res.json({
    success: true,
    accounts
  });
});

app.post(
  "/api/accounts/connect",
  (req, res) => {
    const platform =
      String(
        req.body.platform || ""
      ).toLowerCase();

    if (!accounts[platform]) {
      return res.status(400).json({
        success: false,
        message:
          "Plateforme inconnue."
      });
    }

    accounts[platform].connected = true;

    res.json({
      success: true,
      account:
        accounts[platform]
    });
  }
);

/* =========================
   REPORTS
========================= */

app.get(
  "/api/reports/weekly",
  (req, res) => {
    res.json({
      success: true,
      report: {
        period: "Cette semaine",
        videos: projects.length,
        views: 0,
        likes: 0,
        subscribers: 0,
        revenue: 0
      }
    });
  }
);

app.get(
  "/api/reports/monthly",
  (req, res) => {
    res.json({
      success: true,
      report: {
        period: "Ce mois",
        videos: projects.length,
        views: 0,
        likes: 0,
        subscribers: 0,
        revenue: 0
      }
    });
  }
);

/* =========================================================
   MODERN CINEFLOW INTERFACE
========================================================= */

app.get("/", (req, res) => {
  const html = String.raw`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta
  name="viewport"
  content="width=device-width,initial-scale=1,maximum-scale=1"
/>
<title>Cineflow — Studio vidéo IA</title>

<style>
* {
  box-sizing: border-box;
}

:root {
  --bg: #070a12;
  --panel: rgba(17,22,36,.78);
  --panel2: rgba(24,30,48,.88);
  --line: rgba(255,255,255,.09);
  --text: #f5f7ff;
  --muted: #8d96ae;
  --blue: #5b8cff;
  --cyan: #4de3ff;
  --purple: #9a6cff;
  --green: #55e6a5;
  --danger: #ff6f91;
  --shadow: 0 25px 80px rgba(0,0,0,.35);
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  min-height: 100vh;
  color: var(--text);
  background:
    radial-gradient(
      circle at 15% 0%,
      rgba(91,140,255,.18),
      transparent 30%
    ),
    radial-gradient(
      circle at 90% 15%,
      rgba(154,108,255,.16),
      transparent 28%
    ),
    var(--bg);
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
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
  display: flex;
  min-height: 100vh;
}

.sidebar {
  width: 245px;
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  padding: 22px 16px;
  background: rgba(8,11,20,.88);
  backdrop-filter: blur(22px);
  border-right: 1px solid var(--line);
  z-index: 20;
}

.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 28px;
}

.logo {
  width: 42px;
  height: 42px;
  border-radius: 14px;
  display: grid;
  place-items: center;
  font-size: 20px;
  background:
    linear-gradient(
      135deg,
      var(--blue),
      var(--purple)
    );
  box-shadow:
    0 10px 35px rgba(91,140,255,.35);
}

.brand strong {
  font-size: 20px;
  letter-spacing: -.5px;
}

.brand small {
  display: block;
  color: var(--muted);
  font-size: 10px;
  margin-top: 2px;
}

.nav {
  display: grid;
  gap: 7px;
}

.nav button {
  width: 100%;
  border: 0;
  background: transparent;
  color: #aeb6ca;
  padding: 12px 13px;
  border-radius: 13px;
  text-align: left;
  transition: .2s;
}

.nav button:hover,
.nav button.active {
  color: white;
  background:
    linear-gradient(
      90deg,
      rgba(91,140,255,.18),
      rgba(154,108,255,.08)
    );
}

.side-status {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 20px;
  padding: 15px;
  border-radius: 18px;
  background: var(--panel);
  border: 1px solid var(--line);
}

.dot {
  width: 8px;
  height: 8px;
  display: inline-block;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 15px var(--green);
  margin-right: 7px;
}

.main {
  width: 100%;
  margin-left: 245px;
  padding: 24px;
  max-width: 1600px;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.topbar h1 {
  margin: 0;
  font-size: clamp(24px,4vw,38px);
  letter-spacing: -1.5px;
}

.topbar p {
  margin: 7px 0 0;
  color: var(--muted);
}

.status-pill {
  border: 1px solid rgba(85,230,165,.18);
  background: rgba(85,230,165,.08);
  color: #aaf3d1;
  padding: 9px 13px;
  border-radius: 999px;
  font-size: 12px;
}

.section {
  display: none;
}

.section.active {
  display: block;
  animation: appear .35s ease;
}

@keyframes appear {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.hero {
  position: relative;
  overflow: hidden;
  min-height: 330px;
  padding: 34px;
  border: 1px solid var(--line);
  border-radius: 30px;
  background:
    linear-gradient(
      135deg,
      rgba(24,32,59,.95),
      rgba(12,17,30,.85)
    );
  box-shadow: var(--shadow);
}

.hero::after {
  content: "";
  position: absolute;
  width: 350px;
  height: 350px;
  right: -120px;
  top: -130px;
  border-radius: 50%;
  background:
    radial-gradient(
      circle,
      rgba(91,140,255,.30),
      transparent 65%
    );
}

.hero h2 {
  max-width: 650px;
  font-size: clamp(30px,5vw,56px);
  line-height: 1;
  letter-spacing: -2.5px;
  margin: 0 0 18px;
}

.gradient-text {
  background:
    linear-gradient(
      90deg,
      #fff,
      #8bdfff,
      #a77cff
    );
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.hero p {
  max-width: 650px;
  color: #aeb7cb;
  line-height: 1.7;
}

.primary {
  border: 0;
  color: white;
  padding: 14px 20px;
  border-radius: 14px;
  background:
    linear-gradient(
      135deg,
      var(--blue),
      var(--purple)
    );
  box-shadow:
    0 12px 35px rgba(91,140,255,.25);
  transition: transform .2s, box-shadow .2s;
}

.primary:hover {
  transform: translateY(-2px);
  box-shadow:
    0 16px 40px rgba(91,140,255,.35);
}

.secondary {
  border: 1px solid var(--line);
  color: white;
  background: rgba(255,255,255,.05);
  padding: 12px 17px;
  border-radius: 13px;
}

.cards {
  display: grid;
  grid-template-columns:
    repeat(4,minmax(0,1fr));
  gap: 14px;
  margin-top: 18px;
}

.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 22px;
  padding: 20px;
  backdrop-filter: blur(18px);
}

.card h3 {
  margin: 0 0 7px;
}

.muted {
  color: var(--muted);
}

.studio {
  display: grid;
  grid-template-columns:
    minmax(0,1.35fr)
    minmax(280px,.65fr);
  gap: 18px;
}

.workspace {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 26px;
  padding: 22px;
}

.progress {
  display: grid;
  grid-template-columns:
    repeat(5,1fr);
  gap: 7px;
  margin: 20px 0;
}

.step {
  text-align: center;
  padding: 10px 4px;
  border-radius: 12px;
  color: var(--muted);
  background: rgba(255,255,255,.035);
  font-size: 11px;
}

.step.on {
  color: white;
  background:
    linear-gradient(
      135deg,
      rgba(91,140,255,.28),
      rgba(154,108,255,.20)
    );
}

textarea {
  width: 100%;
  min-height: 145px;
  resize: vertical;
  color: white;
  background: rgba(0,0,0,.20);
  border: 1px solid var(--line);
  border-radius: 17px;
  padding: 17px;
  outline: none;
}

textarea:focus {
  border-color: rgba(91,140,255,.6);
  box-shadow:
    0 0 0 4px rgba(91,140,255,.08);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  margin-top: 12px;
}

.result {
  margin-top: 16px;
}

.scene-grid {
  display: grid;
  grid-template-columns:
    repeat(2,minmax(0,1fr));
  gap: 12px;
}

.scene {
  padding: 16px;
  border-radius: 18px;
  background: rgba(255,255,255,.045);
  border: 1px solid var(--line);
}

.scene-number {
  color: var(--cyan);
  font-size: 12px;
  font-weight: 700;
}

.scene h4 {
  margin: 7px 0;
}

.image-grid {
  display: grid;
  grid-template-columns:
    repeat(2,minmax(0,1fr));
  gap: 12px;
}

.image-card {
  overflow: hidden;
  border-radius: 18px;
  background: #090c14;
  border: 1px solid var(--line);
}

.image-card img {
  display: block;
  width: 100%;
  aspect-ratio: 16/9;
  object-fit: cover;
}

.image-card div {
  padding: 10px 12px;
}

.input-card {
  margin-top: 18px;
}

.preview {
  min-height: 310px;
  display: grid;
  place-items: center;
  text-align: center;
  border-radius: 22px;
  border: 1px solid var(--line);
  background:
    radial-gradient(
      circle at center,
      rgba(91,140,255,.12),
      transparent 60%
    ),
    #080b14;
}

.preview-icon {
  font-size: 54px;
  margin-bottom: 12px;
}

.list {
  display: grid;
  gap: 10px;
}

.list-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px;
  border-radius: 15px;
  background: rgba(255,255,255,.04);
  border: 1px solid var(--line);
}

.mobile-nav {
  display: none;
}

@media(max-width:1000px) {
  .cards {
    grid-template-columns:
      repeat(2,minmax(0,1fr));
  }

  .studio {
    grid-template-columns: 1fr;
  }
}

@media(max-width:720px) {
  .sidebar {
    display: none;
  }

  .main {
    margin-left: 0;
    padding:
      17px 14px 90px;
  }

  .topbar {
    align-items: flex-start;
  }

  .topbar h1 {
    font-size: 25px;
  }

  .status-pill {
    display: none;
  }

  .hero {
    padding: 24px;
    border-radius: 24px;
    min-height: 300px;
  }

  .hero h2 {
    font-size: 38px;
  }

  .cards {
    grid-template-columns: 1fr 1fr;
  }

  .scene-grid,
  .image-grid {
    grid-template-columns: 1fr;
  }

  .workspace {
    padding: 16px;
  }

  .mobile-nav {
    position: fixed;
    display: grid;
    grid-template-columns:
      repeat(4,1fr);
    left: 10px;
    right: 10px;
    bottom: 10px;
    padding: 8px;
    border-radius: 20px;
    background: rgba(12,16,28,.92);
    backdrop-filter: blur(25px);
    border: 1px solid var(--line);
    z-index: 50;
    box-shadow: 0 15px 45px rgba(0,0,0,.45);
  }

  .mobile-nav button {
    border: 0;
    color: #929bb0;
    background: transparent;
    padding: 9px 4px;
    font-size: 11px;
  }

  .mobile-nav button.active {
    color: white;
  }

  .progress {
    overflow-x: auto;
    grid-template-columns:
      repeat(5,90px);
  }
}

.status {
  padding: 13px;
  border-radius: 14px;
  background: rgba(85,230,165,.08);
  border: 1px solid rgba(85,230,165,.15);
  color: #aaf3d1;
}

.error {
  padding: 13px;
  border-radius: 14px;
  background: rgba(255,111,145,.08);
  border: 1px solid rgba(255,111,145,.18);
  color: #ff9eb5;
}

.project-title {
  font-size: 24px;
  font-weight: 800;
  margin-bottom: 7px;
}

.badge {
  display: inline-flex;
  padding: 6px 9px;
  border-radius: 999px;
  font-size: 10px;
  background: rgba(91,140,255,.13);
  color: #a9c0ff;
}
</style>
</head>

<body>

<div class="app">

<aside class="sidebar">

  <div class="brand">
    <div class="logo">▶</div>
    <div>
      <strong>Cineflow</strong>
      <small>STUDIO VIDÉO IA</small>
    </div>
  </div>

  <nav class="nav">
    <button class="active" onclick="showSection('home',this)">
      🏠 Accueil
    </button>

    <button onclick="showSection('create',this)">
      ✨ Créer une vidéo
    </button>

    <button onclick="showSection('studio',this)">
      🎬 Studio
    </button>

    <button onclick="showSection('projects',this)">
      📁 Mes projets
    </button>

    <button onclick="showSection('autopilot',this)">
      🤖 Auto-Pilote
    </button>

    <button onclick="showSection('trends',this)">
      🔥 Tendances
    </button>

    <button onclick="showSection('reports',this)">
      📊 Rapports
    </button>
  </nav>

  <div class="side-status">
    <span class="dot"></span>
    Cineflow prêt
    <div class="muted" style="font-size:11px;margin-top:7px">
      Ton studio de création IA
    </div>
  </div>

</aside>

<main class="main">

  <header class="topbar">
    <div>
      <h1 id="pageTitle">
        Ton studio créatif
      </h1>

      <p id="pageSubtitle">
        Transforme une idée en vidéo.
      </p>
    </div>

    <div class="status-pill">
      <span class="dot"></span>
      Système opérationnel
    </div>
  </header>

  <!-- ACCUEIL -->

  <section id="home" class="section active">

    <div class="hero">

      <div class="badge">
        ✦ CINEFLOW NEXT
      </div>

      <h2>
        Crée.
        <span class="gradient-text">
          Anime.
        </span>
        Publie.
      </h2>

      <p>
        Cineflow transforme ton idée en projet vidéo :
        scénario, scènes, images, animation et montage.
      </p>

      <div class="actions">
        <button
          class="primary"
          onclick="showSection('create')"
        >
          ✨ Commencer une création
        </button>

        <button
          class="secondary"
          onclick="testGemini()"
        >
          ⚡ Tester Gemini
        </button>
      </div>

      <div id="homeResult" class="result"></div>

    </div>

    <div class="cards">

      <div class="card">
        <div class="muted">Projets</div>
        <h3 id="projectCount">0</h3>
      </div>

      <div class="card">
        <div class="muted">Scènes</div>
        <h3>5</h3>
      </div>

      <div class="card">
        <div class="muted">Images</div>
        <h3>16:9</h3>
      </div>

      <div class="card">
        <div class="muted">Moteur</div>
        <h3>Gemini</h3>
      </div>

    </div>

  </section>

  <!-- CREATION -->

  <section id="create" class="section">

    <div class="studio">

      <div class="workspace">

        <div class="badge">
          ÉTAPE 01
        </div>

        <h2>
          Quelle histoire veux-tu créer ?
        </h2>

        <p class="muted">
          Décris ton idée. Cineflow construira le projet.
        </p>

        <div class="progress">
          <div class="step on">💡 Idée</div>
          <div class="step">🧩 Scènes</div>
          <div class="step">🖼️ Images</div>
          <div class="step">🎞️ Animation</div>
          <div class="step">🎬 Vidéo</div>
        </div>

        <textarea
          id="prompt"
          placeholder="Exemple : un jeune footballeur africain rêve de devenir professionnel malgré les difficultés..."
        ></textarea>

        <div class="actions">

          <button
            class="primary"
            onclick="genererProjet()"
          >
            ✨ Générer mon projet
          </button>

          <button
            class="secondary"
            onclick="testGemini()"
          >
            ⚡ Gemini
          </button>

        </div>

        <div
          id="createResult"
          class="result"
        ></div>

      </div>

      <div class="preview">
        <div>
          <div class="preview-icon">🎥</div>
          <strong>Ton prochain film commence ici</strong>
          <p class="muted">
            Une idée suffit.
          </p>
        </div>
      </div>

    </div>

  </section>

  <!-- STUDIO -->

  <section id="studio" class="section">

    <div class="workspace">

      <div class="badge">
        STUDIO
      </div>

      <div
        id="studioProject"
        style="margin-top:15px"
      >
        <h2>Aucun projet ouvert</h2>
        <p class="muted">
          Crée d'abord une vidéo.
        </p>
      </div>

      <div class="progress">
        <div class="step on">💡 Projet</div>
        <div class="step">🧩 Scènes</div>
        <div class="step">🖼️ Images</div>
        <div class="step">🎞️ Veo</div>
        <div class="step">🎬 MP4</div>
      </div>

      <div class="card">

        <h3>🧩 Scènes</h3>

        <p class="muted">
          Cineflow prépare cinq scènes cohérentes.
        </p>

        <button
          class="primary"
          id="prepareScenesBtn"
          onclick="preparerScenes()"
          disabled
        >
          🧩 Préparer les 5 scènes
        </button>

        <div
          id="scenesResult"
          class="result"
        ></div>

      </div>

      <div class="card input-card">

        <h3>🖼️ Génération des images</h3>

        <p class="muted">
          Génère les cinq plans cinématographiques.
        </p>

        <button
          class="primary"
          id="imagesBtn"
          onclick="genererImages()"
          disabled
        >
          🎨 Générer les images
        </button>

        <div
          id="imagesResult"
          class="result"
        ></div>

      </div>

      <div class="card input-card">

        <h3>🎞️ Animation Veo</h3>

        <p class="muted">
          Anime les scènes avec le moteur vidéo.
        </p>

        <button
          class="primary"
          id="animateBtn"
          onclick="animerScenes()"
          disabled
        >
          🎞️ Animer les 5 scènes
        </button>

        <div
          id="animationResult"
          class="result"
        ></div>

      </div>

      <div class="card input-card">

        <h3>🎬 Vidéo finale</h3>

        <p class="muted">
          Assemble les cinq plans en MP4 16:9.
        </p>

        <button
          class="primary"
          id="videoBtn"
          onclick="creerVideo()"
          disabled
        >
          🎬 Créer ma vidéo
        </button>

        <div
          id="videoResult"
          class="result"
        ></div>

      </div>

      <div class="card input-card">

        <h3>🎵 Musique</h3>

        <button
          class="secondary"
          onclick="preparerAudio()"
        >
          🎵 Analyser la musique
        </button>

        <div
          id="audioResult"
          class="result"
        ></div>

      </div>

      <div class="card input-card">

        <h3>📱 Publication</h3>

        <button
          class="secondary"
          onclick="preparerSocial()"
        >
          📱 Préparer les publications
        </button>

        <div
          id="socialResult"
          class="result"
        ></div>

      </div>

    </div>

  </section>

  <!-- PROJETS -->

  <section id="projects" class="section">

    <div class="workspace">

      <div class="badge">
        BIBLIOTHÈQUE
      </div>

      <h2>Mes projets</h2>

      <div
        id="projectsResult"
        class="list"
      >
        <div class="muted">
          Chargement...
        </div>
      </div>

    </div>

  </section>

  <!-- AUTOPILOTE -->

  <section id="autopilot" class="section">

    <div class="hero">

      <div class="badge">
        🤖 AUTO-PILOTE
      </div>

      <h2>
        Cineflow travaille
        <span class="gradient-text">
          avec toi.
        </span>
      </h2>

      <p>
        Prépare ton flux de création et les plateformes
        que tu souhaites utiliser.
      </p>

      <button
        class="primary"
        onclick="preparerAutopilot()"
      >
        🤖 Préparer l'Auto-Pilote
      </button>

      <div
        id="autopilotResult"
        class="result"
      ></div>

    </div>

  </section>

  <!-- TENDANCES -->

  <section id="trends" class="section">

    <div class="workspace">

      <div class="badge">
        🔥 INSPIRATION
      </div>

      <h2>Idées de vidéos</h2>

      <button
        class="primary"
        onclick="chargerTendances()"
      >
        🔥 Trouver des idées
      </button>

      <div
        id="trendsResult"
        class="result"
      ></div>

    </div>

  </section>

  <!-- RAPPORTS -->

  <section id="reports" class="section">

    <div class="cards">

      <div class="card">
        <div class="muted">
          Vidéos
        </div>
        <h3 id="reportVideos">0</h3>
      </div>

      <div class="card">
        <div class="muted">
          Vues
        </div>
        <h3 id="reportViews">0</h3>
      </div>

      <div class="card">
        <div class="muted">
          Likes
        </div>
        <h3 id="reportLikes">0</h3>
      </div>

      <div class="card">
        <div class="muted">
          Revenus
        </div>
        <h3 id="reportRevenue">0 FCFA</h3>
      </div>

    </div>

  </section>

</main>

</div>

<div class="mobile-nav">

  <button
    class="active"
    onclick="showSection('home',this)"
  >
    🏠<br>Accueil
  </button>

  <button
    onclick="showSection('create',this)"
  >
    ✨<br>Créer
  </button>

  <button
    onclick="showSection('studio',this)"
  >
    🎬<br>Studio
  </button>

  <button
    onclick="showSection('projects',this)"
  >
    📁<br>Projets
  </button>

</div>

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

function showSection(id, button) {
  document
    .querySelectorAll(".section")
    .forEach(function(section) {
      section.classList.remove("active");
    });

  var target =
    document.getElementById(id);

  if (target) {
    target.classList.add("active");
  }

  document
    .querySelectorAll(".nav button,.mobile-nav button")
    .forEach(function(btn) {
      btn.classList.remove("active");
    });

  if (button) {
    button.classList.add("active");
  }

  var titles = {
    home: [
      "Ton studio créatif",
      "Transforme une idée en vidéo."
    ],
    create: [
      "Créer une vidéo",
      "Commence avec une simple idée."
    ],
    studio: [
      "Studio Cineflow",
      "Construis ton film étape par étape."
    ],
    projects: [
      "Mes projets",
      "Retrouve tes créations."
    ],
    autopilot: [
      "Auto-Pilote",
      "Prépare ton flux de création."
    ],
    trends: [
      "Tendances",
      "Trouve ta prochaine idée."
    ],
    reports: [
      "Rapports",
      "Observe ton évolution."
    ]
  };

  if (titles[id]) {
    document.getElementById("pageTitle").textContent =
      titles[id][0];

    document.getElementById("pageSubtitle").textContent =
      titles[id][1];
  }

  if (id === "projects") {
    chargerProjets();
  }

  if (id === "reports") {
    chargerRapport();
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
    "homeResult",
    '<div class="card">⏳ Test de Gemini...</div>'
  );

  try {
    var response =
      await fetch("/api/test-gemini");

    var data =
      await response.json();

    if (!data.success) {
      throw new Error(data.message);
    }

    setResult(
      "homeResult",
      '<div class="status">✅ ' +
      escapeHtml(data.message) +
      '</div>'
    );
  } catch (error) {
    setResult(
      "homeResult",
      '<div class="error">❌ ' +
      escapeHtml(error.message) +
      '</div>'
    );
  }
}

async function genererProjet() {
  var prompt =
    document.getElementById("prompt").value.trim();

  if (!prompt) {
    setResult(
      "createResult",
      '<div class="error">Écris ton idée de vidéo.</div>'
    );
    return;
  }

  setResult(
    "createResult",
    '<div class="card">⏳ Cineflow construit ton projet...</div>'
  );

  try {
    var response =
      await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prompt: prompt
        })
      });

    var data =
      await response.json();

    if (!data.success) {
      throw new Error(data.message);
    }

    currentProject = data.project;

    afficherProjet();

    document
      .getElementById("prepareScenesBtn")
      .disabled = false;

    showSection("studio");

  } catch (error) {
    setResult(
      "createResult",
      '<div class="error">❌ ' +
      escapeHtml(error.message) +
      '</div>'
    );
  }
}

function afficherProjet() {
  if (!currentProject) return;

  document.getElementById(
    "studioProject"
  ).innerHTML =
    '<div class="badge">PROJET GÉNÉRÉ</div>' +
    '<div class="project-title">' +
    escapeHtml(currentProject.title) +
    '</div>' +
    '<p class="muted">' +
    escapeHtml(currentProject.concept) +
    '</p>';
}

async function preparerScenes() {
  if (!currentProject) return;

  setResult(
    "scenesResult",
    '<div class="card">⏳ Préparation des scènes...</div>'
  );

  try {
    var response =
      await fetch("/api/prepare-images", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          project: currentProject
        })
      });

    var data =
      await response.json();

    if (!data.success) {
      throw new Error(data.message);
    }

    preparedScenes = data.scenes;

    afficherScenes();

    document.getElementById(
      "imagesBtn"
    ).disabled = false;

  } catch (error) {
    setResult(
      "scenesResult",
      '<div class="error">❌ ' +
      escapeHtml(error.message) +
      '</div>'
    );
  }
}

function afficherScenes() {
  var html =
    '<div class="scene-grid">';

  preparedScenes.forEach(function(scene) {
    html +=
      '<div class="scene">' +
      '<div class="scene-number">SCÈNE ' +
      scene.number +
      '</div>' +
      '<h4>' +
      escapeHtml(scene.title) +
      '</h4>' +
      '<div class="muted">' +
      escapeHtml(scene.description) +
      '</div>' +
      '</div>';
  });

  html += "</div>";

  setResult(
    "scenesResult",
    html
  );
}

async function genererImages() {
  if (preparedScenes.length !== 5) {
    return;
  }

  generatedImages = [];

  setResult(
    "imagesResult",
    '<div class="card">🎨 Génération des 5 images...</div>'
  );

  try {
    for (
      var i = 0;
      i < preparedScenes.length;
      i++
    ) {
      setResult(
        "imagesResult",
        '<div class="card">🎨 Image ' +
        (i + 1) +
        '/5...</div>'
      );

      var response =
        await fetch("/api/generate-image", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            prompt:
              preparedScenes[i].prompt
          })
        });

      var data =
        await response.json();

      if (!data.success) {
        throw new Error(data.message);
      }

      generatedImages.push(
        data.image
      );

      afficherImages();
    }

    document.getElementById(
      "animateBtn"
    ).disabled = false;

    document.getElementById(
      "videoBtn"
    ).disabled = false;

    setResult(
      "imagesResult",
      '<div class="status">✅ Les 5 images sont prêtes.</div>' +
      document.getElementById(
        "imagesResult"
      ).innerHTML
    );

  } catch (error) {
    setResult(
      "imagesResult",
      '<div class="error">❌ ' +
      escapeHtml(error.message) +
      '</div>'
    );
  }
}

function afficherImages() {
  var html =
    '<div class="image-grid">';

  generatedImages.forEach(function(
    image,
    index
  ) {
    html +=
      '<div class="image-card">' +
      '<img src="' +
      image +
      '" alt="Scène ' +
      (index + 1) +
      '">' +
      '<div>🎬 Scène ' +
      (index + 1) +
      '</div>' +
      '</div>';
  });

  html += "</div>";

  setResult(
    "imagesResult",
    html
  );
}

async function animerScenes() {
  if (preparedScenes.length !== 5) {
    return;
  }

  setResult(
    "animationResult",
    '<div class="card">🎞️ Lancement de Veo...</div>'
  );

  try {
    var response =
      await fetch("/api/animate-scenes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          scenes: preparedScenes
        })
      });

    var data =
      await response.json();

    if (!data.success) {
      throw new Error(data.message);
    }

    animationJobId =
      data.jobId;

    pollAnimation();

  } catch (error) {
    setResult(
      "animationResult",
      '<div class="error">❌ ' +
      escapeHtml(error.message) +
      '</div>'
    );
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

    if (!data.success) {
      throw new Error(data.message);
    }

    var job = data.job;

    setResult(
      "animationResult",
      '<div class="card">' +
      '🎞️ Animation : ' +
      job.progress +
      '%<br><br>' +
      '<div class="muted">' +
      job.scenes
        .map(function(scene) {
          return (
            "Scène " +
            (scene.index + 1) +
            " : " +
            scene.status
          );
        })
        .join("<br>") +
      '</div></div>'
    );

    if (
      job.status === "running"
    ) {
      setTimeout(
        pollAnimation,
        5000
      );
    } else {
      setResult(
        "animationResult",
        '<div class="status">✅ Animation terminée.</div>'
      );
    }

  } catch (error) {
    setResult(
      "animationResult",
      '<div class="error">❌ ' +
      escapeHtml(error.message) +
      '</div>'
    );
  }
}

async function creerVideo() {
  if (generatedImages.length !== 5) {
    return;
  }

  setResult(
    "videoResult",
    '<div class="card">🎬 Montage du MP4...</div>'
  );

  try {
    var response =
      await fetch("/api/create-video", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          images:
            generatedImages
        })
      });

    var data =
      await response.json();

    if (!data.success) {
      throw new Error(data.message);
    }

    setResult(
      "videoResult",
      '<div class="status">' +
      '✅ Vidéo créée.<br><br>' +
      '<a href="/api/download-video/' +
      data.videoId +
      '" style="color:white">' +
      '⬇️ Télécharger la vidéo' +
      '</a>' +
      '</div>'
    );

  } catch (error) {
    setResult(
      "videoResult",
      '<div class="error">❌ ' +
      escapeHtml(error.message) +
      '</div>'
    );
  }
}

async function preparerAudio() {
  if (!currentProject) {
    return;
  }

  setResult(
    "audioResult",
    '<div class="card">🎵 Analyse musicale...</div>'
  );

  try {
    var response =
      await fetch("/api/prepare-audio", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          project:
            currentProject
        })
      });

    var data =
      await response.json();

    if (!data.success) {
      throw new Error(data.message);
    }

    setResult(
      "audioResult",
      '<div class="status">' +
      '🎵 Ambiance : ' +
      escapeHtml(data.music.mood) +
      '<br>🎼 Instruments : ' +
      escapeHtml(
        data.music.instruments.join(", ")
      ) +
      '</div>'
    );

  } catch (error) {
    setResult(
      "audioResult",
      '<div class="error">❌ ' +
      escapeHtml(error.message) +
      '</div>'
    );
  }
}

async function preparerSocial() {
  if (!currentProject) return;

  setResult(
    "socialResult",
    '<div class="card">📱 Préparation...</div>'
  );

  try {
    var response =
      await fetch("/api/prepare-social", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          project:
            currentProject
        })
      });

    var data =
      await response.json();

    if (!data.success) {
      throw new Error(data.message);
    }

    setResult(
      "socialResult",
      '<div class="status">✅ Publications préparées pour YouTube, TikTok, Instagram et Facebook.</div>'
    );

  } catch (error) {
    setResult(
      "socialResult",
      '<div class="error">❌ ' +
      escapeHtml(error.message) +
      '</div>'
    );
  }
}

async function preparerAutopilot() {
  setResult(
    "autopilotResult",
    '<div class="card">🤖 Préparation de l' +
    "Auto-Pilote..." +
    '</div>'
  );

  try {
    var response =
      await fetch(
        "/api/autopilot-plan",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            count: 5,
            platforms: [
              "YouTube",
              "TikTok",
              "Instagram",
              "Facebook"
            ]
          })
        }
      );

    var data =
      await response.json();

    setResult(
      "autopilotResult",
      '<div class="status">🤖 Auto-Pilote préparé pour ' +
      data.count +
      ' vidéos.</div>'
    );

  } catch (error) {
    setResult(
      "autopilotResult",
      '<div class="error">❌ ' +
      escapeHtml(error.message) +
      '</div>'
    );
  }
}

async function chargerTendances() {
  setResult(
    "trendsResult",
    '<div class="card">🔥 Recherche d'idées...</div>'
  );

  try {
    var response =
      await fetch(
        "/api/trends"
      );

    var data =
      await response.json();

    var html =
      '<div class="list">';

    (data.ideas || []).forEach(
      function(idea) {
        html +=
          '<div class="list-item">' +
          '<div>' +
          '<strong>' +
          escapeHtml(
            idea.title
          ) +
          '</strong>' +
          '<div class="muted">' +
          escapeHtml(
            idea.category
          ) +
          '</div>' +
          '</div>' +
          '<span>🔥</span>' +
          '</div>';
      }
    );

    html += "</div>";

    setResult(
      "trendsResult",
      html
    );

  } catch (error) {
    setResult(
      "trendsResult",
      '<div class="error">❌ ' +
      escapeHtml(error.message) +
      '</div>'
    );
  }
}

async function chargerProjets() {
  try {
    var response =
      await fetch(
        "/api/projects"
      );

    var data =
      await response.json();

    document.getElementById(
      "projectCount"
    ).textContent =
      data.projects.length;

    if (!data.projects.length) {
      setResult(
        "projectsResult",
        '<div class="card muted">Aucun projet pour le moment.</div>'
      );
      return;
    }

    var html = "";

    data.projects.forEach(
      function(project) {
        html +=
          '<div class="list-item">' +
          '<div>' +
          '<strong>' +
          escapeHtml(
            project.title
          ) +
          '</strong>' +
          '<div class="muted">' +
          escapeHtml(
            project.concept
          ) +
          '</div>' +
          '</div>' +
          '<span class="badge">PROJET</span>' +
          '</div>';
      }
    );

    setResult(
      "projectsResult",
      html
    );

  } catch (error) {
    setResult(
      "projectsResult",
      '<div class="error">❌ Impossible de charger les projets.</div>'
    );
  }
}

async function chargerRapport() {
  try {
    var response =
      await fetch(
        "/api/reports/weekly"
      );

    var data =
      await response.json();

    var report =
      data.report;

    document.getElementById(
      "reportVideos"
    ).textContent =
      report.videos;

    document.getElementById(
      "reportViews"
    ).textContent =
      report.views;

    document.getElementById(
      "reportLikes"
    ).textContent =
      report.likes;

    document.getElementById(
      "reportRevenue"
    ).textContent =
      report.revenue +
      " FCFA";

  } catch (error) {
    console.error(error);
  }
}

chargerProjets();
</script>

</body>
</html>`;

  res.send(html);
});

/* =========================
   404
========================= */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route introuvable."
  });
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log(
    "🎬 Cineflow fonctionne sur le port " +
    PORT
  );
});

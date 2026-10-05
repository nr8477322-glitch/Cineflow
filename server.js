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

const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

const projects = [];
const jobs = new Map();
const generatedImages = new Map();
const generatedVideos = new Map();
const series = [];
const accounts = {
  youtube: false,
  tiktok: false,
  instagram: false,
};

function id(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanJson(text) {
  if (!text) return null;

  let value = String(text)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");

  if (first >= 0 && last >= 0) {
    value = value.slice(first, last + 1);
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getText(result) {
  try {
    return (
      result?.text ||
      result?.response?.text ||
      result?.output_text ||
      result?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || "")
        .join("") ||
      ""
    );
  } catch {
    return "";
  }
}

async function generateText(prompt) {
  if (!ai) {
    throw new Error("GEMINI_API_KEY n'est pas configurée sur Render.");
  }

  const result = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
  });

  return getText(result);
}

async function generateImage(prompt) {
  if (!ai) {
    throw new Error("GEMINI_API_KEY n'est pas configurée sur Render.");
  }

  const result = await ai.interactions.create({
    model: IMAGE_MODEL,
    input: prompt,
    response_format: {
      type: "image",
      mime_type: "image/png",
      aspect_ratio: "16:9",
      image_size: "1K",
    },
  });

  return result;
}

function saveTempFile(buffer, extension = "bin") {
  const file = path.join(
    os.tmpdir(),
    `cineflow_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}.${extension}`
  );

  fs.writeFileSync(file, buffer);
  return file;
}

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

async function convertVideoFormat(input, output, width, height) {
  await runFFmpeg([
    "-y",
    "-i",
    input,
    "-vf",
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    output,
  ]);
}

function createProjectObject(data) {
  return {
    id: id("project"),
    title: data.title || "Nouveau projet",
    prompt: data.prompt || "",
    category: data.category || "Film",
    status: "created",
    progress: 0,
    createdAt: new Date().toISOString(),
    scenes: [],
    images: [],
    videos: [],
    finalVideo: null,
    formats: {},
    audio: null,
    thumbnail: null,
    social: {},
  };
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    cineflow: true,
    gemini: !!API_KEY,
    model: MODEL,
    imageModel: IMAGE_MODEL,
    videoModel: VIDEO_MODEL,
    time: new Date().toISOString(),
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    geminiConnected: !!API_KEY,
    message: API_KEY
      ? "Cineflow est connecté à Gemini."
      : "GEMINI_API_KEY manquante.",
  });
});

/* =========================================================
   GEMINI TEST
========================================================= */

app.get("/api/test-gemini", async (req, res) => {
  try {
    const text = await generateText(
      "Réponds très brièvement en français : confirme que Gemini est connecté à Cineflow."
    );

    res.json({
      success: true,
      message: text || "Gemini est connecté à Cineflow.",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   PROJECT
========================================================= */

app.post("/api/project", async (req, res) => {
  try {
    const { prompt, category, title } = req.body;

    if (!prompt) {
      return res.status(400).json({
        error: "Décris ton idée de vidéo.",
      });
    }

    const project = createProjectObject({
      prompt,
      category,
      title,
    });

    project.status = "generating";
    project.progress = 10;

    const text = await generateText(`
Tu es le scénariste principal de Cineflow.

Crée un projet vidéo cinématographique à partir de cette idée :

${prompt}

Catégorie : ${category || "Film"}

Retourne uniquement un JSON valide sous cette forme :

{
  "title": "titre",
  "concept": "concept court",
  "style": "style visuel",
  "characters": ["personnage 1", "personnage 2"],
  "scenes": [
    {
      "number": 1,
      "title": "titre scène",
      "description": "description détaillée",
      "imagePrompt": "prompt visuel cinématographique",
      "videoPrompt": "prompt pour animation vidéo"
    },
    {
      "number": 2,
      "title": "titre scène",
      "description": "description détaillée",
      "imagePrompt": "prompt visuel cinématographique",
      "videoPrompt": "prompt pour animation vidéo"
    },
    {
      "number": 3,
      "title": "titre scène",
      "description": "description détaillée",
      "imagePrompt": "prompt visuel cinématographique",
      "videoPrompt": "prompt pour animation vidéo"
    },
    {
      "number": 4,
      "title": "titre scène",
      "description": "description détaillée",
      "imagePrompt": "prompt visuel cinématographique",
      "videoPrompt": "prompt pour animation vidéo"
    },
    {
      "number": 5,
      "title": "titre scène",
      "description": "description détaillée",
      "imagePrompt": "prompt visuel cinématographique",
      "videoPrompt": "prompt pour animation vidéo"
    }
  ]
}
`);

    const data = cleanJson(text);

    if (!data) {
      throw new Error("Gemini n'a pas retourné un JSON exploitable.");
    }

    project.title = data.title || project.title;
    project.concept = data.concept || "";
    project.style = data.style || "";
    project.characters = data.characters || [];
    project.scenes = Array.isArray(data.scenes)
      ? data.scenes.slice(0, 5)
      : [];

    project.progress = 30;
    project.status = "ready";

    projects.unshift(project);

    res.json({
      success: true,
      project,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/api/projects", (req, res) => {
  res.json({
    success: true,
    projects,
  });
});

app.get("/api/project/:id", (req, res) => {
  const project = projects.find((p) => p.id === req.params.id);

  if (!project) {
    return res.status(404).json({
      error: "Projet introuvable.",
    });
  }

  res.json({
    success: true,
    project,
  });
});

/* =========================================================
   SCENES
========================================================= */

app.post("/api/scenes", async (req, res) => {
  try {
    const { projectId } = req.body;

    const project = projects.find((p) => p.id === projectId);

    if (!project) {
      return res.status(404).json({
        error: "Projet introuvable.",
      });
    }

    if (!project.scenes.length) {
      return res.status(400).json({
        error: "Aucune scène disponible.",
      });
    }

    project.status = "scenes_ready";
    project.progress = 40;

    res.json({
      success: true,
      scenes: project.scenes,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

/* =========================================================
   IMAGES
========================================================= */

app.post("/api/images", async (req, res) => {
  try {
    const { projectId } = req.body;

    const project = projects.find((p) => p.id === projectId);

    if (!project) {
      return res.status(404).json({
        error: "Projet introuvable.",
      });
    }

    const results = [];

    for (let i = 0; i < project.scenes.length; i++) {
      const scene = project.scenes[i];

      try {
        const result = await generateImage(
          `${scene.imagePrompt}

Style cinématographique premium.
Continuité visuelle avec les autres scènes.
Personnages cohérents.
Composition professionnelle.
Lumière cinématographique.
Format 16:9.
`
        );

        const imageId = id("image");

        generatedImages.set(imageId, {
          id: imageId,
          projectId,
          scene: scene.number,
          result,
        });

        results.push({
          id: imageId,
          scene: scene.number,
          status: "generated",
        });
      } catch (error) {
        results.push({
          scene: scene.number,
          status: "error",
          error: error.message,
        });
      }

      project.progress = 45 + Math.round(((i + 1) / project.scenes.length) * 20);
    }

    project.images = results;
    project.status = "images_ready";

    res.json({
      success: true,
      images: results,
      project,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   REGENERATE SCENE
========================================================= */

app.post("/api/regenerate-scene", async (req, res) => {
  try {
    const { projectId, sceneNumber } = req.body;

    const project = projects.find((p) => p.id === projectId);

    if (!project) {
      return res.status(404).json({
        error: "Projet introuvable.",
      });
    }

    const scene = project.scenes.find(
      (s) => Number(s.number) === Number(sceneNumber)
    );

    if (!scene) {
      return res.status(404).json({
        error: "Scène introuvable.",
      });
    }

    const result = await generateImage(`
${scene.imagePrompt}

Nouvelle version de la scène ${sceneNumber}.
Cinématographique, réaliste, cohérente avec l'histoire.
Format 16:9.
`);

    const imageId = id("image");

    generatedImages.set(imageId, {
      id: imageId,
      projectId,
      scene: sceneNumber,
      result,
    });

    project.images = project.images.filter(
      (image) => Number(image.scene) !== Number(sceneNumber)
    );

    project.images.push({
      id: imageId,
      scene: sceneNumber,
      status: "generated",
    });

    res.json({
      success: true,
      image: {
        id: imageId,
        scene: sceneNumber,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   ANIMATION VEO
========================================================= */

app.post("/api/animate", async (req, res) => {
  try {
    const { projectId } = req.body;

    const project = projects.find((p) => p.id === projectId);

    if (!project) {
      return res.status(404).json({
        error: "Projet introuvable.",
      });
    }

    if (!ai) {
      throw new Error("GEMINI_API_KEY manquante.");
    }

    const videos = [];

    for (const scene of project.scenes) {
      try {
        const operation = await ai.models.generateVideos({
          model: VIDEO_MODEL,
          prompt: scene.videoPrompt || scene.description,
        });

        const jobId = id("video");

        generatedVideos.set(jobId, {
          id: jobId,
          projectId,
          scene: scene.number,
          operation,
        });

        videos.push({
          id: jobId,
          scene: scene.number,
          status: "processing",
        });
      } catch (error) {
        videos.push({
          scene: scene.number,
          status: "error",
          error: error.message,
        });
      }
    }

    project.videos = videos;
    project.status = "animation_processing";
    project.progress = 75;

    res.json({
      success: true,
      videos,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   JOB STATUS
========================================================= */

app.get("/api/jobs", (req, res) => {
  res.json({
    success: true,
    jobs: Array.from(jobs.values()),
  });
});

/* =========================================================
   FINAL VIDEO
========================================================= */

app.post("/api/final-video", async (req, res) => {
  try {
    const { projectId } = req.body;

    const project = projects.find((p) => p.id === projectId);

    if (!project) {
      return res.status(404).json({
        error: "Projet introuvable.",
      });
    }

    project.status = "montage";
    project.progress = 90;

    const jobId = id("render");

    jobs.set(jobId, {
      id: jobId,
      projectId,
      type: "final-video",
      status: "processing",
      progress: 90,
      createdAt: new Date().toISOString(),
    });

    /*
      Le montage final pourra utiliser ici les fichiers vidéo
      retournés par Veo lorsque leur téléchargement sera disponible.
      On conserve le job pour éviter de casser le moteur actuel.
    */

    setTimeout(() => {
      const job = jobs.get(jobId);

      if (job) {
        job.status = "waiting";
        job.progress = 95;
      }
    }, 1000);

    res.json({
      success: true,
      jobId,
      status: "processing",
      message: "Le montage Cineflow est lancé.",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   FORMATS
========================================================= */

app.post("/api/formats", async (req, res) => {
  try {
    const { projectId, inputFile } = req.body;

    const project = projects.find((p) => p.id === projectId);

    if (!project) {
      return res.status(404).json({
        error: "Projet introuvable.",
      });
    }

    if (!inputFile || !fs.existsSync(inputFile)) {
      project.formats = {
        landscape: {
          name: "YouTube",
          ratio: "16:9",
          status: "ready",
        },
        portrait: {
          name: "TikTok / Reels / Shorts",
          ratio: "9:16",
          status: "ready",
        },
        square: {
          name: "Instagram",
          ratio: "1:1",
          status: "ready",
        },
      };

      return res.json({
        success: true,
        formats: project.formats,
      });
    }

    const dir = path.join(os.tmpdir(), "cineflow_formats");

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const outputs = {};

    const formats = [
      ["landscape", 1920, 1080],
      ["portrait", 1080, 1920],
      ["square", 1080, 1080],
    ];

    for (const [name, width, height] of formats) {
      const output = path.join(
        dir,
        `${project.id}_${name}.mp4`
      );

      await convertVideoFormat(inputFile, output, width, height);

      outputs[name] = {
        path: output,
        width,
        height,
        ratio: `${width}:${height}`,
        status: "ready",
      };
    }

    project.formats = outputs;

    res.json({
      success: true,
      formats: outputs,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   AUDIO
========================================================= */

app.post("/api/prepare-audio", async (req, res) => {
  try {
    const { projectId } = req.body;

    const project = projects.find((p) => p.id === projectId);

    if (!project) {
      return res.status(404).json({
        error: "Projet introuvable.",
      });
    }

    project.audio = {
      status: "prepared",
      type: "cinematic",
      message: "Piste audio prête pour le montage.",
    };

    res.json({
      success: true,
      audio: project.audio,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

/* =========================================================
   THUMBNAIL
========================================================= */

app.post("/api/thumbnail", async (req, res) => {
  try {
    const { projectId } = req.body;

    const project = projects.find((p) => p.id === projectId);

    if (!project) {
      return res.status(404).json({
        error: "Projet introuvable.",
      });
    }

    project.thumbnail = {
      status: "prepared",
      title: project.title,
      message: "Miniature prête.",
    };

    res.json({
      success: true,
      thumbnail: project.thumbnail,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

/* =========================================================
   SOCIAL
========================================================= */

app.post("/api/social", async (req, res) => {
  try {
    const { projectId } = req.body;

    const project = projects.find((p) => p.id === projectId);

    if (!project) {
      return res.status(404).json({
        error: "Projet introuvable.",
      });
    }

    project.social = {
      youtube: {
        title: project.title,
        description: project.concept || "",
        status: accounts.youtube ? "connected" : "ready",
      },
      tiktok: {
        caption: project.title,
        status: accounts.tiktok ? "connected" : "ready",
      },
      instagram: {
        caption: project.title,
        status: accounts.instagram ? "connected" : "ready",
      },
    };

    res.json({
      success: true,
      social: project.social,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

/* =========================================================
   ACCOUNTS
========================================================= */

app.get("/api/accounts", (req, res) => {
  res.json({
    success: true,
    accounts,
  });
});

app.post("/api/accounts/connect", (req, res) => {
  const { platform } = req.body;

  if (!accounts.hasOwnProperty(platform)) {
    return res.status(400).json({
      error: "Plateforme inconnue.",
    });
  }

  accounts[platform] = true;

  res.json({
    success: true,
    accounts,
  });
});

/* =========================================================
   AUTO-PILOTE
========================================================= */

app.post("/api/autopilot", async (req, res) => {
  try {
    const { prompt, category, title } = req.body;

    if (!prompt) {
      return res.status(400).json({
        error: "Donne une idée à Cineflow.",
      });
    }

    const project = createProjectObject({
      prompt,
      category,
      title,
    });

    project.status = "autopilot";
    project.progress = 5;

    projects.unshift(project);

    const jobId = id("autopilot");

    jobs.set(jobId, {
      id: jobId,
      projectId: project.id,
      type: "autopilot",
      status: "started",
      progress: 5,
      step: "Création du scénario",
    });

    res.json({
      success: true,
      project,
      jobId,
      message: "Auto-Pilote Cineflow lancé.",
    });

    try {
      const text = await generateText(`
Crée un projet vidéo complet pour Cineflow.

Idée :
${prompt}

Catégorie :
${category || "Film"}

Retourne uniquement un JSON valide avec :
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
"imagePrompt": "",
"videoPrompt": ""
},
{
"number": 2,
"title": "",
"description": "",
"imagePrompt": "",
"videoPrompt": ""
},
{
"number": 3,
"title": "",
"description": "",
"imagePrompt": "",
"videoPrompt": ""
},
{
"number": 4,
"title": "",
"description": "",
"imagePrompt": "",
"videoPrompt": ""
},
{
"number": 5,
"title": "",
"description": "",
"imagePrompt": "",
"videoPrompt": ""
}
]
}
`);

      const data = cleanJson(text);

      if (data) {
        project.title = data.title || project.title;
        project.concept = data.concept || "";
        project.style = data.style || "";
        project.characters = data.characters || [];
        project.scenes = data.scenes || [];
      }

      project.progress = 30;

      const job = jobs.get(jobId);

      if (job) {
        job.progress = 30;
        job.step = "Scénario terminé";
        job.status = "ready_for_images";
      }

      project.status = "ready";
    } catch (error) {
      project.status = "error";

      const job = jobs.get(jobId);

      if (job) {
        job.status = "error";
        job.error = error.message;
      }
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   TRENDS
========================================================= */

app.get("/api/trends", (req, res) => {
  res.json({
    success: true,
    trends: [
      {
        title: "Football & dépassement de soi",
        category: "Football",
        score: 94,
      },
      {
        title: "Histoires courtes émotionnelles",
        category: "Drama",
        score: 91,
      },
      {
        title: "Animation cinématique",
        category: "Animation",
        score: 88,
      },
      {
        title: "Action futuriste",
        category: "Action",
        score: 86,
      },
    ],
  });
});

/* =========================================================
   DASHBOARD
========================================================= */

app.get("/api/dashboard", (req, res) => {
  const completed = projects.filter(
    (p) => p.status === "completed"
  ).length;

  res.json({
    success: true,
    stats: {
      projects: projects.length,
      completed,
      scenes: projects.reduce(
        (sum, p) => sum + (p.scenes?.length || 0),
        0
      ),
      images: projects.reduce(
        (sum, p) => sum + (p.images?.length || 0),
        0
      ),
    },
    projects: projects.slice(0, 8),
  });
});

/* =========================================================
   REPORT
========================================================= */

app.get("/api/report", (req, res) => {
  res.json({
    success: true,
    report: {
      period: "Cette semaine",
      videos: projects.length,
      views: 0,
      likes: 0,
      subscribers: 0,
      revenue: 0,
      message:
        "Les statistiques réelles seront disponibles après connexion des plateformes.",
    },
  });
});

/* =========================================================
   SERIES
========================================================= */

app.post("/api/series", (req, res) => {
  const serie = {
    id: id("series"),
    title: req.body.title || "Nouvelle série",
    description: req.body.description || "",
    episodes: [],
    createdAt: new Date().toISOString(),
  };

  series.push(serie);

  res.json({
    success: true,
    series: serie,
  });
});

app.post("/api/series/:id/episode", (req, res) => {
  const serie = series.find((s) => s.id === req.params.id);

  if (!serie) {
    return res.status(404).json({
      error: "Série introuvable.",
    });
  }

  const episode = {
    id: id("episode"),
    number: serie.episodes.length + 1,
    title:
      req.body.title ||
      `Épisode ${serie.episodes.length + 1}`,
    createdAt: new Date().toISOString(),
  };

  serie.episodes.push(episode);

  res.json({
    success: true,
    episode,
  });
});

/* =========================================================
   PREMIUM UI
========================================================= */

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cineflow — Studio vidéo IA</title>

<style>

:root {
  --bg: #070812;
  --bg2: #0b0e1c;
  --panel: rgba(17, 20, 38, .78);
  --panel2: rgba(22, 26, 48, .9);
  --border: rgba(255,255,255,.08);
  --text: #f7f8ff;
  --muted: #9097b5;
  --purple: #8b5cf6;
  --pink: #ec4899;
  --blue: #38bdf8;
  --green: #22c55e;
  --orange: #fb923c;
}

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
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  color: var(--text);
  background:
    radial-gradient(circle at 20% 0%, rgba(139,92,246,.22), transparent 30%),
    radial-gradient(circle at 90% 10%, rgba(56,189,248,.14), transparent 28%),
    radial-gradient(circle at 50% 100%, rgba(236,72,153,.10), transparent 32%),
    var(--bg);
  min-height: 100vh;
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

/* SIDEBAR */

.sidebar {
  width: 245px;
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  padding: 22px 16px;
  border-right: 1px solid var(--border);
  background: rgba(6,8,18,.86);
  backdrop-filter: blur(22px);
  z-index: 50;
}

.logo {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px 28px;
}

.logo-icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 13px;
  background:
    linear-gradient(135deg, var(--purple), var(--pink));
  box-shadow: 0 12px 30px rgba(139,92,246,.32);
  font-size: 21px;
}

.logo strong {
  font-size: 20px;
  letter-spacing: -.5px;
}

.logo span {
  display: block;
  color: var(--muted);
  font-size: 10px;
  margin-top: 2px;
}

.nav-title {
  color: #666d8b;
  text-transform: uppercase;
  letter-spacing: 1.4px;
  font-size: 10px;
  padding: 12px 12px 8px;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.nav button {
  border: 0;
  background: transparent;
  color: #aeb4ce;
  width: 100%;
  padding: 12px 13px;
  border-radius: 12px;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 12px;
  transition: .2s;
}

.nav button:hover,
.nav button.active {
  background: rgba(139,92,246,.13);
  color: white;
}

.nav-icon {
  width: 20px;
  text-align: center;
}

.sidebar-bottom {
  position: absolute;
  bottom: 20px;
  left: 16px;
  right: 16px;
}

.connection {
  border: 1px solid var(--border);
  border-radius: 15px;
  padding: 13px;
  background: rgba(255,255,255,.025);
}

.connection-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 12px var(--green);
}

/* MAIN */

.main {
  width: calc(100% - 245px);
  margin-left: 245px;
  padding: 24px 30px 80px;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.breadcrumb {
  color: var(--muted);
  font-size: 13px;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.icon-btn {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: rgba(255,255,255,.04);
  color: white;
}

/* HERO */

.hero {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 26px;
  padding: 38px;
  min-height: 355px;
  background:
    linear-gradient(120deg, rgba(139,92,246,.20), rgba(236,72,153,.07)),
    rgba(15,18,34,.78);
  box-shadow: 0 25px 80px rgba(0,0,0,.22);
}

.hero::before {
  content: "";
  position: absolute;
  width: 350px;
  height: 350px;
  right: -120px;
  top: -150px;
  background: rgba(139,92,246,.22);
  filter: blur(80px);
  border-radius: 50%;
}

.hero-content {
  position: relative;
  max-width: 720px;
}

.eyebrow {
  color: #b7a5ff;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 1.4px;
  text-transform: uppercase;
  margin-bottom: 14px;
}

.hero h1 {
  margin: 0;
  font-size: clamp(34px, 5vw, 60px);
  line-height: .98;
  letter-spacing: -2.8px;
}

.hero h1 span {
  background: linear-gradient(90deg, #fff, #c4b5fd, #f9a8d4);
  -webkit-background-clip: text;
  color: transparent;
}

.hero p {
  color: #aeb4ce;
  line-height: 1.7;
  max-width: 630px;
  margin: 18px 0 25px;
}

.hero-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.primary {
  border: 0;
  padding: 14px 19px;
  border-radius: 13px;
  color: white;
  font-weight: 800;
  background: linear-gradient(135deg, var(--purple), var(--pink));
  box-shadow: 0 14px 35px rgba(139,92,246,.28);
  transition: .2s;
}

.primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 18px 42px rgba(139,92,246,.4);
}

.secondary {
  border: 1px solid var(--border);
  padding: 14px 18px;
  border-radius: 13px;
  color: white;
  background: rgba(255,255,255,.045);
}

/* STATS */

.stats {
  display: grid;
  grid-template-columns: repeat(4,1fr);
  gap: 14px;
  margin-top: 18px;
}

.stat {
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 18px;
  padding: 19px;
}

.stat-label {
  color: var(--muted);
  font-size: 12px;
}

.stat-value {
  font-size: 28px;
  font-weight: 800;
  margin-top: 6px;
}

/* SECTION */

.section {
  margin-top: 30px;
}

.section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 15px;
}

.section-head h2 {
  margin: 0;
  font-size: 21px;
  letter-spacing: -.5px;
}

.section-head span {
  color: var(--muted);
  font-size: 12px;
}

/* CREATOR */

.creator {
  display: grid;
  grid-template-columns: 1.35fr .65fr;
  gap: 15px;
}

.card {
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 20px;
  padding: 20px;
}

.card-title {
  font-weight: 750;
  margin-bottom: 12px;
}

textarea {
  width: 100%;
  min-height: 145px;
  resize: vertical;
  border-radius: 15px;
  border: 1px solid var(--border);
  outline: none;
  padding: 16px;
  color: white;
  background: rgba(0,0,0,.22);
}

textarea:focus {
  border-color: rgba(139,92,246,.65);
  box-shadow: 0 0 0 3px rgba(139,92,246,.09);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 13px 0;
}

.chip {
  border: 1px solid var(--border);
  background: rgba(255,255,255,.035);
  color: #bfc5db;
  border-radius: 999px;
  padding: 8px 12px;
  font-size: 11px;
}

.chip.active {
  background: rgba(139,92,246,.17);
  border-color: rgba(139,92,246,.4);
  color: white;
}

/* AUTOPILOT */

.autopilot {
  position: relative;
  overflow: hidden;
  background:
    linear-gradient(145deg, rgba(139,92,246,.20), rgba(236,72,153,.07)),
    var(--panel);
}

.autopilot::after {
  content: "✦";
  position: absolute;
  right: 18px;
  top: 14px;
  font-size: 35px;
  opacity: .18;
}

.auto-icon {
  width: 48px;
  height: 48px;
  border-radius: 15px;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg,var(--purple),var(--pink));
  font-size: 23px;
  margin-bottom: 16px;
}

.autopilot h3 {
  margin: 0 0 8px;
}

.autopilot p {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}

.auto-btn {
  width: 100%;
  margin-top: 10px;
}

/* PROJECTS */

.projects-grid {
  display: grid;
  grid-template-columns: repeat(3,1fr);
  gap: 14px;
}

.project-card {
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 18px;
}

.project-cover {
  height: 145px;
  display: flex;
  align-items: flex-end;
  padding: 14px;
  background:
    radial-gradient(circle at 20% 30%, rgba(139,92,246,.5), transparent 35%),
    radial-gradient(circle at 80% 70%, rgba(236,72,153,.35), transparent 35%),
    linear-gradient(135deg,#15172b,#090a14);
}

.project-cover span {
  font-size: 10px;
  padding: 5px 8px;
  border-radius: 7px;
  background: rgba(0,0,0,.45);
  backdrop-filter: blur(8px);
}

.project-body {
  padding: 15px;
}

.project-body h3 {
  margin: 0;
  font-size: 15px;
}

.project-body p {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 11px;
}

.progress {
  margin-top: 12px;
  height: 5px;
  background: rgba(255,255,255,.07);
  border-radius: 20px;
  overflow: hidden;
}

.progress i {
  display: block;
  height: 100%;
  width: 45%;
  background: linear-gradient(90deg,var(--purple),var(--pink));
}

/* WORKFLOW */

.workflow {
  display: grid;
  grid-template-columns: repeat(5,1fr);
  gap: 10px;
}

.step {
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 15px;
  background: rgba(255,255,255,.025);
  min-height: 130px;
}

.step-number {
  color: #aaa4ff;
  font-size: 11px;
}

.step-icon {
  font-size: 24px;
  margin: 12px 0 7px;
}

.step strong {
  font-size: 12px;
}

.step p {
  color: var(--muted);
  font-size: 10px;
  line-height: 1.5;
}

/* SCENES */

.timeline {
  display: grid;
  grid-template-columns: repeat(5,1fr);
  gap: 12px;
}

.scene {
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 17px;
  overflow: hidden;
  transition: .2s;
}

.scene:hover {
  transform: translateY(-3px);
  border-color: rgba(139,92,246,.4);
}

.scene-visual {
  height: 135px;
  display: grid;
  place-items: center;
  font-size: 31px;
  background:
    radial-gradient(circle at 30% 20%,rgba(56,189,248,.18),transparent 35%),
    radial-gradient(circle at 80% 80%,rgba(139,92,246,.24),transparent 40%),
    #111426;
}

.scene-body {
  padding: 12px;
}

.scene-label {
  color: #a7a1ff;
  font-size: 9px;
  font-weight: 800;
  text-transform: uppercase;
}

.scene h3 {
  margin: 5px 0;
  font-size: 13px;
}

.scene p {
  color: var(--muted);
  font-size: 10px;
  line-height: 1.5;
  min-height: 30px;
}

/* FORMATS */

.formats {
  display: grid;
  grid-template-columns: repeat(3,1fr);
  gap: 14px;
}

.format {
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 18px;
  padding: 18px;
  display: flex;
  gap: 14px;
  align-items: center;
}

.format-preview {
  width: 44px;
  height: 60px;
  border: 2px solid #aaa;
  border-radius: 6px;
  opacity: .7;
}

.format.landscape .format-preview {
  width: 60px;
  height: 38px;
}

.format.square .format-preview {
  width: 48px;
  height: 48px;
}

.format h3 {
  margin: 0;
  font-size: 13px;
}

.format p {
  margin: 5px 0 0;
  color: var(--muted);
  font-size: 10px;
}

/* TOOLS */

.tools {
  display: grid;
  grid-template-columns: repeat(4,1fr);
  gap: 12px;
}

.tool {
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 17px;
  padding: 17px;
}

.tool-icon {
  font-size: 23px;
}

.tool h3 {
  font-size: 13px;
  margin: 9px 0 5px;
}

.tool p {
  margin: 0;
  color: var(--muted);
  font-size: 10px;
  line-height: 1.5;
}

/* FOOTER */

.footer {
  text-align: center;
  color: #5f6680;
  font-size: 10px;
  margin-top: 55px;
}

/* MOBILE */

.mobile-nav {
  display: none;
}

@media(max-width: 1050px) {
  .stats {
    grid-template-columns: repeat(2,1fr);
  }

  .creator {
    grid-template-columns: 1fr;
  }

  .projects-grid {
    grid-template-columns: repeat(2,1fr);
  }

  .workflow,
  .timeline {
    grid-template-columns: repeat(3,1fr);
  }

  .formats {
    grid-template-columns: 1fr;
  }

  .tools {
    grid-template-columns: repeat(2,1fr);
  }
}

@media(max-width: 720px) {

  .sidebar {
    display: none;
  }

  .main {
    width: 100%;
    margin-left: 0;
    padding: 16px 13px 95px;
  }

  .topbar {
    margin-bottom: 14px;
  }

  .hero {
    padding: 25px 20px;
    border-radius: 22px;
  }

  .hero h1 {
    font-size: 38px;
    letter-spacing: -1.8px;
  }

  .stats {
    grid-template-columns: repeat(2,1fr);
  }

  .stat-value {
    font-size: 23px;
  }

  .projects-grid,
  .workflow,
  .timeline,
  .tools {
    grid-template-columns: 1fr;
  }

  .scene {
    display: grid;
    grid-template-columns: 105px 1fr;
  }

  .scene-visual {
    height: 100%;
    min-height: 110px;
  }

  .mobile-nav {
    display: flex;
    position: fixed;
    z-index: 100;
    bottom: 10px;
    left: 10px;
    right: 10px;
    height: 65px;
    border: 1px solid var(--border);
    border-radius: 19px;
    background: rgba(10,12,24,.9);
    backdrop-filter: blur(20px);
    align-items: center;
    justify-content: space-around;
    box-shadow: 0 15px 40px rgba(0,0,0,.35);
  }

  .mobile-nav button {
    border: 0;
    background: transparent;
    color: #8f96b0;
    font-size: 18px;
  }

  .mobile-nav button.active {
    color: white;
  }
}

</style>
</head>

<body>

<div class="app">

  <aside class="sidebar">

    <div class="logo">
      <div class="logo-icon">✦</div>
      <div>
        <strong>Cineflow</strong>
        <span>AI VIDEO STUDIO</span>
      </div>
    </div>

    <div class="nav-title">Workspace</div>

    <nav class="nav">
      <button class="active" onclick="scrollToSection('home')">
        <span class="nav-icon">⌂</span>
        Accueil
      </button>

      <button onclick="scrollToSection('creator')">
        <span class="nav-icon">✦</span>
        Créer
      </button>

      <button onclick="scrollToSection('scenes')">
        <span class="nav-icon">▣</span>
        Studio
      </button>

      <button onclick="scrollToSection('formats')">
        <span class="nav-icon">◫</span>
        Formats
      </button>

      <button onclick="scrollToSection('projects')">
        <span class="nav-icon">▤</span>
        Projets
      </button>

      <button onclick="loadDashboard()">
        <span class="nav-icon">◈</span>
        Analytics
      </button>
    </nav>

    <div class="nav-title">Système</div>

    <nav class="nav">
      <button onclick="testGemini()">
        <span class="nav-icon">●</span>
        Connexion Gemini
      </button>

      <button onclick="alert('La gestion des comptes sociaux arrive dans la prochaine étape.')">
        <span class="nav-icon">◎</span>
        Comptes sociaux
      </button>
    </nav>

    <div class="sidebar-bottom">
      <div class="connection">
        <div class="connection-line">
          <span class="dot"></span>
          <span>Gemini</span>
          <span style="margin-left:auto;color:#6ee7b7">Connecté</span>
        </div>
      </div>
    </div>

  </aside>

  <main class="main">

    <div class="topbar">
      <div class="breadcrumb">
        Cineflow / Studio de création
      </div>

      <div class="top-actions">
        <button class="icon-btn" onclick="testGemini()">⌁</button>
        <button class="icon-btn" onclick="location.reload()">↻</button>
      </div>
    </div>

    <!-- HERO -->

    <section class="hero" id="home">

      <div class="hero-content">

        <div class="eyebrow">
          ✦ TON ESPACE DE CRÉATION IA
        </div>

        <h1>
          Transforme une idée<br>
          en <span>film.</span>
        </h1>

        <p>
          Cineflow imagine ton histoire, construit les scènes,
          prépare les visuels et transforme ton concept en projet vidéo.
        </p>

        <div class="hero-actions">

          <button class="primary"
            onclick="scrollToSection('creator')">
            ✦ Créer une vidéo
          </button>

          <button class="secondary"
            onclick="runAutoPilot()">
            ⚡ Auto-Pilote
          </button>

        </div>

      </div>

    </section>

    <!-- STATS -->

    <div class="stats">

      <div class="stat">
        <div class="stat-label">Projets</div>
        <div class="stat-value" id="statProjects">0</div>
      </div>

      <div class="stat">
        <div class="stat-label">Scènes créées</div>
        <div class="stat-value" id="statScenes">0</div>
      </div>

      <div class="stat">
        <div class="stat-label">Images IA</div>
        <div class="stat-value" id="statImages">0</div>
      </div>

      <div class="stat">
        <div class="stat-label">Vidéos finales</div>
        <div class="stat-value" id="statVideos">0</div>
      </div>

    </div>

    <!-- CREATOR -->

    <section class="section" id="creator">

      <div class="section-head">
        <h2>Créer quelque chose de nouveau</h2>
        <span>Étape 01 · Concept</span>
      </div>

      <div class="creator">

        <div class="card">

          <div class="card-title">
            Décris ton idée
          </div>

          <textarea
            id="prompt"
            placeholder="Exemple : un jeune footballeur africain rêve de devenir professionnel malgré les difficultés..."
          ></textarea>

          <div class="chips">
            <button class="chip active" onclick="setCategory(this,'Film')">🎬 Film</button>
            <button class="chip" onclick="setCategory(this,'Animation')">✨ Animation</button>
            <button class="chip" onclick="setCategory(this,'Action')">⚡ Action</button>
            <button class="chip" onclick="setCategory(this,'Drama')">🎭 Drama</button>
            <button class="chip" onclick="setCategory(this,'Football')">⚽ Football</button>
          </div>

          <button class="primary" style="width:100%" onclick="createProject()">
            Générer mon projet →
          </button>

        </div>

        <div class="card autopilot">

          <div class="auto-icon">⚡</div>

          <h3>Auto-Pilote</h3>

          <p>
            Donne simplement ton idée.
            Cineflow prépare automatiquement la structure
            de ton projet.
          </p>

          <button class="primary auto-btn" onclick="runAutoPilot()">
            Lancer Auto-Pilote
          </button>

        </div>

      </div>

    </section>

    <!-- WORKFLOW -->

    <section class="section">

      <div class="section-head">
        <h2>Le pipeline Cineflow</h2>
        <span>De l'idée au film</span>
      </div>

      <div class="workflow">

        <div class="step">
          <div class="step-number">01</div>
          <div class="step-icon">💡</div>
          <strong>Idée</strong>
          <p>Ton concept devient un projet.</p>
        </div>

        <div class="step">
          <div class="step-number">02</div>
          <div class="step-icon">📝</div>
          <strong>Scénario</strong>
          <p>Une histoire structurée en 5 scènes.</p>
        </div>

        <div class="step">
          <div class="step-number">03</div>
          <div class="step-icon">🎨</div>
          <strong>Visuels</strong>
          <p>Création des images des scènes.</p>
        </div>

        <div class="step">
          <div class="step-number">04</div>
          <div class="step-icon">🎞️</div>
          <strong>Animation</strong>
          <p>Les scènes deviennent animées.</p>
        </div>

        <div class="step">
          <div class="step-number">05</div>
          <div class="step-icon">🎬</div>
          <strong>Film</strong>
          <p>Montage et formats finaux.</p>
        </div>

      </div>

    </section>

    <!-- PROJECTS -->

    <section class="section" id="projects">

      <div class="section-head">
        <h2>Mes projets</h2>
        <span id="projectCount">0 projet</span>
      </div>

      <div class="projects-grid" id="projectsGrid">

        <div class="project-card">

          <div class="project-cover">
            <span>NOUVEAU</span>
          </div>

          <div class="project-body">
            <h3>Ton prochain film</h3>
            <p>Commence avec une idée ci-dessus.</p>

            <div class="progress">
              <i style="width:0%"></i>
            </div>
          </div>

        </div>

      </div>

    </section>

    <!-- SCENES -->

    <section class="section" id="scenes">

      <div class="section-head">
        <h2>Timeline des scènes</h2>
        <span>5 scènes cinématiques</span>
      </div>

      <div class="timeline" id="sceneTimeline">

        <div class="scene">
          <div class="scene-visual">01</div>
          <div class="scene-body">
            <div class="scene-label">Scène 01</div>
            <h3>Ouverture</h3>
            <p>Ta première scène apparaîtra ici.</p>
          </div>
        </div>

        <div class="scene">
          <div class="scene-visual">02</div>
          <div class="scene-body">
            <div class="scene-label">Scène 02</div>
            <h3>Développement</h3>
            <p>La deuxième scène apparaîtra ici.</p>
          </div>
        </div>

        <div class="scene">
          <div class="scene-visual">03</div>
          <div class="scene-body">
            <div class="scene-label">Scène 03</div>
            <h3>Conflit</h3>
            <p>Le cœur de l'histoire.</p>
          </div>
        </div>

        <div class="scene">
          <div class="scene-visual">04</div>
          <div class="scene-body">
            <div class="scene-label">Scène 04</div>
            <h3>Climax</h3>
            <p>Le moment décisif.</p>
          </div>
        </div>

        <div class="scene">
          <div class="scene-visual">05</div>
          <div class="scene-body">
            <div class="scene-label">Scène 05</div>
            <h3>Final</h3>
            <p>La conclusion du film.</p>
          </div>
        </div>

      </div>

    </section>

    <!-- FORMATS -->

    <section class="section" id="formats">

      <div class="section-head">
        <h2>Formats intelligents</h2>
        <span>Un projet · plusieurs plateformes</span>
      </div>

      <div class="formats">

        <div class="format landscape">
          <div class="format-preview"></div>
          <div>
            <h3>YouTube / Cinéma</h3>
            <p>16:9 · 1920 × 1080</p>
          </div>
        </div>

        <div class="format portrait">
          <div class="format-preview"></div>
          <div>
            <h3>TikTok / Shorts / Reels</h3>
            <p>9:16 · 1080 × 1920</p>
          </div>
        </div>

        <div class="format square">
          <div class="format-preview"></div>
          <div>
            <h3>Instagram</h3>
            <p>1:1 · 1080 × 1080</p>
          </div>
        </div>

      </div>

    </section>

    <!-- TOOLS -->

    <section class="section">

      <div class="section-head">
        <h2>Studio Cineflow</h2>
        <span>Tout au même endroit</span>
      </div>

      <div class="tools">

        <div class="tool">
          <div class="tool-icon">🎨</div>
          <h3>Images IA</h3>
          <p>Crée les visuels de chaque scène.</p>
        </div>

        <div class="tool">
          <div class="tool-icon">🎞️</div>
          <h3>Veo</h3>
          <p>Anime les scènes avec l'IA vidéo.</p>
        </div>

        <div class="tool">
          <div class="tool-icon">🎵</div>
          <h3>Musique</h3>
          <p>Prépare la bande sonore du projet.</p>
        </div>

        <div class="tool">
          <div class="tool-icon">📊</div>
          <h3>Analytics</h3>
          <p>Prépare le suivi des performances.</p>
        </div>

      </div>

    </section>

    <div class="footer">
      Cineflow · Ton espace de création assistée par intelligence artificielle
    </div>

  </main>

</div>

<div class="mobile-nav">
  <button class="active" onclick="scrollToSection('home')">⌂</button>
  <button onclick="scrollToSection('creator')">✦</button>
  <button onclick="scrollToSection('scenes')">▣</button>
  <button onclick="scrollToSection('projects')">▤</button>
</div>

<script>

let currentCategory = "Film";
let currentProject = null;

function scrollToSection(id) {
  const element = document.getElementById(id);

  if (element) {
    element.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }
}

function setCategory(button, category) {

  currentCategory = category;

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.classList.remove("active");
  });

  button.classList.add("active");
}

async function createProject() {

  const prompt = document.getElementById("prompt").value.trim();

  if (!prompt) {
    alert("Écris d'abord ton idée de vidéo.");
    return;
  }

  const button = event?.currentTarget;

  if (button) {
    button.disabled = true;
    button.textContent = "✦ Cineflow imagine...";
  }

  try {

    const response = await fetch("/api/project", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt,
        category: currentCategory
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Erreur Cineflow.");
    }

    currentProject = data.project;

    renderProject(currentProject);
    loadDashboard();

    alert("✨ Projet Cineflow créé !");

  } catch (error) {

    alert(error.message);

  } finally {

    if (button) {
      button.disabled = false;
      button.textContent = "Générer mon projet →";
    }
  }
}

async function runAutoPilot() {

  const prompt = document.getElementById("prompt").value.trim();

  if (!prompt) {
    alert("Décris ton idée avant de lancer Auto-Pilote.");
    scrollToSection("creator");
    return;
  }

  try {

    const response = await fetch("/api/autopilot", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt,
        category: currentCategory
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Impossible de lancer Auto-Pilote.");
    }

    currentProject = data.project;

    renderProject(currentProject);
    loadDashboard();

    alert(
      "⚡ Auto-Pilote lancé ! Cineflow prépare ton projet."
    );

  } catch (error) {

    alert(error.message);

  }
}

function renderProject(project) {

  if (!project) return;

  const timeline = document.getElementById("sceneTimeline");

  if (timeline && project.scenes) {

    timeline.innerHTML = project.scenes
      .slice(0, 5)
      .map((scene, index) => {

        return `
          <div class="scene">
            <div class="scene-visual">
              ${String(index + 1).padStart(2, "0")}
            </div>

            <div class="scene-body">
              <div class="scene-label">
                Scène ${String(index + 1).padStart(2, "0")}
              </div>

              <h3>
                ${escapeHtml(scene.title || "Scène")}
              </h3>

              <p>
                ${escapeHtml(
                  scene.description || "Scène générée par Cineflow."
                )}
              </p>
            </div>
          </div>
        `;

      })
      .join("");
  }

  loadProjects();
}

async function loadProjects() {

  try {

    const response = await fetch("/api/projects");
    const data = await response.json();

    const list = data.projects || [];

    const grid = document.getElementById("projectsGrid");

    document.getElementById("projectCount").textContent =
      `${list.length} projet${list.length > 1 ? "s" : ""}`;

    if (!list.length) {
      return;
    }

    grid.innerHTML = list.slice(0, 6).map((project) => {

      const progress = Math.max(
        0,
        Math.min(100, Number(project.progress || 0))
      );

      return `
        <div class="project-card">

          <div class="project-cover">
            <span>${escapeHtml(
              project.category || "FILM"
            ).toUpperCase()}</span>
          </div>

          <div class="project-body">

            <h3>
              ${escapeHtml(project.title || "Projet Cineflow")}
            </h3>

            <p>
              ${escapeHtml(
                project.status || "Projet créé"
              )}
            </p>

            <div class="progress">
              <i style="width:${progress}%"></i>
            </div>

          </div>

        </div>
      `;

    }).join("");

  } catch {}
}

async function loadDashboard() {

  try {

    const response = await fetch("/api/dashboard");
    const data = await response.json();

    if (!data.stats) return;

    document.getElementById("statProjects").textContent =
      data.stats.projects || 0;

    document.getElementById("statScenes").textContent =
      data.stats.scenes || 0;

    document.getElementById("statImages").textContent =
      data.stats.images || 0;

    document.getElementById("statVideos").textContent =
      data.stats.completed || 0;

    loadProjects();

  } catch {}
}

async function testGemini() {

  try {

    const response = await fetch("/api/test-gemini");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Gemini indisponible.");
    }

    alert("✓ " + data.message);

  } catch (error) {

    alert(
      "Gemini : " + error.message
    );

  }
}

function escapeHtml(value) {

  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

loadDashboard();

</script>

</body>
</html>
  `);
});

/* =========================================================
   START
========================================================= */

app.listen(PORT, () => {
  console.log("========================================");
  console.log("        CINEFLOW IS RUNNING");
  console.log("========================================");
  console.log("Port:", PORT);
  console.log("Gemini:", API_KEY ? "CONNECTED" : "MISSING KEY");
  console.log("Text model:", MODEL);
  console.log("Image model:", IMAGE_MODEL);
  console.log("Video model:", VIDEO_MODEL);
  console.log("========================================");
});

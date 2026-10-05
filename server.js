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

const projects = [];
const jobs = new Map();
const generatedImages = new Map();
const generatedVideos = new Map();
const series = [];

const accounts = {
  youtube: false,
  tiktok: false,
  instagram: false
};

/* =========================================================
   HELPERS
========================================================= */

function makeId(prefix) {
  return (
    prefix +
    "_" +
    Date.now() +
    "_" +
    Math.random().toString(36).slice(2, 8)
  );
}

function cleanJson(text) {
  if (!text) return null;

  let value = String(text)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");

  if (first !== -1 && last !== -1) {
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
        ?.map((part) => part.text || "")
        .join("") ||
      ""
    );
  } catch {
    return "";
  }
}

async function generateText(prompt) {
  if (!ai) {
    throw new Error(
      "GEMINI_API_KEY n'est pas configurée sur Render."
    );
  }

  const result = await ai.models.generateContent({
    model: MODEL,
    contents: prompt
  });

  return getText(result);
}

async function generateImage(prompt) {
  if (!ai) {
    throw new Error("GEMINI_API_KEY manquante.");
  }

  return await ai.interactions.create({
    model: IMAGE_MODEL,
    input: prompt,
    response_format: {
      type: "image",
      mime_type: "image/png",
      aspect_ratio: "16:9",
      image_size: "1K"
    }
  });
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
          reject(new Error(stderr || error.message));
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

async function convertVideoFormat(
  input,
  output,
  width,
  height
) {
  await runFFmpeg([
    "-y",
    "-i",
    input,
    "-vf",
    "scale=" +
      width +
      ":" +
      height +
      ":force_original_aspect_ratio=decrease,pad=" +
      width +
      ":" +
      height +
      ":(ow-iw)/2:(oh-ih)/2",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    output
  ]);
}

function createProject(data) {
  return {
    id: makeId("project"),
    title: data.title || "Nouveau projet",
    prompt: data.prompt || "",
    category: data.category || "Film",
    status: "created",
    progress: 0,
    createdAt: new Date().toISOString(),

    concept: "",
    style: "",
    characters: [],

    scenes: [],
    images: [],
    videos: [],

    finalVideo: null,
    formats: {},
    audio: null,
    thumbnail: null,
    social: {}
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
    videoModel: VIDEO_MODEL
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    geminiConnected: !!API_KEY,
    message: API_KEY
      ? "Cineflow est connecté à Gemini."
      : "GEMINI_API_KEY manquante."
  });
});

/* =========================================================
   TEST GEMINI
========================================================= */

app.get("/api/test-gemini", async (req, res) => {
  try {
    const text = await generateText(
      "Réponds très brièvement en français et confirme que Gemini est connecté à Cineflow."
    );

    res.json({
      success: true,
      message:
        text || "Gemini est connecté à Cineflow."
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   CREATE PROJECT
========================================================= */

app.post("/api/project", async (req, res) => {
  try {
    const prompt = req.body.prompt;
    const category = req.body.category;
    const title = req.body.title;

    if (!prompt) {
      return res.status(400).json({
        error: "Décris ton idée de vidéo."
      });
    }

    const project = createProject({
      prompt,
      category,
      title
    });

    project.status = "generating";
    project.progress = 10;

    const text = await generateText(
      [
        "Tu es le scénariste principal de Cineflow.",
        "",
        "Crée un projet vidéo cinématographique à partir de cette idée :",
        prompt,
        "",
        "Catégorie :",
        category || "Film",
        "",
        "Retourne uniquement un JSON valide.",
        "",
        "{",
        '  "title": "titre",',
        '  "concept": "concept court",',
        '  "style": "style visuel",',
        '  "characters": ["personnage 1", "personnage 2"],',
        '  "scenes": [',
        "    {",
        '      "number": 1,',
        '      "title": "titre scène",',
        '      "description": "description détaillée",',
        '      "imagePrompt": "prompt visuel cinématographique",',
        '      "videoPrompt": "prompt animation vidéo"',
        "    },",
        "    {",
        '      "number": 2,',
        '      "title": "titre scène",',
        '      "description": "description détaillée",',
        '      "imagePrompt": "prompt visuel cinématographique",',
        '      "videoPrompt": "prompt animation vidéo"',
        "    },",
        "    {",
        '      "number": 3,',
        '      "title": "titre scène",',
        '      "description": "description détaillée",',
        '      "imagePrompt": "prompt visuel cinématographique",',
        '      "videoPrompt": "prompt animation vidéo"',
        "    },",
        "    {",
        '      "number": 4,',
        '      "title": "titre scène",',
        '      "description": "description détaillée",',
        '      "imagePrompt": "prompt visuel cinématographique",',
        '      "videoPrompt": "prompt animation vidéo"',
        "    },",
        "    {",
        '      "number": 5,',
        '      "title": "titre scène",',
        '      "description": "description détaillée",',
        '      "imagePrompt": "prompt visuel cinématographique",',
        '      "videoPrompt": "prompt animation vidéo"',
        "    }",
        "  ]",
        "}"
      ].join("\n")
    );

    const data = cleanJson(text);

    if (!data) {
      throw new Error(
        "Gemini n'a pas retourné un JSON exploitable."
      );
    }

    project.title = data.title || project.title;
    project.concept = data.concept || "";
    project.style = data.style || "";

    project.characters =
      Array.isArray(data.characters)
        ? data.characters
        : [];

    project.scenes =
      Array.isArray(data.scenes)
        ? data.scenes.slice(0, 5)
        : [];

    project.progress = 30;
    project.status = "ready";

    projects.unshift(project);

    res.json({
      success: true,
      project
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   PROJECTS
========================================================= */

app.get("/api/projects", (req, res) => {
  res.json({
    success: true,
    projects
  });
});

app.get("/api/project/:id", (req, res) => {
  const project = projects.find(
    (item) => item.id === req.params.id
  );

  if (!project) {
    return res.status(404).json({
      error: "Projet introuvable."
    });
  }

  res.json({
    success: true,
    project
  });
});

/* =========================================================
   SCENES
========================================================= */

app.post("/api/scenes", (req, res) => {
  const project = projects.find(
    (item) => item.id === req.body.projectId
  );

  if (!project) {
    return res.status(404).json({
      error: "Projet introuvable."
    });
  }

  project.status = "scenes_ready";
  project.progress = 40;

  res.json({
    success: true,
    scenes: project.scenes
  });
});

/* =========================================================
   IMAGES
========================================================= */

app.post("/api/images", async (req, res) => {
  try {
    const project = projects.find(
      (item) => item.id === req.body.projectId
    );

    if (!project) {
      return res.status(404).json({
        error: "Projet introuvable."
      });
    }

    const results = [];

    for (let i = 0; i < project.scenes.length; i++) {
      const scene = project.scenes[i];

      try {
        const result = await generateImage(
          [
            scene.imagePrompt || scene.description,
            "",
            "Style cinématographique premium.",
            "Personnages cohérents.",
            "Lumière cinématographique.",
            "Format 16:9."
          ].join("\n")
        );

        const imageId = makeId("image");

        generatedImages.set(imageId, {
          id: imageId,
          projectId: project.id,
          scene: scene.number,
          result
        });

        results.push({
          id: imageId,
          scene: scene.number,
          status: "generated"
        });
      } catch (error) {
        results.push({
          scene: scene.number,
          status: "error",
          error: error.message
        });
      }

      project.progress =
        45 +
        Math.round(
          ((i + 1) / project.scenes.length) * 20
        );
    }

    project.images = results;
    project.status = "images_ready";

    res.json({
      success: true,
      images: results,
      project
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   REGENERATE SCENE
========================================================= */

app.post("/api/regenerate-scene", async (req, res) => {
  try {
    const project = projects.find(
      (item) => item.id === req.body.projectId
    );

    if (!project) {
      return res.status(404).json({
        error: "Projet introuvable."
      });
    }

    const scene = project.scenes.find(
      (item) =>
        Number(item.number) ===
        Number(req.body.sceneNumber)
    );

    if (!scene) {
      return res.status(404).json({
        error: "Scène introuvable."
      });
    }

    const result = await generateImage(
      [
        scene.imagePrompt || scene.description,
        "",
        "Nouvelle version de la scène.",
        "Cinématographique.",
        "Cohérente avec l'histoire.",
        "Format 16:9."
      ].join("\n")
    );

    const imageId = makeId("image");

    generatedImages.set(imageId, {
      id: imageId,
      projectId: project.id,
      scene: scene.number,
      result
    });

    project.images = project.images.filter(
      (item) =>
        Number(item.scene) !==
        Number(scene.number)
    );

    project.images.push({
      id: imageId,
      scene: scene.number,
      status: "generated"
    });

    res.json({
      success: true,
      image: {
        id: imageId,
        scene: scene.number
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
   ANIMATION
========================================================= */

app.post("/api/animate", async (req, res) => {
  try {
    const project = projects.find(
      (item) => item.id === req.body.projectId
    );

    if (!project) {
      return res.status(404).json({
        error: "Projet introuvable."
      });
    }

    if (!ai) {
      throw new Error("GEMINI_API_KEY manquante.");
    }

    const videos = [];

    for (const scene of project.scenes) {
      try {
        const operation =
          await ai.models.generateVideos({
            model: VIDEO_MODEL,
            prompt:
              scene.videoPrompt ||
              scene.description
          });

        const videoId = makeId("video");

        generatedVideos.set(videoId, {
          id: videoId,
          projectId: project.id,
          scene: scene.number,
          operation
        });

        videos.push({
          id: videoId,
          scene: scene.number,
          status: "processing"
        });
      } catch (error) {
        videos.push({
          scene: scene.number,
          status: "error",
          error: error.message
        });
      }
    }

    project.videos = videos;
    project.status = "animation_processing";
    project.progress = 75;

    res.json({
      success: true,
      videos
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   JOBS
========================================================= */

app.get("/api/jobs", (req, res) => {
  res.json({
    success: true,
    jobs: Array.from(jobs.values())
  });
});

/* =========================================================
   FINAL VIDEO
========================================================= */

app.post("/api/final-video", (req, res) => {
  const project = projects.find(
    (item) => item.id === req.body.projectId
  );

  if (!project) {
    return res.status(404).json({
      error: "Projet introuvable."
    });
  }

  project.status = "montage";
  project.progress = 90;

  const jobId = makeId("render");

  jobs.set(jobId, {
    id: jobId,
    projectId: project.id,
    type: "final-video",
    status: "processing",
    progress: 90,
    createdAt: new Date().toISOString()
  });

  res.json({
    success: true,
    jobId,
    status: "processing"
  });
});

/* =========================================================
   FORMATS
========================================================= */

app.post("/api/formats", async (req, res) => {
  try {
    const project = projects.find(
      (item) => item.id === req.body.projectId
    );

    if (!project) {
      return res.status(404).json({
        error: "Projet introuvable."
      });
    }

    project.formats = {
      landscape: {
        name: "YouTube",
        ratio: "16:9",
        width: 1920,
        height: 1080,
        status: "ready"
      },

      portrait: {
        name: "TikTok / Reels / Shorts",
        ratio: "9:16",
        width: 1080,
        height: 1920,
        status: "ready"
      },

      square: {
        name: "Instagram",
        ratio: "1:1",
        width: 1080,
        height: 1080,
        status: "ready"
      }
    };

    res.json({
      success: true,
      formats: project.formats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   AUDIO
========================================================= */

app.post("/api/prepare-audio", (req, res) => {
  const project = projects.find(
    (item) => item.id === req.body.projectId
  );

  if (!project) {
    return res.status(404).json({
      error: "Projet introuvable."
    });
  }

  project.audio = {
    status: "prepared",
    type: "cinematic",
    message: "Piste audio préparée."
  };

  res.json({
    success: true,
    audio: project.audio
  });
});

/* =========================================================
   THUMBNAIL
========================================================= */

app.post("/api/thumbnail", (req, res) => {
  const project = projects.find(
    (item) => item.id === req.body.projectId
  );

  if (!project) {
    return res.status(404).json({
      error: "Projet introuvable."
    });
  }

  project.thumbnail = {
    status: "prepared",
    title: project.title
  };

  res.json({
    success: true,
    thumbnail: project.thumbnail
  });
});

/* =========================================================
   SOCIAL
========================================================= */

app.post("/api/social", (req, res) => {
  const project = projects.find(
    (item) => item.id === req.body.projectId
  );

  if (!project) {
    return res.status(404).json({
      error: "Projet introuvable."
    });
  }

  project.social = {
    youtube: {
      status: accounts.youtube
        ? "connected"
        : "ready"
    },

    tiktok: {
      status: accounts.tiktok
        ? "connected"
        : "ready"
    },

    instagram: {
      status: accounts.instagram
        ? "connected"
        : "ready"
    }
  };

  res.json({
    success: true,
    social: project.social
  });
});

/* =========================================================
   ACCOUNTS
========================================================= */

app.get("/api/accounts", (req, res) => {
  res.json({
    success: true,
    accounts
  });
});

app.post("/api/accounts/connect", (req, res) => {
  const platform = req.body.platform;

  if (
    !Object.prototype.hasOwnProperty.call(
      accounts,
      platform
    )
  ) {
    return res.status(400).json({
      error: "Plateforme inconnue."
    });
  }

  accounts[platform] = true;

  res.json({
    success: true,
    accounts
  });
});

/* =========================================================
   AUTO PILOTE
========================================================= */

app.post("/api/autopilot", async (req, res) => {
  try {
    const prompt = req.body.prompt;
    const category = req.body.category;

    if (!prompt) {
      return res.status(400).json({
        error: "Donne une idée à Cineflow."
      });
    }

    const project = createProject({
      prompt,
      category
    });

    project.status = "autopilot";
    project.progress = 5;

    projects.unshift(project);

    const jobId = makeId("autopilot");

    jobs.set(jobId, {
      id: jobId,
      projectId: project.id,
      type: "autopilot",
      status: "started",
      progress: 5,
      step: "Création du scénario"
    });

    res.json({
      success: true,
      project,
      jobId
    });

    try {
      const text = await generateText(
        [
          "Crée un projet vidéo complet pour Cineflow.",
          "",
          "Idée :",
          prompt,
          "",
          "Catégorie :",
          category || "Film",
          "",
          "Retourne uniquement un JSON valide avec un titre,",
          "un concept, un style, des personnages et exactement 5 scènes."
        ].join("\n")
      );

      const data = cleanJson(text);

      if (data) {
        project.title =
          data.title || project.title;

        project.concept =
          data.concept || "";

        project.style =
          data.style || "";

        project.characters =
          Array.isArray(data.characters)
            ? data.characters
            : [];

        project.scenes =
          Array.isArray(data.scenes)
            ? data.scenes.slice(0, 5)
            : [];
      }

      project.progress = 30;
      project.status = "ready";

      const job = jobs.get(jobId);

      if (job) {
        job.progress = 30;
        job.status = "ready";
        job.step = "Scénario terminé";
      }
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
      error: error.message
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
        score: 94
      },
      {
        title: "Histoires émotionnelles",
        category: "Drama",
        score: 91
      },
      {
        title: "Animation cinématique",
        category: "Animation",
        score: 88
      },
      {
        title: "Action futuriste",
        category: "Action",
        score: 86
      }
    ]
  });
});

/* =========================================================
   DASHBOARD
========================================================= */

app.get("/api/dashboard", (req, res) => {
  const completed = projects.filter(
    (project) =>
      project.status === "completed"
  ).length;

  res.json({
    success: true,

    stats: {
      projects: projects.length,

      completed,

      scenes: projects.reduce(
        (sum, project) =>
          sum + (project.scenes?.length || 0),
        0
      ),

      images: projects.reduce(
        (sum, project) =>
          sum + (project.images?.length || 0),
        0
      )
    },

    projects: projects.slice(0, 8)
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
        "Les statistiques réelles seront disponibles après connexion des plateformes."
    }
  });
});

/* =========================================================
   SERIES
========================================================= */

app.post("/api/series", (req, res) => {
  const item = {
    id: makeId("series"),
    title:
      req.body.title ||
      "Nouvelle série",
    description:
      req.body.description || "",
    episodes: [],
    createdAt:
      new Date().toISOString()
  };

  series.push(item);

  res.json({
    success: true,
    series: item
  });
});

app.post("/api/series/:id/episode", (req, res) => {
  const item = series.find(
    (serie) =>
      serie.id === req.params.id
  );

  if (!item) {
    return res.status(404).json({
      error: "Série introuvable."
    });
  }

  const episode = {
    id: makeId("episode"),

    number:
      item.episodes.length + 1,

    title:
      req.body.title ||
      "Épisode " +
        (item.episodes.length + 1),

    createdAt:
      new Date().toISOString()
  };

  item.episodes.push(episode);

  res.json({
    success: true,
    episode
  });
});

/* =========================================================
   PREMIUM INTERFACE
   IMPORTANT :
   Aucun backtick JavaScript imbriqué dans cette chaîne.
========================================================= */

function getHomePage() {
  return String.raw`
<!DOCTYPE html>
<html lang="fr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>Cineflow — AI Video Studio</title>

<style>

* {
  box-sizing: border-box;
}

:root {
  --bg: #060712;
  --panel: #101322;
  --panel2: #15192b;
  --border: rgba(255,255,255,.08);
  --text: #f7f8ff;
  --muted: #9299b7;
  --purple: #8b5cf6;
  --pink: #ec4899;
  --blue: #38bdf8;
  --green: #22c55e;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  color: var(--text);
  font-family:
    Inter,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  background:
    radial-gradient(
      circle at 10% 0%,
      rgba(139,92,246,.23),
      transparent 28%
    ),
    radial-gradient(
      circle at 100% 0%,
      rgba(56,189,248,.12),
      transparent 25%
    ),
    var(--bg);

  min-height: 100vh;
}

button,
textarea {
  font: inherit;
}

button {
  cursor: pointer;
}

.app {
  min-height: 100vh;
}

.sidebar {
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;

  width: 245px;

  padding: 22px 16px;

  border-right: 1px solid var(--border);

  background: rgba(5,7,16,.88);

  backdrop-filter: blur(25px);

  z-index: 20;
}

.logo {
  display: flex;
  gap: 12px;
  align-items: center;

  padding: 8px 10px 28px;
}

.logo-icon {
  width: 43px;
  height: 43px;

  display: grid;
  place-items: center;

  border-radius: 14px;

  background:
    linear-gradient(
      135deg,
      var(--purple),
      var(--pink)
    );

  font-size: 21px;

  box-shadow:
    0 12px 35px
    rgba(139,92,246,.35);
}

.logo strong {
  font-size: 20px;
}

.logo small {
  display: block;
  color: var(--muted);
  font-size: 9px;
  margin-top: 3px;
  letter-spacing: 1px;
}

.nav-title {
  color: #626a87;
  font-size: 10px;
  letter-spacing: 1.4px;
  text-transform: uppercase;
  padding: 13px 12px 8px;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.nav button {
  width: 100%;
  border: 0;
  border-radius: 12px;
  padding: 12px;

  color: #aeb4ce;
  background: transparent;

  text-align: left;

  transition: .2s;
}

.nav button:hover,
.nav button.active {
  color: white;
  background:
    rgba(139,92,246,.13);
}

.connection {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 20px;

  padding: 13px;

  border:
    1px solid var(--border);

  border-radius: 15px;

  background:
    rgba(255,255,255,.025);

  font-size: 12px;
}

.dot {
  display: inline-block;

  width: 8px;
  height: 8px;

  margin-right: 8px;

  border-radius: 50%;

  background: var(--green);

  box-shadow:
    0 0 12px var(--green);
}

.main {
  margin-left: 245px;
  padding: 25px 30px 80px;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;

  margin-bottom: 22px;
}

.muted {
  color: var(--muted);
}

.icon {
  border:
    1px solid var(--border);

  background:
    rgba(255,255,255,.04);

  color: white;

  width: 40px;
  height: 40px;

  border-radius: 12px;
}

.hero {
  position: relative;
  overflow: hidden;

  min-height: 350px;

  padding: 40px;

  border:
    1px solid var(--border);

  border-radius: 27px;

  background:
    linear-gradient(
      120deg,
      rgba(139,92,246,.21),
      rgba(236,72,153,.06)
    );

  box-shadow:
    0 30px 90px
    rgba(0,0,0,.24);
}

.hero:after {
  content: "";

  position: absolute;

  right: -100px;
  top: -150px;

  width: 390px;
  height: 390px;

  border-radius: 50%;

  background:
    rgba(139,92,246,.22);

  filter: blur(80px);
}

.hero-content {
  position: relative;
  z-index: 2;

  max-width: 720px;
}

.eyebrow {
  color: #b9a8ff;

  font-size: 11px;

  font-weight: 800;

  letter-spacing: 1.5px;

  margin-bottom: 15px;
}

.hero h1 {
  margin: 0;

  font-size:
    clamp(38px, 6vw, 62px);

  line-height: .98;

  letter-spacing: -3px;
}

.hero h1 span {
  background:
    linear-gradient(
      90deg,
      white,
      #c4b5fd,
      #f9a8d4
    );

  -webkit-background-clip: text;

  color: transparent;
}

.hero p {
  color: #abb2cc;

  max-width: 620px;

  line-height: 1.7;

  margin: 20px 0 26px;
}

.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.primary {
  border: 0;

  color: white;

  padding: 14px 19px;

  border-radius: 13px;

  font-weight: 800;

  background:
    linear-gradient(
      135deg,
      var(--purple),
      var(--pink)
    );

  box-shadow:
    0 15px 35px
    rgba(139,92,246,.28);
}

.secondary {
  border:
    1px solid var(--border);

  color: white;

  padding: 14px 18px;

  border-radius: 13px;

  background:
    rgba(255,255,255,.045);
}

.stats {
  display: grid;

  grid-template-columns:
    repeat(4,1fr);

  gap: 14px;

  margin-top: 17px;
}

.stat {
  padding: 19px;

  border:
    1px solid var(--border);

  border-radius: 18px;

  background:
    rgba(16,19,34,.78);
}

.stat small {
  color: var(--muted);
}

.stat strong {
  display: block;

  font-size: 28px;

  margin-top: 6px;
}

.section {
  margin-top: 31px;
}

.section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;

  margin-bottom: 14px;
}

.section-head h2 {
  margin: 0;

  font-size: 21px;
}

.section-head span {
  color: var(--muted);

  font-size: 11px;
}

.creator {
  display: grid;

  grid-template-columns:
    1.4fr .6fr;

  gap: 15px;
}

.card {
  padding: 20px;

  border:
    1px solid var(--border);

  border-radius: 20px;

  background:
    rgba(16,19,34,.78);
}

.card-title {
  font-weight: 800;

  margin-bottom: 12px;
}

textarea {
  width: 100%;

  min-height: 145px;

  padding: 16px;

  resize: vertical;

  outline: none;

  border:
    1px solid var(--border);

  border-radius: 15px;

  color: white;

  background:
    rgba(0,0,0,.25);
}

.chips {
  display: flex;

  flex-wrap: wrap;

  gap: 8px;

  margin: 13px 0;
}

.chip {
  border:
    1px solid var(--border);

  color: #bfc5db;

  background:
    rgba(255,255,255,.035);

  padding: 8px 12px;

  border-radius: 999px;

  font-size: 11px;
}

.chip.active {
  color: white;

  background:
    rgba(139,92,246,.17);

  border-color:
    rgba(139,92,246,.5);
}

.autopilot {
  background:
    linear-gradient(
      145deg,
      rgba(139,92,246,.2),
      rgba(236,72,153,.06)
    );
}

.auto-icon {
  width: 48px;
  height: 48px;

  display: grid;
  place-items: center;

  border-radius: 15px;

  background:
    linear-gradient(
      135deg,
      var(--purple),
      var(--pink)
    );

  font-size: 23px;
}

.autopilot h3 {
  margin: 15px 0 8px;
}

.autopilot p {
  color: var(--muted);

  font-size: 13px;

  line-height: 1.6;
}

.workflow {
  display: grid;

  grid-template-columns:
    repeat(5,1fr);

  gap: 10px;
}

.step {
  padding: 16px;

  min-height: 125px;

  border:
    1px solid var(--border);

  border-radius: 16px;

  background:
    rgba(255,255,255,.025);
}

.step-number {
  color: #aaa4ff;

  font-size: 10px;
}

.step-icon {
  font-size: 24px;

  margin: 10px 0 7px;
}

.step strong {
  font-size: 12px;
}

.step p {
  color: var(--muted);

  font-size: 10px;

  line-height: 1.5;
}

.projects {
  display: grid;

  grid-template-columns:
    repeat(3,1fr);

  gap: 14px;
}

.project {
  overflow: hidden;

  border:
    1px solid var(--border);

  border-radius: 18px;

  background:
    rgba(16,19,34,.78);
}

.cover {
  height: 140px;

  display: flex;

  align-items: flex-end;

  padding: 13px;

  background:
    radial-gradient(
      circle at 20% 20%,
      rgba(139,92,246,.5),
      transparent 35%
    ),
    radial-gradient(
      circle at 80% 80%,
      rgba(236,72,153,.35),
      transparent 35%
    ),
    #111426;
}

.cover span {
  font-size: 9px;

  padding: 5px 8px;

  border-radius: 7px;

  background:
    rgba(0,0,0,.45);
}

.project-body {
  padding: 15px;
}

.project-body h3 {
  margin: 0;

  font-size: 14px;
}

.project-body p {
  color: var(--muted);

  font-size: 10px;
}

.progress {
  height: 5px;

  overflow: hidden;

  margin-top: 12px;

  border-radius: 20px;

  background:
    rgba(255,255,255,.07);
}

.progress i {
  display: block;

  height: 100%;

  background:
    linear-gradient(
      90deg,
      var(--purple),
      var(--pink)
    );
}

.timeline {
  display: grid;

  grid-template-columns:
    repeat(5,1fr);

  gap: 11px;
}

.scene {
  overflow: hidden;

  border:
    1px solid var(--border);

  border-radius: 17px;

  background:
    rgba(16,19,34,.78);
}

.scene-visual {
  height: 135px;

  display: grid;

  place-items: center;

  font-size: 30px;

  background:
    radial-gradient(
      circle at 20% 20%,
      rgba(56,189,248,.16),
      transparent 35%
    ),
    radial-gradient(
      circle at 80% 80%,
      rgba(139,92,246,.22),
      transparent 40%
    ),
    #111426;
}

.scene-body {
  padding: 12px;
}

.scene-label {
  color: #aaa4ff;

  font-size: 9px;

  text-transform: uppercase;

  font-weight: 800;
}

.scene h3 {
  margin: 5px 0;

  font-size: 13px;
}

.scene p {
  color: var(--muted);

  font-size: 10px;

  line-height: 1.5;
}

.formats {
  display: grid;

  grid-template-columns:
    repeat(3,1fr);

  gap: 14px;
}

.format {
  display: flex;

  align-items: center;

  gap: 14px;

  padding: 18px;

  border:
    1px solid var(--border);

  border-radius: 18px;

  background:
    rgba(16,19,34,.78);
}

.preview {
  width: 45px;
  height: 60px;

  border:
    2px solid #a5abc0;

  border-radius: 6px;
}

.preview.landscape {
  width: 60px;
  height: 38px;
}

.preview.square {
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

.mobile {
  display: none;
}

@media(max-width:1050px) {

  .stats {
    grid-template-columns:
      repeat(2,1fr);
  }

  .creator {
    grid-template-columns: 1fr;
  }

  .projects {
    grid-template-columns:
      repeat(2,1fr);
  }

  .workflow,
  .timeline {
    grid-template-columns:
      repeat(3,1fr);
  }

}

@media(max-width:720px) {

  .sidebar {
    display: none;
  }

  .main {
    margin-left: 0;

    padding:
      16px
      13px
      90px;
  }

  .hero {
    padding: 26px 20px;

    border-radius: 22px;
  }

  .hero h1 {
    font-size: 39px;
  }

  .stats,
  .projects,
  .workflow,
  .timeline,
  .formats {
    grid-template-columns: 1fr;
  }

  .mobile {
    display: flex;

    position: fixed;

    left: 10px;
    right: 10px;
    bottom: 10px;

    height: 64px;

    align-items: center;

    justify-content:
      space-around;

    z-index: 100;

    border:
      1px solid var(--border);

    border-radius: 19px;

    background:
      rgba(9,11,23,.92);

    backdrop-filter:
      blur(20px);
  }

  .mobile button {
    border: 0;

    background: transparent;

    color: #858da8;

    font-size: 19px;
  }

}

</style>

</head>

<body>

<aside class="sidebar">

  <div class="logo">

    <div class="logo-icon">
      ✦
    </div>

    <div>
      <strong>Cineflow</strong>
      <small>AI VIDEO STUDIO</small>
    </div>

  </div>

  <div class="nav-title">
    Workspace
  </div>

  <div class="nav">

    <button class="active"
      onclick="go('home')">
      🏠 &nbsp; Accueil
    </button>

    <button
      onclick="go('creator')">
      ✦ &nbsp; Créer
    </button>

    <button
      onclick="go('scenes')">
      ▣ &nbsp; Studio
    </button>

    <button
      onclick="go('formats')">
      ◫ &nbsp; Formats
    </button>

    <button
      onclick="go('projects')">
      ▤ &nbsp; Projets
    </button>

    <button
      onclick="testGemini()">
      ● &nbsp; Gemini
    </button>

  </div>

  <div class="connection">
    <span class="dot"></span>
    Gemini
    <span style="float:right;color:#6ee7b7">
      Connecté
    </span>
  </div>

</aside>

<main class="main">

  <div class="topbar">

    <span class="muted">
      Cineflow / Studio de création
    </span>

    <div>

      <button class="icon"
        onclick="testGemini()">
        ✦
      </button>

      <button class="icon"
        onclick="location.reload()">
        ↻
      </button>

    </div>

  </div>

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
        Cineflow imagine ton histoire, construit
        les scènes, prépare les visuels et transforme
        ton concept en projet vidéo.
      </p>

      <div class="actions">

        <button class="primary"
          onclick="go('creator')">
          ✦ Créer une vidéo
        </button>

        <button class="secondary"
          onclick="autopilot()">
          ⚡ Auto-Pilote
        </button>

      </div>

    </div>

  </section>

  <div class="stats">

    <div class="stat">
      <small>Projets</small>
      <strong id="projectsStat">0</strong>
    </div>

    <div class="stat">
      <small>Scènes créées</small>
      <strong id="scenesStat">0</strong>
    </div>

    <div class="stat">
      <small>Images IA</small>
      <strong id="imagesStat">0</strong>
    </div>

    <div class="stat">
      <small>Vidéos finales</small>
      <strong id="videosStat">0</strong>
    </div>

  </div>

  <section class="section" id="creator">

    <div class="section-head">

      <h2>
        Créer quelque chose de nouveau
      </h2>

      <span>
        Étape 01 · Concept
      </span>

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

          <button
            class="chip active"
            onclick="category(this,'Film')">
            🎬 Film
          </button>

          <button
            class="chip"
            onclick="category(this,'Animation')">
            ✨ Animation
          </button>

          <button
            class="chip"
            onclick="category(this,'Action')">
            ⚡ Action
          </button>

          <button
            class="chip"
            onclick="category(this,'Drama')">
            🎭 Drama
          </button>

          <button
            class="chip"
            onclick="category(this,'Football')">
            ⚽ Football
          </button>

        </div>

        <button
          class="primary"
          style="width:100%"
          onclick="createProject()">
          Générer mon projet →
        </button>

      </div>

      <div class="card autopilot">

        <div class="auto-icon">
          ⚡
        </div>

        <h3>
          Auto-Pilote
        </h3>

        <p>
          Donne simplement ton idée.
          Cineflow prépare automatiquement
          la structure de ton projet.
        </p>

        <button
          class="primary"
          style="width:100%"
          onclick="autopilot()">
          Lancer Auto-Pilote
        </button>

      </div>

    </div>

  </section>

  <section class="section">

    <div class="section-head">

      <h2>
        Le pipeline Cineflow
      </h2>

      <span>
        De l'idée au film
      </span>

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
        <p>Une histoire en 5 scènes.</p>
      </div>

      <div class="step">
        <div class="step-number">03</div>
        <div class="step-icon">🎨</div>
        <strong>Visuels</strong>
        <p>Création des images IA.</p>
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
        <p>Montage final.</p>
      </div>

    </div>

  </section>

  <section class="section" id="projects">

    <div class="section-head">

      <h2>
        Mes projets
      </h2>

      <span id="projectCount">
        0 projet
      </span>

    </div>

    <div
      class="projects"
      id="projectsList">

      <div class="project">

        <div class="cover">
          <span>NOUVEAU</span>
        </div>

        <div class="project-body">

          <h3>
            Ton prochain film
          </h3>

          <p>
            Commence avec une idée.
          </p>

          <div class="progress">
            <i style="width:0%"></i>
          </div>

        </div>

      </div>

    </div>

  </section>

  <section class="section" id="scenes">

    <div class="section-head">

      <h2>
        Timeline des scènes
      </h2>

      <span>
        5 scènes cinématiques
      </span>

    </div>

    <div
      class="timeline"
      id="timeline">

      <div class="scene">
        <div class="scene-visual">01</div>
        <div class="scene-body">
          <div class="scene-label">Scène 01</div>
          <h3>Ouverture</h3>
          <p>En attente du scénario.</p>
        </div>
      </div>

      <div class="scene">
        <div class="scene-visual">02</div>
        <div class="scene-body">
          <div class="scene-label">Scène 02</div>
          <h3>Développement</h3>
          <p>En attente du scénario.</p>
        </div>
      </div>

      <div class="scene">
        <div class="scene-visual">03</div>
        <div class="scene-body">
          <div class="scene-label">Scène 03</div>
          <h3>Conflit</h3>
          <p>En attente du scénario.</p>
        </div>
      </div>

      <div class="scene">
        <div class="scene-visual">04</div>
        <div class="scene-body">
          <div class="scene-label">Scène 04</div>
          <h3>Climax</h3>
          <p>En attente du scénario.</p>
        </div>
      </div>

      <div class="scene">
        <div class="scene-visual">05</div>
        <div class="scene-body">
          <div class="scene-label">Scène 05</div>
          <h3>Final</h3>
          <p>En attente du scénario.</p>
        </div>
      </div>

    </div>

  </section>

  <section class="section" id="formats">

    <div class="section-head">

      <h2>
        Formats intelligents
      </h2>

      <span>
        Un projet · plusieurs plateformes
      </span>

    </div>

    <div class="formats">

      <div class="format">

        <div class="preview landscape"></div>

        <div>
          <h3>YouTube / Cinéma</h3>
          <p>16:9 · 1920 × 1080</p>
        </div>

      </div>

      <div class="format">

        <div class="preview"></div>

        <div>
          <h3>TikTok / Shorts / Reels</h3>
          <p>9:16 · 1080 × 1920</p>
        </div>

      </div>

      <div class="format">

        <div class="preview square"></div>

        <div>
          <h3>Instagram</h3>
          <p>1:1 · 1080 × 1080</p>
        </div>

      </div>

    </div>

  </section>

  <div
    style="
      text-align:center;
      margin-top:55px;
      color:#5f6680;
      font-size:10px;
    "
  >
    Cineflow · Ton espace de création assistée par intelligence artificielle
  </div>

</main>

<div class="mobile">

  <button onclick="go('home')">
    ⌂
  </button>

  <button onclick="go('creator')">
    ✦
  </button>

  <button onclick="go('scenes')">
    ▣
  </button>

  <button onclick="go('projects')">
    ▤
  </button>

</div>

<script>

var currentCategory = "Film";

function go(id) {

  var element =
    document.getElementById(id);

  if (element) {
    element.scrollIntoView({
      behavior: "smooth"
    });
  }

}

function category(button, value) {

  currentCategory = value;

  document
    .querySelectorAll(".chip")
    .forEach(function(item) {
      item.classList.remove("active");
    });

  button.classList.add("active");
}

function escapeHtml(value) {

  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function createProject() {

  var prompt =
    document.getElementById("prompt")
      .value
      .trim();

  if (!prompt) {
    alert("Écris ton idée de vidéo.");
    return;
  }

  try {

    var response =
      await fetch("/api/project", {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          prompt: prompt,
          category: currentCategory
        })
      });

    var data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Erreur Cineflow."
      );
    }

    renderProject(data.project);

    loadDashboard();

    alert(
      "✨ Projet Cineflow créé !"
    );

  } catch (error) {

    alert(error.message);

  }

}

async function autopilot() {

  var prompt =
    document.getElementById("prompt")
      .value
      .trim();

  if (!prompt) {

    alert(
      "Décris ton idée avant de lancer Auto-Pilote."
    );

    go("creator");

    return;
  }

  try {

    var response =
      await fetch("/api/autopilot", {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          prompt: prompt,
          category: currentCategory
        })
      });

    var data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Auto-Pilote indisponible."
      );
    }

    renderProject(data.project);

    loadDashboard();

    alert(
      "⚡ Auto-Pilote Cineflow est lancé."
    );

  } catch (error) {

    alert(error.message);

  }

}

function renderProject(project) {

  if (!project) return;

  var timeline =
    document.getElementById("timeline");

  if (!timeline) return;

  var scenes =
    project.scenes || [];

  if (!scenes.length) return;

  var html = "";

  scenes
    .slice(0, 5)
    .forEach(function(scene, index) {

      var number =
        String(index + 1).padStart(2, "0");

      var title =
        escapeHtml(
          scene.title || "Scène"
        );

      var description =
        escapeHtml(
          scene.description ||
          "Scène générée par Cineflow."
        );

      html +=
        '<div class="scene">' +
          '<div class="scene-visual">' +
            number +
          '</div>' +
          '<div class="scene-body">' +
            '<div class="scene-label">' +
              'Scène ' + number +
            '</div>' +
            '<h3>' +
              title +
            '</h3>' +
            '<p>' +
              description +
            '</p>' +
          '</div>' +
        '</div>';

    });

  timeline.innerHTML = html;

  loadProjects();

}

async function loadProjects() {

  try {

    var response =
      await fetch("/api/projects");

    var data =
      await response.json();

    var list =
      data.projects || [];

    var container =
      document.getElementById(
        "projectsList"
      );

    var count =
      document.getElementById(
        "projectCount"
      );

    if (!container || !count) {
      return;
    }

    count.textContent =
      list.length +
      " projet" +
      (list.length > 1 ? "s" : "");

    if (!list.length) return;

    var html = "";

    list
      .slice(0, 6)
      .forEach(function(project) {

        var progress =
          Math.max(
            0,
            Math.min(
              100,
              Number(
                project.progress || 0
              )
            )
          );

        var category =
          escapeHtml(
            (
              project.category ||
              "FILM"
            ).toUpperCase()
          );

        var title =
          escapeHtml(
            project.title ||
            "Projet Cineflow"
          );

        var status =
          escapeHtml(
            project.status ||
            "Projet"
          );

        html +=
          '<div class="project">' +

            '<div class="cover">' +
              '<span>' +
                category +
              '</span>' +
            '</div>' +

            '<div class="project-body">' +

              '<h3>' +
                title +
              '</h3>' +

              '<p>' +
                status +
              '</p>' +

              '<div class="progress">' +
                '<i style="width:' +
                  progress +
                '%"></i>' +
              '</div>' +

            '</div>' +

          '</div>';

      });

    container.innerHTML = html;

  } catch (error) {

    console.log(error);

  }

}

async function loadDashboard() {

  try {

    var response =
      await fetch(
        "/api/dashboard"
      );

    var data =
      await response.json();

    if (!data.stats) return;

    var projectsStat =
      document.getElementById(
        "projectsStat"
      );

    var scenesStat =
      document.getElementById(
        "scenesStat"
      );

    var imagesStat =
      document.getElementById(
        "imagesStat"
      );

    var videosStat =
      document.getElementById(
        "videosStat"
      );

    if (projectsStat) {
      projectsStat.textContent =
        data.stats.projects || 0;
    }

    if (scenesStat) {
      scenesStat.textContent =
        data.stats.scenes || 0;
    }

    if (imagesStat) {
      imagesStat.textContent =
        data.stats.images || 0;
    }

    if (videosStat) {
      videosStat.textContent =
        data.stats.completed || 0;
    }

    loadProjects();

  } catch (error) {

    console.log(error);

  }

}

async function testGemini() {

  try {

    var response =
      await fetch(
        "/api/test-gemini"
      );

    var data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Gemini indisponible."
      );
    }

    alert(
      "✓ " +
      data.message
    );

  } catch (error) {

    alert(
      "Gemini : " +
      error.message
    );

  }

}

loadDashboard();

</script>

</body>

</html>
`;
}

app.get("/", (req, res) => {
  res.send(getHomePage());
});

/* =========================================================
   START SERVER
========================================================= */

app.listen(PORT, () => {

  console.log(
    "========================================"
  );

  console.log(
    "          CINEFLOW IS RUNNING"
  );

  console.log(
    "========================================"
  );

  console.log(
    "Port:",
    PORT
  );

  console.log(
    "Gemini:",
    API_KEY
      ? "CONNECTED"
      : "MISSING KEY"
  );

  console.log(
    "Text model:",
    MODEL
  );

  console.log(
    "Image model:",
    IMAGE_MODEL
  );

  console.log(
    "Video model:",
    VIDEO_MODEL
  );

  console.log(
    "========================================"
  );

});

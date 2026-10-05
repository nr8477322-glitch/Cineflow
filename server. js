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

      if (
        item.content &&
        Array.isArray(item.content)
      ) {
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

  if (
    interaction &&
    Array.isArray(interaction.steps)
  ) {
    for (const step of interaction.steps) {
      if (step.type !== "model_output") continue;

      if (!Array.isArray(step.content)) continue;

      for (const block of step.content) {
        if (
          block.type === "image" &&
          block.data
        ) {
          return {
            base64: block.data,
            mimeType: block.mime_type || "image/png"
          };
        }
      }
    }
  }

  throw new Error(
    "Aucune image n'a été retournée par Gemini."
  );
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
  return {
    mood: detectMood(project),
    bpm: detectMood(project) === "énergique" ? 125 : 95,
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

  /*
   * Le moteur garde une piste audio de secours.
   * Cela permet à Cineflow de continuer même si
   * le modèle musical n'est pas disponible.
   */
  await generateFallbackAudio(
    outputPath,
    40
  );

  return {
    path: outputPath,
    plan: buildAudioPlan(project)
  };
}

function buildTrendPrompt(project) {
  return `
Tu es le moteur créatif de Cineflow.

Crée 5 idées de vidéos ORIGINALES inspirées des tendances générales
des plateformes vidéo.

Plateformes :
YouTube, TikTok, Instagram, Facebook.

Catégorie :
${project?.category || "cinéma"}

Idée actuelle :
${project?.idea || ""}

IMPORTANT :
- Ne copie aucune vidéo existante.
- Ne donne pas de lien.
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
    const parsed = JSON.parse(
      cleanJson(text)
    );

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
        hook: "Il n'avait que quelques secondes pour choisir.",
        concept:
          "Une histoire dramatique avec une décision inattendue.",
        reason:
          "Les histoires à suspense encouragent les spectateurs à rester jusqu'à la fin."
      },
      {
        title: "Le monde de demain",
        platform: "Instagram",
        category: "animation",
        hook: "En 2050, cette chose est devenue normale.",
        concept:
          "Une courte fiction futuriste.",
        reason:
          "Le concept visuel se prête bien à des scènes courtes."
      },
      {
        title: "Le défi impossible",
        platform: "TikTok",
        category: "action",
        hook: "Personne ne pensait qu'il réussirait.",
        concept:
          "Une aventure rapide en cinq scènes.",
        reason:
          "Le rythme permet de créer un hook immédiatement."
      },
      {
        title: "Une histoire qui inspire",
        platform: "Facebook",
        category: "drame",
        hook: "Il a commencé avec presque rien.",
        concept:
          "Une histoire de progression et de réussite.",
        reason:
          "Les récits humains peuvent favoriser les réactions et les partages."
      }
    ];
  }
}

function makeDashboardProject(project, status = "Créé") {
  const item = {
    id:
      "project_" +
      Date.now() +
      "_" +
      Math.random()
        .toString(36)
        .slice(2, 8),
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
    scenes: project?.scenes || [],
    data: project || {}
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

  const text = await generateTextInteraction(
    prompt
  );

  const parsed = JSON.parse(
    cleanJson(text)
  );

  if (
    !parsed.scenes ||
    !Array.isArray(parsed.scenes)
  ) {
    throw new Error(
      "Gemini n'a pas retourné les scènes."
    );
  }

  parsed.scenes = parsed.scenes
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
   GEMINI
========================================================= */

app.get("/api/test-gemini", async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({
        ok: false,
        error:
          "GEMINI_API_KEY est absente de Render."
      });
    }

    const text =
      await generateTextInteraction(
        "Réponds exactement : Je confirme que Gemini est correctement connecté à Cineflow."
      );

    res.json({
      ok: true,
      message: text
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error:
        error.message ||
        "Erreur Gemini."
    });
  }
});

/* =========================================================
   CRÉATION DU PROJET
========================================================= */

app.post("/api/generate", async (req, res) => {
  try {
    const {
      idea,
      category
    } = req.body || {};

    if (!idea) {
      return res.status(400).json({
        ok: false,
        error:
          "Écris une idée pour ta vidéo."
      });
    }

    const project =
      await generateProject(
        idea,
        category
      );

    const saved =
      makeDashboardProject(
        project,
        "Projet généré"
      );

    res.json({
      ok: true,
      project,
      projectId: saved.id
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error:
        error.message ||
        "Impossible de générer le projet."
    });
  }
});

/* =========================================================
   PRÉPARATION DES SCÈNES
========================================================= */

app.post("/api/prepare-images", async (req, res) => {
  try {
    const project =
      req.body?.project || req.body;

    if (
      !project ||
      !Array.isArray(project.scenes)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Aucune scène trouvée."
      });
    }

    const scenes =
      project.scenes
        .slice(0, 5)
        .map((scene, index) => ({
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
      ok: true,
      scenes
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =========================================================
   GÉNÉRATION D'UNE IMAGE
========================================================= */

app.post("/api/generate-image", async (req, res) => {
  try {
    const {
      prompt,
      sceneIndex
    } = req.body || {};

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        error:
          "Le prompt de l'image est vide."
      });
    }

    const image =
      await generateImage(prompt);

    res.json({
      ok: true,
      sceneIndex:
        Number(sceneIndex) || 0,
      image
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error:
        error.message ||
        "Erreur lors de la génération de l'image."
    });
  }
});

/* =========================================================
   ANIMATION D'UNE SCÈNE
========================================================= */

async function animateScene(prompt, image) {
  if (!ai) {
    throw new Error(
      "GEMINI_API_KEY est absente."
    );
  }

  const options = {
    model: VIDEO_MODEL,
    prompt: prompt
  };

  if (
    image &&
    image.base64
  ) {
    options.image = {
      imageBytes: image.base64,
      mimeType:
        image.mimeType ||
        "image/png"
    };
  }

  let operation =
    await ai.models.generateVideos(
      options
    );

  let attempts = 0;

  while (
    !operation.done &&
    attempts < 60
  ) {
    await sleep(10000);

    operation =
      await ai.operations.getVideosOperation({
        operation
      });

    attempts++;
  }

  if (!operation.done) {
    throw new Error(
      "La génération vidéo prend trop de temps."
    );
  }

  if (
    !operation.response ||
    !operation.response.generatedVideos ||
    !operation.response.generatedVideos[0]
  ) {
    throw new Error(
      "Veo n'a pas retourné de vidéo."
    );
  }

  const generated =
    operation.response.generatedVideos[0];

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

  await ai.files.download({
    file: generated.video,
    downloadPath: outputPath
  });

  return outputPath;
}

app.post("/api/animate-scene", async (req, res) => {
  try {
    const {
      prompt,
      image
    } = req.body || {};

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        error:
          "Prompt d'animation manquant."
      });
    }

    const output =
      await animateScene(
        prompt,
        image
      );

    const data =
      fs.readFileSync(output)
        .toString("base64");

    res.json({
      ok: true,
      video: {
        base64: data,
        mimeType: "video/mp4"
      }
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error:
        error.message ||
        "Erreur Veo."
    });
  }
});

/* =========================================================
   ANIMATION DES 5 SCÈNES
========================================================= */

app.post("/api/animate-scenes", async (req, res) => {
  try {
    const {
      scenes
    } = req.body || {};

    if (
      !Array.isArray(scenes) ||
      scenes.length !== 5
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Cineflow doit recevoir exactement 5 scènes."
      });
    }

    const jobId =
      "job_" +
      Date.now() +
      "_" +
      Math.random()
        .toString(36)
        .slice(2, 8);

    animationJobs.set(jobId, {
      id: jobId,
      status: "queued",
      progress: 0,
      scenes: scenes.map(
        (scene, index) => ({
          index,
          status: "queued",
          video: null,
          error: null
        })
      ),
      createdAt:
        new Date().toISOString()
    });

    processAnimationJob(
      jobId,
      scenes
    );

    res.json({
      ok: true,
      jobId
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
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

  job.status = "running";

  for (
    let index = 0;
    index < scenes.length;
    index++
  ) {
    const scene =
      scenes[index];

    job.scenes[index].status =
      "running";

    try {
      const video =
        await animateScene(
          scene.animationPrompt ||
          scene.prompt ||
          scene.description ||
          "",
          scene.image || null
        );

      job.scenes[index] = {
        index,
        status: "completed",
        video,
        error: null
      };
    } catch (error) {
      job.scenes[index] = {
        index,
        status: "error",
        video: null,
        error:
          error.message
      };
    }

    job.progress =
      Math.round(
        ((index + 1) /
          scenes.length) *
          100
      );
  }

  const errors =
    job.scenes.filter(
      scene =>
        scene.status ===
        "error"
    );

  job.status =
    errors.length === 0
      ? "completed"
      : "completed_with_errors";
}

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
        error:
          "Job introuvable."
      });
    }

    res.json({
      ok: true,
      job
    });
  }
);

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
        ok: false,
        error:
          "Scène introuvable."
      });
    }

    if (
      !scene.video ||
      !fs.existsSync(scene.video)
    ) {
      return res.status(404).json({
        ok: false,
        error:
          "Vidéo de scène indisponible."
      });
    }

    res.sendFile(
      path.resolve(
        scene.video
      )
    );
  }
);

/* =========================================================
   RETRY / RÉGÉNÉRATION D'UNE SCÈNE
========================================================= */

app.post(
  "/api/animation-retry",
  async (req, res) => {
    try {
      const {
        jobId,
        sceneIndex
      } = req.body || {};

      const job =
        animationJobs.get(jobId);

      if (!job) {
        return res.status(404).json({
          ok: false,
          error:
            "Job introuvable."
        });
      }

      const scene =
        job.scenes[
          Number(sceneIndex)
        ];

      if (!scene) {
        return res.status(404).json({
          ok: false,
          error:
            "Scène introuvable."
        });
      }

      scene.status =
        "running";

      const original =
        req.body.scene || {};

      try {
        const output =
          await animateScene(
            original.animationPrompt ||
            original.prompt ||
            original.description ||
            "",
            original.image || null
          );

        scene.video =
          output;

        scene.status =
          "completed";

        scene.error = null;

        res.json({
          ok: true,
          scene
        });
      } catch (error) {
        scene.status =
          "error";

        scene.error =
          error.message;

        res.status(500).json({
          ok: false,
          error:
            error.message
        });
      }
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);

app.post(
  "/api/animation-regenerate",
  async (req, res) => {
    try {
      const {
        prompt,
        image
      } = req.body || {};

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          error:
            "Prompt manquant."
        });
      }

      const video =
        await animateScene(
          prompt,
          image
        );

      res.json({
        ok: true,
        video
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
   CRÉATION DU MP4 FINAL
========================================================= */

app.post("/api/create-video", async (req, res) => {
  try {
    const {
      videos,
      project
    } = req.body || {};

    if (
      !Array.isArray(videos) ||
      videos.length === 0
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Aucune scène vidéo fournie."
      });
    }

    const dir =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "cineflow-final-"
        )
      );

    const listPath =
      path.join(
        dir,
        "inputs.txt"
      );

    const normalized =
      [];

    for (
      let i = 0;
      i < videos.length;
      i++
    ) {
      const item =
        videos[i];

      let source =
        item.path ||
        item.videoPath;

      if (
        !source &&
        item.base64
      ) {
        source =
          path.join(
            dir,
            `scene-${i}.mp4`
          );

        fs.writeFileSync(
          source,
          Buffer.from(
            item.base64,
            "base64"
          )
        );
      }

      if (
        source &&
        fs.existsSync(source)
      ) {
        normalized.push(
          source
        );
      }
    }

    if (
      normalized.length === 0
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Aucune vidéo exploitable."
      });
    }

    fs.writeFileSync(
      listPath,
      normalized
        .map(
          file =>
            `file '${file.replace(
              /'/g,
              "'\\''"
            )}'`
        )
        .join("\n")
    );

    const outputPath =
      path.join(
        dir,
        "cineflow-final.mp4"
      );

    await runFfmpeg([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
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
      ok: true,
      videoId,
      downloadUrl:
        `/api/download-video/${videoId}`,
      project:
        project || null
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error:
        error.message ||
        "Erreur lors de la création du MP4."
    });
  }
});

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
      "Cineflow-video.mp4"
    );
  }
);

/* =========================================================
   AUDIO
========================================================= */

app.post(
  "/api/prepare-audio",
  async (req, res) => {
    try {
      const project =
        req.body?.project ||
        req.body;

      const result =
        await generateAudioTrack(
          project
        );

      const data =
        fs.readFileSync(
          result.path
        ).toString("base64");

      res.json({
        ok: true,
        plan: result.plan,
        audio: {
          base64: data,
          mimeType: "audio/mpeg"
        }
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
  async (req, res) => {
    try {
      const project =
        req.body?.project ||
        req.body;

      const prompt =
        project.thumbnailPrompt ||
        `
Crée une miniature YouTube cinématique
16:9 pour cette histoire :

${project.concept || project.title || ""}
        `;

      const image =
        await generateImage(
          prompt
        );

      res.json({
        ok: true,
        image
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
   RÉSEAUX SOCIAUX
========================================================= */

app.post(
  "/api/prepare-social",
  async (req, res) => {
    try {
      const project =
        req.body?.project ||
        req.body;

      const prompt = `
Prépare les textes de publication
pour cette vidéo Cineflow.

Titre :
${project.title || ""}

Concept :
${project.concept || ""}

Retourne uniquement JSON :

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

      let social;

      try {
        social =
          JSON.parse(
            cleanJson(text)
          );
      } catch {
        social = {
          youtube: text,
          tiktok: text,
          instagram: text,
          facebook: text
        };
      }

      res.json({
        ok: true,
        social
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
  async (req, res) => {
    try {
      const {
        idea,
        category
      } = req.body || {};

      const project =
        await generateProject(
          idea ||
            "Créer une vidéo originale et captivante.",
          category ||
            "cinéma"
        );

      const plan = {
        steps: [
          "Idée",
          "Scénario",
          "5 scènes",
          "Images",
          "Animation",
          "Voix",
          "Musique",
          "Montage",
          "Formats",
          "Publication",
          "Statistiques"
        ],
        project
      };

      const saved =
        makeDashboardProject(
          project,
          "Auto-Pilote"
        );

      res.json({
        ok: true,
        plan,
        projectId:
          saved.id
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
   TENDANCES
========================================================= */

app.get(
  "/api/trends",
  async (req, res) => {
    try {
      const project = {
        category:
          req.query.category ||
          "cinéma",
        idea:
          req.query.idea ||
          ""
      };

      const ideas =
        await generateTrendIdeas(
          project
        );

      res.json({
        ok: true,
        live: false,
        message:
          "Idées inspirées des tendances générales, pas des statistiques temps réel.",
        ideas
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
   DASHBOARD
========================================================= */

app.get(
  "/api/dashboard",
  (req, res) => {
    const totalViews =
      dashboardAccounts.reduce(
        (sum, account) =>
          sum +
          account.views,
        0
      );

    const totalLikes =
      dashboardAccounts.reduce(
        (sum, account) =>
          sum +
          account.likes,
        0
      );

    const totalSubscribers =
      dashboardAccounts.reduce(
        (sum, account) =>
          sum +
          account.subscribers,
        0
      );

    const revenue =
      dashboardAccounts.reduce(
        (sum, account) =>
          sum +
          account.revenue,
        0
      );

    res.json({
      ok: true,
      metrics: {
        projects:
          dashboardProjects.length,
        series:
          dashboardSeries.length,
        views:
          totalViews,
        likes:
          totalLikes,
        subscribers:
          totalSubscribers,
        revenue
      },
      projects:
        dashboardProjects,
      accounts:
        dashboardAccounts,
      series:
        dashboardSeries
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
    try {
      const project =
        req.body?.project ||
        req.body;

      const saved =
        makeDashboardProject(
          project,
          project.status ||
            "Créé"
        );

      res.json({
        ok: true,
        project:
          saved
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

app.post(
  "/api/projects/status",
  (req, res) => {
    const {
      projectId,
      status
    } = req.body || {};

    const project =
      getProjectById(
        projectId
      );

    if (!project) {
      return res.status(404).json({
        ok: false,
        error:
          "Projet introuvable."
      });
    }

    project.status =
      status ||
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
        ok: false,
        error:
          "Plateforme inconnue."
      });
    }

    /*
     * Cette route prépare l'interface.
     * Le véritable OAuth doit être ajouté
     * avec les API officielles de chaque plateforme.
     */

    account.connected = true;

    res.json({
      ok: true,
      account,
      message:
        "Compte marqué comme connecté. L'OAuth réel devra être configuré pour publier réellement."
    });
  }
);

/* =========================================================
   RAPPORT HEBDOMADAIRE
========================================================= */

app.get(
  "/api/reports/weekly",
  (req, res) => {
    const best =
      dashboardProjects[0] ||
      null;

    const report = {
      period: "Cette semaine",
      videosCreated:
        dashboardProjects.length,
      videosPublished: 0,
      views:
        dashboardAccounts.reduce(
          (s, a) =>
            s + a.views,
          0
        ),
      likes:
        dashboardAccounts.reduce(
          (s, a) =>
            s + a.likes,
          0
        ),
      subscribers:
        dashboardAccounts.reduce(
          (s, a) =>
            s + a.subscribers,
          0
        ),
      estimatedRevenue:
        dashboardAccounts.reduce(
          (s, a) =>
            s + a.revenue,
          0
        ),
      bestVideo:
        best?.title ||
        "Aucune vidéo",
      suggestions: [
        "Tester plusieurs hooks.",
        "Créer davantage de formats courts.",
        "Regarder quelles catégories retiennent le mieux les spectateurs.",
        "Régénérer les scènes qui fonctionnent moins bien."
      ]
    };

    res.json({
      ok: true,
      report
    });
  }
);

/* =========================================================
   RAPPORT MENSUEL
========================================================= */

app.get(
  "/api/reports/monthly",
  (req, res) => {
    const report = {
      period: "Ce mois",
      projects:
        dashboardProjects.length,
      series:
        dashboardSeries.length,
      videosPublished: 0,
      totalViews:
        dashboardAccounts.reduce(
          (s, a) =>
            s + a.views,
          0
        ),
      totalLikes:
        dashboardAccounts.reduce(
          (s, a) =>
            s + a.likes,
          0
        ),
      subscribers:
        dashboardAccounts.reduce(
          (s, a) =>
            s + a.subscribers,
          0
        ),
      estimatedRevenue:
        dashboardAccounts.reduce(
          (s, a) =>
            s + a.revenue,
          0
        ),
      bestPlatform:
        dashboardAccounts
          .slice()
          .sort(
            (a, b) =>
              b.views - a.views
          )[0]?.platform ||
        "Aucune",
      recommendations: [
        "Continuer les concepts qui obtiennent le plus d'intérêt.",
        "Tester différents formats de publication.",
        "Utiliser les rapports pour améliorer les prochains projets."
      ]
    };

    res.json({
      ok: true,
      report
    });
  }
);

/* =========================================================
   MODE SÉRIE
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
    const {
      title,
      concept,
      characters
    } = req.body || {};

    if (!title) {
      return res.status(400).json({
        ok: false,
        error:
          "Le nom de la série est obligatoire."
      });
    }

    const series = {
      id:
        "series_" +
        Date.now(),
      title,
      concept:
        concept || "",
      characters:
        characters || [],
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
  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport"
content="width=device-width,initial-scale=1.0">

<title>Cineflow Studio</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: #080b16;
  color: #ffffff;
}

button,
textarea,
input,
select {
  font: inherit;
}

button {
  border: 0;
  cursor: pointer;
}

.app {
  min-height: 100vh;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  padding: 16px;
  background: rgba(8,11,22,.96);
  border-bottom: 1px solid #20263b;
}

.logo {
  font-size: 25px;
  font-weight: 800;
}

.subtitle {
  color: #9da6bd;
  margin-top: 5px;
  font-size: 13px;
}

.layout {
  display: flex;
  min-height: calc(100vh - 75px);
}

.sidebar {
  width: 245px;
  padding: 15px;
  border-right: 1px solid #20263b;
  background: #0b1020;
}

.nav-button {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  color: #dce3f7;
  padding: 12px;
  margin-bottom: 5px;
  border-radius: 10px;
}

.nav-button:hover {
  background: #171d31;
}

.main {
  flex: 1;
  padding: 20px;
  padding-bottom: 100px;
  max-width: 1200px;
}

.section {
  display: none;
}

.section.active {
  display: block;
}

h1 {
  margin-top: 0;
}

h2 {
  margin-top: 0;
}

.card {
  background: #10162a;
  border: 1px solid #222a42;
  border-radius: 18px;
  padding: 18px;
  margin-bottom: 15px;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fit,minmax(220px,1fr));
  gap: 14px;
}

.metric {
  font-size: 28px;
  font-weight: 800;
  margin-top: 8px;
}

.label {
  color: #9da6bd;
  font-size: 13px;
}

textarea,
input,
select {
  width: 100%;
  background: #080c18;
  border: 1px solid #2a3450;
  color: white;
  border-radius: 12px;
  padding: 13px;
  outline: none;
}

textarea {
  min-height: 130px;
  resize: vertical;
}

.primary {
  background: #635bff;
  color: white;
  padding: 13px 18px;
  border-radius: 12px;
  font-weight: 700;
  margin-top: 10px;
}

.secondary {
  background: #1b2338;
  color: white;
  padding: 11px 15px;
  border-radius: 10px;
  margin-top: 8px;
}

.primary:disabled,
.secondary:disabled {
  opacity: .45;
  cursor: not-allowed;
}

.scene {
  background: #0c1222;
  border: 1px solid #242d46;
  border-radius: 14px;
  padding: 15px;
  margin-top: 10px;
}

.scene img {
  width: 100%;
  border-radius: 12px;
  margin-top: 10px;
}

.status {
  padding: 8px 11px;
  border-radius: 999px;
  background: #19223a;
  color: #cdd7ef;
  display: inline-block;
  font-size: 12px;
}

.progress {
  height: 9px;
  border-radius: 20px;
  background: #1a2134;
  overflow: hidden;
  margin-top: 12px;
}

.progressBar {
  height: 100%;
  width: 0%;
  background: #635bff;
  transition: width .3s;
}

.bottom-nav {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 30;
  background: rgba(8,11,22,.97);
  border-top: 1px solid #20263b;
  display: flex;
  overflow-x: auto;
}

.bottom-nav button {
  min-width: 95px;
  padding: 12px 8px;
  background: transparent;
  color: #aeb7ce;
  font-size: 12px;
}

.bottom-nav button:hover {
  color: white;
}

.idea {
  padding: 14px;
  background: #0c1222;
  border: 1px solid #242d46;
  border-radius: 14px;
  margin-top: 10px;
}

.small {
  font-size: 12px;
  color: #9da6bd;
}

.success {
  color: #62e6a8;
}

.warning {
  color: #ffd166;
}

.error {
  color: #ff7b8b;
}

pre {
  white-space: pre-wrap;
  word-break: break-word;
}

@media(max-width:800px) {

  .sidebar {
    display: none;
  }

  .main {
    padding: 14px;
  }

}

</style>
</head>

<body>

<div class="app">

<header class="topbar">
  <div class="logo">🎬 Cineflow</div>
  <div class="subtitle">
    Ton espace de création assistée par intelligence artificielle
  </div>
</header>

<div class="layout">

<aside class="sidebar">

<button class="nav-button"
onclick="showSection('home')">
🏠 Accueil
</button>

<button class="nav-button"
onclick="showSection('trends')">
📈 Tendances
</button>

<button class="nav-button"
onclick="showSection('create')">
🎬 Créer une vidéo
</button>

<button class="nav-button"
onclick="showSection('autopilot')">
🤖 Auto-Pilote
</button>

<button class="nav-button"
onclick="showSection('projects')">
🎬 Mes projets
</button>

<button class="nav-button"
onclick="showSection('series')">
📺 Mes séries
</button>

<button class="nav-button"
onclick="showSection('accounts')">
👤 Mes comptes
</button>

<button class="nav-button"
onclick="showSection('weekly')">
📊 Vérification hebdomadaire
</button>

<button class="nav-button"
onclick="showSection('monthly')">
📋 Rapport mensuel
</button>

<button class="nav-button"
onclick="showSection('studio')">
🎥 Studio
</button>

<button class="nav-button"
onclick="showSection('settings')">
⚙️ Paramètres
</button>

</aside>

<main class="main">

<!-- ACCUEIL -->

<section id="home"
class="section active">

<h1>🏠 Accueil</h1>

<div class="grid">

<div class="card">
<div class="label">Projets</div>
<div id="homeProjects"
class="metric">0</div>
</div>

<div class="card">
<div class="label">Vues</div>
<div id="homeViews"
class="metric">0</div>
</div>

<div class="card">
<div class="label">Likes</div>
<div id="homeLikes"
class="metric">0</div>
</div>

<div class="card">
<div class="label">Abonnés</div>
<div id="homeSubscribers"
class="metric">0</div>
</div>

</div>

<div class="card">
<h2>🚀 Créer rapidement</h2>

<p>
Transforme une idée en projet vidéo Cineflow.
</p>

<button class="primary"
onclick="showSection('create')">
🎬 Créer une vidéo
</button>

<button class="secondary"
onclick="showSection('autopilot')">
🤖 Lancer Auto-Pilote
</button>

<button class="secondary"
onclick="showSection('trends')">
📈 Voir les tendances
</button>
</div>

</section>

<!-- TENDANCES -->

<section id="trends"
class="section">

<h1>📈 Tendances</h1>

<div class="card">

<p>
Cineflow peut générer des idées originales
inspirées des tendances générales.
</p>

<select id="trendCategory">
<option>cinéma</option>
<option>animation</option>
<option>action</option>
<option>drame</option>
<option>football</option>
</select>

<button class="primary"
onclick="chargerTendances()">
✨ Générer les idées
</button>

<div id="trendResults"></div>

</div>

</section>

<!-- CREATE -->

<section id="create"
class="section">

<h1>🎬 Créer une vidéo</h1>

<div class="card">

<label>Catégorie</label>

<select id="category">

<option value="film">
🎬 Film
</option>

<option value="animation">
✨ Animation
</option>

<option value="action">
🔥 Action
</option>

<option value="drame">
🎭 Drame
</option>

<option value="football">
⚽ Football
</option>

</select>

<br><br>

<label>Ton idée</label>

<textarea
id="idea"
placeholder="Exemple : un jeune footballeur africain rêve de devenir professionnel malgré les difficultés...">
</textarea>

<button
id="generateProjectButton"
class="primary"
onclick="genererProjet()">
🚀 Générer mon projet
</button>

<div
id="projectResult"
style="margin-top:15px">
</div>

</div>

</section>

<!-- STUDIO -->

<section id="studio"
class="section">

<h1>🎥 Studio Cineflow</h1>

<div class="card">

<h2>1️⃣ Projet</h2>

<div id="studioProject">
Aucun projet généré.
</div>

</div>

<div class="card">

<h2>2️⃣ 🧩 Scènes</h2>

<button
id="prepareScenesButton"
class="primary"
onclick="preparerScenes()"
disabled>
🧩 Préparer les 5 scènes
</button>

<div
id="scenesResult">
</div>

</div>

<div class="card">

<h2>3️⃣ 🖼️ Images</h2>

<button
id="generateImagesButton"
class="primary"
onclick="genererImages()"
disabled>
🎨 Générer les images
</button>

<div
id="imagesResult">
</div>

</div>

<div class="card">

<h2>4️⃣ 🎞️ Animation</h2>

<button
id="animateScenesButton"
class="primary"
onclick="animerScenes()"
disabled>
🎞️ Animer les 5 scènes
</button>

<div class="progress">
<div
id="animationProgress"
class="progressBar">
</div>
</div>

<div
id="animationResult">
</div>

</div>

<div class="card">

<h2>5️⃣ 🎬 Vidéo finale</h2>

<button
id="createVideoButton"
class="primary"
onclick="creerVideo()"
disabled>
🎬 Créer ma vidéo
</button>

<div
id="finalVideoResult">
</div>

</div>

<div class="card">

<h2>6️⃣ 🎵 Audio</h2>

<button
class="secondary"
onclick="preparerAudio()">
🎵 Préparer la musique
</button>

<div id="audioResult"></div>

</div>

<div class="card">

<h2>7️⃣ 🖼️ Miniature</h2>

<button
class="secondary"
onclick="preparerThumbnail()">
🖼️ Générer la miniature
</button>

<div id="thumbnailResult"></div>

</div>

<div class="card">

<h2>8️⃣ 📱 Réseaux sociaux</h2>

<button
class="secondary"
onclick="preparerSocial()">
📱 Préparer les publications
</button>

<div id="socialResult"></div>

</div>

</section>

<!-- AUTOPILOTE -->

<section id="autopilot"
class="section">

<h1>🤖 Auto-Pilote</h1>

<div class="card">

<h2>Création automatique</h2>

<p>
Idée → scénario → scènes → images →
animation → montage → formats → publication → statistiques.
</p>

<textarea
id="autopilotIdea"
placeholder="Décris l'idée de la vidéo...">
</textarea>

<select id="autopilotCategory">
<option>cinéma</option>
<option>animation</option>
<option>action</option>
<option>drame</option>
<option>football</option>
</select>

<button
class="primary"
onclick="preparerAutopilot()">
🤖 Préparer Auto-Pilote
</button>

<div id="autopilotResult"></div>

</div>

</section>

<!-- PROJETS -->

<section id="projects"
class="section">

<h1>🎬 Mes projets</h1>

<button
class="primary"
onclick="chargerProjets()">
🔄 Actualiser
</button>

<div id="projectsResult"></div>

</section>

<!-- SERIES -->

<section id="series"
class="section">

<h1>📺 Mes séries</h1>

<div class="card">

<input
id="seriesTitle"
placeholder="Nom de la série">

<textarea
id="seriesConcept"
placeholder="Concept de la série">
</textarea>

<button
class="primary"
onclick="creerSerie()">
📺 Créer une série
</button>

</div>

<div id="seriesResult"></div>

</section>

<!-- COMPTES -->

<section id="accounts"
class="section">

<h1>👤 Mes comptes</h1>

<div id="accountsResult"></div>

</section>

<!-- WEEKLY -->

<section id="weekly"
class="section">

<h1>📊 Vérification hebdomadaire</h1>

<button
class="primary"
onclick="chargerHebdo()">
📊 Générer le rapport
</button>

<div id="weeklyResult"></div>

</section>

<!-- MONTHLY -->

<section id="monthly"
class="section">

<h1>📋 Rapport mensuel</h1>

<button
class="primary"
onclick="chargerMensuel()">
📋 Générer le rapport
</button>

<div id="monthlyResult"></div>

</section>

<!-- SETTINGS -->

<section id="settings"
class="section">

<h1>⚙️ Paramètres</h1>

<div class="card">

<h2>Gemini</h2>

<button
class="primary"
onclick="testGemini()">
✨ Tester Gemini
</button>

<div id="geminiResult"></div>

</div>

<div class="card">

<h2>ℹ️ Cineflow</h2>

<p class="small">
Cineflow est conçu pour automatiser progressivement
la création vidéo.
</p>

<p class="small">
La connexion réelle OAuth et la publication automatique
sur les plateformes devront être configurées séparément.
</p>

</div>

</section>

</main>
</div>

<nav class="bottom-nav">

<button onclick="showSection('home')">
🏠<br>Accueil
</button>

<button onclick="showSection('trends')">
📈<br>Tendance
</button>

<button onclick="showSection('studio')">
🎥<br>Studio
</button>

<button onclick="showSection('studio')">
🧩<br>Scènes
</button>

<button onclick="showSection('studio')">
🖼️<br>Images
</button>

<button onclick="showSection('studio')">
🎞️<br>Animation
</button>

<button onclick="showSection('studio')">
🎬<br>Vidéo
</button>

</nav>

</div>

<script>

let currentProject = null;
let preparedScenes = [];
let generatedImages = [];
let animationJobId = null;

function showSection(id) {

  document
    .querySelectorAll(".section")
    .forEach(section => {
      section.classList.remove("active");
    });

  const target =
    document.getElementById(id);

  if (target) {
    target.classList.add("active");
  }

  if (id === "home") {
    chargerAccueil();
  }

  if (id === "projects") {
    chargerProjets();
  }

  if (id === "accounts") {
    chargerComptes();
  }

  if (id === "weekly") {
    chargerHebdo();
  }

  if (id === "monthly") {
    chargerMensuel();
  }

  if (id === "series") {
    chargerSeries();
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

function genererProjet() {

  const idea =
    document
      .getElementById("idea")
      .value
      .trim();

  const category =
    document
      .getElementById("category")
      .value;

  if (!idea) {
    alert(
      "Écris d'abord ton idée."
    );
    return;
  }

  const button =
    document
      .getElementById(
        "generateProjectButton"
      );

  button.disabled = true;
  button.textContent =
    "⏳ Génération...";

  fetch("/api/generate", {
    method: "POST",
    headers: {
      "Content-Type":
        "application/json"
    },
    body: JSON.stringify({
      idea,
      category
    })
  })
  .then(r => r.json())
  .then(data => {

    if (!data.ok) {
      throw new Error(
        data.error
      );
    }

    currentProject =
      data.project;

    currentProject.id =
      data.projectId;

    document
      .getElementById(
        "projectResult"
      )
      .innerHTML = `
        <div class="card">
          <h2>
            ${escapeHtml(
              data.project.title
            )}
          </h2>

          <p>
            ${escapeHtml(
              data.project.concept
            )}
          </p>

          <span class="status">
            Projet généré
          </span>
        </div>
      `;

    document
      .getElementById(
        "studioProject"
      )
      .innerHTML = `
        <h3>
          ${escapeHtml(
            data.project.title
          )}
        </h3>

        <p>
          ${escapeHtml(
            data.project.scenario
          )}
        </p>
      `;

    document
      .getElementById(
        "prepareScenesButton"
      )
      .disabled = false;

    showSection("studio");

  })
  .catch(error => {

    document
      .getElementById(
        "projectResult"
      )
      .innerHTML = `
        <p class="error">
          ❌ ${escapeHtml(
            error.message
          )}
        </p>
      `;

  })
  .finally(() => {

    button.disabled = false;

    button.textContent =
      "🚀 Générer mon projet";

  });
}

function preparerScenes() {

  if (!currentProject) {
    alert(
      "Crée d'abord un projet."
    );
    return;
  }

  const button =
    document
      .getElementById(
        "prepareScenesButton"
      );

  button.disabled = true;
  button.textContent =
    "⏳ Préparation...";

  fetch(
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
  )
  .then(r => r.json())
  .then(data => {

    if (!data.ok) {
      throw new Error(
        data.error
      );
    }

    preparedScenes =
      data.scenes;

    afficherScenes();

    document
      .getElementById(
        "generateImagesButton"
      )
      .disabled = false;

  })
  .catch(error => {

    document
      .getElementById(
        "scenesResult"
      )
      .innerHTML = `
        <p class="error">
          ❌ ${escapeHtml(
            error.message
          )}
        </p>
      `;

  })
  .finally(() => {

    button.disabled = false;
    button.textContent =
      "🧩 Préparer les 5 scènes";

  });
}

function afficherScenes() {

  const container =
    document.getElementById(
      "scenesResult"
    );

  container.innerHTML =
    preparedScenes
      .map(scene => `
        <div class="scene">

          <span class="status">
            Scène ${scene.number}
          </span>

          <h3>
            ${escapeHtml(
              scene.title
            )}
          </h3>

          <p>
            ${escapeHtml(
              scene.prompt
            )}
          </p>

        </div>
      `)
      .join("");
}

async function genererImages() {

  if (
    !preparedScenes.length
  ) {
    alert(
      "Prépare d'abord les scènes."
    );
    return;
  }

  const button =
    document
      .getElementById(
        "generateImagesButton"
      );

  button.disabled = true;
  button.textContent =
    "⏳ Génération des images...";

  generatedImages = [];

  const container =
    document.getElementById(
      "imagesResult"
    );

  container.innerHTML = "";

  try {

    for (
      let i = 0;
      i < preparedScenes.length;
      i++
    ) {

      const scene =
        preparedScenes[i];

      container.innerHTML += `
        <div class="scene"
        id="imageScene${i}">
          <b>
            🖼️ Scène ${i + 1}
          </b>
          <p class="small">
            Génération...
          </p>
        </div>
      `;

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
                scene.prompt,
              sceneIndex: i
            })
          }
        );

      const data =
        await response.json();

      if (!data.ok) {
        throw new Error(
          data.error
        );
      }

      generatedImages[i] =
        data.image;

      const element =
        document.getElementById(
          `imageScene${i}`
        );

      if (element) {
        element.innerHTML = `
          <b>
            🖼️ Scène ${i + 1}
          </b>

          <img
          src="data:${data.image.mimeType};base64,${data.image.base64}"
          alt="Image Cineflow">

          <p class="success">
            ✅ Image générée
          </p>
        `;
      }
    }

    document
      .getElementById(
        "animateScenesButton"
      )
      .disabled = false;

  } catch (error) {

    container.innerHTML += `
      <p class="error">
        ❌ ${escapeHtml(
          error.message
        )}
      </p>
    `;

  } finally {

    button.disabled = false;

    button.textContent =
      "🎨 Générer les images";

  }
}

async function animerScenes() {

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
      "animateScenesButton"
    );

  button.disabled = true;
  button.textContent =
    "⏳ Lancement...";

  const scenes =
    preparedScenes.map(
      (scene, index) => ({
        ...scene,
        image:
          generatedImages[index]
      })
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
            scenes
          })
        }
      );

    const data =
      await response.json();

    if (!data.ok) {
      throw new Error(
        data.error
      );
    }

    animationJobId =
      data.jobId;

    pollAnimation();

  } catch (error) {

    document
      .getElementById(
        "animationResult"
      )
      .innerHTML = `
        <p class="error">
          ❌ ${escapeHtml(
            error.message
          )}
        </p>
      `;

    button.disabled = false;
    button.textContent =
      "🎞️ Animer les 5 scènes";
  }
}

async function pollAnimation() {

  if (!animationJobId) {
    return;
  }

  try {

    const response =
      await fetch(
        `/api/animation-status/${animationJobId}`
      );

    const data =
      await response.json();

    if (!data.ok) {
      throw new Error(
        data.error
      );
    }

    const job =
      data.job;

    document
      .getElementById(
        "animationProgress"
      )
      .style.width =
      `${job.progress}%`;

    document
      .getElementById(
        "animationResult"
      )
      .innerHTML = `
        <p>
          Progression :
          ${job.progress}%
        </p>

        ${job.scenes
          .map(scene => `
            <div class="scene">
              Scène
              ${scene.index + 1} :
              <span class="status">
                ${escapeHtml(
                  scene.status
                )}
              </span>
            </div>
          `)
          .join("")}
      `;

    if (
      job.status === "completed" ||
      job.status ===
        "completed_with_errors"
    ) {

      document
        .getElementById(
          "createVideoButton"
        )
        .disabled =
        job.scenes.every(
          scene =>
            scene.status ===
            "completed"
        );

      document
        .getElementById(
          "animateScenesButton"
        )
        .disabled = false;

      document
        .getElementById(
          "animateScenesButton"
        )
        .textContent =
        "🎞️ Animer les 5 scènes";

      return;
    }

    setTimeout(
      pollAnimation,
      5000
    );

  } catch (error) {

    document
      .getElementById(
        "animationResult"
      )
      .innerHTML += `
        <p class="error">
          ❌ ${escapeHtml(
            error.message
          )}
        </p>
      `;
  }
}

async function creerVideo() {

  if (!animationJobId) {
    alert(
      "Anime d'abord les scènes."
    );
    return;
  }

  const response =
    await fetch(
      `/api/animation-status/${animationJobId}`
    );

  const data =
    await response.json();

  if (!data.ok) {
    alert(
      data.error
    );
    return;
  }

  const videos =
    data.job.scenes
      .filter(
        scene =>
          scene.status ===
          "completed"
      )
      .map(
        scene => ({
          path:
            scene.video
        })
      );

  if (
    videos.length !== 5
  ) {
    alert(
      "Les 5 scènes doivent être terminées."
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

  try {

    const result =
      await fetch(
        "/api/create-video",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            videos,
            project:
              currentProject
          })
        }
      );

    const final =
      await result.json();

    if (!final.ok) {
      throw new Error(
        final.error
      );
    }

    document
      .getElementById(
        "finalVideoResult"
      )
      .innerHTML = `
        <p class="success">
          ✅ Vidéo finale créée !
        </p>

        <a
        class="primary"
        href="${final.downloadUrl}"
        download>
          🎬 Télécharger la vidéo
        </a>
      `;

  } catch (error) {

    document
      .getElementById(
        "finalVideoResult"
      )
      .innerHTML = `
        <p class="error">
          ❌ ${escapeHtml(
            error.message
          )}
        </p>
      `;

  } finally {

    button.disabled = false;
    button.textContent =
      "🎬 Créer ma vidéo";
  }
}

function preparerAudio() {

  if (!currentProject) {
    alert(
      "Crée d'abord un projet."
    );
    return;
  }

  fetch(
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
  )
  .then(r => r.json())
  .then(data => {

    if (!data.ok) {
      throw new Error(
        data.error
      );
    }

    document
      .getElementById(
        "audioResult"
      )
      .innerHTML = `
        <p class="success">
          🎵 Plan musical :
          ${escapeHtml(
            data.plan.mood
          )}
        </p>

        <audio
        controls
        style="width:100%"
        src="data:${data.audio.mimeType};base64,${data.audio.base64}">
        </audio>
      `;

  })
  .catch(error => {

    document
      .getElementById(
        "audioResult"
      )
      .innerHTML = `
        <p class="error">
          ❌ ${escapeHtml(
            error.message
          )}
        </p>
      `;

  });
}

function preparerThumbnail() {

  if (!currentProject) {
    alert(
      "Crée d'abord un projet."
    );
    return;
  }

  fetch(
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
  )
  .then(r => r.json())
  .then(data => {

    if (!data.ok) {
      throw new Error(
        data.error
      );
    }

    document
      .getElementById(
        "thumbnailResult"
      )
      .innerHTML = `
        <img
        style="width:100%;border-radius:12px;margin-top:10px"
        src="data:${data.image.mimeType};base64,${data.image.base64}">
      `;

  })
  .catch(error => {

    document
      .getElementById(
        "thumbnailResult"
      )
      .innerHTML = `
        <p class="error">
          ❌ ${escapeHtml(
            error.message
          )}
        </p>
      `;

  });
}

function preparerSocial() {

  if (!currentProject) {
    alert(
      "Crée d'abord un projet."
    );
    return;
  }

  fetch(
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
  )
  .then(r => r.json())
  .then(data => {

    if (!data.ok) {
      throw new Error(
        data.error
      );
    }

    document
      .getElementById(
        "socialResult"
      )
      .innerHTML = `
        <div class="scene">
          <b>YouTube</b>
          <p>
            ${escapeHtml(
              data.social.youtube
            )}
          </p>
        </div>

        <div class="scene">
          <b>TikTok</b>
          <p>
            ${escapeHtml(
              data.social.tiktok
            )}
          </p>
        </div>

        <div class="scene">
          <b>Instagram</b>
          <p>
            ${escapeHtml(
              data.social.instagram
            )}
          </p>
        </div>

        <div class="scene">
          <b>Facebook</b>
          <p>
            ${escapeHtml(
              data.social.facebook
            )}
          </p>
        </div>
      `;

  })
  .catch(error => {

    document
      .getElementById(
        "socialResult"
      )
      .innerHTML = `
        <p class="error">
          ❌ ${escapeHtml(
            error.message
          )}
        </p>
      `;

  });
}

function preparerAutopilot() {

  const idea =
    document
      .getElementById(
        "autopilotIdea"
      )
      .value
      .trim();

  const category =
    document
      .getElementById(
        "autopilotCategory"
      )
      .value;

  if (!idea) {
    alert(
      "Écris une idée."
    );
    return;
  }

  document
    .getElementById(
      "autopilotResult"
    )
    .innerHTML =
    "⏳ Préparation du plan Auto-Pilote...";

  fetch(
    "/api/autopilot-plan",
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
  )
  .then(r => r.json())
  .then(data => {

    if (!data.ok) {
      throw new Error(
        data.error
      );
    }

    document
      .getElementById(
        "autopilotResult"
      )
      .innerHTML = `
        <div class="scene">

          <h3>
            🤖 Auto-Pilote prêt
          </h3>

          ${data.plan.steps
            .map(
              (step, i) => `
                <p>
                  ${i + 1}.
                  ${escapeHtml(
                    step
                  )}
                </p>
              `
            )
            .join("")}

          <p class="success">
            Projet :
            ${escapeHtml(
              data.project.title
            )}
          </p>

        </div>
      `;

  })
  .catch(error => {

    document
      .getElementById(
        "autopilotResult"
      )
      .innerHTML = `
        <p class="error">
          ❌ ${escapeHtml(
            error.message
          )}
        </p>
      `;

  });
}

function chargerTendances() {

  const category =
    document
      .getElementById(
        "trendCategory"
      )
      .value;

  document
    .getElementById(
      "trendResults"
    )
    .innerHTML =
    "⏳ Recherche d'idées...";

  fetch(
    "/api/trends?category=" +
    encodeURIComponent(
      category
    )
  )
  .then(r => r.json())
  .then(data => {

    if (!data.ok) {
      throw new Error(
        data.error
      );
    }

    document
      .getElementById(
        "trendResults"
      )
      .innerHTML = `

        <p class="small">
          ${escapeHtml(
            data.message
          )}
        </p>

        ${data.ideas
          .map(
            (idea, index) => `
              <div class="idea">

                <span class="status">
                  ${escapeHtml(
                    idea.platform
                  )}
                </span>

                <h3>
                  ${index + 1}.
                  ${escapeHtml(
                    idea.title
                  )}
                </h3>

                <p>
                  <b>Hook :</b>
                  ${escapeHtml(
                    idea.hook
                  )}
                </p>

                <p>
                  ${escapeHtml(
                    idea.concept
                  )}
                </p>

                <p class="small">
                  ${escapeHtml(
                    idea.reason
                  )}
                </p>

                <button
                class="secondary"
                onclick='utiliserTendance(${JSON.stringify(
                  idea
                )})'>
                  🎬 Utiliser cette idée
                </button>

              </div>
            `
          )
          .join("")}
      `;

  })
  .catch(error => {

    document
      .getElementById(
        "trendResults"
      )
      .innerHTML = `
        <p class="error">
          ❌ ${escapeHtml(
            error.message
          )}
        </p>
      `;

  });
}

function utiliserTendance(idea) {

  document
    .getElementById(
      "idea"
    )
    .value =
    `${idea.title}

${idea.concept}

Hook :
${idea.hook}`;

  if (idea.category) {

    const select =
      document
        .getElementById(
          "category"
        );

    const options =
      Array.from(
        select.options
      );

    const found =
      options.find(
        option =>
          option.value ===
          idea.category
      );

    if (found) {
      select.value =
        idea.category;
    }
  }

  showSection("create");
}

function chargerProjets() {

  fetch(
    "/api/projects"
  )
  .then(r => r.json())
  .then(data => {

    document
      .getElementById(
        "projectsResult"
      )
      .innerHTML =
      data.projects.length
        ? data.projects
            .map(
              project => `
                <div class="card">

                  <h3>
                    ${escapeHtml(
                      project.title
                    )}
                  </h3>

                  <p>
                    ${escapeHtml(
                      project.category
                    )}
                  </p>

                  <span class="status">
                    ${escapeHtml(
                      project.status
                    )}
                  </span>

                  <p class="small">
                    ${new Date(
                      project.createdAt
                    ).toLocaleString()}
                  </p>

                </div>
              `
            )
            .join("")
        :
        `
          <div class="card">
            Aucun projet pour le moment.
          </div>
        `;

  })
  .catch(error => {

    document
      .getElementById(
        "projectsResult"
      )
      .innerHTML = `
        <p class="error">
          ❌ ${escapeHtml(
            error.message
          )}
        </p>
      `;

  });
}

function chargerComptes() {

  fetch(
    "/api/accounts"
  )
  .then(r => r.json())
  .then(data => {

    document
      .getElementById(
        "accountsResult"
      )
      .innerHTML =
      data.accounts
        .map(
          account => `
            <div class="card">

              <h2>
                ${escapeHtml(
                  account.platform
                )}
              </h2>

              <span class="status">
                ${
                  account.connected
                    ? "Connecté"
                    : "Non connecté"
                }
              </span>

              <div class="grid">

                <div>
                  <div class="label">
                    Vues
                  </div>
                  <div class="metric">
                    ${account.views}
                  </div>
                </div>

                <div>
                  <div class="label">
                    Likes
                  </div>
                  <div class="metric">
                    ${account.likes}
                  </div>
                </div>

                <div>
                  <div class="label">
                    Abonnés
                  </div>
                  <div class="metric">
                    ${account.subscribers}
                  </div>
                </div>

                <div>
                  <div class="label">
                    Revenus estimés
                  </div>
                  <div class="metric">
                    ${account.revenue}
                  </div>
                </div>

              </div>

              <button
              class="secondary"
              onclick="connecterCompte('${account.platform}')">
                ${
                  account.connected
                    ? "Compte connecté"
                    : "🔗 Connecter"
                }
              </button>

            </div>
          `
        )
        .join("");

  });
}

function connecterCompte(platform) {

  fetch(
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
  )
  .then(r => r.json())
  .then(() => {
    chargerComptes();
  });
}

function chargerHebdo() {

  document
    .getElementById(
      "weeklyResult"
    )
    .innerHTML =
    "⏳ Génération...";

  fetch(
    "/api/reports/weekly"
  )
  .then(r => r.json())
  .then(data => {

    const report =
      data.report;

    document
      .getElementById(
        "weeklyResult"
      )
      .innerHTML = `

        <div class="grid">

          <div class="card">
            <div class="label">
              Vidéos créées
            </div>
            <div class="metric">
              ${report.videosCreated}
            </div>
          </div>

          <div class="card">
            <div class="label">
              Vues
            </div>
            <div class="metric">
              ${report.views}
            </div>
          </div>

          <div class="card">
            <div class="label">
              Likes
            </div>
            <div class="metric">
              ${report.likes}
            </div>
          </div>

          <div class="card">
            <div class="label">
              Abonnés gagnés
            </div>
            <div class="metric">
              ${report.subscribers}
            </div>
          </div>

        </div>

        <div class="card">

          <h3>
            🏆 Meilleure vidéo
          </h3>

          <p>
            ${escapeHtml(
              report.bestVideo
            )}
          </p>

          <h3>
            💡 Suggestions
          </h3>

          ${report.suggestions
            .map(
              item =>
                `<p>• ${escapeHtml(
                  item
                )}</p>`
            )
            .join("")}

        </div>
      `;

  });
}

function chargerMensuel() {

  document
    .getElementById(
      "monthlyResult"
    )
    .innerHTML =
    "⏳ Génération...";

  fetch(
    "/api/reports/monthly"
  )
  .then(r => r.json())
  .then(data => {

    const report =
      data.report;

    document
      .getElementById(
        "monthlyResult"
      )
      .innerHTML = `

        <div class="grid">

          <div class="card">
            <div class="label">
              Projets
            </div>
            <div class="metric">
              ${report.projects}
            </div>
          </div>

          <div class="card">
            <div class="label">
              Vues
            </div>
            <div class="metric">
              ${report.totalViews}
            </div>
          </div>

          <div class="card">
            <div class="label">
              Likes
            </div>
            <div class="metric">
              ${report.totalLikes}
            </div>
          </div>

          <div class="card">
            <div class="label">
              Plateforme principale
            </div>
            <div class="metric"
            style="font-size:20px">
              ${escapeHtml(
                report.bestPlatform
              )}
            </div>
          </div>

        </div>

        <div class="card">

          <h3>
            💰 Revenus estimés
          </h3>

          <div class="metric">
            ${report.estimatedRevenue}
          </div>

          <h3>
            💡 Recommandations
          </h3>

          ${report.recommendations
            .map(
              item =>
                `<p>• ${escapeHtml(
                  item
                )}</p>`
            )
            .join("")}

        </div>
      `;

  });
}

function chargerSeries() {

  fetch(
    "/api/series"
  )
  .then(r => r.json())
  .then(data => {

    document
      .getElementById(
        "seriesResult"
      )
      .innerHTML =
      data.series.length
        ? data.series
            .map(
              series => `
                <div class="card">

                  <h2>
                    📺 ${escapeHtml(
                      series.title
                    )}
                  </h2>

                  <p>
                    ${escapeHtml(
                      series.concept
                    )}
                  </p>

                  <span class="status">
                    ${series.episodes.length}
                    épisode(s)
                  </span>

                </div>
              `
            )
            .join("")
        :
        `
          <div class="card">
            Aucune série pour le moment.
          </div>
        `;

  });
}

function creerSerie() {

  const title =
    document
      .getElementById(
        "seriesTitle"
      )
      .value
      .trim();

  const concept =
    document
      .getElementById(
        "seriesConcept"
      )
      .value
      .trim();

  if (!title) {
    alert(
      "Donne un nom à la série."
    );
    return;
  }

  fetch(
    "/api/series",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify({
        title,
        concept
      })
    }
  )
  .then(r => r.json())
  .then(data => {

    if (!data.ok) {
      throw new Error(
        data.error
      );
    }

    document
      .getElementById(
        "seriesTitle"
      )
      .value = "";

    document
      .getElementById(
        "seriesConcept"
      )
      .value = "";

    chargerSeries();

  })
  .catch(error => {

    alert(
      error.message
    );

  });
}

function chargerAccueil() {

  fetch(
    "/api/dashboard"
  )
  .then(r => r.json())
  .then(data => {

    document
      .getElementById(
        "homeProjects"
      )
      .textContent =
      data.metrics.projects;

    document
      .getElementById(
        "homeViews"
      )
      .textContent =
      data.metrics.views;

    document
      .getElementById(
        "homeLikes"
      )
      .textContent =
      data.metrics.likes;

    document
      .getElementById(
        "homeSubscribers"
      )
      .textContent =
      data.metrics.subscribers;

  });
}

function testGemini() {

  document
    .getElementById(
      "geminiResult"
    )
    .innerHTML =
    "⏳ Test Gemini...";

  fetch(
    "/api/test-gemini"
  )
  .then(r => r.json())
  .then(data => {

    if (!data.ok) {
      throw new Error(
        data.error
      );
    }

    document
      .getElementById(
        "geminiResult"
      )
      .innerHTML = `
        <p class="success">
          ✅ ${escapeHtml(
            data.message
          )}
        </p>
      `;

  })
  .catch(error => {

    document
      .getElementById(
        "geminiResult"
      )
      .innerHTML = `
        <p class="error">
          ❌ ${escapeHtml(
            error.message
          )}
        </p>
      `;

  });
}

chargerAccueil();

</script>

</body>
</html>
`);
});

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      error:
        "Route introuvable."
    });
  }
);

/* =========================================================
   DÉMARRAGE
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `🎬 Cineflow fonctionne sur le port ${PORT}`
    );

    console.log(
      API_KEY
        ? "✅ GEMINI_API_KEY détectée."
        : "⚠️ GEMINI_API_KEY absente."
    );
  }
);
